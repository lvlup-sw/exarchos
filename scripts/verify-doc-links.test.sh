#!/usr/bin/env bash
# Verify Doc Links — Test Suite
# Validates internal markdown link resolution.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-doc-links.sh"
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

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Doc Links Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AllLinksValid_ExitsZero
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/docs"
echo "some content" > "$TMPDIR_ROOT/docs/other.md"
cat > "$TMPDIR_ROOT/docs/test.md" << 'EOF'
# Test Doc

See [other doc](other.md) for details.
Also check [same dir](./other.md).
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --doc-file "$TMPDIR_ROOT/docs/test.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllLinksValid_ExitsZero"
else
    fail "AllLinksValid_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: BrokenLink_ExitsOne
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/docs"
cat > "$TMPDIR_ROOT/docs/test.md" << 'EOF'
# Test Doc

See [missing doc](nonexistent.md) for details.
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --doc-file "$TMPDIR_ROOT/docs/test.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "BrokenLink_ExitsOne"
else
    fail "BrokenLink_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Check that output mentions the broken link
if echo "$OUTPUT" | grep -q "nonexistent.md"; then
    pass "BrokenLink_OutputMentionsTarget"
else
    fail "BrokenLink_OutputMentionsTarget (output does not mention broken target)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: ExternalUrlSkipped_ExitsZero
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/docs"
cat > "$TMPDIR_ROOT/docs/test.md" << 'EOF'
# Test Doc

See [Google](https://google.com) and [HTTP site](http://example.com).
Also [relative](nonexistent-but-external.md) is missing, but let's test external only.
EOF
# Create the relative file so only externals are tested
echo "exists" > "$TMPDIR_ROOT/docs/nonexistent-but-external.md"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --doc-file "$TMPDIR_ROOT/docs/test.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ExternalUrlSkipped_ExitsZero"
else
    fail "ExternalUrlSkipped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: AnchorOnlySkipped_ExitsZero
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/docs"
cat > "$TMPDIR_ROOT/docs/test.md" << 'EOF'
# Test Doc

See [section below](#some-section) for details.
And [another anchor](#another) too.
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --doc-file "$TMPDIR_ROOT/docs/test.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AnchorOnlySkipped_ExitsZero"
else
    fail "AnchorOnlySkipped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: RecursiveDir_ChecksAllFiles
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/docs/sub"
echo "exists" > "$TMPDIR_ROOT/docs/exists.md"
cat > "$TMPDIR_ROOT/docs/good.md" << 'EOF'
[link](exists.md)
EOF
cat > "$TMPDIR_ROOT/docs/sub/bad.md" << 'EOF'
[broken](../missing.md)
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --docs-dir "$TMPDIR_ROOT/docs" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "RecursiveDir_ChecksAllFiles"
else
    fail "RecursiveDir_ChecksAllFiles (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify broken link from sub/ is reported
if echo "$OUTPUT" | grep -q "missing.md"; then
    pass "RecursiveDir_ReportsBrokenFromSubdir"
else
    fail "RecursiveDir_ReportsBrokenFromSubdir (output missing broken link from subdir)"
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
