#!/usr/bin/env bash
# Tests for sync-versions.sh. Each test isolates its sinks by copying the real
# repo files into a temp directory and pointing the script at the copies via
# the override flags. The repo's own files are never mutated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/sync-versions.sh"

# ─── Helpers ─────────────────────────────────────────────────────────────────

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

PKG_VERSION=$(node -p "require('${REPO_ROOT}/package.json').version")

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Mirror the real `servers/exarchos-mcp/src/` shape under TMPDIR so the
# script's path resolution works unchanged.
TS_TMPDIR="$TMPDIR/mcp-src"
mkdir -p "$TS_TMPDIR/adapters" "$TS_TMPDIR/cli-commands"
cp "$REPO_ROOT/servers/exarchos-mcp/src/index.ts"                    "$TS_TMPDIR/index.ts"
cp "$REPO_ROOT/servers/exarchos-mcp/src/adapters/mcp.ts"             "$TS_TMPDIR/adapters/mcp.ts"
cp "$REPO_ROOT/servers/exarchos-mcp/src/adapters/cli.ts"             "$TS_TMPDIR/adapters/cli.ts"
cp "$REPO_ROOT/servers/exarchos-mcp/src/cli-commands/session-start.ts" "$TS_TMPDIR/cli-commands/session-start.ts"

# Mirror the JSON sinks too.
cp "$REPO_ROOT/.claude-plugin/plugin.json"                "$TMPDIR/plugin.json"
cp "$REPO_ROOT/manifest.json"                             "$TMPDIR/manifest.json"
cp "$REPO_ROOT/servers/exarchos-mcp/package.json"         "$TMPDIR/mcp-package.json"

SYNC_ARGS=(
  --plugin-json    "$TMPDIR/plugin.json"
  --manifest-json  "$TMPDIR/manifest.json"
  --mcp-package    "$TMPDIR/mcp-package.json"
  --mcp-src-dir    "$TS_TMPDIR"
  --package-json   "$REPO_ROOT/package.json"
)

# Read the first single-quoted literal that follows an ERE prefix in a file —
# mirrors the in-script helper so tests assert what the script actually reads.
read_quoted_after() {
  local file="$1"
  local prefix_re="$2"
  grep -E -o "${prefix_re}'[^']*'" "$file" | head -1 | sed -E "s/^.*'([^']*)'.*/\1/"
}

# Wipe every sink to a known-bad version so the next sync run has something
# to do. Returns the bad version so the caller can assert it shifted.
poison_all_sinks() {
  local bad="$1"

  jq --arg v "$bad" '.version = $v | .metadata.compat.minBinaryVersion = $v' \
    "$TMPDIR/plugin.json"  > "$TMPDIR/plugin.json.tmp"
  mv "$TMPDIR/plugin.json.tmp" "$TMPDIR/plugin.json"

  jq --arg v "$bad" '.version = $v' "$TMPDIR/manifest.json" > "$TMPDIR/manifest.json.tmp"
  mv "$TMPDIR/manifest.json.tmp" "$TMPDIR/manifest.json"

  jq --arg v "$bad" '.version = $v' "$TMPDIR/mcp-package.json" > "$TMPDIR/mcp-package.json.tmp"
  mv "$TMPDIR/mcp-package.json.tmp" "$TMPDIR/mcp-package.json"

  sed -E "s/(^export const SERVER_VERSION = )'[^']*'/\1'${bad}'/g" \
    "$TS_TMPDIR/index.ts" > "$TS_TMPDIR/index.ts.tmp"
  mv "$TS_TMPDIR/index.ts.tmp" "$TS_TMPDIR/index.ts"

  sed -E "s/(^const SERVER_VERSION = )'[^']*'/\1'${bad}'/g" \
    "$TS_TMPDIR/adapters/mcp.ts" > "$TS_TMPDIR/adapters/mcp.ts.tmp"
  mv "$TS_TMPDIR/adapters/mcp.ts.tmp" "$TS_TMPDIR/adapters/mcp.ts"

  sed -E "s/(\.version\()'[^']*'/\1'${bad}'/g" \
    "$TS_TMPDIR/adapters/cli.ts" > "$TS_TMPDIR/adapters/cli.ts.tmp"
  mv "$TS_TMPDIR/adapters/cli.ts.tmp" "$TS_TMPDIR/adapters/cli.ts"

  sed -E "s/(binaryVersion: )'[^']*'/\1'${bad}'/g" \
    "$TS_TMPDIR/adapters/cli.ts" > "$TS_TMPDIR/adapters/cli.ts.tmp"
  mv "$TS_TMPDIR/adapters/cli.ts.tmp" "$TS_TMPDIR/adapters/cli.ts"

  sed -E "s/(^const SESSION_START_BINARY_VERSION = )'[^']*'/\1'${bad}'/g" \
    "$TS_TMPDIR/cli-commands/session-start.ts" > "$TS_TMPDIR/cli-commands/session-start.ts.tmp"
  mv "$TS_TMPDIR/cli-commands/session-start.ts.tmp" "$TS_TMPDIR/cli-commands/session-start.ts"
}

