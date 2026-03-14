#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Verify jq is available
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed. Install with: sudo apt install jq (or brew install jq)" >&2
  exit 2
fi

# Defaults
PLUGIN_JSON="${REPO_ROOT}/.claude-plugin/plugin.json"
MANIFEST_JSON="${REPO_ROOT}/manifest.json"
PACKAGE_JSON="${REPO_ROOT}/package.json"
MCP_PACKAGE_JSON="${REPO_ROOT}/servers/exarchos-mcp/package.json"
CHECK_MODE=false

require_arg() {
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Error: $1 requires a value" >&2
    exit 2
  fi
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plugin-json) require_arg "$1" "${2:-}"; PLUGIN_JSON="$2"; shift 2 ;;
    --manifest-json) require_arg "$1" "${2:-}"; MANIFEST_JSON="$2"; shift 2 ;;
    --package-json) require_arg "$1" "${2:-}"; PACKAGE_JSON="$2"; shift 2 ;;
    --check)
      CHECK_MODE=true; shift ;;
    --help)
      echo "Usage: sync-versions.sh [--plugin-json <path>] [--manifest-json <path>] [--package-json <path>] [--check]"
      echo ""
      echo "Syncs version from package.json to plugin.json, manifest.json, and exarchos-mcp/package.json."
      echo "  --check    Exit 1 if versions are out of sync (no modifications)"
      exit 0 ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      exit 2 ;;
  esac
done

VERSION=$(node -e "console.log(require(process.argv[1]).version)" "${PACKAGE_JSON}")

if [[ "$CHECK_MODE" == "true" ]]; then
  PLUGIN_VER=$(jq -r '.version' "$PLUGIN_JSON")
  MANIFEST_VER=$(jq -r '.version' "$MANIFEST_JSON")

  ERRORS=0
  if [[ "$PLUGIN_VER" != "$VERSION" ]]; then
    echo "MISMATCH: plugin.json version=$PLUGIN_VER, expected=$VERSION" >&2
    ((ERRORS++)) || true
  fi
  if [[ "$MANIFEST_VER" != "$VERSION" ]]; then
    echo "MISMATCH: manifest.json version=$MANIFEST_VER, expected=$VERSION" >&2
    ((ERRORS++)) || true
  fi
  if [[ -f "$MCP_PACKAGE_JSON" ]]; then
    MCP_VER=$(jq -r '.version' "$MCP_PACKAGE_JSON")
    if [[ "$MCP_VER" != "$VERSION" ]]; then
      echo "MISMATCH: servers/exarchos-mcp/package.json version=$MCP_VER, expected=$VERSION" >&2
      ((ERRORS++)) || true
    fi
  fi

  if [[ $ERRORS -gt 0 ]]; then
    exit 1
  fi
  echo "All versions in sync: $VERSION"
  exit 0
fi

# Update plugin.json
jq --arg v "$VERSION" '.version = $v' "$PLUGIN_JSON" > "${PLUGIN_JSON}.tmp"
mv "${PLUGIN_JSON}.tmp" "$PLUGIN_JSON"

# Update manifest.json
jq --arg v "$VERSION" '.version = $v' "$MANIFEST_JSON" > "${MANIFEST_JSON}.tmp"
mv "${MANIFEST_JSON}.tmp" "$MANIFEST_JSON"

# Update servers/exarchos-mcp/package.json
if [[ -f "$MCP_PACKAGE_JSON" ]]; then
  jq --arg v "$VERSION" '.version = $v' "$MCP_PACKAGE_JSON" > "${MCP_PACKAGE_JSON}.tmp"
  mv "${MCP_PACKAGE_JSON}.tmp" "$MCP_PACKAGE_JSON"
fi

echo "Synced version ${VERSION} to plugin.json, manifest.json, and exarchos-mcp/package.json"
