#!/usr/bin/env bash
# sync-versions.sh — propagate `package.json` version to every derived call
# site. `package.json` is the single source of truth (DIM-1: topology); every
# other site is a mechanical projection of it.
#
# Sinks:
#   JSON:
#     .claude-plugin/plugin.json   .version
#                                  .metadata.compat.minBinaryVersion
#     manifest.json                .version
#     servers/exarchos-mcp/        .version
#       package.json
#
#   TypeScript string literals (under <mcp-src-dir>/):
#     index.ts                          export const SERVER_VERSION = '…'
#     adapters/mcp.ts                   const SERVER_VERSION = '…'
#     adapters/cli.ts                   .version('…')   AND   binaryVersion: '…'
#     cli-commands/session-start.ts     const SESSION_START_BINARY_VERSION = '…'
#
# Modes:
#   default            patch every sink
#   --check            verify every sink matches; exit 1 on any drift
#
# Exit codes:
#   0   success (--check pass, or write completed)
#   1   drift detected in --check mode, or a write step failed
#   2   usage / missing-dependency error
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed. Install with: sudo apt install jq (or brew install jq)" >&2
  exit 2
fi

# ─── Defaults ───────────────────────────────────────────────────────────────

PLUGIN_JSON="${REPO_ROOT}/.claude-plugin/plugin.json"
MANIFEST_JSON="${REPO_ROOT}/manifest.json"
PACKAGE_JSON="${REPO_ROOT}/package.json"
MCP_PACKAGE_JSON="${REPO_ROOT}/servers/exarchos-mcp/package.json"
MCP_SRC_DIR="${REPO_ROOT}/servers/exarchos-mcp/src"
CHECK_MODE=false

require_arg() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Error: $1 requires a value" >&2
    exit 2
  fi
}

# ─── Args ───────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin-json)   require_arg "$1" "${2:-}"; PLUGIN_JSON="$2"; shift 2 ;;
    --manifest-json) require_arg "$1" "${2:-}"; MANIFEST_JSON="$2"; shift 2 ;;
    --package-json)  require_arg "$1" "${2:-}"; PACKAGE_JSON="$2"; shift 2 ;;
    --mcp-package)   require_arg "$1" "${2:-}"; MCP_PACKAGE_JSON="$2"; shift 2 ;;
    --mcp-src-dir)   require_arg "$1" "${2:-}"; MCP_SRC_DIR="$2"; shift 2 ;;
    --check) CHECK_MODE=true; shift ;;
    --help)
      cat <<HELP
Usage: sync-versions.sh [options] [--check]

Propagates the version from package.json (single source of truth) to every
derived call site (manifest JSONs + TypeScript string literals).

Options:
  --plugin-json    PATH    Override .claude-plugin/plugin.json
  --manifest-json  PATH    Override manifest.json
  --package-json   PATH    Override the source-of-truth package.json
  --mcp-package    PATH    Override servers/exarchos-mcp/package.json
  --mcp-src-dir    DIR     Override servers/exarchos-mcp/src/ (TS sinks resolve here)
  --check                  Verify all sinks; exit 1 on drift, do not modify.
  --help                   Show this message.

Exit codes:
  0  success    1  drift / write failure    2  usage / missing dependency
HELP
      exit 0 ;;
    *) echo "Error: Unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# Resolved TS-sink paths. Defined once so check-mode and write-mode share the
# same definition (DIM-1: no divergent paths).
INDEX_TS="${MCP_SRC_DIR}/index.ts"
MCP_TS="${MCP_SRC_DIR}/adapters/mcp.ts"
CLI_TS="${MCP_SRC_DIR}/adapters/cli.ts"
SESSION_START_TS="${MCP_SRC_DIR}/cli-commands/session-start.ts"

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "${PACKAGE_JSON}")

# ─── TS substitution helpers ────────────────────────────────────────────────

