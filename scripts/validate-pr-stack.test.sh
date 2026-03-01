#!/usr/bin/env bash
# validate-pr-stack.sh tests
# Tests PR chain validation against GitHub-native stacking

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-pr-stack.sh"

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

# Create a mock gh script that returns predetermined JSON
# Args: $1 = test tmp dir, $2 = JSON output for `gh pr list`
create_mock_gh() {
    local dir="$1"
    local pr_list_json="$2"

    mkdir -p "$dir/mock-bin"
    printf '%s' "$pr_list_json" > "$dir/gh-pr-list-output.json"

    cat > "$dir/mock-bin/gh" <<'GHEOF'
#!/usr/bin/env bash
MOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$1" == "pr" && "$2" == "list" ]]; then
    cat "$MOCK_DIR/gh-pr-list-output.json"
    exit 0
fi
exit 0
GHEOF
    chmod +x "$dir/mock-bin/gh"
}

# Run the script under test with mock PATH
run_script() {
    local test_dir="$1"
    shift
    RESULT_STDOUT=""
    RESULT_STDERR=""
    RESULT_EXIT=0

    local mock_path="$test_dir/mock-bin:$PATH"

    RESULT_STDOUT=$(PATH="$mock_path" bash "$SCRIPT_UNDER_TEST" "$@" 2>"$test_dir/stderr.txt") || RESULT_EXIT=$?
    RESULT_STDERR=$(cat "$test_dir/stderr.txt" 2>/dev/null || true)
}

# Prerequisite: script must exist
if [[ ! -f "$SCRIPT_UNDER_TEST" ]]; then
    echo -e "${RED}FATAL${NC}: Script not found: $SCRIPT_UNDER_TEST"
    echo -e "${RED}All tests will fail - script does not exist${NC}"
    echo ""

    echo "0 4" > "$RESULTS_FILE"

    echo "=== Test Summary ==="
    echo -e "Passed: ${GREEN}0${NC}"
    echo -e "Failed: ${RED}4${NC}"
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
fi

# ============================================================
# TESTS
# ============================================================
echo "=== validate-pr-stack Tests ==="

# Test: validate_pr_stack_NoArgs_ExitsWithUsageError
setup_test_tmp
(
    create_mock_gh "$TEST_TMP" "[]"

    run_script "$TEST_TMP"

    if [[ "$RESULT_EXIT" -eq 2 ]]; then
        pass "validate_pr_stack_NoArgs_ExitsWithUsageError"
    else
        fail "validate_pr_stack_NoArgs_ExitsWithUsageError (exit=$RESULT_EXIT, expected=2, stderr=$RESULT_STDERR)"
    fi
)

# Test: validate_pr_stack_NoPRs_ExitsClean
setup_test_tmp
(
    create_mock_gh "$TEST_TMP" "[]"

    run_script "$TEST_TMP" main

    if [[ "$RESULT_EXIT" -eq 0 ]]; then
        pass "validate_pr_stack_NoPRs_ExitsClean"
    else
        fail "validate_pr_stack_NoPRs_ExitsClean (exit=$RESULT_EXIT, expected=0, stderr=$RESULT_STDERR)"
    fi
)

# Test: validate_pr_stack_HealthyChain_ExitsClean
setup_test_tmp
(
    # A valid chain: main <- feat/step-1 <- feat/step-2 <- feat/step-3
    PR_JSON='[
        {"number": 101, "baseRefName": "main", "headRefName": "feat/step-1", "state": "OPEN"},
        {"number": 102, "baseRefName": "feat/step-1", "headRefName": "feat/step-2", "state": "OPEN"},
        {"number": 103, "baseRefName": "feat/step-2", "headRefName": "feat/step-3", "state": "OPEN"}
    ]'
    create_mock_gh "$TEST_TMP" "$PR_JSON"

    run_script "$TEST_TMP" main

    if [[ "$RESULT_EXIT" -eq 0 ]]; then
        pass "validate_pr_stack_HealthyChain_ExitsClean"
    else
        fail "validate_pr_stack_HealthyChain_ExitsClean (exit=$RESULT_EXIT, expected=0, stdout=$RESULT_STDOUT, stderr=$RESULT_STDERR)"
    fi
)

# Test: validate_pr_stack_BrokenChain_ExitsWithError
setup_test_tmp
(
    # Broken chain: PR 102 targets main instead of feat/step-1
    PR_JSON='[
        {"number": 101, "baseRefName": "main", "headRefName": "feat/step-1", "state": "OPEN"},
        {"number": 102, "baseRefName": "main", "headRefName": "feat/step-2", "state": "OPEN"},
        {"number": 103, "baseRefName": "feat/step-2", "headRefName": "feat/step-3", "state": "OPEN"}
    ]'
    create_mock_gh "$TEST_TMP" "$PR_JSON"

    run_script "$TEST_TMP" main

    if [[ "$RESULT_EXIT" -eq 1 ]]; then
        pass "validate_pr_stack_BrokenChain_ExitsWithError"
    else
        fail "validate_pr_stack_BrokenChain_ExitsWithError (exit=$RESULT_EXIT, expected=1, stdout=$RESULT_STDOUT, stderr=$RESULT_STDERR)"
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
