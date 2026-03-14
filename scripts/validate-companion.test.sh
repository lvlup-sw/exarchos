#!/usr/bin/env bash
# validate-companion.test.sh — Tests for validate-companion.sh
#
# Pattern: create temp dirs with valid/invalid structures, verify exit codes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/validate-companion.sh"
PASS=0
FAIL=0
TMPDIRS=()
cleanup() { for d in "${TMPDIRS[@]}"; do rm -rf "$d"; done; }
trap cleanup EXIT

# Helper
assert_exit() {
  local expected=$1; shift
  if "$@" >/dev/null 2>&1; then actual=0; else actual=$?; fi
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "- **PASS**: Expected exit $expected, got $actual"
  else
    FAIL=$((FAIL + 1))
    echo "- **FAIL**: Expected exit $expected, got $actual"
  fi
}

echo "## validate-companion.sh Tests"
echo

# Test 1: Valid companion structure passes
TMPDIR1=$(mktemp -d)
TMPDIRS+=("$TMPDIR1")
mkdir -p "$TMPDIR1/companion/.claude-plugin"
cat > "$TMPDIR1/companion/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos-dev-tools",
  "version": "2.0.0",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR1/companion/.mcp.json" << 'EOF'
{
  "microsoft-learn": { "type": "http", "url": "https://learn.microsoft.com/api/mcp" }
}
EOF
cat > "$TMPDIR1/companion/settings.json" << 'EOF'
{
  "enabledPlugins": {
    "serena@claude-plugins-official": true,
    "context7@claude-plugins-official": true
  }
}
EOF
assert_exit 0 bash "$SCRIPT" --repo-root "$TMPDIR1"

# Test 2: Missing companion directory fails
TMPDIR2=$(mktemp -d)
TMPDIRS+=("$TMPDIR2")
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR2"

# Test 3: Missing settings.json fails
TMPDIR3=$(mktemp -d)
TMPDIRS+=("$TMPDIR3")
mkdir -p "$TMPDIR3/companion/.claude-plugin"
cat > "$TMPDIR3/companion/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos-dev-tools",
  "version": "2.0.0",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR3/companion/.mcp.json" << 'EOF'
{ "microsoft-learn": { "type": "http" } }
EOF
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR3"

# Test 4: settings.json without enabledPlugins fails
TMPDIR4=$(mktemp -d)
TMPDIRS+=("$TMPDIR4")
mkdir -p "$TMPDIR4/companion/.claude-plugin"
cat > "$TMPDIR4/companion/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos-dev-tools",
  "version": "2.0.0",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR4/companion/.mcp.json" << 'EOF'
{ "microsoft-learn": { "type": "http" } }
EOF
cat > "$TMPDIR4/companion/settings.json" << 'EOF'
{ "model": "claude-opus-4-6" }
EOF
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR4"

# Test 5: Invalid JSON in plugin.json fails
TMPDIR5=$(mktemp -d)
TMPDIRS+=("$TMPDIR5")
mkdir -p "$TMPDIR5/companion/.claude-plugin"
echo "not json" > "$TMPDIR5/companion/.claude-plugin/plugin.json"
cat > "$TMPDIR5/companion/.mcp.json" << 'EOF'
{ "microsoft-learn": { "type": "http" } }
EOF
cat > "$TMPDIR5/companion/settings.json" << 'EOF'
{ "enabledPlugins": {} }
EOF
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR5"

echo
echo "---"
echo "**Results:** $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
