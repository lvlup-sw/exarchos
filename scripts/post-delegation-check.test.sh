#!/usr/bin/env bash
# post-delegation-check.test.sh — Tests for post-delegation-check.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/post-delegation-check.sh"
PASS=0
FAIL=0

# Colors
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
MOCK_BIN=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"

    # Create a repo root with worktrees
    REPO_DIR="$TMPDIR_ROOT/repo"
    mkdir -p "$REPO_DIR/.worktrees/task-001-types"
    mkdir -p "$REPO_DIR/.worktrees/task-002-api"

    # Create mock bin directory
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"

    # Mock npm: always succeeds
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper: create a state file with all tasks complete
create_all_complete_state() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "delegate",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" },
    { "id": "task-002", "title": "API", "status": "complete", "branch": "feature/task-002-api", "worktree": ".worktrees/task-002-api" }
  ]
}
EOF
    echo "$dir/state.json"
}

# Helper: create a state file with one incomplete task
create_incomplete_state() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "delegate",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" },
    { "id": "task-002", "title": "API", "status": "in_progress", "branch": "feature/task-002-api", "worktree": ".worktrees/task-002-api" }
  ]
}
EOF
    echo "$dir/state.json"
}

# Helper: create state with no tasks
create_empty_tasks_state() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "delegate",
  "tasks": []
}
EOF
    echo "$dir/state.json"
}

# Helper: create state with tasks that have no worktree field
create_no_worktree_state() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "delegate",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types" }
  ]
}
EOF
    echo "$dir/state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Post-Delegation Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: HappyPath_AllComplete_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_all_complete_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HappyPath_AllComplete_ExitsZero"
else
    fail "HappyPath_AllComplete_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: IncompleteTask_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_incomplete_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "IncompleteTask_ExitsOne"
else
    fail "IncompleteTask_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingStateFile_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "/nonexistent/state.json" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingStateFile_ExitsOne"
else
    fail "MissingStateFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: UsageError_NoArgs_ExitsTwo
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
# Test 5: UsageError_MissingStateFile_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingStateFile_ExitsTwo"
else
    fail "UsageError_MissingStateFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: EmptyTasks_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_empty_tasks_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EmptyTasks_ExitsOne"
else
    fail "EmptyTasks_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: SkipTests_Flag_SkipsWorktreeTests
# --------------------------------------------------
setup
STATE_FILE="$(create_all_complete_state "$TMPDIR_ROOT")"
# Create a failing npm mock
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "npm SHOULD NOT RUN" >&2
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipTests_Flag_SkipsWorktreeTests"
else
    fail "SkipTests_Flag_SkipsWorktreeTests (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "npm SHOULD NOT RUN"; then
    fail "SkipTests_Flag_NpmNotCalled (npm was called despite --skip-tests)"
else
    pass "SkipTests_Flag_NpmNotCalled"
fi
teardown

# --------------------------------------------------
# Test 8: StructuredOutput_MarkdownFormat
# --------------------------------------------------
setup
STATE_FILE="$(create_all_complete_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "\*\*(PASS|FAIL)\*\*"; then
    pass "StructuredOutput_HasPassFailMarkers"
else
    fail "StructuredOutput_HasPassFailMarkers (no PASS/FAIL in output)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no ## heading in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: Idempotent_RunTwice_SameResult
# --------------------------------------------------
setup
STATE_FILE="$(create_all_complete_state "$TMPDIR_ROOT")"
OUTPUT1="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$REPO_DIR" --skip-tests 2>&1)" && EXIT1=$? || EXIT1=$?
OUTPUT2="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$REPO_DIR" --skip-tests 2>&1)" && EXIT2=$? || EXIT2=$?
if [[ "$EXIT1" -eq "$EXIT2" && "$OUTPUT1" == "$OUTPUT2" ]]; then
    pass "Idempotent_RunTwice_SameResult"
else
    fail "Idempotent_RunTwice_SameResult (run1 exit=$EXIT1 vs run2 exit=$EXIT2)"
fi
teardown

# --------------------------------------------------
# Test 10: PerTaskReport_ShowsTaskDetails
# --------------------------------------------------
setup
STATE_FILE="$(create_incomplete_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should mention the incomplete task
if echo "$OUTPUT" | grep -qi "task-002\|in_progress"; then
    pass "PerTaskReport_ShowsIncompleteTaskDetails"
else
    fail "PerTaskReport_ShowsIncompleteTaskDetails (task-002 not in output)"
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
