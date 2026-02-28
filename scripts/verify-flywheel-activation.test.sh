#!/usr/bin/env bash
# Tests for verify-flywheel-activation.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-flywheel-activation.sh"

PASS=0
FAIL=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }

TMPDIR_ROOT=""
setup() {
    TMPDIR_ROOT="$(mktemp -d)"
}
teardown() {
    rm -rf "$TMPDIR_ROOT"
}

echo "=== Verify Flywheel Activation Tests ==="
echo ""

# --------------------------------------------------
# Test 1: MissingArgs_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingArgs_ExitsTwo"
else
    fail "MissingArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
fi

# --------------------------------------------------
# Test 2: HelpFlag_ExitsZero
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_ExitsZero"
else
    fail "HelpFlag_ExitsZero (exit=$EXIT_CODE, expected 0)"
fi

# --------------------------------------------------
# Test 3: MissingGoldStandard_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/nonexistent.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingGoldStandard_ExitsOne"
else
    fail "MissingGoldStandard_ExitsOne (exit=$EXIT_CODE, expected 1)"
fi
teardown

# --------------------------------------------------
# Test 4: InsufficientCases_ExitsOne
# --------------------------------------------------
setup
# Create a gold standard with only 5 cases (need >= 20)
for i in $(seq 1 5); do
    echo "{\"caseId\":\"test-$i\",\"skill\":\"delegation\",\"rubricName\":\"test-rubric\",\"humanVerdict\":true,\"humanScore\":0.9,\"humanRationale\":\"Good\"}" >> "$TMPDIR_ROOT/gold.jsonl"
done
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/gold.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InsufficientCases_ExitsOne"
else
    fail "InsufficientCases_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: ValidGoldStandard_ExitsZero
# --------------------------------------------------
setup
# Create a valid gold standard with 20 cases
for i in $(seq 1 10); do
    echo "{\"caseId\":\"del-td-$(printf '%02d' $i)\",\"skill\":\"delegation\",\"rubricName\":\"task-decomposition-quality\",\"humanVerdict\":true,\"humanScore\":0.9,\"humanRationale\":\"Good coverage\"}" >> "$TMPDIR_ROOT/gold.jsonl"
done
for i in $(seq 1 10); do
    echo "{\"caseId\":\"brs-iq-$(printf '%02d' $i)\",\"skill\":\"brainstorming\",\"rubricName\":\"ideation-quality\",\"humanVerdict\":false,\"humanScore\":0.3,\"humanRationale\":\"Missing approaches\"}" >> "$TMPDIR_ROOT/gold.jsonl"
done
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/gold.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidGoldStandard_ExitsZero"
else
    fail "ValidGoldStandard_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: InvalidJSON_ExitsOne
# --------------------------------------------------
setup
# Create a file with invalid JSON
for i in $(seq 1 20); do
    echo "not valid json $i" >> "$TMPDIR_ROOT/gold.jsonl"
done
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/gold.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InvalidJSON_ExitsOne"
else
    fail "InvalidJSON_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: MissingRequiredFields_ExitsOne
# --------------------------------------------------
setup
# Create cases missing humanRationale field
for i in $(seq 1 20); do
    echo "{\"caseId\":\"test-$i\",\"skill\":\"delegation\",\"rubricName\":\"test\",\"humanVerdict\":true,\"humanScore\":0.9}" >> "$TMPDIR_ROOT/gold.jsonl"
done
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/gold.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingRequiredFields_ExitsOne"
else
    fail "MissingRequiredFields_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: OutputContainsCheckResults
# --------------------------------------------------
setup
for i in $(seq 1 10); do
    echo "{\"caseId\":\"del-td-$(printf '%02d' $i)\",\"skill\":\"delegation\",\"rubricName\":\"task-decomposition-quality\",\"humanVerdict\":true,\"humanScore\":0.9,\"humanRationale\":\"Good\"}" >> "$TMPDIR_ROOT/gold.jsonl"
done
for i in $(seq 1 10); do
    echo "{\"caseId\":\"brs-iq-$(printf '%02d' $i)\",\"skill\":\"brainstorming\",\"rubricName\":\"ideation-quality\",\"humanVerdict\":false,\"humanScore\":0.3,\"humanRationale\":\"Poor\"}" >> "$TMPDIR_ROOT/gold.jsonl"
done
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --gold-standard "$TMPDIR_ROOT/gold.jsonl" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "gold standard" && echo "$OUTPUT" | grep -qi "cases"; then
    pass "OutputContainsCheckResults"
else
    fail "OutputContainsCheckResults (expected output with check results)"
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
