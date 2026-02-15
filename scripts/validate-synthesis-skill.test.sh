#!/usr/bin/env bash
# validate-synthesis-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass, exit 1 on first failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/../skills/synthesis/SKILL.md"

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

echo "=== Synthesis SKILL.md Validation ==="
echo ""

# Step 1: References pre-synthesis-check.sh script
assert_contains \
  "Step1_ReferencesScript_NotProse" \
  "pre-synthesis-check.sh"

# Step 2: References reconstruct-stack.sh script
assert_contains \
  "Step2_ReferencesScript_NotProse" \
  "reconstruct-stack.sh"

# Step 4: References check-coderabbit.sh script
assert_contains \
  "Step4_ReferencesScript_NotProse" \
  "check-coderabbit.sh"

# Step 1: Prose checklist removed
assert_not_contains \
  "Step1_NoProsChecklist_Removed" \
  "\- \[ \] All delegated tasks complete"

# Failure routing documented for each script step
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