# read_quoted_after FILE PREFIX_ERE
#
# Read the first single-quoted string literal anchored after PREFIX_ERE in
# FILE. Prints the captured value on stdout; returns 1 (no print) if the
# prefix is absent. PREFIX_ERE is matched by grep / sed in ERE mode.
read_quoted_after() {
  local file="$1"
  local prefix_re="$2"
  local match
  match=$(grep -E -o "${prefix_re}'[^']*'" "$file" 2>/dev/null | head -1)
  if [[ -z "$match" ]]; then
    return 1
  fi
  printf '%s\n' "$match" | sed -E "s/^.*'([^']*)'.*/\1/"
}

# patch_quoted_after FILE PREFIX_ERE NEW_VERSION LABEL
#
# Replace every single-quoted string literal anchored after PREFIX_ERE in
# FILE with NEW_VERSION. Atomic via tempfile + mv. Refuses to write if the
# prefix doesn't match a line — silent no-ops on a structural change would
# leave a stale version in the binary, so we fail loud (DIM-2: observability).
patch_quoted_after() {
  local file="$1"
  local prefix_re="$2"
  local new_version="$3"
  local label="$4"

  if [[ ! -f "$file" ]]; then
    echo "Error: ${label}: file not found at ${file}" >&2
    return 1
  fi
  if ! grep -E -q "${prefix_re}'[^']*'" "$file"; then
    echo "Error: ${label}: pattern not found in ${file} (regex: ${prefix_re}'…')" >&2
    return 1
  fi
  sed -E "s/(${prefix_re})'[^']*'/\1'${new_version}'/g" "$file" > "${file}.tmp"
  mv "${file}.tmp" "$file"
}

