#!/usr/bin/env bash
# extract-fix-tasks.test.sh — Tests for extract-fix-tasks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/extract-fix-tasks.sh"
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

setup() {
    TMPDIR_ROOT="$(mktemp -d)"

    # Create a repo root with worktrees
    REPO_DIR="$TMPDIR_ROOT/repo"
    mkdir -p "$REPO_DIR/.worktrees/task-001-types"
    mkdir -p "$REPO_DIR/.worktrees/task-002-api"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper: create state file with review findings
create_state_with_findings() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" },
    { "id": "task-002", "title": "API", "status": "complete", "branch": "feature/task-002-api", "worktree": ".worktrees/task-002-api" }
  ],
  "reviews": {
    "specReview": {
      "status": "fail",
      "findings": [
        { "severity": "HIGH", "file": "src/types/user.ts", "line": 42, "description": "Missing required field validation" },
        { "severity": "MEDIUM", "file": "src/api/endpoints.ts", "line": 15, "description": "Unhandled error case in POST handler" }
      ]
    },
    "qualityReview": {
      "status": "fail",
      "findings": [
        { "severity": "LOW", "file": "src/types/user.ts", "line": 10, "description": "Unused import statement" }
      ]
    }
  }
}
EOF
    echo "$dir/state.json"
}

# Helper: create state with no findings
create_state_no_findings() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" }
  ],
  "reviews": {
    "specReview": { "status": "pass", "findings": [] },
    "qualityReview": { "status": "pass", "findings": [] }
  }
}
EOF
    echo "$dir/state.json"
}

# Helper: create a standalone review report file
create_review_report() {
    local dir="$1"
    cat > "$dir/review-report.json" << 'EOF'
{
  "findings": [
    { "severity": "HIGH", "file": "src/types/user.ts", "line": 42, "description": "Missing required field validation" },
    { "severity": "MEDIUM", "file": "src/api/endpoints.ts", "line": 15, "description": "Unhandled error case in POST handler" }
  ]
}
EOF
    echo "$dir/review-report.json"
}

# Helper: create state file with findings and a SINGLE worktree
create_state_single_worktree_with_findings() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" }
  ],
  "reviews": {
    "specReview": {
      "status": "fail",
      "findings": [
        { "severity": "HIGH", "file": "src/types/user.ts", "line": 42, "description": "Missing required field validation" },
        { "severity": "MEDIUM", "file": "src/api/endpoints.ts", "line": 15, "description": "Unhandled error case in POST handler" }
      ]
    },
    "qualityReview": {
      "status": "fail",
      "findings": [
        { "severity": "LOW", "file": "src/types/user.ts", "line": 10, "description": "Unused import statement" }
      ]
    }
  }
}
EOF
    echo "$dir/state.json"
}

# Helper: create state with empty reviews
create_state_empty_reviews() {
    local dir="$1"
    cat > "$dir/state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" }
  ],
  "reviews": {}
}
EOF
    echo "$dir/state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Extract Fix Tasks Tests ==="
echo ""

# --------------------------------------------------
# Test 1: HappyPath_FindingsExist_ExitsZero_OutputsJSON
# --------------------------------------------------
setup
STATE_FILE="$(create_state_single_worktree_with_findings "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HappyPath_FindingsExist_ExitsZero"
else
    fail "HappyPath_FindingsExist_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify output is valid JSON array
if echo "$OUTPUT" | jq 'type == "array"' 2>/dev/null | grep -q "true"; then
    pass "HappyPath_OutputIsJSONArray"
else
    fail "HappyPath_OutputIsJSONArray (output is not a JSON array)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: FindingFields_HasRequiredFields
# --------------------------------------------------
setup
STATE_FILE="$(create_state_single_worktree_with_findings "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check that each fix task has the required fields
FIELD_CHECK="$(echo "$OUTPUT" | jq '.[0] | [has("id"), has("file"), has("description"), has("severity")] | all' 2>/dev/null)"
if [[ "$FIELD_CHECK" == "true" ]]; then
    pass "FindingFields_HasRequiredFields"
else
    fail "FindingFields_HasRequiredFields (missing required fields)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: WorktreeMapping_SingleWorktree_AssignsCorrectly
# --------------------------------------------------
setup
STATE_FILE="$(create_state_single_worktree_with_findings "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Verify worktree field is present
WORKTREE_PRESENT="$(echo "$OUTPUT" | jq '.[0] | has("worktree")' 2>/dev/null)"
if [[ "$WORKTREE_PRESENT" == "true" ]]; then
    pass "WorktreeMapping_HasWorktreeField"
