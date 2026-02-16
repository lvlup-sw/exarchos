#!/usr/bin/env bash
# Review Verdict — Test Suite
# Validates all assertions for scripts/review-verdict.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/review-verdict.sh"
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

# ============================================================
# TEST CASES
# ============================================================

echo "=== Review Verdict Tests ==="
echo ""

# --------------------------------------------------
# Test 1: NoHighFindings_AllLow_ExitsZero (APPROVED)
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 0 --medium 2 --low 5 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NoHighFindings_AllLow_ExitsZero"
else
    fail "NoHighFindings_AllLow_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: HighFindingsPresent_ExitsOne (NEEDS_FIXES)
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 3 --medium 1 --low 0 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "HighFindingsPresent_ExitsOne"
else
    fail "HighFindingsPresent_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: BlockedFlag_ExitsTwo (BLOCKED)
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 0 --medium 0 --low 0 --blocked "Architecture redesign needed" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "BlockedFlag_ExitsTwo"
else
    fail "BlockedFlag_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
# Verify output includes the blocking reason
if echo "$OUTPUT" | grep -q "Architecture redesign needed"; then
    pass "BlockedFlag_IncludesReason"
else
    fail "BlockedFlag_IncludesReason (expected blocking reason in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: FindingsFile_ParsesJSON_CorrectVerdict
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/findings.json" << 'EOF'
{"high": 2, "medium": 1, "low": 3}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --findings-file "$TMPDIR_ROOT/findings.json" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "FindingsFile_ParsesJSON_CorrectVerdict"
else
    fail "FindingsFile_ParsesJSON_CorrectVerdict (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: ZeroFindings_ExitsZero (APPROVED)
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 0 --medium 0 --low 0 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ZeroFindings_ExitsZero"
else
    fail "ZeroFindings_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: OutputContainsVerdict_MarkdownFormat
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 0 --medium 1 --low 2 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for markdown heading with verdict
if echo "$OUTPUT" | grep -qE "^## Review Verdict:"; then
    pass "OutputContainsVerdict_MarkdownHeading"
else
    fail "OutputContainsVerdict_MarkdownHeading (no '## Review Verdict:' in output)"
    echo "  Output: $OUTPUT"
fi
# Check APPROVED appears in output for no-HIGH case
if echo "$OUTPUT" | grep -q "APPROVED"; then
    pass "OutputContainsVerdict_ApprovedLabel"
else
    fail "OutputContainsVerdict_ApprovedLabel (expected APPROVED in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_NoArgs_ExitsTwo
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
# Test 8: NeedsFixesOutput_ContainsRoutingInstruction
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --high 2 --medium 0 --low 0 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "NEEDS_FIXES"; then
    pass "NeedsFixesOutput_ContainsVerdictLabel"
else
    fail "NeedsFixesOutput_ContainsVerdictLabel (expected NEEDS_FIXES in output)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "delegate\|fixes"; then
    pass "NeedsFixesOutput_ContainsRoutingInstruction"
else
    fail "NeedsFixesOutput_ContainsRoutingInstruction (expected routing instruction in output)"
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
