#!/usr/bin/env bash
# check-post-merge.sh — Test Suite
# Validates post-merge gate check for synthesize → cleanup boundary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-post-merge.sh"
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
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create mock gh that reports all checks passing
create_gh_success_mock() {
    cat > "$MOCK_BIN/gh" << 'MOCKEOF'
#!/usr/bin/env bash
# Mock gh: pr checks returns all SUCCESS
if [[ "${1:-}" == "pr" && "${2:-}" == "checks" ]]; then
    echo '[{"name":"build","state":"SUCCESS"},{"name":"test","state":"SUCCESS"},{"name":"lint","state":"NEUTRAL"}]'
    exit 0
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/gh"
}

# Create mock gh that reports CI failures
create_gh_failure_mock() {
    cat > "$MOCK_BIN/gh" << 'MOCKEOF'
#!/usr/bin/env bash
# Mock gh: pr checks returns a FAILURE
if [[ "${1:-}" == "pr" && "${2:-}" == "checks" ]]; then
    echo '[{"name":"build","state":"SUCCESS"},{"name":"test","state":"FAILURE"},{"name":"lint","state":"SUCCESS"}]'
    exit 0
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/gh"
}

# Create mock npm that succeeds
create_npm_success_mock() {
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"
}

# Create mock npm that fails (test regression)
create_npm_failure_mock() {
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "FAIL: some test broke" >&2
exit 1
MOCKEOF
    chmod +x "$MOCK_BIN/npm"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Post-Merge Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: PostMerge_AllChecksPass_ExitZero
# --------------------------------------------------
setup
create_gh_success_mock
create_npm_success_mock
STDOUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "PostMerge_AllChecksPass_ExitZero"
else
    fail "PostMerge_AllChecksPass_ExitZero (exit=$EXIT_CODE, expected 0)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 2: PostMerge_CIFailing_ExitOne
# --------------------------------------------------
setup
create_gh_failure_mock
create_npm_success_mock
STDOUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "PostMerge_CIFailing_ExitOne"
else
    fail "PostMerge_CIFailing_ExitOne (exit=$EXIT_CODE, expected 1)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 3: PostMerge_TestsRegression_ExitOne
# --------------------------------------------------
setup
create_gh_success_mock
create_npm_failure_mock
STDOUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "PostMerge_TestsRegression_ExitOne"
else
    fail "PostMerge_TestsRegression_ExitOne (exit=$EXIT_CODE, expected 1)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 4: PostMerge_MissingArgs_ExitTwo
# --------------------------------------------------
setup
STDOUT="$(bash "$SCRIPT_UNDER_TEST" 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "PostMerge_MissingArgs_ExitTwo"
else
    fail "PostMerge_MissingArgs_ExitTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 5: PostMerge_HelpFlag_ExitZero
# --------------------------------------------------
setup
STDOUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "PostMerge_HelpFlag_ExitZero"
else
    fail "PostMerge_HelpFlag_ExitZero (exit=$EXIT_CODE, expected 0)"
    echo "  Stdout: $STDOUT"
fi
# Verify usage text is present
if echo "$STDOUT" | grep -q "pr-url"; then
    pass "PostMerge_HelpFlag_ShowsUsage"
else
    fail "PostMerge_HelpFlag_ShowsUsage (no usage text in output)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 6: PostMerge_StructuredFindings_OnStderr
# --------------------------------------------------
setup
create_gh_failure_mock
create_npm_success_mock
STDERR="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>&1 1>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$STDERR" | grep -qE 'FINDING \['; then
    pass "PostMerge_StructuredFindings_OnStderr"
else
    fail "PostMerge_StructuredFindings_OnStderr (no FINDING on stderr)"
    echo "  Stderr: $STDERR"
fi
# Verify finding contains criterion and evidence
if echo "$STDERR" | grep -qE 'criterion='; then
    pass "PostMerge_StructuredFindings_HasCriterion"
else
    fail "PostMerge_StructuredFindings_HasCriterion (no criterion= in FINDING)"
    echo "  Stderr: $STDERR"
fi
teardown

# --------------------------------------------------
# Test 7: PostMerge_SummaryReport_OnStdout
# --------------------------------------------------
setup
create_gh_success_mock
create_npm_success_mock
STDOUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
# Verify summary header
if echo "$STDOUT" | grep -qE "^## "; then
    pass "PostMerge_SummaryReport_HasMarkdownHeading"
else
    fail "PostMerge_SummaryReport_HasMarkdownHeading (no ## heading on stdout)"
    echo "  Stdout: $STDOUT"
fi
# Verify result line
if echo "$STDOUT" | grep -qE "Result: PASS"; then
    pass "PostMerge_SummaryReport_HasResultLine"
else
    fail "PostMerge_SummaryReport_HasResultLine (no Result: PASS on stdout)"
    echo "  Stdout: $STDOUT"
fi
teardown

# --------------------------------------------------
# Test 8: PostMerge_BothFail_TwoFindings
# --------------------------------------------------
setup
create_gh_failure_mock
create_npm_failure_mock
STDERR="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --pr-url "https://github.com/org/repo/pull/42" --merge-sha "abc1234" 2>&1 1>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
FINDING_COUNT="$(echo "$STDERR" | grep -c 'FINDING \[' || true)"
if [[ "$FINDING_COUNT" -ge 2 ]]; then
    pass "PostMerge_BothFail_TwoFindings"
else
    fail "PostMerge_BothFail_TwoFindings (found $FINDING_COUNT findings, expected >=2)"
    echo "  Stderr: $STDERR"
fi
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "PostMerge_BothFail_ExitOne"
else
    fail "PostMerge_BothFail_ExitOne (exit=$EXIT_CODE, expected 1)"
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
