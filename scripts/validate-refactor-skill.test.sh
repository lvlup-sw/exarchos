#!/usr/bin/env bash
# validate-refactor-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/../skills/refactor/SKILL.md"

PASS=0
FAIL=0

assert_contains() {
  local label="$1"
  local pattern="$2"
  if grep -q "$pattern" "$SKILL_FILE"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label — expected to find: $pattern"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1"
  local pattern="$2"
  if grep -q "$pattern" "$SKILL_FILE"; then
    echo "FAIL: $label — expected NOT to find: $pattern"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

echo "=== Refactor SKILL.md Validation ==="
echo ""

# References assess-refactor-scope.sh script
assert_contains \
  "ReferencesScript_AssessRefactorScope" \
  "assess-refactor-scope.sh"

# References check-polish-scope.sh script
assert_contains \
  "ReferencesScript_CheckPolishScope" \
  "check-polish-scope.sh"

# References validate-refactor.sh script
assert_contains \
  "ReferencesScript_ValidateRefactor" \
  "validate-refactor.sh"

# References verify-doc-links.sh script
assert_contains \
  "ReferencesScript_VerifyDocLinks" \
  "verify-doc-links.sh"

# Exit code documentation (refactor skill uses "Exit 0" capitalized)
assert_contains \
  "FailureRouting_Exit0_Documented" \
  "Exit 0"

assert_contains \
  "FailureRouting_Exit1_Documented" \
  "Exit 1"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
