#!/usr/bin/env bash
# Security Scan — Test Suite
# Validates all assertions for scripts/security-scan.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/security-scan.sh"
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

# Create a clean diff with no security patterns
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

# Create a diff with a hardcoded API key
create_apikey_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/config.ts b/src/config.ts
index abc1234..def5678 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,4 @@
+const API_KEY = "sk-1234567890abcdef1234567890abcdef";
+const SECRET_TOKEN = "ghp_ABCDEFghijklmnop1234567890";
 export const config = {
   timeout: 5000,
 };
EOF
    echo "$path"
}

# Create a diff with eval() usage
create_eval_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/handler.ts b/src/handler.ts
index abc1234..def5678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1,2 +1,4 @@
+function execute(code: string) {
+  return eval(code);
+}
 export function handle() {}
EOF
    echo "$path"
}

# Create a diff with SQL concatenation
create_sql_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/db.ts b/src/db.ts
index abc1234..def5678 100644
--- a/src/db.ts
+++ b/src/db.ts
@@ -1,2 +1,4 @@
+function query(userId: string) {
+  return db.execute("SELECT * FROM users WHERE id = " + userId);
+}
 export function connect() {}
EOF
    echo "$path"
}

# Create a diff with innerHTML assignment
create_innerhtml_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/render.ts b/src/render.ts
index abc1234..def5678 100644
--- a/src/render.ts
+++ b/src/render.ts
@@ -1,2 +1,4 @@
+function render(content: string) {
+  document.getElementById('app').innerHTML = content;
+}
 export function init() {}
EOF
    echo "$path"
}

# Create a diff with multiple security issues
create_multi_issue_diff() {
    local path="$1"
    cat > "$path" << 'EOF'
diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,10 @@
+const PASSWORD = "hunter2";
+function run(input: string) {
+  eval(input);
+}
+function renderHtml(html: string) {
+  element.innerHTML = html;
+}
+function getUser(id: string) {
+  return db.query("SELECT * FROM users WHERE id = " + id);
+}
 export function main() {}
EOF
    echo "$path"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Security Scan Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CleanDiff_NoPatterns_ExitsZero
# --------------------------------------------------
setup
DIFF_FILE="$(create_clean_diff "$TMPDIR_ROOT/clean.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CleanDiff_NoPatterns_ExitsZero"
else
    fail "CleanDiff_NoPatterns_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: HardcodedApiKey_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_apikey_diff "$TMPDIR_ROOT/apikey.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "HardcodedApiKey_Detected_ExitsOne"
else
    fail "HardcodedApiKey_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the finding mentions the pattern
if echo "$OUTPUT" | grep -qi "secret\|key\|token\|password\|credential"; then
    pass "HardcodedApiKey_FindingDescribed"
else
    fail "HardcodedApiKey_FindingDescribed (expected pattern description in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: EvalUsage_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_eval_diff "$TMPDIR_ROOT/eval.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EvalUsage_Detected_ExitsOne"
else
    fail "EvalUsage_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: SqlConcatenation_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_sql_diff "$TMPDIR_ROOT/sql.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "SqlConcatenation_Detected_ExitsOne"
else
    fail "SqlConcatenation_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: InnerHtml_Detected_ExitsOne
# --------------------------------------------------
setup
DIFF_FILE="$(create_innerhtml_diff "$TMPDIR_ROOT/innerhtml.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InnerHtml_Detected_ExitsOne"
else
    fail "InnerHtml_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: MultipleFindingTypes_AllReported
# --------------------------------------------------
setup
DIFF_FILE="$(create_multi_issue_diff "$TMPDIR_ROOT/multi.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MultipleFindingTypes_ExitsOne"
else
    fail "MultipleFindingTypes_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Count the number of distinct findings reported (should be multiple)
FINDING_COUNT="$(echo "$OUTPUT" | grep -cE "^\- " || true)"
if [[ "$FINDING_COUNT" -ge 3 ]]; then
    pass "MultipleFindingTypes_AllReported ($FINDING_COUNT findings)"
else
    fail "MultipleFindingTypes_AllReported (only $FINDING_COUNT findings, expected >= 3)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: EmptyDiff_ExitsZero
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
DIFF_FILE="$(create_apikey_diff "$TMPDIR_ROOT/fmt.diff")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$DIFF_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_MarkdownHeading"
else
    fail "StructuredOutput_MarkdownHeading (no markdown heading in output)"
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
