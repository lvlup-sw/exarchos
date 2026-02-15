#!/usr/bin/env bash
# Stack Reconstruction Script Tests
# Tests detection, reconstruction, and validation phases

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/reconstruct-stack.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Cleanup all temp dirs on exit
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

# Create a minimal git repo
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

# Create a state file with task definitions
create_state_file() {
    local path="$1"
    local tasks_json="$2"
    cat > "$path" <<STATEEOF
{
  "workflowId": "test-workflow",
  "featureId": "test-feature",
  "phase": "synthesize",
  "tasks": $tasks_json
}
STATEEOF
}

# Create a mock gt script
create_mock_gt() {
    local dir="$1"
    local gt_log_output="$2"

    mkdir -p "$dir/mock-bin"
    cat > "$dir/mock-bin/gt" <<'GTEOF'
#!/usr/bin/env bash
MOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$1" == "log" ]]; then
    cat "$MOCK_DIR/gt-log-output.txt"
    exit 0
elif [[ "$1" == "ls" ]]; then
    if [[ -f "$MOCK_DIR/gt-ls-output.txt" ]]; then
        cat "$MOCK_DIR/gt-ls-output.txt"
    fi
    exit 0
elif [[ "$1" == "track" ]]; then
    echo "MOCK: gt track $*" >> "$MOCK_DIR/gt-commands.log"
    exit 0
elif [[ "$1" == "untrack" ]]; then
    echo "MOCK: gt untrack $*" >> "$MOCK_DIR/gt-commands.log"
    exit 0
elif [[ "$1" == "--version" ]]; then
    echo "gt version 1.0.0-mock"
    exit 0
fi
exit 0
GTEOF
    chmod +x "$dir/mock-bin/gt"

    # Write gt log output (use printf to handle empty strings)
    printf '%s\n' "$gt_log_output" > "$dir/gt-log-output.txt"
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

    # Count all tests as failed
    echo "0 11" > "$RESULTS_FILE"

    echo "=== Test Summary ==="
    echo -e "Passed: ${GREEN}0${NC}"
    echo -e "Failed: ${RED}11${NC}"
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
fi

# ============================================================
# DETECTION TESTS
# ============================================================
echo "=== Detection Tests ==="

# Test: HealthyStack_CleanGtLog_ExitsZero
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    git checkout -b task/002-second --quiet
    echo "task2" > task2.txt
    git add task2.txt
    git commit -m "feat: second task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"},
        {"id": "task-2", "title": "Second Task", "branch": "task/002-second", "status": "complete"}
    ]'

    GT_LOG="  task/002-second
  task/001-first
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if [[ "$RESULT_EXIT" -eq 0 ]]; then
        pass "HealthyStack_CleanGtLog_ExitsZero"
    else
        fail "HealthyStack_CleanGtLog_ExitsZero (exit=$RESULT_EXIT, stderr=$RESULT_STDERR)"
    fi
)

# Test: DivergedBranch_GtLogDiverged_DetectsAndReports
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"}
    ]'

    GT_LOG="  task/001-first (diverged)
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if echo "$RESULT_STDOUT" | grep -qi "diverged"; then
        pass "DivergedBranch_GtLogDiverged_DetectsAndReports"
    else
        fail "DivergedBranch_GtLogDiverged_DetectsAndReports (output=$RESULT_STDOUT)"
    fi
)

# Test: NeedsRestack_GtLogRestack_DetectsAndReports
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"}
    ]'

    GT_LOG="  task/001-first (needs restack)
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if echo "$RESULT_STDOUT" | grep -qi "needs restack"; then
        pass "NeedsRestack_GtLogRestack_DetectsAndReports"
    else
        fail "NeedsRestack_GtLogRestack_DetectsAndReports (output=$RESULT_STDOUT)"
    fi
)

# Test: MissingBranch_ExpectedNotInGtLog_Detects
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"},
        {"id": "task-2", "title": "Second Task", "branch": "task/002-second", "status": "complete"}
    ]'

    GT_LOG="  task/001-first
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if echo "$RESULT_STDOUT" | grep -qi "missing\|not tracked\|not found"; then
        pass "MissingBranch_ExpectedNotInGtLog_Detects"
    else
        fail "MissingBranch_ExpectedNotInGtLog_Detects (output=$RESULT_STDOUT)"
    fi
)

# ============================================================
# RECONSTRUCTION TESTS
# ============================================================
echo ""
echo "=== Reconstruction Tests ==="

# Test: Reconstruct_DivergedBranches_FixesStack
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    git checkout -b task/002-second --quiet
    echo "task2" > task2.txt
    git add task2.txt
    git commit -m "feat: second task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"},
        {"id": "task-2", "title": "Second Task", "branch": "task/002-second", "status": "complete"}
    ]'

    GT_LOG="  task/002-second (diverged)
  task/001-first (diverged)
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if [[ -f "$TEST_TMP/gt-commands.log" ]] && grep -q "gt track" "$TEST_TMP/gt-commands.log"; then
        pass "Reconstruct_DivergedBranches_FixesStack"
    else
        fail "Reconstruct_DivergedBranches_FixesStack (no gt track commands found, log=$(cat "$TEST_TMP/gt-commands.log" 2>/dev/null || echo 'none'))"
    fi
)

