#!/usr/bin/env bash
# get-exarchos.sh — Unix bootstrap installer for the exarchos CLI binary.
#
# Downloads the exarchos binary from GitHub Releases, verifies the SHA-512
# checksum, installs it to a user-local PATH location, and updates the
# user's shell rc files so the binary is immediately usable.
#
# Modeled on dotnet/aspire/eng/scripts/get-aspire-cli.sh. Self-contained:
# no jq, no yq. Tested by scripts/get-exarchos.test.sh.
#
# PORTABILITY: this script requires bash (the shebang is /usr/bin/env bash).
# It uses a small number of bash-isms — `local`, `[[ ]]` where convenient,
# and `readonly` — all of which are also accepted by dash/zsh, so piping
# `curl … | sh` on systems where /bin/sh is dash will still work, but we
# recommend `curl … | bash` for explicitness. We deliberately avoid `local`
# in hot paths and any `[[ ]]` constructs requiring extglob.
#
# USAGE
#   curl -fsSL https://get.exarchos.dev | bash
#   bash tools/release/get-exarchos.sh [options]
#
# OPTIONS
#   --dry-run              Print the install plan without executing.
#   --version <tag>        Pin to a specific release tag (e.g. v2.9.0-rc1).
#                          Default: latest GitHub release.
#   --tier <release|staging|dev>
#                          Quality tier. release (default) fetches from
#                          tagged GitHub Releases; staging/dev are stubs.
#   --github-actions       Append install dir to \$GITHUB_PATH instead of
#                          mutating user shell rc files.
#   --allow-modified-source
#                          Accept an artifact whose embedded build identity
#                          reports sourceState=modified (built from a dirty
#                          working tree). REFUSED by default: such an artifact
#                          is exactly the case where the signed manifest's
#                          source digest cannot vouch for the compiled bytes.
#   -h | --help            Show this help text.
#
# ENVIRONMENT
#   EXARCHOS_INSTALL_DIR   Override install location (default: \$HOME/.local/bin).
#   EXARCHOS_LATEST_VERSION
#                          Hermetic override for the "latest version" lookup
#                          (skips the GitHub API call). Primarily used by
#                          tests; also useful in air-gapped environments.
#   EXARCHOS_RELEASE_BASE_URL
#                          Override the release URL space (default
#                          https://github.com/lvlup-sw/exarchos/releases).
#                          For internal mirrors and the acceptance suite.
#   EXARCHOS_RELEASE_VERIFIER
#                          Path to the shipped release verifier
#                          (dist/release-verify.js, or the
#                          `exarchos-release-verify` bin). Overrides discovery.
#   EXARCHOS_TRUST_ROOT_PEM_FILE
#                          Path to the publisher Ed25519 PUBLIC key to verify
#                          the release manifest against, replacing the key
#                          pinned in this script. OPERATOR-supplied only —
#                          never fetch this from the same origin as the
#                          release (that would be trust-on-first-use and buys
#                          nothing).
#   EXARCHOS_TRUST_ROOT_KEY_ID
#                          Key id that must appear in the manifest signature
#                          (default: exarchos.release.v1).
#   GITHUB_PATH            Path to GitHub Actions \$GITHUB_PATH file; only
#                          honored when --github-actions is set.
#
# EXIT STATUS
#   0   Success (install, dry-run, or --help)
#   1   Generic failure (missing deps, download error, checksum mismatch,
#       signed-manifest rejection, …)

set -eu

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
readonly EXARCHOS_REPO="lvlup-sw/exarchos"
readonly GITHUB_RELEASES_BASE="https://github.com/${EXARCHOS_REPO}/releases"
readonly GITHUB_API_LATEST="https://api.github.com/repos/${EXARCHOS_REPO}/releases/latest"
readonly MARKER_BEGIN="# >>> exarchos >>>"
readonly MARKER_END="# <<< exarchos <<<"

# The signed release manifest published alongside the binaries. Exported as
# RELEASE_MANIFEST_FILENAME from tools/release/build-release-manifest.ts — this is a
# WIRE CONTRACT with the publishing workflow.
readonly RELEASE_MANIFEST_FILENAME="exarchos-release-manifest.json"

