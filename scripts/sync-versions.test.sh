#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-versions.sh"

# ─── Helpers ─────────────────────────────────────────────────────────────────

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# Read version from package.json
PKG_VERSION=$(node -p "require('${REPO_ROOT}/package.json').version")

# Create temp dir for working copies
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Copy all manifests to temp dir
cp "$REPO_ROOT/.claude-plugin/plugin.json" "$TMPDIR/plugin.json"
cp "$REPO_ROOT/.claude-plugin/marketplace.json" "$TMPDIR/marketplace.json"
cp "$REPO_ROOT/manifest.json" "$TMPDIR/manifest.json"

SYNC_ARGS=(--plugin-json "$TMPDIR/plugin.json" --marketplace-json "$TMPDIR/marketplace.json" --manifest-json "$TMPDIR/manifest.json" --package-json "$REPO_ROOT/package.json")

# ─── Test 1: SyncVersions_UpdatesPluginJson ──────────────────────────────────

echo "Test 1: SyncVersions_UpdatesPluginJson"

# Set plugin.json to wrong version
jq '.version = "0.0.0"' "$TMPDIR/plugin.json" > "$TMPDIR/plugin.json.tmp"
mv "$TMPDIR/plugin.json.tmp" "$TMPDIR/plugin.json"

# Run sync script
bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}"

RESULT=$(jq -r '.version' "$TMPDIR/plugin.json")
if [[ "$RESULT" == "$PKG_VERSION" ]]; then
  pass "plugin.json version updated to $PKG_VERSION"
else
  fail "plugin.json version is $RESULT, expected $PKG_VERSION"
fi

# ─── Test 2: SyncVersions_UpdatesMarketplaceJson ─────────────────────────────

echo "Test 2: SyncVersions_UpdatesMarketplaceJson"

# Reset marketplace.json with wrong versions
jq '.plugins[0].version = "0.0.0" | .plugins[0].source.version = "0.0.0"' \
  "$REPO_ROOT/.claude-plugin/marketplace.json" > "$TMPDIR/marketplace.json"

bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}"

PLUGIN_VER=$(jq -r '.plugins[0].version' "$TMPDIR/marketplace.json")
SOURCE_VER=$(jq -r '.plugins[0].source.version' "$TMPDIR/marketplace.json")

if [[ "$PLUGIN_VER" == "$PKG_VERSION" && "$SOURCE_VER" == "$PKG_VERSION" ]]; then
  pass "marketplace.json both version fields updated to $PKG_VERSION"
else
  fail "marketplace versions: plugin=$PLUGIN_VER source=$SOURCE_VER, expected $PKG_VERSION"
fi

# ─── Test 3: SyncVersions_UpdatesManifestJson ────────────────────────────────

echo "Test 3: SyncVersions_UpdatesManifestJson"

# Reset manifest.json with wrong version
jq '.version = "0.0.0"' "$REPO_ROOT/manifest.json" > "$TMPDIR/manifest.json"

bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}"

MANIFEST_VER=$(jq -r '.version' "$TMPDIR/manifest.json")
if [[ "$MANIFEST_VER" == "$PKG_VERSION" ]]; then
  pass "manifest.json version updated to $PKG_VERSION"
else
  fail "manifest.json version is $MANIFEST_VER, expected $PKG_VERSION"
fi

# ─── Test 4: SyncVersions_Idempotent ──────────────────────────────────────────

echo "Test 4: SyncVersions_Idempotent"

# Run sync twice
bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}"
FIRST_PLUGIN=$(cat "$TMPDIR/plugin.json")
FIRST_MARKETPLACE=$(cat "$TMPDIR/marketplace.json")
FIRST_MANIFEST=$(cat "$TMPDIR/manifest.json")

bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}"
SECOND_PLUGIN=$(cat "$TMPDIR/plugin.json")
SECOND_MARKETPLACE=$(cat "$TMPDIR/marketplace.json")
SECOND_MANIFEST=$(cat "$TMPDIR/manifest.json")

if [[ "$FIRST_PLUGIN" == "$SECOND_PLUGIN" && "$FIRST_MARKETPLACE" == "$SECOND_MARKETPLACE" && "$FIRST_MANIFEST" == "$SECOND_MANIFEST" ]]; then
  pass "Running sync twice produces identical output"
else
  fail "Running sync twice produces different output"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
