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
#   bash scripts/get-exarchos.sh [options]
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
#   -h | --help            Show this help text.
#
# ENVIRONMENT
#   EXARCHOS_INSTALL_DIR   Override install location (default: \$HOME/.local/bin).
#   EXARCHOS_LATEST_VERSION
#                          Hermetic override for the "latest version" lookup
#                          (skips the GitHub API call). Primarily used by
#                          tests; also useful in air-gapped environments.
#   GITHUB_PATH            Path to GitHub Actions \$GITHUB_PATH file; only
#                          honored when --github-actions is set.
#
# EXIT STATUS
#   0   Success (install, dry-run, or --help)
#   1   Generic failure (missing deps, download error, checksum mismatch, …)

set -eu

# ------------------------------------------------------------------
# Constants
# ------------------------------------------------------------------
readonly EXARCHOS_REPO="lvlup-sw/exarchos"
readonly GITHUB_RELEASES_BASE="https://github.com/${EXARCHOS_REPO}/releases"
readonly GITHUB_API_LATEST="https://api.github.com/repos/${EXARCHOS_REPO}/releases/latest"
readonly MARKER_BEGIN="# >>> exarchos >>>"
readonly MARKER_END="# <<< exarchos <<<"

# ------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------
log()   { printf '[exarchos] %s\n' "$*"; }
warn()  { printf '[exarchos] WARN: %s\n' "$*" >&2; }
err()   { printf '[exarchos] ERROR: %s\n' "$*" >&2; }
die()   { err "$*"; exit 1; }

# ------------------------------------------------------------------
# Option parsing
# ------------------------------------------------------------------
DRY_RUN=0
VERSION=""
TIER="release"
GITHUB_ACTIONS_MODE=0

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
if [ -n "$RESOLVED_VERSION" ]; then
    BINARY_URL="${GITHUB_RELEASES_BASE}/download/${RESOLVED_VERSION}/${ASSET_NAME}"
else
    # Dry-run with no pinned version — print the latest/download alias so
    # the user can see the URL shape without paying for a network round-trip.
    BINARY_URL="${GITHUB_RELEASES_BASE}/latest/download/${ASSET_NAME}"
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
