#!/usr/bin/env bash
# Assess Refactor Scope — Test Suite
# Validates scope assessment and track recommendation logic.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/assess-refactor-scope.sh"
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
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a minimal project structure for testing
create_project() {
    local dir="$1"
    local project="$dir/project"
    mkdir -p "$project/src" "$project/tests"

    # Create some source files
    echo 'export function foo() {}' > "$project/src/foo.ts"
    echo 'export function bar() {}' > "$project/src/bar.ts"
    echo 'export function baz() {}' > "$project/src/baz.ts"

    # Create test files for foo and bar only
    echo 'test("foo", () => {})' > "$project/src/foo.test.ts"
    echo 'test("bar", () => {})' > "$project/src/bar.test.ts"

    echo "$project"
}

# Create a state file with scope assessment
create_state_with_files() {
    local dir="$1"
    shift
    local files_json="["
    local first=true
    for f in "$@"; do
        if [[ "$first" == true ]]; then
            first=false
        else
            files_json+=","
        fi
        files_json+="\"$f\""
    done
    files_json+="]"

    cat > "$dir/test.state.json" << EOF
{
  "version": "1.1",
  "featureId": "refactor-test",
  "workflowType": "refactor",
  "phase": "explore",
  "explore": {
    "scopeAssessment": {
      "filesAffected": $files_json
    }
  }
}
EOF
    echo "$dir/test.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Assess Refactor Scope Tests ==="
echo ""

# --------------------------------------------------
# Test 1: FewFiles_SingleModule_RecommendsPolish_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --files "src/foo.ts,src/bar.ts,src/baz.ts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "FewFiles_SingleModule_RecommendsPolish_ExitsZero"
else
    fail "FewFiles_SingleModule_RecommendsPolish_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: ManyFiles_RecommendsOverhaul_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --files "src/a.ts,src/b.ts,src/c.ts,src/d.ts,src/e.ts,src/f.ts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ManyFiles_RecommendsOverhaul_ExitsOne"
else
    fail "ManyFiles_RecommendsOverhaul_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: CrossModule_RecommendsOverhaul_ExitsOne
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --files "src/foo.ts,plugins/bar.ts,commands/baz.ts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CrossModule_RecommendsOverhaul_ExitsOne"
else
    fail "CrossModule_RecommendsOverhaul_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: FilesFlag_ParsesCommaSeparated
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --files "src/a.ts,src/b.ts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should contain file count of 2
if echo "$OUTPUT" | grep -q "2"; then
    pass "FilesFlag_ParsesCommaSeparated"
else
    fail "FilesFlag_ParsesCommaSeparated (output does not mention file count 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: StateFileFlag_ReadsFromState
# --------------------------------------------------
setup
STATE_FILE="$(create_state_with_files "$TMPDIR_ROOT" "src/foo.ts" "src/bar.ts")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "StateFileFlag_ReadsFromState"
else
    fail "StateFileFlag_ReadsFromState (exit=$EXIT_CODE, expected 0)"
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
# Test 7: OutputContainsScopeAssessment
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --files "src/foo.ts,src/bar.ts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for key assessment components in output
if echo "$OUTPUT" | grep -qi "scope\|assessment\|recommendation\|file"; then
    pass "OutputContainsScopeAssessment"
else
    fail "OutputContainsScopeAssessment (output missing scope assessment info)"
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
