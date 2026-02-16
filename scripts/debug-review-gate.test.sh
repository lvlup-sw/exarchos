#!/usr/bin/env bash
# Debug Review Gate — Test Suite
# Validates all assertions for scripts/debug-review-gate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/debug-review-gate.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Use a shared results file so subshell results propagate
RESULTS_FILE="$(mktemp)"
echo "0 0" > "$RESULTS_FILE"

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    local counts
    counts=$(cat "$RESULTS_FILE")
    local p f
    p=$(echo "$counts" | awk '{print $1}')
    f=$(echo "$counts" | awk '{print $2}')
    echo "$(( p + 1 )) $f" > "$RESULTS_FILE"
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    local counts
    counts=$(cat "$RESULTS_FILE")
    local p f
    p=$(echo "$counts" | awk '{print $1}')
    f=$(echo "$counts" | awk '{print $2}')
    echo "$p $(( f + 1 ))" > "$RESULTS_FILE"
}

# ============================================================
# TEST HELPERS
# ============================================================

ALL_TMPS=()
cleanup() {
    for d in "${ALL_TMPS[@]+"${ALL_TMPS[@]}"}"; do
        if [[ -n "$d" && -d "$d" ]]; then
            rm -rf "$d"
        fi
    done
    rm -f "$RESULTS_FILE"
}
trap cleanup EXIT

setup_test_tmp() {
    TEST_TMP="$(mktemp -d)"
    ALL_TMPS+=("$TEST_TMP")
}

# Create a minimal git repo with an initial commit on main
create_test_repo() {
    local dir="$1"
    mkdir -p "$dir"
    cd "$dir"
    git init -b main --quiet
    git config user.email "test@test.com"
    git config user.name "Test"

    echo "initial" > README.md
    git add README.md
    git commit -m "initial commit" --quiet
}

# Create mock npm that succeeds and reports test count
create_mock_npm_pass() {
    local dir="$1"
    local test_count="${2:-10}"
    mkdir -p "$dir/mock-bin"
    cat > "$dir/mock-bin/npm" << MOCKEOF
#!/usr/bin/env bash
echo "Tests: $test_count passed"
exit 0
MOCKEOF
    chmod +x "$dir/mock-bin/npm"
}

# Create mock npm that fails
create_mock_npm_fail() {
    local dir="$1"
    mkdir -p "$dir/mock-bin"
    cat > "$dir/mock-bin/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "Tests: 3 failed, 7 passed"
exit 1
MOCKEOF
    chmod +x "$dir/mock-bin/npm"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Debug Review Gate Tests ==="
echo ""

# --------------------------------------------------
# Test 1: NewTestsAdded_ExitsZero
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    # Create a fix branch with new test files
    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    echo "import { describe, it, expect } from 'vitest'; describe('login', () => { it('works', () => { expect(true).toBe(true); }); });" > login-fix.test.ts
    git add login-fix.ts login-fix.test.ts
    git commit -m "fix: login bug with test" --quiet

    create_mock_npm_pass "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 0 ]]; then
        pass "NewTestsAdded_ExitsZero"
    else
        fail "NewTestsAdded_ExitsZero (exit=$EXIT_CODE, expected 0)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 2: NoNewTests_ExitsOne
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    # Create a fix branch WITHOUT test files
    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    git add login-fix.ts
    git commit -m "fix: login bug without test" --quiet

    create_mock_npm_pass "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 1 ]]; then
        pass "NoNewTests_ExitsOne"
    else
        fail "NoNewTests_ExitsOne (exit=$EXIT_CODE, expected 1)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 3: TestsPass_ExitsZero
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    echo "describe('login', () => { it('works', () => {}); });" > login-fix.test.ts
    git add login-fix.ts login-fix.test.ts
    git commit -m "fix: login bug with test" --quiet

    create_mock_npm_pass "$TEST_TMP" 10

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 0 ]]; then
        pass "TestsPass_ExitsZero"
    else
        fail "TestsPass_ExitsZero (exit=$EXIT_CODE, expected 0)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 4: TestsFail_ExitsOne
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    echo "describe('login', () => { it('works', () => {}); });" > login-fix.test.ts
    git add login-fix.ts login-fix.test.ts
    git commit -m "fix: login bug with test" --quiet

    create_mock_npm_fail "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 1 ]]; then
        pass "TestsFail_ExitsOne"
    else
        fail "TestsFail_ExitsOne (exit=$EXIT_CODE, expected 1)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 5: SkipRun_Flag_SkipsExecution
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    echo "describe('login', () => { it('works', () => {}); });" > login-fix.test.ts
    git add login-fix.ts login-fix.test.ts
    git commit -m "fix: login bug with test" --quiet

    # Create a FAILING npm mock — if --skip-run works, this won't be called
    create_mock_npm_fail "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 0 ]]; then
        pass "SkipRun_Flag_SkipsExecution"
    else
        fail "SkipRun_Flag_SkipsExecution (exit=$EXIT_CODE, expected 0)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 6: UsageError_MissingArgs_ExitsTwo
# --------------------------------------------------
setup_test_tmp
(
    OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 2 ]]; then
        pass "UsageError_MissingArgs_ExitsTwo"
    else
        fail "UsageError_MissingArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 7: OutputContainsMarkdown
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b fix/login-bug --quiet
    echo "export function fixLogin() { return true; }" > login-fix.ts
    echo "describe('login', () => { it('works', () => {}); });" > login-fix.test.ts
    git add login-fix.ts login-fix.test.ts
    git commit -m "fix: login bug with test" --quiet

    create_mock_npm_pass "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if echo "$OUTPUT" | grep -qE "^## "; then
        pass "OutputContainsMarkdown"
    else
        fail "OutputContainsMarkdown (no markdown heading in output)"
        echo "  Output: $OUTPUT"
    fi
)

# --------------------------------------------------
# Test 8: ShellTestFiles_AlsoDetected
# --------------------------------------------------
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b fix/script-bug --quiet
    echo "#!/bin/bash" > fix.sh
    echo "#!/bin/bash" > fix.test.sh
    git add fix.sh fix.test.sh
    git commit -m "fix: script bug with shell test" --quiet

    create_mock_npm_pass "$TEST_TMP"

    OUTPUT="$(PATH="$TEST_TMP/mock-bin:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$TEST_TMP/repo" --base-branch main --skip-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
    if [[ $EXIT_CODE -eq 0 ]]; then
        pass "ShellTestFiles_AlsoDetected"
    else
        fail "ShellTestFiles_AlsoDetected (exit=$EXIT_CODE, expected 0)"
        echo "  Output: $OUTPUT"
    fi
)

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "=== Test Summary ==="
FINAL_COUNTS=$(cat "$RESULTS_FILE")
PASS=$(echo "$FINAL_COUNTS" | awk '{print $1}')
FAIL=$(echo "$FINAL_COUNTS" | awk '{print $2}')
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
