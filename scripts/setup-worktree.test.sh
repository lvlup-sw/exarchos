#!/usr/bin/env bash
# setup-worktree.test.sh — Tests for setup-worktree.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/setup-worktree.sh"
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

    # Create a real git repo as repo root
    REPO_DIR="$TMPDIR_ROOT/repo"
    mkdir -p "$REPO_DIR"
    git -C "$REPO_DIR" init -b main --quiet
    git -C "$REPO_DIR" config user.email "test@test.com"
    git -C "$REPO_DIR" config user.name "Test"
    # Add an initial commit so branches can be created
    echo "init" > "$REPO_DIR/README.md"
    git -C "$REPO_DIR" add README.md
    git -C "$REPO_DIR" commit -m "init" --quiet

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
        # Clean up any worktrees before removing repo
        if [[ -d "$REPO_DIR/.worktrees" ]]; then
            for wt in "$REPO_DIR"/.worktrees/*/; do
                [[ -d "$wt" ]] && git -C "$REPO_DIR" worktree remove --force "$wt" 2>/dev/null || true
            done
        fi
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Setup Worktree Tests ==="
echo ""

# --------------------------------------------------
# Test 1: HappyPath_ValidArgs_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-001" \
    --task-name "user-model" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HappyPath_ValidArgs_ExitsZero"
else
    fail "HappyPath_ValidArgs_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify worktree directory was created
if [[ -d "$REPO_DIR/.worktrees/task-001-user-model" ]]; then
    pass "HappyPath_WorktreeDirCreated"
else
    fail "HappyPath_WorktreeDirCreated (directory not found)"
fi
teardown

# --------------------------------------------------
# Test 2: GitignoreCheck_WorktreesGitignored
# --------------------------------------------------
setup
# Ensure .worktrees is NOT in .gitignore initially
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-002" \
    --task-name "auth-api" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check that .worktrees is now gitignored
if (cd "$REPO_DIR" && git check-ignore -q .worktrees/) 2>/dev/null; then
    pass "GitignoreCheck_WorktreesGitignored"
else
    fail "GitignoreCheck_WorktreesGitignored (.worktrees not in .gitignore)"
fi
teardown

# --------------------------------------------------
# Test 3: BranchCreated_FeatureBranchExists
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-003" \
    --task-name "data-layer" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Verify the feature branch exists
if git -C "$REPO_DIR" branch --list "feature/task-003-data-layer" | grep -q "feature/task-003-data-layer"; then
    pass "BranchCreated_FeatureBranchExists"
else
    fail "BranchCreated_FeatureBranchExists (branch not found)"
    echo "  Branches: $(git -C "$REPO_DIR" branch --list)"
fi
teardown

# --------------------------------------------------
# Test 4: UsageError_MissingRepoRoot_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --task-id "task-004" --task-name "test" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingRepoRoot_ExitsTwo"
else
    fail "UsageError_MissingRepoRoot_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: UsageError_MissingTaskId_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --task-name "test" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingTaskId_ExitsTwo"
else
    fail "UsageError_MissingTaskId_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UsageError_MissingTaskName_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_DIR" --task-id "task-006" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingTaskName_ExitsTwo"
else
    fail "UsageError_MissingTaskName_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_NoArgs_ExitsTwo
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
# Test 8: SkipTests_Flag_SkipsBaselineTests
# --------------------------------------------------
setup
# Create a failing npm mock to prove --skip-tests skips it
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "npm SHOULD NOT RUN" >&2
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-008" \
    --task-name "skip-test" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipTests_Flag_SkipsBaselineTests"
else
    fail "SkipTests_Flag_SkipsBaselineTests (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: StructuredOutput_MarkdownFormat
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-009" \
    --task-name "markdown-test" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for PASS/FAIL markers
if echo "$OUTPUT" | grep -qE "\*\*(PASS|FAIL)\*\*"; then
    pass "StructuredOutput_HasPassFailMarkers"
else
    fail "StructuredOutput_HasPassFailMarkers (no PASS/FAIL in output)"
    echo "  Output: $OUTPUT"
fi
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no ## heading in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: Idempotent_RunTwice_WorktreeExists
# --------------------------------------------------
setup
# First run creates worktree
PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-010" \
    --task-name "idempotent" \
    --skip-tests 2>&1 >/dev/null || true
# Second run should handle existing worktree gracefully (exit 0 or report it)
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-010" \
    --task-name "idempotent" \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "Idempotent_RunTwice_WorktreeExists"
else
    fail "Idempotent_RunTwice_WorktreeExists (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: CustomBaseBranch_UsesSpecifiedBase
# --------------------------------------------------
setup
# Create a develop branch
git -C "$REPO_DIR" branch develop main
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" \
    --repo-root "$REPO_DIR" \
    --task-id "task-011" \
    --task-name "custom-base" \
    --base-branch develop \
    --skip-tests 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CustomBaseBranch_UsesSpecifiedBase"
else
    fail "CustomBaseBranch_UsesSpecifiedBase (exit=$EXIT_CODE, expected 0)"
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
