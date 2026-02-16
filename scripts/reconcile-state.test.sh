#!/usr/bin/env bash
# Reconcile State — Test Suite
# Validates all assertions for scripts/reconcile-state.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/reconcile-state.sh"
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
GIT_REPO=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"

    # Create a real git repo for branch/worktree testing
    GIT_REPO="$TMPDIR_ROOT/repo"
    mkdir -p "$GIT_REPO"
    git -C "$GIT_REPO" init -q
    git -C "$GIT_REPO" config user.email "test@test.com"
    git -C "$GIT_REPO" config user.name "Test"
    git -C "$GIT_REPO" commit --allow-empty -m "initial" -q

    # Create some branches
    git -C "$GIT_REPO" branch task/001-types
    git -C "$GIT_REPO" branch task/002-api
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a consistent state file (branches and worktrees match git reality)
create_consistent_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "workflowType": "feature",
  "phase": "delegate",
  "tasks": [
    { "id": "001", "title": "Define types", "status": "complete", "branch": "task/001-types" },
    { "id": "002", "title": "Build API", "status": "in-progress", "branch": "task/002-api" }
  ],
  "worktrees": {}
}
EOF
    echo "$dir/test.state.json"
}

# Create a state file referencing a branch that does not exist
create_missing_branch_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "workflowType": "feature",
  "phase": "delegate",
  "tasks": [
    { "id": "001", "title": "Define types", "status": "complete", "branch": "task/001-types" },
    { "id": "002", "title": "Build API", "status": "in-progress", "branch": "task/999-nonexistent" }
  ],
  "worktrees": {}
}
EOF
    echo "$dir/test.state.json"
}

# Create a state file referencing a worktree that does not exist
create_missing_worktree_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "workflowType": "feature",
  "phase": "delegate",
  "tasks": [
    { "id": "001", "title": "Define types", "status": "complete", "branch": "task/001-types" }
  ],
  "worktrees": {
    "wt-001": { "branch": "task/001-types", "taskId": "001", "status": "active", "path": "/tmp/nonexistent-worktree-path" }
  }
}
EOF
    echo "$dir/test.state.json"
}

# Create a state file with an invalid phase for the workflow type
create_invalid_phase_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "workflowType": "feature",
  "phase": "triage",
  "tasks": [],
  "worktrees": {}
}
EOF
    echo "$dir/test.state.json"
}

# Create a state file with empty tasks
create_empty_tasks_state() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "workflowType": "feature",
  "phase": "ideate",
  "tasks": [],
  "worktrees": {}
}
EOF
    echo "$dir/test.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Reconcile State Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ConsistentState_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_consistent_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ConsistentState_ExitsZero"
else
    fail "ConsistentState_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: MissingBranch_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_missing_branch_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingBranch_ExitsOne"
else
    fail "MissingBranch_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the missing branch
if echo "$OUTPUT" | grep -qi "task/999-nonexistent"; then
    pass "MissingBranch_MentionedInOutput"
else
    fail "MissingBranch_MentionedInOutput (expected 'task/999-nonexistent' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingWorktree_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_missing_worktree_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingWorktree_ExitsOne"
else
    fail "MissingWorktree_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the missing worktree
if echo "$OUTPUT" | grep -qi "nonexistent-worktree\|wt-001\|worktree"; then
    pass "MissingWorktree_MentionedInOutput"
else
    fail "MissingWorktree_MentionedInOutput (expected worktree reference in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: InvalidPhase_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_invalid_phase_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InvalidPhase_ExitsOne"
else
    fail "InvalidPhase_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions invalid phase
if echo "$OUTPUT" | grep -qi "triage\|invalid.*phase\|phase.*invalid"; then
    pass "InvalidPhase_MentionedInOutput"
else
    fail "InvalidPhase_MentionedInOutput (expected 'triage' or 'invalid phase' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: EmptyTaskArray_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_empty_tasks_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "EmptyTaskArray_ExitsZero"
else
    fail "EmptyTaskArray_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UsageError_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_ExitsTwo"
else
    fail "UsageError_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: OutputShowsDiscrepancies
# --------------------------------------------------
setup
STATE_FILE="$(create_missing_branch_state "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$GIT_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should have structured output with PASS/FAIL markers
if echo "$OUTPUT" | grep -qE "(PASS|FAIL)"; then
    pass "OutputShowsDiscrepancies_HasPassFailMarkers"
else
    fail "OutputShowsDiscrepancies_HasPassFailMarkers (no PASS/FAIL in output)"
    echo "  Output: $OUTPUT"
fi
# Should have markdown heading
if echo "$OUTPUT" | grep -qE "^## |^# "; then
    pass "OutputShowsDiscrepancies_HasMarkdownHeadings"
else
    fail "OutputShowsDiscrepancies_HasMarkdownHeadings (no markdown headings in output)"
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