# The build-identity banner marker stamped into every artifact by
# tools/release/build-binary.ts. v2 carries `sourceState`; a v1 artifact predates it
# and is therefore UNTRUSTWORTHY rather than "assumed clean" — an omitted field
# must never be able to downgrade a check.
readonly BUILD_IDENTITY_MARKER="exarchos-build-identity/v2"

# ------------------------------------------------------------------
# PINNED PUBLISHER TRUST ROOT
# ------------------------------------------------------------------
# The Ed25519 PUBLIC key the release manifest's signature must chain to.
#
# It is pinned HERE, in the installer, and deliberately NOT published as a
# release asset: shipping a verifying key next to the signature it verifies is
# trust-on-first-use and buys nothing — whoever can replace the signature can
# replace the key. Pinning is what makes the `manifest-signature` dimension
# mean anything at all.
#
# Until the publisher key is pinned below, this installer FAILS CLOSED: it
# refuses to install rather than silently skipping signature verification.
# Replacing the sentinel is a release-engineering step (see
# `EXARCHOS_RELEASE_SIGNING_KEY` in .github/workflows/release.yml — pin the
# SPKI PEM of its public half).
readonly PINNED_TRUST_ROOT_KEY_ID="exarchos.release.v1"
PINNED_TRUST_ROOT_PEM="__EXARCHOS_PUBLISHER_TRUST_ROOT_PEM_UNPINNED__"


# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------
log()   { printf '[exarchos] %s\n' "$*"; }
warn()  { printf '[exarchos] WARN: %s\n' "$*" >&2; }
err()   { printf '[exarchos] ERROR: %s\n' "$*" >&2; }
die()   { err "$*"; exit 1; }

# ------------------------------------------------------------------
# Release manifest verification (P05-01 / DR-20)
# ------------------------------------------------------------------
# The fail-closed gate that runs on the REAL install path (see
# `verify_release_or_die`, called from the download block below) before any
# byte reaches the install location.
#
# Six independently fatal checks, in this order:
#
#   1. build identity present    — the artifact must carry a v2
#                                  `exarchos-build-identity` banner. Absent, or
#                                  a v1 banner, is a rejection: a missing field
#                                  must never downgrade a later check.
#   2/3/4/5. signature, source,  — delegated in ONE fail-closed pass to the
#      contract, asset digest      shipped verifier (`dist/release-verify.js`,
#                                  the tested `runReleaseVerify` core). POSIX
#                                  shells have no portable Ed25519 primitive,
#                                  so the whole verdict is delegated rather
#                                  than crypto being re-implemented here. The
#                                  `--expect-source` / `--expect-contract`
#                                  values come from the ARTIFACT's own embedded
#                                  identity, so this is a cross-check between
#                                  two independent objects (signed manifest vs.
#                                  downloaded bytes), not a self-comparison.
#   6. release binding           — the artifact's embedded version must equal
#                                  the release tag being installed, so a
#                                  validly-signed OLDER release cannot be
#                                  served in place of the requested one.
#   7. source state              — checked LAST, and only once the asset-digest
#                                  check has authenticated the bytes: a
#                                  `modified` artifact was compiled from a
#                                  working tree that did not match the commit
#                                  the manifest vouches for.
#
# `asset_sha256` is exposed as a native, unit-testable primitive (it matches
# release-manifest.ts `digestAssetBytes`).

# asset_sha256 <file> → prints "sha256:<lowerhex>" over the RAW bytes.
# Mirrors the installer's SHA-512 sidecar tooling detection but uses SHA-256
# to match the manifest's `sha256:` asset digests. Returns non-zero if no
# sha256 tool is available (fail closed — the caller must treat it as fatal).
asset_sha256() {
    _asset_file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        _asset_hash="$(sha256sum "$_asset_file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        _asset_hash="$(shasum -a 256 "$_asset_file" | awk '{print $1}')"
    else
        err "no sha256 tool found on PATH — cannot digest release asset"
        return 1
    fi
    printf 'sha256:%s\n' "$_asset_hash"
}

# build_identity_window <artifact> → prints the banner text, or nothing.
#
# `tr -c '[:print:]' '\n'` splits the artifact's byte stream into printable
# runs, so a 100MB single-"line" binary never has to be held as one grep line
# and the (entirely printable) banner survives intact on a line of its own.
# The match is a FIXED string including the v2 marker, so a v1 banner simply
# does not match and the caller rejects.
build_identity_window() {
    LC_ALL=C tr -c '[:print:]' '\n' < "$1" 2>/dev/null \
        | LC_ALL=C grep -a -m1 -F "globalThis.__EXARCHOS_BUILD_IDENTITY__={\"marker\":\"${BUILD_IDENTITY_MARKER}\"" \
        || true
}

