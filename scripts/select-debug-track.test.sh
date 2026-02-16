#!/usr/bin/env bash
# Select Debug Track — Test Suite
# Validates all assertions for scripts/select-debug-track.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/select-debug-track.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# ============================================================
# TEST FIXTURES
# ============================================================

TMPDIR_ROOT=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a state file with urgency and rootCauseKnown fields
create_state_with_triage() {
    local dir="$1"
    local urgency="$2"
    local root_cause_known="$3"
    cat > "$dir/test.state.json" << EOF
{
  "featureId": "debug-test",
  "phase": "triage",
  "track": "",
  "urgency": {
    "level": "$urgency"
  },
  "investigation": {
    "rootCauseKnown": "$root_cause_known"
  }
}
EOF
    echo "$dir/test.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Select Debug Track Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CriticalKnown_SelectsHotfix_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency critical --root-cause-known yes 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CriticalKnown_SelectsHotfix_ExitsZero"
else
    fail "CriticalKnown_SelectsHotfix_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: CriticalUnknown_SelectsThorough_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency critical --root-cause-known no 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CriticalUnknown_SelectsThorough_ExitsOne"
else
    fail "CriticalUnknown_SelectsThorough_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: HighKnown_SelectsHotfix_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency high --root-cause-known yes 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HighKnown_SelectsHotfix_ExitsZero"
else
    fail "HighKnown_SelectsHotfix_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: HighUnknown_SelectsThorough_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency high --root-cause-known no 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "HighUnknown_SelectsThorough_ExitsOne"
else
    fail "HighUnknown_SelectsThorough_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: MediumAny_SelectsThorough_ExitsOne
# --------------------------------------------------
setup
OUTPUT_YES="$(bash "$SCRIPT_UNDER_TEST" --urgency medium --root-cause-known yes 2>&1)" && EXIT_YES=$? || EXIT_YES=$?
OUTPUT_NO="$(bash "$SCRIPT_UNDER_TEST" --urgency medium --root-cause-known no 2>&1)" && EXIT_NO=$? || EXIT_NO=$?
if [[ $EXIT_YES -eq 1 && $EXIT_NO -eq 1 ]]; then
    pass "MediumAny_SelectsThorough_ExitsOne"
else
    fail "MediumAny_SelectsThorough_ExitsOne (yes_exit=$EXIT_YES, no_exit=$EXIT_NO, expected both 1)"
fi
teardown

# --------------------------------------------------
# Test 6: LowAny_SelectsThorough_ExitsOne
# --------------------------------------------------
setup
OUTPUT_YES="$(bash "$SCRIPT_UNDER_TEST" --urgency low --root-cause-known yes 2>&1)" && EXIT_YES=$? || EXIT_YES=$?
OUTPUT_NO="$(bash "$SCRIPT_UNDER_TEST" --urgency low --root-cause-known no 2>&1)" && EXIT_NO=$? || EXIT_NO=$?
if [[ $EXIT_YES -eq 1 && $EXIT_NO -eq 1 ]]; then
    pass "LowAny_SelectsThorough_ExitsOne"
else
    fail "LowAny_SelectsThorough_ExitsOne (yes_exit=$EXIT_YES, no_exit=$EXIT_NO, expected both 1)"
fi
teardown

# --------------------------------------------------
# Test 7: InvalidUrgency_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency bogus --root-cause-known yes 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "InvalidUrgency_ExitsTwo"
else
    fail "InvalidUrgency_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: OutputContainsReasoning
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --urgency critical --root-cause-known yes 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "reasoning"; then
    pass "OutputContainsReasoning"
else
    fail "OutputContainsReasoning (no 'reasoning' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: StateFileInput_ReadsTriage
# --------------------------------------------------
setup
STATE_FILE="$(create_state_with_triage "$TMPDIR_ROOT" "critical" "yes")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "StateFileInput_ReadsTriage"
else
    fail "StateFileInput_ReadsTriage (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: UsageError_NoArgs_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoArgs_ExitsTwo"
else
    fail "UsageError_NoArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
