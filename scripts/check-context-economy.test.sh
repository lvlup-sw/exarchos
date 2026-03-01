#!/usr/bin/env bash
# Check Context Economy — Test Suite
# Validates all assertions for scripts/check-context-economy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-context-economy.sh"
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

setup_git_repo() {
    TMPDIR_ROOT="$(mktemp -d)"
    local repo="$TMPDIR_ROOT/repo"
    mkdir -p "$repo/src"
    cd "$repo"
    git init -q
    git checkout -q -b main
    # Initial commit with a small file
    echo 'export const x = 1;' > src/index.ts
    git add -A
    git commit -q -m "initial"
    # Create feature branch
    git checkout -q -b feature
    echo "$repo"
}

setup_tmpdir() {
    TMPDIR_ROOT="$(mktemp -d)"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a clean diff with no context-economy issues
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
}

# Create a diff with a very long .ts file (>400 added lines)
create_long_file_diff() {
    local path="$1"
    {
        echo 'diff --git a/src/huge.ts b/src/huge.ts'
        echo 'index abc1234..def5678 100644'
        echo '--- a/src/huge.ts'
        echo '+++ b/src/huge.ts'
        echo '@@ -0,0 +1,450 @@'
        for i in $(seq 1 450); do
            echo "+export const var_$i = $i;"
        done
    } > "$path"
}

# Create a diff with >30 files
create_wide_diff() {
    local path="$1"
    {
        for i in $(seq 1 35); do
            echo "diff --git a/src/file-$i.ts b/src/file-$i.ts"
            echo 'index abc1234..def5678 100644'
            echo "--- a/src/file-$i.ts"
            echo "+++ b/src/file-$i.ts"
            echo '@@ -0,0 +1,1 @@'
            echo "+export const x = $i;"
        done
    } > "$path"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Context Economy Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CleanDiff_NoIssues_ExitsZero (--diff-file mode)
# --------------------------------------------------
setup_tmpdir
create_clean_diff "$TMPDIR_ROOT/clean.diff"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$TMPDIR_ROOT/clean.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CleanDiff_NoIssues_ExitsZero"
else
    fail "CleanDiff_NoIssues_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: CleanDiff_GitRepo_ExitsZero
# --------------------------------------------------
REPO="$(setup_git_repo)"
# Add a small, clean change
echo 'export const y = 2;' >> "$REPO/src/index.ts"
cd "$REPO" && git add -A && git commit -q -m "small change"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CleanDiff_GitRepo_ExitsZero"
else
    fail "CleanDiff_GitRepo_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: LargeFile_Detected_ExitsOne (--diff-file mode)
# --------------------------------------------------
setup_tmpdir
create_long_file_diff "$TMPDIR_ROOT/long.diff"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$TMPDIR_ROOT/long.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "LargeFile_DiffFile_Detected_ExitsOne"
else
    fail "LargeFile_DiffFile_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: LargeFile_GitRepo_Detected_ExitsOne
# --------------------------------------------------
REPO="$(setup_git_repo)"
{
    for i in $(seq 1 450); do
        echo "export const var_$i = $i;"
    done
} > "$REPO/src/big-file.ts"
cd "$REPO" && git add -A && git commit -q -m "add large file"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "LargeFile_GitRepo_Detected_ExitsOne"
else
    fail "LargeFile_GitRepo_Detected_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the output mentions the file and threshold
if echo "$OUTPUT" | grep -q "big-file.ts" && echo "$OUTPUT" | grep -q "400 lines"; then
    pass "LargeFile_OutputDescribesIssue"
else
    fail "LargeFile_OutputDescribesIssue (expected file name and threshold in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: WideDiff_ManyFiles_ExitsOne (--diff-file mode)
# --------------------------------------------------
setup_tmpdir
create_wide_diff "$TMPDIR_ROOT/wide.diff"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$TMPDIR_ROOT/wide.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "WideDiff_DiffFile_ExitsOne"
else
    fail "WideDiff_DiffFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions diff breadth
if echo "$OUTPUT" | grep -qi "breadth\|files changed"; then
    pass "WideDiff_OutputDescribesIssue"
else
    fail "WideDiff_OutputDescribesIssue (expected 'breadth' or 'files changed' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: WideDiff_GitRepo_ManyFiles_ExitsOne
# --------------------------------------------------
REPO="$(setup_git_repo)"
for i in $(seq 1 35); do
    echo "export const x = $i;" > "$REPO/src/file-$i.ts"
done
cd "$REPO" && git add -A && git commit -q -m "add many files"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --base-branch main 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "WideDiff_GitRepo_ExitsOne"
else
    fail "WideDiff_GitRepo_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_NoArgs_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoArgs_ExitsTwo"
else
    fail "UsageError_NoArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 8: StructuredOutput_HasMarkdownHeading
# --------------------------------------------------
setup_tmpdir
create_clean_diff "$TMPDIR_ROOT/fmt.diff"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --diff-file "$TMPDIR_ROOT/fmt.diff" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "^## Context Economy Report"; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no markdown heading in output)"
    echo "  Output: $OUTPUT"
fi
# Check for Result line
if echo "$OUTPUT" | grep -qE "\*\*Result: (PASS|FINDINGS)\*\*"; then
    pass "StructuredOutput_HasResultLine"
else
    fail "StructuredOutput_HasResultLine (no Result line in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: EmptyDiff_ExitsZero
# --------------------------------------------------
setup_tmpdir
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
