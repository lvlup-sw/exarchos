#!/usr/bin/env bash
# Static Analysis Gate — Test Suite
# Validates all assertions for scripts/static-analysis-gate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/static-analysis-gate.sh"
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
    MOCK_BIN="$TMPDIR_ROOT/mock-bin"
    mkdir -p "$MOCK_BIN"

    # Create a minimal repo root with package.json that has all scripts
    MOCK_REPO="$TMPDIR_ROOT/repo"
    mkdir -p "$MOCK_REPO"
    cat > "$MOCK_REPO/package.json" << 'EOF'
{
  "name": "test-repo",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "quality-check": "echo quality"
  }
}
EOF

    # Mock npm: succeeds by default
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
# Default mock: all npm commands succeed with no output
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Static Analysis Gate Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AllToolsPass_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllToolsPass_ExitsZero"
else
    fail "AllToolsPass_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: LintFails_ExitsOne
# --------------------------------------------------
setup
# Override npm mock to fail on lint
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${*}" == *"lint"* ]]; then
    echo "error: ESLint found problems" >&2
    exit 1
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "LintFails_ExitsOne"
else
    fail "LintFails_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: TypecheckFails_ExitsOne
# --------------------------------------------------
setup
# Override npm mock to fail on typecheck
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${*}" == *"typecheck"* ]]; then
    echo "error TS2322: Type 'string' is not assignable" >&2
    exit 1
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "TypecheckFails_ExitsOne"
else
    fail "TypecheckFails_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: SkipLint_Flag_SkipsLintCheck
# --------------------------------------------------
setup
# Override npm mock to fail on lint (should be skipped)
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${*}" == *"lint"* ]]; then
    echo "LINT_SHOULD_NOT_RUN" >&2
    exit 1
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" --skip-lint 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipLint_Flag_SkipsLintCheck"
else
    fail "SkipLint_Flag_SkipsLintCheck (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify lint was not invoked
if echo "$OUTPUT" | grep -q "LINT_SHOULD_NOT_RUN"; then
    fail "SkipLint_Flag_LintNotCalled (lint was called despite --skip-lint)"
else
    pass "SkipLint_Flag_LintNotCalled"
fi
teardown

# --------------------------------------------------
# Test 5: MissingScript_Skipped (npm script doesn't exist -> skip, not fail)
# --------------------------------------------------
setup
# Package.json with only lint, no typecheck or quality-check
cat > "$MOCK_REPO/package.json" << 'EOF'
{
  "name": "test-repo",
  "scripts": {
    "lint": "eslint ."
  }
}
EOF
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MissingScript_Skipped_ExitsZero"
else
    fail "MissingScript_Skipped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify SKIP appears for missing scripts
if echo "$OUTPUT" | grep -qi "SKIP"; then
    pass "MissingScript_Skipped_ShowsSkip"
else
    fail "MissingScript_Skipped_ShowsSkip (expected SKIP in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: WarningsOnly_ExitsZero (warnings don't fail)
# --------------------------------------------------
setup
# npm mock that outputs warnings but exits 0
cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${*}" == *"lint"* ]]; then
    echo "warning: Unused variable 'x'" >&2
    echo "1 warning found"
    exit 0
fi
exit 0
MOCKEOF
chmod +x "$MOCK_BIN/npm"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "WarningsOnly_ExitsZero"
else
    fail "WarningsOnly_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: StructuredOutput_MarkdownFormat
# --------------------------------------------------
setup
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_MarkdownHeading"
else
    fail "StructuredOutput_MarkdownHeading (no markdown heading in output)"
    echo "  Output: $OUTPUT"
fi
# Check for PASS/FAIL/SKIP markers
if echo "$OUTPUT" | grep -qE "(PASS|FAIL|SKIP)"; then
    pass "StructuredOutput_HasStatusMarkers"
else
    fail "StructuredOutput_HasStatusMarkers (no PASS/FAIL/SKIP in output)"
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
