#!/usr/bin/env bash
# spec-coverage-check.sh — Test Suite
# Validates spec coverage checking for plan compliance.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/spec-coverage-check.sh"
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

    # Mock npx vitest run: always succeeds by default
    cat > "$MOCK_BIN/npx" << 'MOCKEOF'
#!/usr/bin/env bash
# Default mock: print coverage summary and exit 0
echo "Test Files  3 passed"
echo "Tests  12 passed"
echo "Coverage: 85%"
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npx"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a plan file with test references
create_plan_with_tests() {
    local dir="$1"
    mkdir -p "$dir/src"
    # Create actual test files on disk
    echo "// test" > "$dir/src/widget.test.ts"
    echo "// test" > "$dir/src/api.test.ts"

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

### Task 001: Create widget component

**Test file:** `src/widget.test.ts`

### Task 002: Create API client

**Test file:** `src/api.test.ts`
EOF
    echo "$dir/plan.md"
}

# Create a plan referencing a missing test file
create_plan_with_missing_test() {
    local dir="$1"
    mkdir -p "$dir/src"
    echo "// test" > "$dir/src/widget.test.ts"
    # Note: src/missing.test.ts does NOT exist

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

### Task 001: Create widget component

**Test file:** `src/widget.test.ts`

### Task 002: Create missing module

**Test file:** `src/missing.test.ts`
EOF
    echo "$dir/plan.md"
}

# Create a plan with no test references
create_plan_no_tests() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

### Task 001: Setup configuration

No test files referenced.
EOF
    echo "$dir/plan.md"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Spec Coverage Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AllTestsExist_ExitsZero
# --------------------------------------------------
setup
PLAN="$(create_plan_with_tests "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --plan-file "$PLAN" --repo-root "$TMPDIR_ROOT" --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllTestsExist_ExitsZero"
else
    fail "AllTestsExist_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: MissingTestFile_ExitsOne
# --------------------------------------------------
setup
PLAN="$(create_plan_with_missing_test "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --plan-file "$PLAN" --repo-root "$TMPDIR_ROOT" --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingTestFile_ExitsOne"
else
    fail "MissingTestFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: SkipRun_Flag_SkipsExecution
# --------------------------------------------------
setup
PLAN="$(create_plan_with_tests "$TMPDIR_ROOT")"
# Create a failing npx mock — if --skip-run works, it won't be called
cat > "$MOCK_BIN/npx" << 'MOCKEOF'
#!/usr/bin/env bash
echo "npx SHOULD NOT RUN" >&2
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/npx"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --plan-file "$PLAN" --repo-root "$TMPDIR_ROOT" --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipRun_Flag_SkipsExecution"
else
    fail "SkipRun_Flag_SkipsExecution (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "npx SHOULD NOT RUN"; then
    fail "SkipRun_Flag_NpxNotCalled (npx was called despite --skip-run)"
else
    pass "SkipRun_Flag_NpxNotCalled"
fi
teardown

# --------------------------------------------------
# Test 4: NoTestsInPlan_ExitsOne
# --------------------------------------------------
setup
PLAN="$(create_plan_no_tests "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --plan-file "$PLAN" --repo-root "$TMPDIR_ROOT" --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "NoTestsInPlan_ExitsOne"
else
    fail "NoTestsInPlan_ExitsOne (exit=$EXIT_CODE, expected 1)"
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
# Test 6: StructuredOutput_ContainsReport
# --------------------------------------------------
setup
PLAN="$(create_plan_with_tests "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --plan-file "$PLAN" --repo-root "$TMPDIR_ROOT" --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "## |Coverage"; then
    pass "StructuredOutput_ContainsReport"
else
    fail "StructuredOutput_ContainsReport (no report structure in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: HelpFlag_ShowsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_ShowsUsage_ExitsZero"
else
    fail "HelpFlag_ShowsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "plan-file"; then
    pass "HelpFlag_ShowsUsageText"
else
    fail "HelpFlag_ShowsUsageText (no usage text in output)"
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