# identity_field <window> <key> → prints the string value of a top-level field.
identity_field() {
    printf '%s' "$1" \
        | LC_ALL=C grep -o -E "\"$2\":\"[^\"]*\"" \
        | head -n 1 \
        | sed -E 's/^"[^"]*":"(.*)"$/\1/'
}

# identity_contract_digest <window> → prints `contract.digest`.
# Anchored on `"contract":{"digest":` so it cannot be satisfied by the
# unrelated `treeDigest` field.
identity_contract_digest() {
    printf '%s' "$1" \
        | LC_ALL=C grep -o -E '"contract":\{"digest":"[^"]*"' \
        | head -n 1 \
        | sed -E 's/.*"digest":"([^"]*)"/\1/'
}

# resolve_release_verifier → prints a path to the shipped verifier, or fails.
# Discovery order: explicit override, the package's own dist/ (repo checkout or
# an npm-installed @lvlup-sw/exarchos), then the `exarchos-release-verify` bin
# that package.json exposes. NEVER downloaded from the release being verified —
# fetching your verifier from the origin you are verifying is not verification.
resolve_release_verifier() {
    if [ -n "${EXARCHOS_RELEASE_VERIFIER:-}" ]; then
        [ -f "$EXARCHOS_RELEASE_VERIFIER" ] || return 1
        printf '%s\n' "$EXARCHOS_RELEASE_VERIFIER"
        return 0
    fi
    _script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || _script_dir=""
    if [ -n "$_script_dir" ] && [ -f "${_script_dir}/../../dist/release-verify.js" ]; then
        printf '%s\n' "${_script_dir}/../../dist/release-verify.js"
        return 0
    fi
    if command -v exarchos-release-verify >/dev/null 2>&1; then
        command -v exarchos-release-verify
        return 0
    fi
    return 1
}

# resolve_trust_root_pem <workdir> → prints a path to the publisher PUBLIC key.
# Fails (non-zero) when no key is pinned and none was supplied — an
# unverifiable manifest is refused, never waved through.
resolve_trust_root_pem() {
    if [ -n "${EXARCHOS_TRUST_ROOT_PEM_FILE:-}" ]; then
        if [ ! -f "$EXARCHOS_TRUST_ROOT_PEM_FILE" ]; then
            err "EXARCHOS_TRUST_ROOT_PEM_FILE does not exist: $EXARCHOS_TRUST_ROOT_PEM_FILE"
            return 1
        fi
        printf '%s\n' "$EXARCHOS_TRUST_ROOT_PEM_FILE"
        return 0
    fi
    case "$PINNED_TRUST_ROOT_PEM" in
        *"BEGIN PUBLIC KEY"*) ;;
        *)
            err "no publisher trust root is pinned in this installer"
            err "hint: the release manifest signature cannot be verified without it — refusing to install"
            err "hint: supply the publisher public key via EXARCHOS_TRUST_ROOT_PEM_FILE=<path to spki .pem>"
            return 1
            ;;
    esac
    _pem_path="${1}/pinned-trust-root.pem"
    printf '%s\n' "$PINNED_TRUST_ROOT_PEM" > "$_pem_path"
    printf '%s\n' "$_pem_path"
}

# run_release_verifier <verifier> <manifest> <keyId> <pubkey.pem> \
#                      <commit#treeDigest> <contractDigest> <name> <asset>
# Delegates the four-way, fail-closed verdict to the shipped verifier and
# returns its exit code (0 = verified). `.js` is run under node; anything else
# is executed directly (the npm bin shim).
run_release_verifier() {
    _verifier="$1"; _manifest="$2"; _key_id="$3"; _pubkey="$4"
    _expect_source="$5"; _expect_contract="$6"; _asset_name="$7"; _asset_path="$8"
    case "$_verifier" in
        *.js)
            if ! command -v node >/dev/null 2>&1; then
                err "the release verifier needs node on PATH — refusing to install (fail-closed)"
                return 1
            fi
            set -- node "$_verifier"
            ;;
        *) set -- "$_verifier" ;;
    esac
    "$@" \
        --manifest "$_manifest" \
        --trust-root "${_key_id}=${_pubkey}" \
        --expect-source "$_expect_source" \
        --expect-contract "$_expect_contract" \
        --asset "${_asset_name}=${_asset_path}"
}