# Test: Reconstruct_IdempotentRerun_NoChanges
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"}
    ]'

    GT_LOG="  task/001-first
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"
    EXIT1=$RESULT_EXIT

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"
    EXIT2=$RESULT_EXIT

    if [[ "$EXIT1" -eq 0 && "$EXIT2" -eq 0 ]]; then
        pass "Reconstruct_IdempotentRerun_NoChanges"
    else
        fail "Reconstruct_IdempotentRerun_NoChanges (exit1=$EXIT1, exit2=$EXIT2)"
    fi
)

# ============================================================
# VALIDATION TESTS
# ============================================================
echo ""
echo "=== Validation Tests ==="

# Test: Validate_CleanStack_ParentChainCorrect
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    git checkout -b task/002-second --quiet
    echo "task2" > task2.txt
    git add task2.txt
    git commit -m "feat: second task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"},
        {"id": "task-2", "title": "Second Task", "branch": "task/002-second", "status": "complete"}
    ]'

    GT_LOG="  task/002-second
  task/001-first
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if [[ "$RESULT_EXIT" -eq 0 ]] && echo "$RESULT_STDOUT" | grep -qi "healthy\|valid\|clean"; then
        pass "Validate_CleanStack_ParentChainCorrect"
    else
        fail "Validate_CleanStack_ParentChainCorrect (exit=$RESULT_EXIT, output=$RESULT_STDOUT)"
    fi
)

# Test: Validate_FailedReconstruction_ExitsNonZero
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"},
        {"id": "task-2", "title": "Second Task", "branch": "task/002-second", "status": "complete"}
    ]'

    # Custom mock gt that always returns diverged (simulating failed reconstruction)
    create_mock_gt "$TEST_TMP" ""
    cat > "$TEST_TMP/mock-bin/gt" <<'GTEOF'
#!/usr/bin/env bash
MOCK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$1" == "log" ]]; then
    echo "  task/001-first (diverged)"
    echo "  main"
    exit 0
elif [[ "$1" == "track" || "$1" == "untrack" ]]; then
    echo "MOCK: gt $*" >> "$MOCK_DIR/gt-commands.log"
    exit 0
elif [[ "$1" == "--version" ]]; then
    echo "gt version 1.0.0-mock"
    exit 0
fi
exit 0
GTEOF
    chmod +x "$TEST_TMP/mock-bin/gt"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if [[ "$RESULT_EXIT" -eq 1 ]]; then
        pass "Validate_FailedReconstruction_ExitsNonZero"
    else
        fail "Validate_FailedReconstruction_ExitsNonZero (exit=$RESULT_EXIT, expected=1)"
    fi
)

# ============================================================
# EDGE CASE TESTS
# ============================================================
echo ""
echo "=== Edge Case Tests ==="

# Test: EmptyState_NoTasks_ExitsZero
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"

    create_state_file "$TEST_TMP/state.json" '[]'

    GT_LOG="  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json"

    if [[ "$RESULT_EXIT" -eq 0 ]]; then
        pass "EmptyState_NoTasks_ExitsZero"
    else
        fail "EmptyState_NoTasks_ExitsZero (exit=$RESULT_EXIT, stderr=$RESULT_STDERR)"
    fi
)

# Test: DryRun_NoBranchChanges_ReportsOnly
setup_test_tmp
(
    create_test_repo "$TEST_TMP/repo"
    cd "$TEST_TMP/repo"

    git checkout -b task/001-first --quiet
    echo "task1" > task1.txt
    git add task1.txt
    git commit -m "feat: first task" --quiet
    TASK1_SHA=$(git rev-parse task/001-first)

    create_state_file "$TEST_TMP/state.json" '[
        {"id": "task-1", "title": "First Task", "branch": "task/001-first", "status": "complete"}
    ]'

    GT_LOG="  task/001-first (diverged)
  main"
    create_mock_gt "$TEST_TMP" "$GT_LOG"

    run_script "$TEST_TMP" --repo-root "$TEST_TMP/repo" --state-file "$TEST_TMP/state.json" --dry-run

    # Verify no gt track/untrack commands were actually run
    if [[ -f "$TEST_TMP/gt-commands.log" ]]; then
        fail "DryRun_NoBranchChanges_ReportsOnly (gt commands were executed: $(cat "$TEST_TMP/gt-commands.log"))"
    else
        # Verify the script actually ran (exit code must be 0, not 127)
        if [[ "$RESULT_EXIT" -eq 127 ]]; then
            fail "DryRun_NoBranchChanges_ReportsOnly (script not found)"
        else
            # Also verify branch wasn't moved
            cd "$TEST_TMP/repo"
            CURRENT_SHA=$(git rev-parse task/001-first)
            if [[ "$CURRENT_SHA" == "$TASK1_SHA" ]]; then
                pass "DryRun_NoBranchChanges_ReportsOnly"
            else
                fail "DryRun_NoBranchChanges_ReportsOnly (branch was moved from $TASK1_SHA to $CURRENT_SHA)"
            fi
        fi
    fi
)

# Test: UsageError_NoArgs_ExitsTwo
setup_test_tmp
(
    create_mock_gt "$TEST_TMP" ""

    run_script "$TEST_TMP"

    if [[ "$RESULT_EXIT" -eq 2 ]]; then
        pass "UsageError_NoArgs_ExitsTwo"
    else
        fail "UsageError_NoArgs_ExitsTwo (exit=$RESULT_EXIT, expected=2)"
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