# ─── Test 1: SyncVersions_UpdatesPluginJson ──────────────────────────────────

echo "Test 1: SyncVersions_UpdatesPluginJson_VersionAndMinBinaryVersion"

poison_all_sinks "0.0.0"
bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}" >/dev/null

PLUGIN_VER=$(jq -r '.version' "$TMPDIR/plugin.json")
PLUGIN_MIN=$(jq -r '.metadata.compat.minBinaryVersion' "$TMPDIR/plugin.json")
if [[ "$PLUGIN_VER" == "$PKG_VERSION" && "$PLUGIN_MIN" == "$PKG_VERSION" ]]; then
  pass "plugin.json .version + .metadata.compat.minBinaryVersion → $PKG_VERSION"
else
  fail "plugin.json: version=$PLUGIN_VER, minBinaryVersion=$PLUGIN_MIN, expected=$PKG_VERSION"
fi

# ─── Test 2: SyncVersions_UpdatesManifestJson ────────────────────────────────

echo "Test 2: SyncVersions_UpdatesManifestJson"

MANIFEST_VER=$(jq -r '.version' "$TMPDIR/manifest.json")
if [[ "$MANIFEST_VER" == "$PKG_VERSION" ]]; then
  pass "manifest.json version → $PKG_VERSION"
else
  fail "manifest.json version=$MANIFEST_VER, expected=$PKG_VERSION"
fi

# ─── Test 3: SyncVersions_UpdatesMcpPackageJson ──────────────────────────────

echo "Test 3: SyncVersions_UpdatesMcpPackageJson"

MCP_VER=$(jq -r '.version' "$TMPDIR/mcp-package.json")
if [[ "$MCP_VER" == "$PKG_VERSION" ]]; then
  pass "servers/exarchos-mcp/package.json version → $PKG_VERSION"
else
  fail "mcp-package.json version=$MCP_VER, expected=$PKG_VERSION"
fi

# ─── Test 4: SyncVersions_UpdatesIndexTs_ServerVersion ──────────────────────

echo "Test 4: SyncVersions_UpdatesIndexTs_ServerVersion"

INDEX_VER=$(read_quoted_after "$TS_TMPDIR/index.ts" '^export const SERVER_VERSION = ')
if [[ "$INDEX_VER" == "$PKG_VERSION" ]]; then
  pass "index.ts SERVER_VERSION → $PKG_VERSION"
else
  fail "index.ts SERVER_VERSION=$INDEX_VER, expected=$PKG_VERSION"
fi

# ─── Test 5: SyncVersions_UpdatesAdapterMcpTs_ServerVersion ─────────────────

echo "Test 5: SyncVersions_UpdatesAdapterMcpTs_ServerVersion"

MCP_TS_VER=$(read_quoted_after "$TS_TMPDIR/adapters/mcp.ts" '^const SERVER_VERSION = ')
if [[ "$MCP_TS_VER" == "$PKG_VERSION" ]]; then
  pass "adapters/mcp.ts SERVER_VERSION → $PKG_VERSION"
else
  fail "adapters/mcp.ts SERVER_VERSION=$MCP_TS_VER, expected=$PKG_VERSION"
fi

# ─── Test 6: SyncVersions_UpdatesAdapterCliTs_BothCallSites ─────────────────

echo "Test 6: SyncVersions_UpdatesAdapterCliTs_BothCallSites"

# .version() appears at the commander setup AND in inline doc text — the
# substitution must touch BOTH so commentary stays correct (DIM-5: hygiene).
CLI_VERSION_HITS=$(grep -E -c "\\.version\\('${PKG_VERSION}'\\)" "$TS_TMPDIR/adapters/cli.ts" || true)
CLI_BINVER=$(read_quoted_after "$TS_TMPDIR/adapters/cli.ts" 'binaryVersion: ')
if [[ "$CLI_VERSION_HITS" -ge 2 && "$CLI_BINVER" == "$PKG_VERSION" ]]; then
  pass "adapters/cli.ts: .version() rewrites=${CLI_VERSION_HITS} (≥2), binaryVersion=$PKG_VERSION"
else
  fail "adapters/cli.ts: .version() rewrites=${CLI_VERSION_HITS}, binaryVersion=$CLI_BINVER, expected ≥2 + $PKG_VERSION"
