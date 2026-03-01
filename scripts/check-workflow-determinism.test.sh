#!/usr/bin/env bash
# Workflow Determinism Check — Test Suite
# Validates all assertions for scripts/check-workflow-determinism.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-workflow-determinism.sh"
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

# Create a clean diff with no determinism issues
create_clean_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/utils.test.ts b/src/utils.test.ts
index abc1234..def5678 100644
--- a/src/utils.test.ts
+++ b/src/utils.test.ts
@@ -1,3 +1,5 @@
+describe('add', () => {
+  it('should return the sum', () => {
+    expect(add(1, 2)).toBe(3);
+  });
+});
 describe('greet', () => {
   it('returns greeting', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with test.only
create_test_only_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/handler.test.ts b/src/handler.test.ts
index abc1234..def5678 100644
--- a/src/handler.test.ts
+++ b/src/handler.test.ts
@@ -1,3 +1,5 @@
+describe.only('handler', () => {
+  it('should handle request', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with it.skip
create_test_skip_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/service.test.ts b/src/service.test.ts
index abc1234..def5678 100644
--- a/src/service.test.ts
+++ b/src/service.test.ts
@@ -1,3 +1,5 @@
+describe('service', () => {
+  it.skip('should connect', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with debugger statement in test
create_debugger_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/parser.test.ts b/src/parser.test.ts
index abc1234..def5678 100644
--- a/src/parser.test.ts
+++ b/src/parser.test.ts
@@ -1,3 +1,6 @@
+describe('parser', () => {
+  it('should parse', () => {
+    debugger;
+    expect(parse('hello')).toBe('hello');
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with console.log in test
create_console_log_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/api.test.ts b/src/api.test.ts
index abc1234..def5678 100644
--- a/src/api.test.ts
+++ b/src/api.test.ts
@@ -1,3 +1,6 @@
+describe('api', () => {
+  it('should fetch', () => {
+    console.log('debug output');
+    expect(fetch('/api')).toBeDefined();
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with Date.now() in test (no fake timers)
create_date_now_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/timer.test.ts b/src/timer.test.ts
index abc1234..def5678 100644
--- a/src/timer.test.ts
+++ b/src/timer.test.ts
@@ -1,3 +1,6 @@
+describe('timer', () => {
+  it('should track time', () => {
+    const now = Date.now();
+    expect(now).toBeGreaterThan(0);
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with Math.random() in test (no mock)
create_math_random_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/shuffle.test.ts b/src/shuffle.test.ts
index abc1234..def5678 100644
--- a/src/shuffle.test.ts
+++ b/src/shuffle.test.ts
@@ -1,3 +1,6 @@
+describe('shuffle', () => {
+  it('should randomize', () => {
+    const val = Math.random();
+    expect(val).toBeLessThan(1);
+  });
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff with multiple issues
create_multi_issue_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/app.test.ts b/src/app.test.ts
index abc1234..def5678 100644
--- a/src/app.test.ts
+++ b/src/app.test.ts
@@ -1,2 +1,12 @@
+describe.only('app', () => {
+  it('should initialize', () => {
+    console.log('testing init');
+    const now = Date.now();
+    expect(now).toBeGreaterThan(0);
+  });
+  it.skip('should shutdown', () => {});
+});
 describe('other', () => {
   it('works', () => {});
 });
EOF
    echo "$path"
}

# Create a diff in non-test file (should not trigger test-only checks)
create_non_test_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,2 +1,5 @@
+const now = Date.now();
+console.log('starting...');
+const val = Math.random();
 export function main() {}
EOF
    echo "$path"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Workflow Determinism Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CleanDiff_NoIssues_ExitsZero
# --------------------------------------------------
setup
DIFF_FILE="$(create_clean_diff "$TMPDIR_ROOT/clean.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CleanDiff_NoIssues_ExitsZero"
else
    fail "CleanDiff_NoIssues_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: TestOnly_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_test_only_diff "$TMPDIR_ROOT/only.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "TestOnly_Detected_ExitsOne"
else
    fail "TestOnly_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify finding mentions the pattern
if echo "$OUTPUT" | grep -qi "only\|skip\|focus"; then
    pass "TestOnly_FindingDescribed"
else
    fail "TestOnly_FindingDescribed (expected pattern description in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: TestSkip_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_test_skip_diff "$TMPDIR_ROOT/skip.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "TestSkip_Detected_ExitsOne"
else
    fail "TestSkip_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: Debugger_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_debugger_diff "$TMPDIR_ROOT/debugger.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "Debugger_Detected_ExitsOne"
else
    fail "Debugger_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify it says debug artifact
if echo "$OUTPUT" | grep -qi "debug\|artifact"; then
    pass "Debugger_FindingDescribed"
else
    fail "Debugger_FindingDescribed (expected debug artifact description in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: ConsoleLog_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_console_log_diff "$TMPDIR_ROOT/console.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ConsoleLog_Detected_ExitsOne"
else
    fail "ConsoleLog_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: DateNow_InTest_NoFakeTimers_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_date_now_diff "$TMPDIR_ROOT/date.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DateNow_InTest_NoFakeTimers_ExitsOne"
else
    fail "DateNow_InTest_NoFakeTimers_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: MathRandom_InTest_NoMock_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_math_random_diff "$TMPDIR_ROOT/random.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MathRandom_InTest_NoMock_ExitsOne"
else
    fail "MathRandom_InTest_NoMock_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: UsageError_NoArgs_ExitsTwo
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
# Test 9: StructuredOutput_MarkdownFormat
# --------------------------------------------------
setup
DIFF_FILE="$(create_test_only_diff "$TMPDIR_ROOT/fmt.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_MarkdownHeading"
else
    fail "StructuredOutput_MarkdownHeading (no markdown heading in output)"
    echo "  Output: $OUTPUT"
fi
# Check for result line
if echo "$OUTPUT" | grep -qE "\*\*Result:"; then
    pass "StructuredOutput_ResultLine"
else
    fail "StructuredOutput_ResultLine (no result line in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: MultipleIssues_AllReported
# --------------------------------------------------
setup
DIFF_FILE="$(create_multi_issue_diff "$TMPDIR_ROOT/multi.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MultipleIssues_ExitsOne"
else
    fail "MultipleIssues_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Count the number of distinct findings reported (should be multiple)
FINDING_COUNT="$(echo "$OUTPUT" | grep -cE "^\- " || true)"
if [[ "$FINDING_COUNT" -ge 3 ]]; then
    pass "MultipleIssues_AllReported ($FINDING_COUNT findings)"
else
    fail "MultipleIssues_AllReported (only $FINDING_COUNT findings, expected >= 3)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: NonTestFile_NotFlagged_ExitsZero
# --------------------------------------------------
setup
DIFF_FILE="$(create_non_test_diff "$TMPDIR_ROOT/nontest.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NonTestFile_NotFlagged_ExitsZero"
else
    fail "NonTestFile_NotFlagged_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 12: EmptyDiff_ExitsZero
# --------------------------------------------------
setup
echo "" > "$TMPDIR_ROOT/empty.diff"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$TMPDIR_ROOT/empty.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "EmptyDiff_ExitsZero"
else
    fail "EmptyDiff_ExitsZero (exit=$EXIT_CODE, expected 0)"
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
