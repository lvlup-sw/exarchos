#!/usr/bin/env bash
# validate-delegation-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/../skills/delegation"

PASS=0
FAIL=0

assert_contains() {
  local label="$1"
  local pattern="$2"
  if grep -rq "$pattern" "$SKILL_DIR" --include="*.md"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label — expected to find: $pattern"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Delegation SKILL.md Validation ==="
echo ""

# References setup-worktree.sh script
assert_contains \
  "ReferencesScript_SetupWorktree" \
  "setup-worktree.sh"

# References post-delegation-check.sh script
assert_contains \
  "ReferencesScript_PostDelegationCheck" \
  "post-delegation-check.sh"

# References extract-fix-tasks.sh script
assert_contains \
  "ReferencesScript_ExtractFixTasks" \
  "extract-fix-tasks.sh"

# References needs-schema-sync.sh script
assert_contains \
  "ReferencesScript_NeedsSchemaSync" \
  "needs-schema-sync.sh"

# Exit code documentation
assert_contains \
  "FailureRouting_Exit0_Documented" \
  "exit 0"

assert_contains \
  "FailureRouting_Exit1_Documented" \
  "exit 1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