fi

# ─── Test 7: SyncVersions_UpdatesSessionStartTs ─────────────────────────────

echo "Test 7: SyncVersions_UpdatesSessionStartTs"

SS_VER=$(read_quoted_after "$TS_TMPDIR/cli-commands/session-start.ts" '^const SESSION_START_BINARY_VERSION = ')
if [[ "$SS_VER" == "$PKG_VERSION" ]]; then
  pass "session-start.ts SESSION_START_BINARY_VERSION → $PKG_VERSION"
else
  fail "session-start.ts SESSION_START_BINARY_VERSION=$SS_VER, expected=$PKG_VERSION"
fi

# ─── Test 8: SyncVersions_Idempotent ─────────────────────────────────────────

echo "Test 8: SyncVersions_Idempotent"

# Snapshot every sink.
SNAPSHOT_BEFORE=$(cat \
  "$TMPDIR/plugin.json" \
  "$TMPDIR/manifest.json" \
  "$TMPDIR/mcp-package.json" \
  "$TS_TMPDIR/index.ts" \
  "$TS_TMPDIR/adapters/mcp.ts" \
  "$TS_TMPDIR/adapters/cli.ts" \
  "$TS_TMPDIR/cli-commands/session-start.ts" \
  | sha256sum)

bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}" >/dev/null

SNAPSHOT_AFTER=$(cat \
  "$TMPDIR/plugin.json" \
  "$TMPDIR/manifest.json" \
  "$TMPDIR/mcp-package.json" \
  "$TS_TMPDIR/index.ts" \
  "$TS_TMPDIR/adapters/mcp.ts" \
  "$TS_TMPDIR/adapters/cli.ts" \
  "$TS_TMPDIR/cli-commands/session-start.ts" \
  | sha256sum)

if [[ "$SNAPSHOT_BEFORE" == "$SNAPSHOT_AFTER" ]]; then
  pass "Running sync twice produces byte-identical output across all 7 sinks"
else
  fail "Second sync run mutated at least one sink"
fi

# ─── Test 9: SyncVersions_CheckMode_Passes_WhenInSync ───────────────────────

echo "Test 9: SyncVersions_CheckMode_Passes_WhenInSync"

if bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}" --check >/dev/null 2>&1; then
  pass "--check exits 0 when all sinks match"
else
  fail "--check exits non-zero despite synced sinks"
fi

# ─── Test 10: SyncVersions_CheckMode_ReportsAllDrifts_NotJustFirst ──────────

echo "Test 10: SyncVersions_CheckMode_ReportsAllDrifts_NotJustFirst"

# Wipe every sink to a known-bad version, then run --check and confirm the
# report covers every site rather than short-circuiting on the first error.
poison_all_sinks "0.0.0"

CHECK_OUTPUT=$(bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}" --check 2>&1 || true)
EXPECTED_HITS=(
  "plugin.json .version"
  "plugin.json .metadata.compat.minBinaryVersion"
  "manifest.json version"
  "servers/exarchos-mcp/package.json version"
  "src/index.ts SERVER_VERSION"
  "adapters/mcp.ts SERVER_VERSION"
  "adapters/cli.ts .version()"
  "adapters/cli.ts binaryVersion"
  "session-start.ts SESSION_START_BINARY_VERSION"
)
MISSING=0
for hit in "${EXPECTED_HITS[@]}"; do
  if ! grep -qF "$hit" <<<"$CHECK_OUTPUT"; then
    fail "--check did not report drift for: $hit"
    MISSING=$((MISSING + 1))
  fi
done
if [[ $MISSING -eq 0 ]]; then
  pass "--check reported drift across all 9 site labels (no short-circuit)"
fi

# ─── Test 11: SyncVersions_FailsLoud_OnStructuralPatternMiss ────────────────

echo "Test 11: SyncVersions_FailsLoud_OnStructuralPatternMiss"

# Replace the SERVER_VERSION line in index.ts with garbage so the prefix
# regex no longer matches. The script must refuse to silently leave the
# version stale (DIM-2: observability — silent no-op on structural drift
# would let a release ship with a wrong version baked into the binary).
sed -E "s/^export const SERVER_VERSION = '[^']*';/export const RENAMED = '0.0.0';/" \
  "$TS_TMPDIR/index.ts" > "$TS_TMPDIR/index.ts.tmp"
mv "$TS_TMPDIR/index.ts.tmp" "$TS_TMPDIR/index.ts"

if bash "$SYNC_SCRIPT" "${SYNC_ARGS[@]}" 2>/dev/null; then
  fail "write mode should exit non-zero when a TS sink pattern is missing"
else
  pass "write mode fails loud when a TS sink pattern is missing"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