# Back-compat alias for the previous helper name (unit-tested by
# get-exarchos.test.sh via EXARCHOS_LIB_ONLY).
verify_release_manifest() {
    run_release_verifier "$@"
}

# verify_release_or_die <workdir> <artifact> <manifest> <asset-name> <tag>
# The complete gate. Any failure exits non-zero BEFORE anything is written to
# the install location.
verify_release_or_die() {
    _vr_work="$1"; _vr_bin="$2"; _vr_manifest="$3"; _vr_asset="$4"; _vr_tag="$5"

    if [ ! -f "$_vr_manifest" ]; then
        die "release REJECTED [manifest-missing]: no signed ${RELEASE_MANIFEST_FILENAME} was published for ${_vr_tag} — refusing to install an unverifiable release"
    fi

    _vr_verifier="$(resolve_release_verifier)" || die "release REJECTED [verifier-unavailable]: could not locate the release verifier (dist/release-verify.js or the exarchos-release-verify bin); set EXARCHOS_RELEASE_VERIFIER — refusing to install (fail-closed)"
    _vr_pem="$(resolve_trust_root_pem "$_vr_work")" || die "release REJECTED [trust-root-unavailable]: no publisher trust root to verify the manifest signature against"
    _vr_key_id="${EXARCHOS_TRUST_ROOT_KEY_ID:-$PINNED_TRUST_ROOT_KEY_ID}"

    # 1. Build identity — present, and stamped by the current (v2) format.
    _vr_window="$(build_identity_window "$_vr_bin")"
    if [ -z "$_vr_window" ]; then
        die "release REJECTED [build-identity]: ${_vr_asset} carries no '${BUILD_IDENTITY_MARKER}' build identity — its source and contract provenance cannot be established"
    fi
    _vr_commit="$(identity_field "$_vr_window" commit)"
    _vr_tree="$(identity_field "$_vr_window" treeDigest)"
    _vr_state="$(identity_field "$_vr_window" sourceState)"
    _vr_version="$(identity_field "$_vr_window" version)"
    _vr_contract="$(identity_contract_digest "$_vr_window")"
    if [ -z "$_vr_commit" ] || [ -z "$_vr_tree" ] || [ -z "$_vr_state" ] || \
       [ -z "$_vr_version" ] || [ -z "$_vr_contract" ]; then
        die "release REJECTED [build-identity]: ${_vr_asset} has an incomplete build identity"
    fi

    # 2-5. Signature + source + contract + asset digest, one fail-closed pass.
    if ! run_release_verifier "$_vr_verifier" "$_vr_manifest" "$_vr_key_id" "$_vr_pem" \
            "${_vr_commit}#${_vr_tree}" "$_vr_contract" "$_vr_asset" "$_vr_bin"; then
        die "refusing to install ${_vr_asset}: the signed release manifest did not verify"
    fi

    # 6. Release binding — a validly-signed OLDER release is still the wrong one.
    _vr_expected_version="${_vr_tag#v}"
    if [ "$_vr_version" != "$_vr_expected_version" ]; then
        die "release REJECTED [release-binding]: ${_vr_asset} declares version '${_vr_version}' but release '${_vr_tag}' was requested"
    fi

    # 7. Source state — meaningful only now that the bytes are authenticated.
    if [ "$_vr_state" != "clean" ]; then
        if [ "${ALLOW_MODIFIED_SOURCE:-0}" -ne 1 ]; then
            die "release REJECTED [source-state]: ${_vr_asset} was built from a MODIFIED working tree (sourceState=${_vr_state}); the manifest's source digest cannot vouch for these bytes. Re-run with --allow-modified-source to accept it anyway."
        fi
        warn "artifact reports sourceState=${_vr_state} — accepted only because --allow-modified-source was given"
    fi

    log "release manifest verified — signature, source, contract, asset digest, release binding and source state all match"
}


