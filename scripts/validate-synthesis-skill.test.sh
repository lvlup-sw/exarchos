#!/usr/bin/env bash
# validate-synthesis-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$SCRIPT_DIR/../skills/synthesis"

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

assert_not_contains() {
  local label="$1"
  local pattern="$2"
  if grep -rq "$pattern" "$SKILL_DIR" --include="*.md"; then
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
  "Step1_NoProseChecklist_Removed" \
  "\- \[ \] All delegated tasks complete"

# Failure routing documented for each script step
assert_contains \
  "FailureRouting_Exit0_Documented" \
  "exit 0"

assert_contains \
  "FailureRouting_Exit1_Documented" \
  "exit 1"

# Review gate script exists and is executable
if [[ -x "$SCRIPT_DIR/coderabbit-review-gate.sh" ]]; then
    echo "PASS: ReviewGate_ScriptExists"
    PASS=$((PASS + 1))
else
    echo "FAIL: ReviewGate_ScriptExists — scripts/coderabbit-review-gate.sh not found or not executable"
    FAIL=$((FAIL + 1))
fi

# Review gate test exists
if [[ -f "$SCRIPT_DIR/coderabbit-review-gate.test.sh" ]]; then
    echo "PASS: ReviewGate_TestExists"
    PASS=$((PASS + 1))
else
    echo "FAIL: ReviewGate_TestExists — scripts/coderabbit-review-gate.test.sh not found"
    FAIL=$((FAIL + 1))
fi

# Review gate workflow exists
if [[ -f "$SCRIPT_DIR/../.github/workflows/coderabbit-review-gate.yml" ]]; then
    echo "PASS: ReviewGate_WorkflowExists"
    PASS=$((PASS + 1))
else
    echo "FAIL: ReviewGate_WorkflowExists — .github/workflows/coderabbit-review-gate.yml not found"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
