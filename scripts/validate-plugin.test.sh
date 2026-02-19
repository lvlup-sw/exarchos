#!/usr/bin/env bash
# validate-plugin.test.sh — Tests for validate-plugin.sh
#
# Pattern: create temp dirs with valid/invalid structures, verify exit codes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/validate-plugin.sh"
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

echo "## validate-plugin.sh Tests"
echo

# Test 1: Valid structure passes
TMPDIR1=$(mktemp -d)
TMPDIRS+=("$TMPDIR1")
mkdir -p "$TMPDIR1/.claude-plugin" "$TMPDIR1/commands" "$TMPDIR1/skills" "$TMPDIR1/hooks"
cat > "$TMPDIR1/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos",
  "version": "2.0.0",
  "commands": "./commands/",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR1/.mcp.json" << 'EOF'
{
  "exarchos": { "type": "stdio", "command": "bun", "args": ["run", "dist/exarchos-mcp.js"] },
  "graphite": { "type": "stdio", "command": "gt", "args": ["mcp"] }
}
EOF
cat > "$TMPDIR1/hooks/hooks.json" << 'HOOKEOF'
{
  "hooks": {
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "TaskCompleted": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "TeammateIdle": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node cli" }] }]
  }
}
HOOKEOF
assert_exit 0 bash "$SCRIPT" --repo-root "$TMPDIR1"

# Test 2: Missing plugin.json fails
TMPDIR2=$(mktemp -d)
TMPDIRS+=("$TMPDIR2")
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR2"

# Test 3: Missing hook types fails
TMPDIR3=$(mktemp -d)
TMPDIRS+=("$TMPDIR3")
mkdir -p "$TMPDIR3/.claude-plugin" "$TMPDIR3/commands" "$TMPDIR3/skills" "$TMPDIR3/hooks"
cat > "$TMPDIR3/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos",
  "version": "2.0.0",
  "commands": "./commands/",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR3/.mcp.json" << 'EOF'
{
  "exarchos": { "type": "stdio" },
  "graphite": { "type": "stdio" }
}
EOF
cat > "$TMPDIR3/hooks/hooks.json" << 'HOOKEOF'
{
  "hooks": {
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node cli" }] }]
  }
}
HOOKEOF
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR3"

# Test 4: {{CLI_PATH}} in hooks fails
TMPDIR4=$(mktemp -d)
TMPDIRS+=("$TMPDIR4")
mkdir -p "$TMPDIR4/.claude-plugin" "$TMPDIR4/commands" "$TMPDIR4/skills" "$TMPDIR4/hooks"
cat > "$TMPDIR4/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "exarchos",
  "version": "2.0.0",
  "commands": "./commands/",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
EOF
cat > "$TMPDIR4/.mcp.json" << 'EOF'
{
  "exarchos": { "type": "stdio" },
  "graphite": { "type": "stdio" }
}
EOF
cat > "$TMPDIR4/hooks/hooks.json" << 'HOOKEOF'
{
  "hooks": {
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "node \"{{CLI_PATH}}\" pre-compact" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "TaskCompleted": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "TeammateIdle": [{ "hooks": [{ "type": "command", "command": "node cli" }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "node cli" }] }]
  }
}
HOOKEOF
assert_exit 1 bash "$SCRIPT" --repo-root "$TMPDIR4"

# Test 5: No arguments uses current directory (should handle gracefully)
# This tests that the script doesn't crash without --repo-root
# We don't assert a specific exit code since it depends on cwd structure

echo
echo "---"
echo "**Results:** $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
