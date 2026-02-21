#!/usr/bin/env bash
# extract-task.test.sh — Tests for extract-task.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/extract-task.sh"
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

    # Create a sample plan file with multiple tasks
    PLAN_FILE="$TMPDIR_ROOT/plan.md"
    cat > "$PLAN_FILE" << 'PLANEOF'
# Implementation Plan

## Overview

This is a test implementation plan.

### Task 1: Set up project structure

Create the initial project structure with the following:

- src/ directory
- tests/ directory
- package.json

Dependencies: none

### Task 2: Implement core module

Build the core module with:

- Data models
- Business logic
- Error handling

Dependencies: Task 1

### Task 3: Add tests

Write comprehensive tests for the core module.

- Unit tests
- Integration tests

Dependencies: Task 2
PLANEOF
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Extract Task Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ExtractTask_ValidTaskId_OutputsTaskSection
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$PLAN_FILE" "1" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ExtractTask_ValidTaskId_ExitsZero"
else
    fail "ExtractTask_ValidTaskId_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify output contains the task title
if echo "$OUTPUT" | grep -q "Task 1"; then
    pass "ExtractTask_ValidTaskId_ContainsTaskTitle"
else
    fail "ExtractTask_ValidTaskId_ContainsTaskTitle (missing 'Task 1')"
    echo "  Output: $OUTPUT"
fi
# Verify output contains task content
if echo "$OUTPUT" | grep -q "project structure"; then
    pass "ExtractTask_ValidTaskId_ContainsTaskContent"
else
    fail "ExtractTask_ValidTaskId_ContainsTaskContent (missing task content)"
    echo "  Output: $OUTPUT"
fi
# Verify output does NOT contain other tasks
if ! echo "$OUTPUT" | grep -q "Task 2"; then
    pass "ExtractTask_ValidTaskId_ExcludesOtherTasks"
else
    fail "ExtractTask_ValidTaskId_ExcludesOtherTasks (output contains Task 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: ExtractTask_InvalidTaskId_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$PLAN_FILE" "999" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ExtractTask_InvalidTaskId_ExitsOne"
else
    fail "ExtractTask_InvalidTaskId_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify stderr mentions not found
if echo "$OUTPUT" | grep -qi "not found"; then
    pass "ExtractTask_InvalidTaskId_MentionsNotFound"
else
    fail "ExtractTask_InvalidTaskId_MentionsNotFound (output missing 'not found')"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ExtractTask_MissingArgs_ExitsTwo (usage error → exit 2)
# --------------------------------------------------
setup
# No arguments at all
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "ExtractTask_MissingArgs_ExitsTwo"
else
    fail "ExtractTask_MissingArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
# Also test with plan path but no task ID
OUTPUT2="$(bash "$SCRIPT_UNDER_TEST" "$PLAN_FILE" 2>&1)" && EXIT_CODE2=$? || EXIT_CODE2=$?
if [[ $EXIT_CODE2 -eq 2 ]]; then
    pass "ExtractTask_MissingTaskId_ExitsTwo"
else
    fail "ExtractTask_MissingTaskId_ExitsTwo (exit=$EXIT_CODE2, expected 2)"
    echo "  Output: $OUTPUT2"
fi
teardown

# --------------------------------------------------
# Test 4: ExtractTask_MissingPlanFile_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT/nonexistent-plan.md" "1" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ExtractTask_MissingPlanFile_ExitsOne"
else
    fail "ExtractTask_MissingPlanFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
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