# Library mode: when sourced with EXARCHOS_LIB_ONLY=1 (the shell-native test
# harness does this), stop here so the verification/asset primitives are
# available without running option parsing or the installer body. Mirrors the
# PowerShell counterpart's -LoadOnly sentinel.
if [ -n "${EXARCHOS_LIB_ONLY:-}" ]; then
    return 0 2>/dev/null || exit 0
fi

# ------------------------------------------------------------------
# Option parsing
# ------------------------------------------------------------------
DRY_RUN=0
VERSION=""
TIER="release"
GITHUB_ACTIONS_MODE=0
ALLOW_MODIFIED_SOURCE=0

print_help() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)        DRY_RUN=1; shift ;;
        --version)        VERSION="${2:-}"; shift 2 ;;
        --version=*)      VERSION="${1#--version=}"; shift ;;
        --tier)           TIER="${2:-release}"; shift 2 ;;
        --tier=*)         TIER="${1#--tier=}"; shift ;;
        --github-actions) GITHUB_ACTIONS_MODE=1; shift ;;
        --allow-modified-source) ALLOW_MODIFIED_SOURCE=1; shift ;;
        -h|--help)        print_help; exit 0 ;;
        *)                die "Unknown argument: $1 (use --help)" ;;
    esac
done

case "$TIER" in
    release) ;;
    staging|dev)
        warn "--tier $TIER is a stub in v2.9 — falling back to release tier"
        TIER="release"
        ;;
    *) die "Unknown --tier value: $TIER (expected release|staging|dev)" ;;
esac

# ------------------------------------------------------------------
# Dependency preflight
# ------------------------------------------------------------------
# require_cmd <cmd> <install-hint>
#   Exits with a clear, actionable error if <cmd> is not on PATH.
require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "required command not found: $1"
        if [ -n "${2:-}" ]; then
            err "hint: $2"
        fi
        exit 1
    fi
}

require_cmd uname "uname ships with every supported OS; check your PATH"
require_cmd curl  "install via: apt-get install curl | brew install curl | dnf install curl"

# sha512 tooling: prefer sha512sum (Linux coreutils), fall back to shasum (macOS perl).
# Set SHA512_CMD to a callable command string.
if command -v sha512sum >/dev/null 2>&1; then
    SHA512_CMD="sha512sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA512_CMD="shasum -a 512"
else
    err "no sha512 tool found on PATH"
    err "hint: install coreutils (Linux: apt-get install coreutils) or perl (macOS: /usr/bin/shasum ships with the OS)"
    exit 1
fi

# ------------------------------------------------------------------
# Platform detection
# ------------------------------------------------------------------
# detect_platform populates four globals so downstream code reads clean:
#   PLATFORM_OS    - "linux" or "darwin"
#   PLATFORM_ARCH  - "x64" or "arm64"
#   PLATFORM_LIBC  - "glibc" or "musl" (informational; we always fetch glibc in v2.9)
#   ASSET_NAME     - "exarchos-<os>-<arch>" used for the release asset filename
#
# Centralizing the detection here keeps the main control flow linear and
# makes the function trivially unit-testable by overriding `uname` on PATH.
detect_platform() {
    case "$(uname -s)" in
        Linux)  PLATFORM_OS="linux" ;;
        Darwin) PLATFORM_OS="darwin" ;;
        *)      die "unsupported OS: $(uname -s) (Linux and Darwin supported; Windows uses get-exarchos.ps1)" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)   PLATFORM_ARCH="x64" ;;
        arm64|aarch64)  PLATFORM_ARCH="arm64" ;;
        *)              die "unsupported arch: $(uname -m) (x86_64 and arm64 supported)" ;;
    esac

    # musl detection is informational only in v2.9 — we still download the
    # glibc build. True musl support is deferred.
    PLATFORM_LIBC="glibc"
    if command -v ldd >/dev/null 2>&1; then
        if ldd --version 2>&1 | grep -q musl; then
            PLATFORM_LIBC="musl"
            warn "musl libc detected — downloading glibc build (musl support deferred)"
        fi
    fi

    ASSET_NAME="exarchos-${PLATFORM_OS}-${PLATFORM_ARCH}"
}

detect_platform

# Back-compat / print-plan shorthands (avoid churn in the plan template)
OS="$PLATFORM_OS"
ARCH="$PLATFORM_ARCH"
LIBC="$PLATFORM_LIBC"

