#!/usr/bin/env bash
# validate-plugin.test.sh — DR-10 unfiltered re-assert for the plugin-packaging
# gate (task 064, DR-24).
#
# Why a `.test.sh` when scripts/validate-plugin.test.ts already exists. The
# vitest suite runs only in the path-filtered `test-root` job, so a PR that
# touches ONLY `scripts/**` skips it — the gate's own implementation surface is
# outside the filter that would notice a regression in it. This file re-asserts
# the same fail-closed properties on the UNFILTERED grep-gates host, where it
# fires on every PR. Same pattern as check-type-debt.test.sh /
# check-coverage-ratchet.test.sh; see docs/guides/ci-gate-hosting.md.
#
# Its predecessor asserted the OPPOSITE policy: it seeded a fixture carrying all
# six retired enforcement hooks and a `.mcp.json` and expected exit 0. It had
# rotted that far because nothing ran it — the same reason the gate it tested
# had five wrong checks. Every case below therefore exercises the SHIPPED
# policy document rather than a copy of the rules, so this file cannot drift
# from the gate the way the old one did.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="$SCRIPT_DIR/validate-plugin.sh"
POLICY="$REPO_ROOT/.claude-plugin/packaging-policy.json"

PASS=0
FAIL=0
TMPDIRS=()
# `return 0` is load-bearing: under `set -e` a trap whose last command exits
# non-zero (an empty array, a already-removed dir) overrides the script's own
# exit status, and this file reported FAIL-on-all-green until it was added.
cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do
    [[ -n "$d" ]] && rm -rf "$d"
  done
  return 0
}
trap cleanup EXIT

# Assert an exit code without letting `set -e` abort the run — every case must
# report, which is the same aggregation discipline the gate itself now enforces.
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

# Build a minimal tree that satisfies the shipped policy. Kept in ONE place so
# each case below can break exactly one thing.
seed_conforming_tree() {
  local root="$1"
  mkdir -p "$root/.claude-plugin" "$root/commands" "$root/skills" "$root/hooks"
  cat > "$root/.claude-plugin/plugin.json" << 'JSON'
{
  "name": "exarchos",
  "version": "9.9.9",
  "commands": "./commands/",
  "skills": "./skills/",
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

# Seed a conforming tree and assign its path to the named variable.
#
# Assigns rather than echoes on purpose: `dir=$(mktree)` runs the body in a
# SUBSHELL, so the `TMPDIRS+=` never reaches the parent and every fixture dir
# leaks into $TMPDIR for the life of the machine.
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

# 1. The shipped tree satisfies the shipped policy. If this ever needs a change,
#    the packaging changed — go edit the policy, deliberately.
assert_exit "real repository tree passes" 0 bash "$GATE" --repo-root "$REPO_ROOT"

# 2. A conforming synthetic tree passes against the SAME policy document, so the
#    gate is not accidentally passing on properties unique to this checkout.
mktree T_OK
assert_exit "conforming synthetic tree passes" 0 bash "$GATE" --repo-root "$T_OK" --policy "$POLICY"

# 3. Missing manifest → fail.
mktree T_NOMANIFEST
rm -f "$T_NOMANIFEST/.claude-plugin/plugin.json"
assert_exit "missing plugin.json fails" 1 bash "$GATE" --repo-root "$T_NOMANIFEST" --policy "$POLICY"

# 4. A forbidden file reappearing → fail. `.mcp.json` was deleted on purpose
#    (2b62e1bf3) and its return double-registers the MCP server.
mktree T_MCP
echo '{"mcpServers":{"exarchos":{"type":"stdio"}}}' > "$T_MCP/.mcp.json"
assert_exit "forbidden .mcp.json fails" 1 bash "$GATE" --repo-root "$T_MCP" --policy "$POLICY"

# 5. A retired enforcement hook returning → fail. The hook layer is observe-only
#    (docs/adrs/2026-05-24-hook-layer-observe-only.md).
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

# 6. An unsubstituted build-time placeholder → fail. It never resolves on a
#    consumer's machine, so the hook would be a silent no-op.
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

# 7. NON-EMPTY DENOMINATOR. A policy that asserts nothing must not read as a
#    clean run — this is the tooth that keeps a gutted policy from going green.
mktree T_EMPTY
echo '{}' > "$T_EMPTY/empty-policy.json"
assert_exit "policy yielding zero checks fails" 1 \
  bash "$GATE" --repo-root "$T_EMPTY" --policy "$T_EMPTY/empty-policy.json"

# 8. FAIL CLOSED. An unreadable policy is a broken instrument; exit 2, never 0.
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
