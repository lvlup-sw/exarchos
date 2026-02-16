#!/usr/bin/env bash
# check-tdd-compliance.sh — Test Suite
# Validates test-first git history order checking.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-tdd-compliance.sh"
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

    # Create a git repo with controlled commit history
    cd "$TMPDIR_ROOT"
    git init -b main --quiet
    git config user.email "test@test.com"
    git config user.name "Test"

    # Initial commit on main
    echo "# README" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a compliant branch: test file committed before/with implementation
create_compliant_branch() {
    cd "$TMPDIR_ROOT"
    git checkout -b feature/compliant --quiet

    # Commit 1: test file first
    mkdir -p src
    echo "// test" > src/widget.test.ts
    git add src/widget.test.ts
    git commit -m "test: add widget tests" --quiet

    # Commit 2: implementation
    echo "// impl" > src/widget.ts
    git add src/widget.ts
    git commit -m "feat: add widget" --quiet
}

# Create a violating branch: implementation committed without any test
create_violating_branch() {
    cd "$TMPDIR_ROOT"
    git checkout -b feature/violating --quiet

    # Commit 1: implementation only (no test)
    mkdir -p src
    echo "// impl" > src/api.ts
    git add src/api.ts
    git commit -m "feat: add api" --quiet

    # Commit 2: test added later
    echo "// test" > src/api.test.ts
    git add src/api.test.ts
    git commit -m "test: add api tests" --quiet
}

# Create a mixed-commit branch: test and impl in same commit (OK)
create_mixed_commit_branch() {
    cd "$TMPDIR_ROOT"
    git checkout -b feature/mixed --quiet

    # Single commit with both test and implementation
    mkdir -p src
    echo "// test" > src/util.test.ts
    echo "// impl" > src/util.ts
    git add src/util.test.ts src/util.ts
    git commit -m "feat: add util with tests" --quiet
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== TDD Compliance Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: TestFirst_Compliant_ExitsZero
# --------------------------------------------------
setup
create_compliant_branch
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" --branch "feature/compliant" --base-branch "main" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "TestFirst_Compliant_ExitsZero"
else
    fail "TestFirst_Compliant_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: ImplFirst_Violation_ExitsOne
# --------------------------------------------------
setup
create_violating_branch
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" --branch "feature/violating" --base-branch "main" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ImplFirst_Violation_ExitsOne"
else
    fail "ImplFirst_Violation_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the violation
if echo "$OUTPUT" | grep -qi "violation\|FAIL"; then
    pass "ImplFirst_Violation_ReportsViolation"
else
    fail "ImplFirst_Violation_ReportsViolation (no violation reported)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MixedCommit_TestAndImpl_ExitsZero
# --------------------------------------------------
setup
create_mixed_commit_branch
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" --branch "feature/mixed" --base-branch "main" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MixedCommit_TestAndImpl_ExitsZero"
else
    fail "MixedCommit_TestAndImpl_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: UsageError_MissingArgs_ExitsTwo
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
# Test 5: HelpFlag_ShowsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_ShowsUsage_ExitsZero"
else
    fail "HelpFlag_ShowsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "repo-root"; then
    pass "HelpFlag_ShowsUsageText"
else
    fail "HelpFlag_ShowsUsageText (no usage text in output)"
fi
teardown

# --------------------------------------------------
# Test 6: StructuredOutput_ContainsPerCommitReport
# --------------------------------------------------
setup
create_compliant_branch
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" --branch "feature/compliant" --base-branch "main" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "##.*Compliance|commit"; then
    pass "StructuredOutput_ContainsPerCommitReport"
else
    fail "StructuredOutput_ContainsPerCommitReport (no per-commit report)"
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