# TS-sink registry. Pipe-separated tuples: file|prefix-regex|label. Both
# check_ts_sites and write_ts_sites iterate this list so a new sink is added
# in exactly one place (DIM-5: hygiene — no divergent registries).
ts_sites() {
  cat <<SITES
${INDEX_TS}|^export const SERVER_VERSION = |src/index.ts SERVER_VERSION
${MCP_TS}|^const SERVER_VERSION = |adapters/mcp.ts SERVER_VERSION
${CLI_TS}|\\.version\\(|adapters/cli.ts .version()
${CLI_TS}|binaryVersion: |adapters/cli.ts binaryVersion
${SESSION_START_TS}|^const SESSION_START_BINARY_VERSION = |cli-commands/session-start.ts SESSION_START_BINARY_VERSION
SITES
}

write_ts_sites() {
  while IFS='|' read -r file prefix label; do
    [[ -z "$file" ]] && continue
    patch_quoted_after "$file" "$prefix" "$VERSION" "$label"
  done < <(ts_sites)
}

# Prints the number of mismatches discovered. Each mismatch is also written
# to stderr in the same MISMATCH:/MISSING: format the JSON checks use.
check_ts_sites() {
  local errors=0
  local file prefix label found
  while IFS='|' read -r file prefix label; do
    [[ -z "$file" ]] && continue
    if [[ ! -f "$file" ]]; then
      echo "MISSING: ${label} file not found at ${file}" >&2
      errors=$((errors + 1))
      continue
    fi
    if ! found=$(read_quoted_after "$file" "$prefix"); then
      echo "MISMATCH: ${label} pattern not found in ${file} (regex: ${prefix}'…')" >&2
      errors=$((errors + 1))
      continue
    fi
    if [[ "$found" != "$VERSION" ]]; then
      echo "MISMATCH: ${label} version=${found}, expected=${VERSION}" >&2
      errors=$((errors + 1))
    fi
  done < <(ts_sites)
  printf '%d\n' "$errors"
}

# ─── Check mode ─────────────────────────────────────────────────────────────

if [[ "$CHECK_MODE" == "true" ]]; then
  ERRORS=0

  PLUGIN_VER=$(jq -r '.version' "$PLUGIN_JSON")
  PLUGIN_MIN_VER=$(jq -r '.metadata.compat.minBinaryVersion // empty' "$PLUGIN_JSON")
  MANIFEST_VER=$(jq -r '.version' "$MANIFEST_JSON")

  if [[ "$PLUGIN_VER" != "$VERSION" ]]; then
    echo "MISMATCH: plugin.json .version=${PLUGIN_VER}, expected=${VERSION}" >&2
    ERRORS=$((ERRORS + 1))
  fi
  # The minBinaryVersion field is optional — only check it if it exists, so
  # plugin manifests that omit it (no compat declaration) don't trip a false
  # drift report.
  if [[ -n "$PLUGIN_MIN_VER" && "$PLUGIN_MIN_VER" != "$VERSION" ]]; then
    echo "MISMATCH: plugin.json .metadata.compat.minBinaryVersion=${PLUGIN_MIN_VER}, expected=${VERSION}" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [[ "$MANIFEST_VER" != "$VERSION" ]]; then
    echo "MISMATCH: manifest.json version=${MANIFEST_VER}, expected=${VERSION}" >&2
    ERRORS=$((ERRORS + 1))
  fi
  if [[ -f "$MCP_PACKAGE_JSON" ]]; then
    MCP_VER=$(jq -r '.version' "$MCP_PACKAGE_JSON")
    if [[ "$MCP_VER" != "$VERSION" ]]; then
      echo "MISMATCH: servers/exarchos-mcp/package.json version=${MCP_VER}, expected=${VERSION}" >&2
      ERRORS=$((ERRORS + 1))
    fi
  fi

  TS_ERR=$(check_ts_sites)
  ERRORS=$((ERRORS + TS_ERR))

  if [[ $ERRORS -gt 0 ]]; then
    echo "Version check failed: ${ERRORS} mismatch(es)" >&2
    exit 1
  fi
  echo "All versions in sync: ${VERSION}"
  exit 0
fi

# ─── Write mode ─────────────────────────────────────────────────────────────

# plugin.json: update both .version and .metadata.compat.minBinaryVersion in a
# single jq pass so the file is never half-written. The minBinaryVersion arm
# is gated on the field already existing — we don't introduce it where the
# manifest didn't declare a compat block.
jq --arg v "$VERSION" '
  .version = $v
  | if (.metadata? // {}) | has("compat") and (.compat | has("minBinaryVersion"))
    then .metadata.compat.minBinaryVersion = $v
    else .
    end
' "$PLUGIN_JSON" > "${PLUGIN_JSON}.tmp"
mv "${PLUGIN_JSON}.tmp" "$PLUGIN_JSON"

jq --arg v "$VERSION" '.version = $v' "$MANIFEST_JSON" > "${MANIFEST_JSON}.tmp"
mv "${MANIFEST_JSON}.tmp" "$MANIFEST_JSON"

if [[ -f "$MCP_PACKAGE_JSON" ]]; then
  jq --arg v "$VERSION" '.version = $v' "$MCP_PACKAGE_JSON" > "${MCP_PACKAGE_JSON}.tmp"
  mv "${MCP_PACKAGE_JSON}.tmp" "$MCP_PACKAGE_JSON"
fi

write_ts_sites

echo "Synced version ${VERSION} to:"
echo "  - ${PLUGIN_JSON#${REPO_ROOT}/} (.version, .metadata.compat.minBinaryVersion)"
echo "  - ${MANIFEST_JSON#${REPO_ROOT}/} (.version)"
echo "  - ${MCP_PACKAGE_JSON#${REPO_ROOT}/} (.version)"
echo "  - ${INDEX_TS#${REPO_ROOT}/} (SERVER_VERSION)"
echo "  - ${MCP_TS#${REPO_ROOT}/} (SERVER_VERSION)"
echo "  - ${CLI_TS#${REPO_ROOT}/} (.version() + binaryVersion)"
echo "  - ${SESSION_START_TS#${REPO_ROOT}/} (SESSION_START_BINARY_VERSION)"
