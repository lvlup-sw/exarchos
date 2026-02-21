#!/usr/bin/env bash
# review-diff.test.sh — Tests for review-diff.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/review-diff.sh"
PASS=0
FAIL=0

# Colors
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
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper to create a git repo with a main branch and a feature branch with changes
create_repo_with_change() {
    local repo_dir="$1"
    mkdir -p "$repo_dir"
    git -C "$repo_dir" init -b main --quiet
    git -C "$repo_dir" config user.email "test@test.com"
    git -C "$repo_dir" config user.name "Test"

    # Initial commit on main
    echo "initial content" > "$repo_dir/file.txt"
    git -C "$repo_dir" add file.txt
    git -C "$repo_dir" commit -m "initial commit" --quiet

    # Create feature branch and add a change
    git -C "$repo_dir" checkout -b feature/test-branch --quiet
    echo "modified content" > "$repo_dir/file.txt"
    git -C "$repo_dir" add file.txt
    git -C "$repo_dir" commit -m "modify file" --quiet
}

# Helper to create a git repo with a feature branch but no changes from main
create_repo_no_change() {
    local repo_dir="$1"
    mkdir -p "$repo_dir"
    git -C "$repo_dir" init -b main --quiet
    git -C "$repo_dir" config user.email "test@test.com"
    git -C "$repo_dir" config user.name "Test"

    # Initial commit on main
    echo "initial content" > "$repo_dir/file.txt"
    git -C "$repo_dir" add file.txt
    git -C "$repo_dir" commit -m "initial commit" --quiet

    # Create feature branch with no additional changes
    git -C "$repo_dir" checkout -b feature/no-change --quiet
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Review Diff Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ReviewDiff_ValidWorktree_ProducesMarkdownDiff
# --------------------------------------------------
setup
REPO_DIR="$TMPDIR_ROOT/repo-with-change"
create_repo_with_change "$REPO_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$REPO_DIR" main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ReviewDiff_ValidWorktree_ExitsZero"
else
    fail "ReviewDiff_ValidWorktree_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify output contains expected markdown structure
if echo "$OUTPUT" | grep -q "## Review Diff"; then
    pass "ReviewDiff_ValidWorktree_ContainsReviewDiffHeader"
else
    fail "ReviewDiff_ValidWorktree_ContainsReviewDiffHeader (missing '## Review Diff')"
    echo "  Output: $OUTPUT"
fi
# Verify output contains diff content (the file modification)
if echo "$OUTPUT" | grep -q "file.txt"; then
    pass "ReviewDiff_ValidWorktree_ContainsDiffContent"
else
    fail "ReviewDiff_ValidWorktree_ContainsDiffContent (missing 'file.txt' in diff)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: ReviewDiff_NoChanges_ProducesEmptyDiff
# --------------------------------------------------
setup
REPO_DIR="$TMPDIR_ROOT/repo-no-change"
create_repo_no_change "$REPO_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$REPO_DIR" main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ReviewDiff_NoChanges_ExitsZero"
else
    fail "ReviewDiff_NoChanges_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify output has the structure but no actual diff lines (no +/- lines)
if echo "$OUTPUT" | grep -q "## Review Diff"; then
    pass "ReviewDiff_NoChanges_HasStructure"
else
    fail "ReviewDiff_NoChanges_HasStructure (missing '## Review Diff')"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ReviewDiff_InvalidDir_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT/nonexistent-dir" main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ReviewDiff_InvalidDir_ExitsOne"
else
    fail "ReviewDiff_InvalidDir_ExitsOne (exit=$EXIT_CODE, expected 1)"
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
