#!/usr/bin/env bash
# verify-worktree.test.sh — Tests for verify-worktree.sh
# Validates worktree path detection with --cwd override and structured output.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-worktree.sh"
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
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Worktree Tests ==="
echo ""

# --------------------------------------------------
# Test 1: InsideWorktree_ValidPath_ExitsZero
# --------------------------------------------------
setup
WORKTREE_DIR="$TMPDIR_ROOT/project/.worktrees/task-001"
mkdir -p "$WORKTREE_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --cwd "$WORKTREE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "InsideWorktree_ValidPath_ExitsZero"
else
    fail "InsideWorktree_ValidPath_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: OutsideWorktree_NormalDir_ExitsOne
# --------------------------------------------------
setup
NORMAL_DIR="$TMPDIR_ROOT/some/normal/directory"
mkdir -p "$NORMAL_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --cwd "$NORMAL_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "OutsideWorktree_NormalDir_ExitsOne"
else
    fail "OutsideWorktree_NormalDir_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: CwdFlag_OverridesDefault_UsesProvidedPath
# --------------------------------------------------
setup
# Create a worktree path and a non-worktree path
WORKTREE_DIR="$TMPDIR_ROOT/repo/.worktrees/feature-x"
mkdir -p "$WORKTREE_DIR"
# Even if current dir is not a worktree, --cwd should override
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --cwd "$WORKTREE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CwdFlag_OverridesDefault_UsesProvidedPath"
else
    fail "CwdFlag_OverridesDefault_UsesProvidedPath (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify the output mentions the provided path
if echo "$OUTPUT" | grep -q "$WORKTREE_DIR"; then
    pass "CwdFlag_OutputContainsProvidedPath"
else
    fail "CwdFlag_OutputContainsProvidedPath (path not in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: HelpFlag_PrintsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_PrintsUsage_ExitsZero"
else
    fail "HelpFlag_PrintsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify usage text is printed
if echo "$OUTPUT" | grep -qi "usage"; then
    pass "HelpFlag_ContainsUsageText"
else
    fail "HelpFlag_ContainsUsageText (no 'usage' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: StructuredOutput_ContainsOKorERROR
# --------------------------------------------------
setup
# In worktree: should contain OK
WORKTREE_DIR="$TMPDIR_ROOT/repo/.worktrees/task-1"
mkdir -p "$WORKTREE_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --cwd "$WORKTREE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "OK:"; then
    pass "StructuredOutput_InWorktree_ContainsOK"
else
    fail "StructuredOutput_InWorktree_ContainsOK (no 'OK:' in output)"
    echo "  Output: $OUTPUT"
fi

# Not in worktree: should contain ERROR
NORMAL_DIR="$TMPDIR_ROOT/not-a-worktree"
mkdir -p "$NORMAL_DIR"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --cwd "$NORMAL_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "ERROR:"; then
    pass "StructuredOutput_NotInWorktree_ContainsERROR"
else
    fail "StructuredOutput_NotInWorktree_ContainsERROR (no 'ERROR:' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UnknownArg_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --bogus-flag 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UnknownArg_ExitsTwo"
else
    fail "UnknownArg_ExitsTwo (exit=$EXIT_CODE, expected 2)"
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
