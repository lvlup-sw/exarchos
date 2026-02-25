#!/usr/bin/env bash
# Pre-Synthesis Readiness Check — Test Suite
# Validates all assertions for scripts/pre-synthesis-check.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/pre-synthesis-check.sh"
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

    # Create mock gt and npm commands directory
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"

    # Mock gt log --short: outputs a simple stack
    cat > "$MOCK_BIN/gt" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "log" ]]; then
    echo "main"
    echo "  task/001-types"
    echo "    task/002-api"
    exit 0
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/gt"

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

# Create a valid state file with all tasks complete and reviews passed
create_valid_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "synthesize",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" },
    { "id": "task-2", "title": "Task Two", "status": "complete", "branch": "task/002" },
    { "id": "task-3", "title": "Task Three", "status": "complete", "branch": "task/003" }
  ],
  "reviews": {
    "specReview": { "status": "pass", "timestamp": "2026-01-01T00:00:00Z" },
    "qualityReview": { "status": "approved", "timestamp": "2026-01-01T00:00:00Z" }
  }
}
EOF
    echo "$dir/test.state.json"
}

# Create state with one incomplete task
create_incomplete_task_state() {
    local dir="$1"
    cat > "$dir/incomplete.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "delegate",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" },
    { "id": "task-2", "title": "Task Two", "status": "in-progress", "branch": "task/002" },
    { "id": "task-3", "title": "Task Three", "status": "complete", "branch": "task/003" }
  ],
  "reviews": {
    "specReview": { "status": "pass", "timestamp": "2026-01-01T00:00:00Z" },
    "qualityReview": { "status": "approved", "timestamp": "2026-01-01T00:00:00Z" }
  }
}
EOF
    echo "$dir/incomplete.state.json"
}

# Create state with no review data
create_no_review_state() {
    local dir="$1"
    cat > "$dir/noreview.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "synthesize",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" }
  ],
  "reviews": {}
}
EOF
    echo "$dir/noreview.state.json"
}

# Create state with a task needing fixes
create_needs_fixes_state() {
    local dir="$1"
    cat > "$dir/fixes.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" },
    { "id": "task-2", "title": "Task Two", "status": "needs_fixes", "branch": "task/002" },
    { "id": "task-3", "title": "Task Three", "status": "complete", "branch": "task/003" }
  ],
  "reviews": {
    "specReview": { "status": "pass", "timestamp": "2026-01-01T00:00:00Z" },
    "qualityReview": { "status": "approved", "timestamp": "2026-01-01T00:00:00Z" }
  }
}
EOF
    echo "$dir/fixes.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Pre-Synthesis Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AllTasksComplete_ValidState_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_valid_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllTasksComplete_ValidState_ExitsZero"
else
    fail "AllTasksComplete_ValidState_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: IncompleteTask_OneTaskPending_ExitsNonZero
# --------------------------------------------------
setup
STATE_FILE="$(create_incomplete_task_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "IncompleteTask_OneTaskPending_ExitsNonZero"
else
    fail "IncompleteTask_OneTaskPending_ExitsNonZero (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ReviewNotPassed_MissingReview_ExitsNonZero
# --------------------------------------------------
setup
STATE_FILE="$(create_no_review_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ReviewNotPassed_MissingReview_ExitsNonZero"
else
    fail "ReviewNotPassed_MissingReview_ExitsNonZero (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: OutstandingFixes_FixTask_ExitsNonZero
# --------------------------------------------------
setup
STATE_FILE="$(create_needs_fixes_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "OutstandingFixes_FixTask_ExitsNonZero"
else
    fail "OutstandingFixes_FixTask_ExitsNonZero (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: MissingStateFile_ExitsNonZero
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "/nonexistent/path/state.json" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingStateFile_ExitsNonZero"
else
    fail "MissingStateFile_ExitsNonZero (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify helpful message in output
if echo "$OUTPUT" | grep -qi "not found\|does not exist\|missing"; then
    pass "MissingStateFile_HelpfulMessage"
else
    fail "MissingStateFile_HelpfulMessage (expected 'not found' or similar in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: StructuredOutput_AllChecks_MarkdownFormat
# --------------------------------------------------
setup
STATE_FILE="$(create_valid_state "$TMPDIR_ROOT")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for PASS/FAIL markers
if echo "$OUTPUT" | grep -qE "(PASS|FAIL)"; then
    pass "StructuredOutput_AllChecks_HasPassFailMarkers"
else
    fail "StructuredOutput_AllChecks_HasPassFailMarkers (no PASS/FAIL in output)"
    echo "  Output: $OUTPUT"
fi
# Check for markdown summary heading
if echo "$OUTPUT" | grep -qE "^## |^# "; then
    pass "StructuredOutput_AllChecks_MarkdownHeadings"
else
    fail "StructuredOutput_AllChecks_MarkdownHeadings (no markdown headings in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: SkipTests_Flag_SkipsTestCheck
# --------------------------------------------------
setup
STATE_FILE="$(create_valid_state "$TMPDIR_ROOT")"
# Create a failing npm mock to prove --skip-tests skips it
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "npm SHOULD NOT RUN" >&2
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipTests_Flag_SkipsTestCheck"
else
    fail "SkipTests_Flag_SkipsTestCheck (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify npm was not invoked (no npm output in stderr)
