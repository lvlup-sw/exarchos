#!/usr/bin/env bash
# validate-planning-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/../skills/implementation-planning/SKILL.md"

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

echo "=== Implementation Planning SKILL.md Validation ==="
echo ""

# References verify-plan-coverage.sh script
assert_contains \
  "ReferencesScript_VerifyPlanCoverage" \
  "verify-plan-coverage.sh"

# References spec-coverage-check.sh script
assert_contains \
  "ReferencesScript_SpecCoverageCheck" \
  "spec-coverage-check.sh"

# References generate-traceability.sh script
assert_contains \
  "ReferencesScript_GenerateTraceability" \
  "generate-traceability.sh"

# References check-tdd-compliance.sh script
assert_contains \
  "ReferencesScript_CheckTddCompliance" \
  "check-tdd-compliance.sh"

# References check-coverage-thresholds.sh script
assert_contains \
  "ReferencesScript_CheckCoverageThresholds" \
  "check-coverage-thresholds.sh"

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
