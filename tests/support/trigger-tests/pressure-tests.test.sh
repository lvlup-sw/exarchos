#!/usr/bin/env bash
# pressure-tests.test.sh — Validate pressure test fixture structure and coverage
#
# Tests:
# 1. Fixture file exists
# 2. Has at least 9 entries with category "pressure-test"
# 3. Each entry has all required fields (input, expected_skill, expected_behavior, category)
# 4. At least 3 entries per discipline skill (implementation-planning, spec-review, quality-review)
# 5. All entries have category "pressure-test"
#
# Usage: bash skills/trigger-tests/pressure-tests.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="${SCRIPT_DIR}/fixtures/pressure-tests.jsonl"
PASS=0; FAIL=0

assert() {
  local desc="$1" result="$2"
  if [[ "$result" == "true" ]]; then
    PASS=$((PASS + 1))
    echo "PASS: $desc"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $desc"
  fi
}

# Test 1: Fixture file exists
if [[ -f "$FIXTURES" ]]; then
  assert "Fixture file exists" "true"
else
  assert "Fixture file exists" "false"
  echo "=== Pressure Tests: ${PASS} passed, ${FAIL} failed ==="
  exit 1
fi

# Count total entries with category "pressure-test"
TOTAL=$(jq -r 'select(.category == "pressure-test")' "$FIXTURES" | jq -s 'length')

# Test 2: At least 9 entries
assert "At least 9 pressure-test entries (found: $TOTAL)" "$( [[ "$TOTAL" -ge 9 ]] && echo true || echo false )"

# Test 3: Each entry has all required fields
MISSING_FIELDS=0
LINE_NUM=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  LINE_NUM=$((LINE_NUM + 1))
  for field in input expected_skill expected_behavior category; do
    val=$(echo "$line" | jq -r ".$field // empty")
    if [[ -z "$val" ]]; then
      MISSING_FIELDS=$((MISSING_FIELDS + 1))
      echo "  Missing '$field' on line $LINE_NUM"
    fi
  done
done < "$FIXTURES"

assert "All entries have required fields (missing: $MISSING_FIELDS)" "$( [[ "$MISSING_FIELDS" -eq 0 ]] && echo true || echo false )"

# Test 4: At least 3 entries per discipline skill
for skill in implementation-planning spec-review quality-review; do
  COUNT=$(jq -r "select(.expected_skill == \"$skill\" and .category == \"pressure-test\")" "$FIXTURES" | jq -s 'length')
  assert "At least 3 entries for $skill (found: $COUNT)" "$( [[ "$COUNT" -ge 3 ]] && echo true || echo false )"
done

# Test 5: All entries have category "pressure-test"
NON_PRESSURE=$(jq -r 'select(.category != "pressure-test")' "$FIXTURES" | jq -s 'length')
assert "All entries have category 'pressure-test' (non-matching: $NON_PRESSURE)" "$( [[ "$NON_PRESSURE" -eq 0 ]] && echo true || echo false )"

# Test 6: No duplicate inputs
UNIQUE_INPUTS=$(jq -r '.input' "$FIXTURES" | sort -u | wc -l | tr -d ' ')
TOTAL_INPUTS=$(jq -r '.input' "$FIXTURES" | wc -l | tr -d ' ')
assert "No duplicate inputs ($UNIQUE_INPUTS unique of $TOTAL_INPUTS)" "$( [[ "$UNIQUE_INPUTS" -eq "$TOTAL_INPUTS" ]] && echo true || echo false )"

# Test 7: expected_behavior is non-trivial (at least 20 chars)
SHORT_BEHAVIORS=0
while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  behavior=$(echo "$line" | jq -r '.expected_behavior // ""')
  if [[ ${#behavior} -lt 20 ]]; then
    SHORT_BEHAVIORS=$((SHORT_BEHAVIORS + 1))
    echo "  Short expected_behavior: '$behavior'"
  fi
done < "$FIXTURES"
assert "All expected_behavior fields are substantial (short: $SHORT_BEHAVIORS)" "$( [[ "$SHORT_BEHAVIORS" -eq 0 ]] && echo true || echo false )"

echo "=== Pressure Tests: ${PASS} passed, ${FAIL} failed ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