else
    fail "WorktreeMapping_HasWorktreeField (no worktree field in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: NoFindings_EmptyArray_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_state_no_findings "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NoFindings_ExitsZero"
else
    fail "NoFindings_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Should output an empty array
ARRAY_LEN="$(echo "$OUTPUT" | jq 'length' 2>/dev/null)"
if [[ "$ARRAY_LEN" == "0" ]]; then
    pass "NoFindings_EmptyArray"
else
    fail "NoFindings_EmptyArray (expected empty array, got length=$ARRAY_LEN)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: ReviewReportFile_UsesExternalReport
# --------------------------------------------------
setup
STATE_FILE="$(create_state_no_findings "$TMPDIR_ROOT")"
REPORT_FILE="$(create_review_report "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --review-report "$REPORT_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ReviewReportFile_ExitsZero"
else
    fail "ReviewReportFile_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Should have findings from the report
ARRAY_LEN="$(echo "$OUTPUT" | jq 'length' 2>/dev/null)"
if [[ "$ARRAY_LEN" -gt 0 ]]; then
    pass "ReviewReportFile_HasFindings"
else
    fail "ReviewReportFile_HasFindings (expected findings from report file)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UsageError_NoArgs_ExitsTwo
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
# Test 7: UsageError_MissingStateFile_ExitsTwo
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
# Test 8: ParseError_InvalidJSON_ExitsOne
# --------------------------------------------------
setup
echo "NOT VALID JSON" > "$TMPDIR_ROOT/bad.json"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$TMPDIR_ROOT/bad.json" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ParseError_InvalidJSON_ExitsOne"
else
    fail "ParseError_InvalidJSON_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: Idempotent_RunTwice_SameResult
# --------------------------------------------------
setup
STATE_FILE="$(create_state_single_worktree_with_findings "$TMPDIR_ROOT")"
OUTPUT1="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$REPO_DIR" 2>&1)" && EXIT1=$? || EXIT1=$?
OUTPUT2="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --repo-root "$REPO_DIR" 2>&1)" && EXIT2=$? || EXIT2=$?
if [[ "$EXIT1" -eq "$EXIT2" && "$OUTPUT1" == "$OUTPUT2" ]]; then
    pass "Idempotent_RunTwice_SameResult"
else
    fail "Idempotent_RunTwice_SameResult (run1 exit=$EXIT1 vs run2 exit=$EXIT2)"
fi
teardown

# --------------------------------------------------
# Test 10: MissingStateFile_Path_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "/nonexistent/state.json" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingStateFile_Path_ExitsOne"
else
    fail "MissingStateFile_Path_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: MultipleWorktrees_WithFindings_FailsFast
# --------------------------------------------------
setup
STATE_FILE="$(create_state_with_findings "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$STATE_FILE" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MultipleWorktrees_WithFindings_FailsFast"
else
    fail "MultipleWorktrees_WithFindings_FailsFast (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify error message mentions worktrees
if echo "$OUTPUT" | grep -qi "worktrees detected"; then
    pass "MultipleWorktrees_ErrorMessageMentionsWorktrees"
else
    fail "MultipleWorktrees_ErrorMessageMentionsWorktrees"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 12: MultipleWorktrees_NoFindings_ExitsZero
# --------------------------------------------------
setup
STATE_FILE="$(create_state_no_findings "$TMPDIR_ROOT")"
# Replace the single-worktree fixture with a multi-worktree one that has no findings
cat > "$TMPDIR_ROOT/multi-no-findings.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "review",
  "tasks": [
    { "id": "task-001", "title": "Types", "status": "complete", "branch": "feature/task-001-types", "worktree": ".worktrees/task-001-types" },
    { "id": "task-002", "title": "API", "status": "complete", "branch": "feature/task-002-api", "worktree": ".worktrees/task-002-api" }
  ],
  "reviews": {
    "specReview": { "status": "pass", "findings": [] },
    "qualityReview": { "status": "pass", "findings": [] }
  }
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" \
    --state-file "$TMPDIR_ROOT/multi-no-findings.json" \
    --repo-root "$REPO_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MultipleWorktrees_NoFindings_ExitsZero"
else
    fail "MultipleWorktrees_NoFindings_ExitsZero (exit=$EXIT_CODE, expected 0)"
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
