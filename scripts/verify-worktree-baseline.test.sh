#!/usr/bin/env bash
# verify-worktree-baseline.test.sh — Tests for verify-worktree-baseline.sh
# Validates baseline test detection and execution across project types.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-worktree-baseline.sh"
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
MOCK_BIN=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Worktree Baseline Tests ==="
echo ""

# --------------------------------------------------
# Test 1: NodeProject_PackageJsonExists_RunsNpmTest
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/project"
mkdir -p "$WORKTREE"
echo '{ "name": "test-project" }' > "$WORKTREE/package.json"

# Mock npm that succeeds and leaves a breadcrumb
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "npm-test-executed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NodeProject_PackageJsonExists_ExitsZero"
else
    fail "NodeProject_PackageJsonExists_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify npm was actually called
if echo "$OUTPUT" | grep -q "npm-test-executed\|Node.js\|package.json"; then
    pass "NodeProject_PackageJsonExists_DetectedNode"
else
    fail "NodeProject_PackageJsonExists_DetectedNode (Node.js not mentioned in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: DotnetProject_CsprojExists_RunsDotnetTest
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/dotnet-proj"
mkdir -p "$WORKTREE"
echo '<Project />' > "$WORKTREE/MyApp.csproj"

# Mock dotnet that succeeds
cat > "$MOCK_BIN/dotnet" << 'MOCKEOF'
#!/usr/bin/env bash
echo "dotnet-test-executed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/dotnet"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "DotnetProject_CsprojExists_ExitsZero"
else
    fail "DotnetProject_CsprojExists_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify dotnet detection
if echo "$OUTPUT" | grep -qi "dotnet\|\.csproj\|\.NET"; then
    pass "DotnetProject_CsprojExists_DetectedDotnet"
else
    fail "DotnetProject_CsprojExists_DetectedDotnet (.NET not mentioned in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: UnknownProject_NoProjectFile_ExitsTwo
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/empty-proj"
mkdir -p "$WORKTREE"
# No package.json, no .csproj, no Cargo.toml

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UnknownProject_NoProjectFile_ExitsTwo"
else
    fail "UnknownProject_NoProjectFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: BaselinePass_TestsSucceed_ExitsZero
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/passing-proj"
mkdir -p "$WORKTREE"
echo '{ "name": "passing" }' > "$WORKTREE/package.json"

cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "Tests: 42 passed, 0 failed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "BaselinePass_TestsSucceed_ExitsZero"
else
    fail "BaselinePass_TestsSucceed_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: BaselineFail_TestsFail_ExitsOne
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/failing-proj"
mkdir -p "$WORKTREE"
echo '{ "name": "failing" }' > "$WORKTREE/package.json"

cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "Tests: 10 passed, 3 failed"
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/npm"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "BaselineFail_TestsFail_ExitsOne"
else
    fail "BaselineFail_TestsFail_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: MissingWorktreePath_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingWorktreePath_ExitsTwo"
else
    fail "MissingWorktreePath_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: StructuredOutput_MarkdownFormat
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/md-proj"
mkdir -p "$WORKTREE"
echo '{ "name": "markdown-test" }' > "$WORKTREE/package.json"

cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
echo "All tests passed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no '## ' heading in output)"
    echo "  Output: $OUTPUT"
fi
# Check for project type in output
if echo "$OUTPUT" | grep -qi "project type\|detected"; then
    pass "StructuredOutput_MentionsProjectType"
else
    fail "StructuredOutput_MentionsProjectType (no project type mentioned)"
    echo "  Output: $OUTPUT"
fi
# Check for pass/fail result
if echo "$OUTPUT" | grep -qiE "PASS|FAIL|result"; then
    pass "StructuredOutput_HasResult"
else
    fail "StructuredOutput_HasResult (no result indicator in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: RustProject_CargoTomlExists_RunsCargoTest
# --------------------------------------------------
setup
WORKTREE="$TMPDIR_ROOT/rust-proj"
mkdir -p "$WORKTREE"
cat > "$WORKTREE/Cargo.toml" << 'TOML'
[package]
name = "test-crate"
version = "0.1.0"
TOML

# Mock cargo that succeeds
cat > "$MOCK_BIN/cargo" << 'MOCKEOF'
#!/usr/bin/env bash
echo "cargo-test-executed"
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/cargo"

OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --worktree-path "$WORKTREE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "RustProject_CargoTomlExists_ExitsZero"
else
    fail "RustProject_CargoTomlExists_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "rust\|cargo"; then
    pass "RustProject_CargoTomlExists_DetectedRust"
else
    fail "RustProject_CargoTomlExists_DetectedRust (Rust not mentioned in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: HelpFlag_PrintsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_PrintsUsage_ExitsZero"
else
    fail "HelpFlag_PrintsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "usage"; then
    pass "HelpFlag_ContainsUsageText"
else
    fail "HelpFlag_ContainsUsageText (no 'usage' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: NonexistentWorktreePath_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --worktree-path "/nonexistent/path/nowhere" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "NonexistentWorktreePath_ExitsTwo"
else
    fail "NonexistentWorktreePath_ExitsTwo (exit=$EXIT_CODE, expected 2)"
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