# ------------------------------------------------------------------
# Version resolution
# ------------------------------------------------------------------
resolve_latest_version() {
    # Hermetic override path — tests set this to avoid network.
    if [ -n "${EXARCHOS_LATEST_VERSION:-}" ]; then
        printf '%s\n' "$EXARCHOS_LATEST_VERSION"
        return 0
    fi
    # Ask the GitHub API. Parse out `"tag_name": "vX.Y.Z"` without jq.
    local body
    body="$(curl -fsSL "$GITHUB_API_LATEST")" \
        || die "failed to query GitHub releases API ($GITHUB_API_LATEST)"
    local tag
    tag="$(printf '%s\n' "$body" \
        | grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | head -n 1 \
        | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
    if [ -z "$tag" ]; then
        die "could not parse tag_name from GitHub releases API response"
    fi
    printf '%s\n' "$tag"
}

# Defer the GitHub API call so `--dry-run` stays offline. Without this,
# air-gapped hosts (or any environment with no GitHub egress) fail at
# `resolve_latest_version` even when the user just wants to print the
# install plan. We swap in `latest/download` placeholders for the URLs
# below; the real install path resolves the concrete tag downstream.
RESOLVED_VERSION=""
if [ -n "$VERSION" ]; then
    RESOLVED_VERSION="$VERSION"
elif [ "$DRY_RUN" -ne 1 ]; then
    RESOLVED_VERSION="$(resolve_latest_version)"
    VERSION="$RESOLVED_VERSION"
fi

# ------------------------------------------------------------------
# Install location
# ------------------------------------------------------------------
INSTALL_DIR="${EXARCHOS_INSTALL_DIR:-$HOME/.local/bin}"
RELEASE_BASE="${EXARCHOS_RELEASE_BASE_URL:-$GITHUB_RELEASES_BASE}"
if [ -n "$RESOLVED_VERSION" ]; then
    BINARY_URL="${RELEASE_BASE}/download/${RESOLVED_VERSION}/${ASSET_NAME}"
    MANIFEST_URL="${RELEASE_BASE}/download/${RESOLVED_VERSION}/${RELEASE_MANIFEST_FILENAME}"
else
    # Dry-run with no pinned version — print the latest/download alias so
    # the user can see the URL shape without paying for a network round-trip.
    BINARY_URL="${RELEASE_BASE}/latest/download/${ASSET_NAME}"
    MANIFEST_URL="${RELEASE_BASE}/latest/download/${RELEASE_MANIFEST_FILENAME}"
fi
CHECKSUM_URL="${BINARY_URL}.sha512"
BINARY_PATH="${INSTALL_DIR}/exarchos"

