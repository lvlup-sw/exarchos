#!/usr/bin/env bash
# check-coverage-thresholds.sh — Test Suite
# Validates coverage threshold checking against test output.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-coverage-thresholds.sh"
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

# Istanbul/Vitest JSON coverage summary format — above defaults
create_above_threshold_coverage() {
    local dir="$1"
    cat > "$dir/coverage-summary.json" << 'EOF'
{
  "total": {
    "lines": { "total": 100, "covered": 90, "skipped": 0, "pct": 90 },
    "statements": { "total": 100, "covered": 90, "skipped": 0, "pct": 90 },
    "functions": { "total": 20, "covered": 20, "skipped": 0, "pct": 100 },
    "branches": { "total": 30, "covered": 24, "skipped": 0, "pct": 80 }
  }
}
EOF
    echo "$dir/coverage-summary.json"
}

# Coverage below default thresholds
create_below_threshold_coverage() {
    local dir="$1"
    cat > "$dir/coverage-summary.json" << 'EOF'
{
  "total": {
    "lines": { "total": 100, "covered": 50, "skipped": 0, "pct": 50 },
    "statements": { "total": 100, "covered": 50, "skipped": 0, "pct": 50 },
    "functions": { "total": 20, "covered": 10, "skipped": 0, "pct": 50 },
    "branches": { "total": 30, "covered": 12, "skipped": 0, "pct": 40 }
  }
}
EOF
    echo "$dir/coverage-summary.json"
}

# Coverage that passes custom thresholds but fails defaults
create_custom_threshold_coverage() {
    local dir="$1"
    cat > "$dir/coverage-summary.json" << 'EOF'
{
  "total": {
    "lines": { "total": 100, "covered": 65, "skipped": 0, "pct": 65 },
    "statements": { "total": 100, "covered": 65, "skipped": 0, "pct": 65 },
    "functions": { "total": 20, "covered": 12, "skipped": 0, "pct": 60 },
    "branches": { "total": 30, "covered": 15, "skipped": 0, "pct": 50 }
  }
}
EOF
    echo "$dir/coverage-summary.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Coverage Thresholds Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AboveThreshold_ExitsZero
# --------------------------------------------------
setup
COV="$(create_above_threshold_coverage "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "$COV" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AboveThreshold_ExitsZero"
else
    fail "AboveThreshold_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: BelowThreshold_ExitsOne
# --------------------------------------------------
setup
COV="$(create_below_threshold_coverage "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "$COV" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "BelowThreshold_ExitsOne"
else
    fail "BelowThreshold_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: CustomThresholds_Applied
# --------------------------------------------------
setup
COV="$(create_custom_threshold_coverage "$TMPDIR_ROOT")"
# Use low custom thresholds that the coverage meets
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "$COV" --line-threshold 60 --branch-threshold 50 --function-threshold 60 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CustomThresholds_Applied_PassesWithLowerThresholds"
else
    fail "CustomThresholds_Applied_PassesWithLowerThresholds (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Now verify the same file FAILS with default thresholds
OUTPUT2="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "$COV" 2>&1)" && EXIT_CODE2=$? || EXIT_CODE2=$?
if [[ $EXIT_CODE2 -eq 1 ]]; then
    pass "CustomThresholds_Applied_FailsWithDefaults"
else
    fail "CustomThresholds_Applied_FailsWithDefaults (exit=$EXIT_CODE2, expected 1)"
    echo "  Output: $OUTPUT2"
fi
teardown

# --------------------------------------------------
# Test 4: MissingCoverageFile_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "/nonexistent/coverage.json" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingCoverageFile_ExitsTwo"
else
    fail "MissingCoverageFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: UsageError_MissingArgs_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingArgs_ExitsTwo"
else
    fail "UsageError_MissingArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: HelpFlag_ShowsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_ShowsUsage_ExitsZero"
else
    fail "HelpFlag_ShowsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "coverage-file"; then
    pass "HelpFlag_ShowsUsageText"
else
    fail "HelpFlag_ShowsUsageText (no usage text in output)"
fi
teardown

# --------------------------------------------------
# Test 7: StructuredOutput_ContainsSummary
# --------------------------------------------------
setup
COV="$(create_above_threshold_coverage "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --coverage-file "$COV" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "PASS|lines|branches|functions"; then
    pass "StructuredOutput_ContainsSummary"
else
    fail "StructuredOutput_ContainsSummary (no summary metrics in output)"
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
