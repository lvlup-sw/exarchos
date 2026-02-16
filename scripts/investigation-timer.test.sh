#!/usr/bin/env bash
# Investigation Timer — Test Suite
# Validates all assertions for scripts/investigation-timer.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/investigation-timer.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Create a state file with investigation.startedAt timestamp
create_state_with_started_at() {
    local dir="$1"
    local timestamp="$2"
    cat > "$dir/test.state.json" << EOF
{
  "featureId": "debug-test",
  "phase": "investigate",
  "track": "hotfix",
  "investigation": {
    "startedAt": "$timestamp"
  }
}
EOF
    echo "$dir/test.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Investigation Timer Tests ==="
echo ""

# --------------------------------------------------
# Test 1: WithinBudget_5Minutes_ExitsZero
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "WithinBudget_5Minutes_ExitsZero"
else
    fail "WithinBudget_5Minutes_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: ExceededBudget_20Minutes_ExitsOne
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-20M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ExceededBudget_20Minutes_ExitsOne"
else
    fail "ExceededBudget_20Minutes_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ExactBudget_15Minutes_ExitsZero (edge case: at exactly budget)
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ExactBudget_15Minutes_ExitsZero"
else
    fail "ExactBudget_15Minutes_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: CustomBudget_30Minutes_Works
# --------------------------------------------------
setup
# 20 minutes ago, with 30 minute budget => within budget
STARTED_AT="$(date -u -v-20M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" --budget-minutes 30 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CustomBudget_30Minutes_Works"
else
    fail "CustomBudget_30Minutes_Works (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: InvalidTimestamp_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "not-a-timestamp" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "InvalidTimestamp_ExitsTwo"
else
    fail "InvalidTimestamp_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UsageError_NoArgs_ExitsTwo
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

# --------------------------------------------------
# Test 7: OutputContainsElapsedTime
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "elapsed"; then
    pass "OutputContainsElapsedTime"
else
    fail "OutputContainsElapsedTime (no 'elapsed' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: OutputContainsRemainingTime (when within budget)
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --started-at "$STARTED_AT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "remaining"; then
    pass "OutputContainsRemainingTime"
else
    fail "OutputContainsRemainingTime (no 'remaining' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: StateFileInput_ReadsStartedAt
# --------------------------------------------------
setup
STARTED_AT="$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)"
STATE_FILE="$(create_state_with_started_at "$TMPDIR_ROOT" "$STARTED_AT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "StateFileInput_ReadsStartedAt"
else
    fail "StateFileInput_ReadsStartedAt (exit=$EXIT_CODE, expected 0)"
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