# ------------------------------------------------------------------
# Install plan (shared between dry-run and real run)
# ------------------------------------------------------------------
print_plan() {
    local display_version="${VERSION:-<latest>}"
    cat <<EOF
exarchos install plan
---------------------
  Platform:     ${OS}-${ARCH} (libc: ${LIBC})
  Version:      ${display_version}
  Tier:         ${TIER}
  Asset:        ${ASSET_NAME}
  Binary URL:   ${BINARY_URL}
  Checksum URL: ${CHECKSUM_URL}
  Manifest URL: ${MANIFEST_URL}
  Install dir:  ${INSTALL_DIR}
  Binary path:  ${BINARY_PATH}
  PATH update:  $(if [ "$GITHUB_ACTIONS_MODE" -eq 1 ]; then echo "GITHUB_PATH (\$GITHUB_PATH)"; else echo "user shell rc files (.bashrc, .zshrc, fish config)"; fi)
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
    print_plan
    log "dry-run complete — no changes made"
    exit 0
fi

# ------------------------------------------------------------------
# Download + checksum verify
# ------------------------------------------------------------------
log "downloading $ASSET_NAME $VERSION"
print_plan

TMP_WORK="$(mktemp -d)"
trap 'rm -rf "$TMP_WORK"' EXIT

TMP_BIN="${TMP_WORK}/${ASSET_NAME}"
TMP_SHA="${TMP_WORK}/${ASSET_NAME}.sha512"

if ! curl -fsSL -o "$TMP_BIN" "$BINARY_URL"; then
    err "failed to download binary from $BINARY_URL"
    err "hint: verify the release exists at ${GITHUB_RELEASES_BASE}/tag/${VERSION}"
    err "hint: check network access to github.com and any proxy configuration"
    exit 1
fi
if ! curl -fsSL -o "$TMP_SHA" "$CHECKSUM_URL"; then
    err "failed to download checksum sidecar from $CHECKSUM_URL"
    err "hint: a missing .sha512 sidecar usually means the release is incomplete — report upstream"
    exit 1
fi

# Compute actual hash and compare against sidecar (raw hex, first whitespace-separated token).
ACTUAL_SHA="$($SHA512_CMD "$TMP_BIN" | awk '{print $1}')"
EXPECTED_SHA="$(awk '{print $1}' < "$TMP_SHA")"

if [ -z "$EXPECTED_SHA" ]; then
    die "checksum sidecar was empty or unreadable: $CHECKSUM_URL"
fi

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    err "checksum verification FAILED for $ASSET_NAME"
    err "  expected sha512: $EXPECTED_SHA"
    err "  actual sha512:   $ACTUAL_SHA"
    die "refusing to install a binary that does not match its checksum"
fi
log "sha512 checksum verified"

# ------------------------------------------------------------------
# Signed release manifest verification (DR-20) — MANDATORY
# ------------------------------------------------------------------
# The sidecar above only proves the bytes survived transport: it is served
# from the same origin as the binary, so anyone who can replace one can
# replace the other. Everything that makes this release *this* release —
# publisher signature, source provenance, contract authority, asset identity
# and release binding — is established here, before anything is installed.
TMP_MANIFEST="${TMP_WORK}/${RELEASE_MANIFEST_FILENAME}"
if ! curl -fsSL -o "$TMP_MANIFEST" "$MANIFEST_URL"; then
    err "failed to download the signed release manifest from $MANIFEST_URL"
    err "hint: releases without ${RELEASE_MANIFEST_FILENAME} cannot be verified and are refused by design"
    exit 1
fi
verify_release_or_die "$TMP_WORK" "$TMP_BIN" "$TMP_MANIFEST" "$ASSET_NAME" "$VERSION"

# ------------------------------------------------------------------
# Install
# ------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
# Use `cp` then `chmod` rather than mv so we retain a clean copy semantics
# on filesystems that don't support atomic rename across mounts.
cp "$TMP_BIN" "$BINARY_PATH"
chmod +x "$BINARY_PATH"
log "installed to $BINARY_PATH"

# ------------------------------------------------------------------
# PATH configuration
# ------------------------------------------------------------------
append_marker_block() {
    # $1 = path to rc file (may not yet exist)
    # $2 = line to write between the markers
    local rc="$1"
    local line="$2"
    # Idempotence: skip if our marker already exists in the file
    if [ -f "$rc" ] && grep -Fq "$MARKER_BEGIN" "$rc"; then
        return 0
    fi
    mkdir -p "$(dirname "$rc")"
    {
        printf '\n%s\n' "$MARKER_BEGIN"
        printf '# Added by get-exarchos.sh — do not edit this block manually\n'
        printf '%s\n' "$line"
        printf '%s\n' "$MARKER_END"
    } >> "$rc"
}

configure_path_user_rc() {
    local bash_line="export PATH=\"$INSTALL_DIR:\$PATH\""
    local fish_line="set -gx PATH $INSTALL_DIR \$PATH"
    append_marker_block "$HOME/.bashrc"                   "$bash_line"
    append_marker_block "$HOME/.zshrc"                    "$bash_line"
    append_marker_block "$HOME/.config/fish/config.fish"  "$fish_line"
    log "updated shell rc files (.bashrc, .zshrc, fish config) — open a new shell or source them"
}

configure_path_github_actions() {
    local gh_path="${GITHUB_PATH:-}"
    if [ -z "$gh_path" ]; then
        die "--github-actions mode requires \$GITHUB_PATH to be set"
    fi
    printf '%s\n' "$INSTALL_DIR" >> "$gh_path"
    log "appended $INSTALL_DIR to \$GITHUB_PATH ($gh_path)"
}

if [ "$GITHUB_ACTIONS_MODE" -eq 1 ]; then
    configure_path_github_actions
else
    configure_path_user_rc
fi

log "done — run 'exarchos --version' in a new shell to verify"
log "next  — run 'exarchos onboard' to wire skills + config (or 'exarchos doctor' to check)"
