#!/usr/bin/env bash
# Check Operational Resilience — Test Suite
# Validates all assertions for scripts/check-operational-resilience.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-operational-resilience.sh"
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

# Create a clean diff with no anti-patterns
create_clean_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/utils.ts b/src/utils.ts
index abc1234..def5678 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,5 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
 export function greet(name: string): string {
   return `Hello, ${name}`;
 }
EOF
    echo "$path"
}

# Create a diff with an empty catch block
create_empty_catch_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,6 @@
+function risky() {
+  try {
+    doSomething();
+  } catch (e) { }
+}
 export function handle() {}
EOF
    echo "$path"
}

# Create a diff with console.log in source
create_console_log_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/service.ts b/src/service.ts
index abc1234..def5678 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,2 +1,5 @@
+function debug(value: unknown) {
+  console.log("debugging:", value);
+  return value;
+}
 export function init() {}
EOF
    echo "$path"
}

# Create a diff with console.log in a test file (should NOT be flagged)
create_console_log_test_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/service.test.ts b/src/service.test.ts
index abc1234..def5678 100644
--- a/src/service.test.ts
+++ b/src/service.test.ts
@@ -1,2 +1,5 @@
+it('logs value', () => {
+  console.log("test output");
+  expect(true).toBe(true);
+});
 export {};
EOF
    echo "$path"
}

# Create a diff with an unbounded retry loop
create_unbounded_retry_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/poller.ts b/src/poller.ts
index abc1234..def5678 100644
--- a/src/poller.ts
+++ b/src/poller.ts
@@ -1,2 +1,6 @@
+async function poll() {
+  while (true) {
+    await fetch('/status');
+  }
+}
 export function start() {}
EOF
    echo "$path"
}

# Create a diff with multiple issues
create_multi_issue_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,12 @@
+function risky() {
+  try {
+    doSomething();
+  } catch (e) { }
+}
+function debug() {
+  console.log("value");
+}
+async function poll() {
+  while (true) {
+    await fetch('/status');
+  }
+}
 export function main() {}
EOF
    echo "$path"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Operational Resilience Tests ==="
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
# Test 2: EmptyCatch_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_empty_catch_diff "$TMPDIR_ROOT/catch.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EmptyCatch_Detected_ExitsOne"
else
    fail "EmptyCatch_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the output mentions the issue
if echo "$OUTPUT" | grep -qi "catch"; then
    pass "EmptyCatch_OutputDescribesIssue"
else
    fail "EmptyCatch_OutputDescribesIssue (expected 'catch' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ConsoleLog_InSource_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_console_log_diff "$TMPDIR_ROOT/console.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ConsoleLog_InSource_ExitsOne"
else
    fail "ConsoleLog_InSource_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the output mentions console.log
if echo "$OUTPUT" | grep -q "console.log"; then
    pass "ConsoleLog_OutputDescribesIssue"
else
    fail "ConsoleLog_OutputDescribesIssue (expected 'console.log' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: ConsoleLog_InTestFile_ExitsZero
# --------------------------------------------------
setup
DIFF_FILE="$(create_console_log_test_diff "$TMPDIR_ROOT/test-console.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ConsoleLog_InTestFile_ExitsZero"
else
    fail "ConsoleLog_InTestFile_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: UsageError_NoArgs_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoArgs_ExitsTwo"
else
    fail "UsageError_NoArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 6: StructuredOutput_HasMarkdownHeading
# --------------------------------------------------
setup
DIFF_FILE="$(create_clean_diff "$TMPDIR_ROOT/fmt.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "^## Operational Resilience Report"; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no markdown heading in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UnboundedRetry_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_unbounded_retry_diff "$TMPDIR_ROOT/retry.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "UnboundedRetry_Detected_ExitsOne"
else
    fail "UnboundedRetry_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the output mentions the pattern
if echo "$OUTPUT" | grep -qi "retry\|unbounded\|while"; then
    pass "UnboundedRetry_OutputDescribesIssue"
else
    fail "UnboundedRetry_OutputDescribesIssue (expected retry-related text in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: MultipleIssues_AllReported
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
# Test 9: ResultLine_PassFormat
# --------------------------------------------------
setup
DIFF_FILE="$(create_clean_diff "$TMPDIR_ROOT/pass.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE '\*\*Result: PASS\*\*'; then
    pass "ResultLine_PassFormat"
else
    fail "ResultLine_PassFormat (expected **Result: PASS** in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: ResultLine_FindingsFormat
# --------------------------------------------------
setup
DIFF_FILE="$(create_empty_catch_diff "$TMPDIR_ROOT/findings.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE '\*\*Result: FINDINGS\*\*'; then
    pass "ResultLine_FindingsFormat"
else
    fail "ResultLine_FindingsFormat (expected **Result: FINDINGS** in output)"
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