if echo "$OUTPUT" | grep -q "npm SHOULD NOT RUN"; then
    fail "SkipTests_Flag_NpmNotCalled (npm was called despite --skip-tests)"
else
    pass "SkipTests_Flag_NpmNotCalled"
fi
teardown

# --------------------------------------------------
# Test 8: SkipStack_Flag_SkipsStackCheck
# --------------------------------------------------
setup
STATE_FILE="$(create_valid_state "$TMPDIR_ROOT")"
# Create a failing gt mock to prove --skip-stack skips it
cat > "$MOCK_BIN/gt" << 'MOCKEOF'
#!/usr/bin/env bash
echo "gt SHOULD NOT RUN" >&2
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/gt"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipStack_Flag_SkipsStackCheck"
else
    fail "SkipStack_Flag_SkipsStackCheck (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify gt was not invoked
if echo "$OUTPUT" | grep -q "gt SHOULD NOT RUN"; then
    fail "SkipStack_Flag_GtNotCalled (gt was called despite --skip-stack)"
else
    pass "SkipStack_Flag_GtNotCalled"
fi
teardown

# --------------------------------------------------
# Test 9: Idempotent_RunTwice_SameResult
# --------------------------------------------------
setup
STATE_FILE="$(create_valid_state "$TMPDIR_ROOT")"
OUTPUT1="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT1=$? || EXIT1=$?
OUTPUT2="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --skip-tests --skip-stack 2>&1)" && EXIT2=$? || EXIT2=$?
if [[ "$EXIT1" -eq "$EXIT2" && "$OUTPUT1" == "$OUTPUT2" ]]; then
    pass "Idempotent_RunTwice_SameResult"
else
    fail "Idempotent_RunTwice_SameResult (run1 exit=$EXIT1 vs run2 exit=$EXIT2)"
fi
teardown

# --------------------------------------------------
# Test 10: UsageError_NoArgs_ExitsTwo
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
# Test NEW-1: RefactorPolishValidate_CorrectMessage
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/polish.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-refactor",
  "workflowType": "refactor",
  "phase": "polish-validate",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" }
  ],
  "reviews": {
    "specReview": { "status": "pass" },
    "qualityReview": { "status": "approved" }
  }
}
EOF
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$TMPDIR_ROOT/polish.state.json" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "RefactorPolishValidate_CorrectlyRejects"
else
    fail "RefactorPolishValidate_CorrectlyRejects (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify it mentions "polish track" or "no synthesize" or "directly"
if echo "$OUTPUT" | grep -qi "polish\|no synthesize\|directly\|completes directly"; then
    pass "RefactorPolishValidate_MentionsPolishTrack"
else
    fail "RefactorPolishValidate_MentionsPolishTrack (expected mention of polish track)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test NEW-2: RefactorOverhaulPlan_ListsAllTransitions
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/overhaul.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-refactor",
  "workflowType": "refactor",
  "phase": "overhaul-plan",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" }
  ],
  "reviews": {
    "specReview": { "status": "pass" },
    "qualityReview": { "status": "approved" }
  }
}
EOF
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$TMPDIR_ROOT/overhaul.state.json" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "RefactorOverhaulPlan_ExitsOne"
else
    fail "RefactorOverhaulPlan_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Should list remaining transitions including overhaul-delegate
if echo "$OUTPUT" | grep -qi "overhaul-delegate"; then
    pass "RefactorOverhaulPlan_ListsOverhaulDelegate"
else
    fail "RefactorOverhaulPlan_ListsOverhaulDelegate (expected overhaul-delegate in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test NEW-3: DebugValidate_UsesCorrectPhaseName
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/debug.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-debug",
  "workflowType": "debug",
  "phase": "debug-validate",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" }
  ],
  "reviews": {
    "specReview": { "status": "pass" },
    "qualityReview": { "status": "approved" }
  }
}
EOF
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$TMPDIR_ROOT/debug.state.json" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DebugValidate_ExitsOne"
else
    fail "DebugValidate_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Should mention debug-review or synthesize as next steps
if echo "$OUTPUT" | grep -qi "debug-review\|synthesize"; then
    pass "DebugValidate_MentionsNextPhase"
else
    fail "DebugValidate_MentionsNextPhase (expected debug-review or synthesize in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test NEW-4: DebugHotfixValidate_CorrectMessage
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/hotfix.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-debug",
  "workflowType": "debug",
  "phase": "hotfix-validate",
  "tasks": [
    { "id": "task-1", "title": "Task One", "status": "complete", "branch": "task/001" }
  ],
  "reviews": {
    "specReview": { "status": "pass" },
    "qualityReview": { "status": "approved" }
  }
}
EOF
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --state-file "$TMPDIR_ROOT/hotfix.state.json" --skip-tests --skip-stack 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DebugHotfixValidate_ExitsOne"
else
    fail "DebugHotfixValidate_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Should mention synthesize as target
if echo "$OUTPUT" | grep -qi "synthesize\|hotfix"; then
    pass "DebugHotfixValidate_MentionsTarget"
else
    fail "DebugHotfixValidate_MentionsTarget (expected synthesize or hotfix in output)"
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
