#!/usr/bin/env bash
# validate-rm.test.sh — Tests for validate-rm.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-rm.sh"
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
    TEST_CWD="$TMPDIR_ROOT/test-cwd"
    mkdir -p "$TEST_CWD"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Validate RM Tests ==="
echo ""

# --------------------------------------------------
# Test 1: SafeDelete_PathWithinCWD_ExitsZero
# --------------------------------------------------
setup
echo "test content" > "$TEST_CWD/file.txt"
INPUT=$(cat <<EOF
{ "tool_input": { "command": "rm file.txt" }, "cwd": "$TEST_CWD" }
EOF
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SafeDelete_PathWithinCWD_ExitsZero"
else
    fail "SafeDelete_PathWithinCWD_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: UnsafeDelete_PathOutsideCWD_ExitsTwo
# --------------------------------------------------
setup
INPUT=$(cat <<EOF
{ "tool_input": { "command": "rm /etc/passwd" }, "cwd": "$TEST_CWD" }
EOF
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UnsafeDelete_PathOutsideCWD_ExitsTwo"
else
    fail "UnsafeDelete_PathOutsideCWD_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
# Verify stderr contains BLOCKED
if echo "$OUTPUT" | grep -q "BLOCKED"; then
    pass "UnsafeDelete_PathOutsideCWD_StderrContainsBlocked"
else
    fail "UnsafeDelete_PathOutsideCWD_StderrContainsBlocked (output missing BLOCKED)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: UnsafeDelete_UnsetVariable_ExitsTwo
# --------------------------------------------------
setup
INPUT=$(cat <<'ENDJSON'
{ "tool_input": { "command": "rm -rf $UNSET_VAR/foo" }, "cwd": "/tmp/test-dir" }
ENDJSON
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UnsafeDelete_UnsetVariable_ExitsTwo"
else
    fail "UnsafeDelete_UnsetVariable_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: UnsafeDelete_RootPath_ExitsTwo
# --------------------------------------------------
setup
INPUT=$(cat <<EOF
{ "tool_input": { "command": "rm -rf /" }, "cwd": "$TEST_CWD" }
EOF
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UnsafeDelete_RootPath_ExitsTwo"
else
    fail "UnsafeDelete_RootPath_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: NonRmCommand_ExitsZero
# --------------------------------------------------
setup
INPUT=$(cat <<EOF
{ "tool_input": { "command": "ls -la" }, "cwd": "$TEST_CWD" }
EOF
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NonRmCommand_ExitsZero"
else
    fail "NonRmCommand_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: SafeDelete_RelativePath_ExitsZero
# --------------------------------------------------
setup
mkdir -p "$TEST_CWD/subdir"
echo "test" > "$TEST_CWD/subdir/file.txt"
INPUT=$(cat <<EOF
{ "tool_input": { "command": "rm subdir/file.txt" }, "cwd": "$TEST_CWD" }
EOF
)
OUTPUT="$(echo "$INPUT" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SafeDelete_RelativePath_ExitsZero"
else
    fail "SafeDelete_RelativePath_ExitsZero (exit=$EXIT_CODE, expected 0)"
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
