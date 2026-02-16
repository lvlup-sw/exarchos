#!/usr/bin/env bash
# Check Polish Scope — Test Suite
# Validates scope expansion detection during polish track.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-polish-scope.sh"
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

# Create a git repo with a given number of modified files in specified directories
create_git_repo() {
    local dir="$1"
    shift
    local files=("$@")

    mkdir -p "$dir"
    cd "$dir"
    git init -q
    git checkout -q -b main

    # Create initial commit with package.json
    echo '{}' > package.json
    git add package.json
    git commit -q -m "initial"

    # Create feature branch
    git checkout -q -b feature

    # Create modified files
    for f in "${files[@]}"; do
        mkdir -p "$(dirname "$f")"
        echo "modified" > "$f"
        # Also create test file if it's a .ts file (for test coverage check)
        local test_file="${f%.ts}.test.ts"
        if [[ "$f" == *.ts && ! "$f" == *.test.ts ]]; then
            # Don't create test file — let the test decide
            :
        fi
        git add "$f"
    done
    git commit -q -m "feature changes"

    cd - > /dev/null
    echo "$dir"
}

# Create test counterpart files
add_test_files() {
    local dir="$1"
    shift
    for f in "$@"; do
        local test_file="${f%.ts}.test.ts"
        mkdir -p "$dir/$(dirname "$test_file")"
        echo "test" > "$dir/$test_file"
        cd "$dir"
        git add "$test_file"
        git commit -q -m "add test for $f"
        cd - > /dev/null
    done
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Check Polish Scope Tests ==="
echo ""

# --------------------------------------------------
# Test 1: WithinLimits_ExitsZero
# --------------------------------------------------
setup
# Create only 2 source files with their test counterparts in a single commit (4 files total, <= 5)
REPO="$(create_git_repo "$TMPDIR_ROOT/repo1" "src/foo.ts" "src/bar.ts")"
add_test_files "$REPO" "src/foo.ts" "src/bar.ts"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "WithinLimits_ExitsZero"
else
    fail "WithinLimits_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: TooManyFiles_ExitsOne
# --------------------------------------------------
setup
REPO="$(create_git_repo "$TMPDIR_ROOT/repo2" "src/a.ts" "src/b.ts" "src/c.ts" "src/d.ts" "src/e.ts" "src/f.ts")"
add_test_files "$REPO" "src/a.ts" "src/b.ts" "src/c.ts" "src/d.ts" "src/e.ts" "src/f.ts"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "TooManyFiles_ExitsOne"
else
    fail "TooManyFiles_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: CrossModuleBoundary_ExitsOne
# --------------------------------------------------
setup
REPO="$(create_git_repo "$TMPDIR_ROOT/repo3" "src/foo.ts" "plugins/bar.ts" "commands/baz.ts")"
add_test_files "$REPO" "src/foo.ts" "plugins/bar.ts" "commands/baz.ts"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CrossModuleBoundary_ExitsOne"
else
    fail "CrossModuleBoundary_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: MissingTestFiles_ExitsOne
# --------------------------------------------------
setup
REPO="$(create_git_repo "$TMPDIR_ROOT/repo4" "src/foo.ts" "src/bar.ts")"
# Don't add test files — triggers "new test files needed"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingTestFiles_ExitsOne"
else
    fail "MissingTestFiles_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: OutputShowsTrigger
# --------------------------------------------------
setup
REPO="$(create_git_repo "$TMPDIR_ROOT/repo5" "src/a.ts" "src/b.ts" "src/c.ts" "src/d.ts" "src/e.ts" "src/f.ts")"
add_test_files "$REPO" "src/a.ts" "src/b.ts" "src/c.ts" "src/d.ts" "src/e.ts" "src/f.ts"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Output should mention the trigger that fired
if echo "$OUTPUT" | grep -qi "file count\|files modified\|trigger\|exceeds"; then
    pass "OutputShowsTrigger"
else
    fail "OutputShowsTrigger (output missing trigger info)"
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
