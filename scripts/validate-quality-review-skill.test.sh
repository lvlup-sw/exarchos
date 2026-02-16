#!/usr/bin/env bash
# validate-quality-review-skill.test.sh — Verifies SKILL.md references scripts, not prose
#
# Exit 0 if all assertions pass; exit 1 if any check fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_FILE="$SCRIPT_DIR/../skills/quality-review/SKILL.md"

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

echo "=== Quality Review SKILL.md Validation ==="
echo ""

# References review-verdict.sh script
assert_contains \
  "ReferencesScript_ReviewVerdict" \
  "review-verdict.sh"

# References static-analysis-gate.sh script
assert_contains \
  "ReferencesScript_StaticAnalysisGate" \
  "static-analysis-gate.sh"

# References security-scan.sh script
assert_contains \
  "ReferencesScript_SecurityScan" \
  "security-scan.sh"

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
