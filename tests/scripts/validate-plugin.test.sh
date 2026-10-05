#!/usr/bin/env bash
# Self-test for the plugin-packaging gate, tools/audit/gates/validate-plugin.sh.
#
# tests/scripts/validate-plugin.test.ts runs only in a path-filtered CI job.
# This script asserts the same fail-closed properties in the unfiltered
# `grep-gates` job, which runs on every PR. check-type-debt.test.sh and
# check-coverage-ratchet.test.sh use the same pattern.
#
# Cases 1 to 6 exercise the shipped policy document, not a copy of the rules, so
# the fixtures cannot drift from the gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
GATE="$SCRIPT_DIR/validate-plugin.sh"
POLICY="$REPO_ROOT/.claude-plugin/packaging-policy.json"

PASS=0
FAIL=0
TMPDIRS=()
# `return 0` is necessary. Under `set -e`, a trap whose last command exits
# non-zero replaces the exit status of the script, and a green run then fails.
cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do
    [[ -n "$d" ]] && rm -rf "$d"
  done
  return 0
}
trap cleanup EXIT

# Asserts an exit code and does not let `set -e` stop the run. Each case must
# report its result.
assert_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual=0
  "$@" > /dev/null 2>&1 || actual=$?
  if [[ "$actual" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "- **PASS**: $label (exit $actual)"
  else
    FAIL=$((FAIL + 1))
    echo "- **FAIL**: $label — expected exit $expected, got $actual"
  fi
}

# Builds a minimal tree that satisfies the shipped policy. It is in one place,
# so each case below can break exactly one thing.
seed_conforming_tree() {
  local root="$1"
  mkdir -p "$root/.claude-plugin" "$root/rendered/commands" "$root/rendered/skills" "$root/hooks"
  cat > "$root/.claude-plugin/plugin.json" << 'JSON'
{
  "name": "exarchos",
  "version": "9.9.9",
  "commands": "./rendered/commands/",
  "skills": "./rendered/skills/",
  "mcpServers": {
    "exarchos": { "type": "stdio", "command": "exarchos", "args": ["mcp"] }
  }
}
JSON
  cat > "$root/hooks/hooks.json" << 'JSON'
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "exarchos session-start", "timeout": 10 }] }
    ],
    "SubagentStop": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "exarchos subagent-stop", "timeout": 30 }] }
    ]
  }
}
JSON
}

# Seeds a conforming tree and assigns its path to the named variable.
#
# It assigns and does not echo. `dir=$(mktree)` runs the body in a subshell, so
# `TMPDIRS+=` does not reach the parent and each fixture directory leaks.
mktree() {
  local __outvar="$1"
  local d
  d=$(mktemp -d)
  TMPDIRS+=("$d")
  seed_conforming_tree "$d"
  printf -v "$__outvar" '%s' "$d"
}

echo "## validate-plugin.sh Tests"
echo

# 1. The shipped tree satisfies the shipped policy. If this case fails, the
#    packaging changed. Then edit the policy on purpose.
assert_exit "real repository tree passes" 0 bash "$GATE" --repo-root "$REPO_ROOT"

# 2. A conforming synthetic tree passes against the same policy document. Thus
#    the pass does not depend on properties of this checkout.
mktree T_OK
assert_exit "conforming synthetic tree passes" 0 bash "$GATE" --repo-root "$T_OK" --policy "$POLICY"

# 3. Missing manifest → fail.
mktree T_NOMANIFEST
rm -f "$T_NOMANIFEST/.claude-plugin/plugin.json"
assert_exit "missing plugin.json fails" 1 bash "$GATE" --repo-root "$T_NOMANIFEST" --policy "$POLICY"

# 4. A forbidden file → fail. A `.mcp.json` registers the MCP server a second
#    time.
mktree T_MCP
echo '{"mcpServers":{"exarchos":{"type":"stdio"}}}' > "$T_MCP/.mcp.json"
assert_exit "forbidden .mcp.json fails" 1 bash "$GATE" --repo-root "$T_MCP" --policy "$POLICY"

# 5. An enforcement hook (`PreToolUse`) → fail. The hook layer is observe-only.
mktree T_HOOK
cat > "$T_HOOK/hooks/hooks.json" << 'JSON'
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "exarchos session-start" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "exarchos subagent-stop" }] }],
    "PreToolUse": [{ "hooks": [{ "type": "command", "command": "exarchos guard" }] }]
  }
}
JSON
assert_exit "retired PreToolUse hook fails" 1 bash "$GATE" --repo-root "$T_HOOK" --policy "$POLICY"

# 6. An unsubstituted build-time placeholder → fail. It does not resolve on the
#    machine of a consumer, so the hook is a silent no-op.
mktree T_TOKEN
cat > "$T_TOKEN/hooks/hooks.json" << 'JSON'
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"{{CLI_PATH}}\" session-start" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "exarchos subagent-stop" }] }]
  }
}
JSON
assert_exit "unsubstituted {{CLI_PATH}} fails" 1 bash "$GATE" --repo-root "$T_TOKEN" --policy "$POLICY"

# 7. Non-empty denominator. A policy that asserts nothing must not give a clean
#    run, or an emptied policy passes.
mktree T_EMPTY
echo '{}' > "$T_EMPTY/empty-policy.json"
assert_exit "policy yielding zero checks fails" 1 \
  bash "$GATE" --repo-root "$T_EMPTY" --policy "$T_EMPTY/empty-policy.json"

# 8. Fail closed. An unreadable policy must exit 2, never 0.
mktree T_MISSING
assert_exit "unreadable policy exits 2" 2 \
  bash "$GATE" --repo-root "$T_MISSING" --policy "$T_MISSING/does-not-exist.json"

# 9. Usage errors stay usage errors.
assert_exit "unknown argument exits 2" 2 bash "$GATE" --nope

echo
echo "---"
echo "**Results:** $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then exit 1; fi
if [[ "$PASS" -eq 0 ]]; then
  echo "**FAIL**: zero cases ran — a self-test that asserts nothing is not a self-test"
  exit 1
fi
exit 0
