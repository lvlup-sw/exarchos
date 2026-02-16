#!/usr/bin/env bash
# Validate Refactor — Test Suite
# Validates test/lint/typecheck execution with structured output.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-refactor.sh"
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
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Create a repo root with package.json containing all scripts
create_repo_all_pass() {
    local dir="$1"
    mkdir -p "$dir"

    # Create package.json with all scripts
    cat > "$dir/package.json" << 'EOF'
{
  "scripts": {
    "test:run": "echo tests passed",
    "lint": "echo lint passed",
    "typecheck": "echo typecheck passed"
  }
}
EOF

    # Mock npm that reads package.json and succeeds for all scripts
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
# Simulate npm run — always succeeds
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"

    echo "$dir"
}

# Create repo where tests fail
create_repo_tests_fail() {
    local dir="$1"
    mkdir -p "$dir"

    cat > "$dir/package.json" << 'EOF'
{
  "scripts": {
    "test:run": "echo tests failed && exit 1",
    "lint": "echo lint passed",
    "typecheck": "echo typecheck passed"
  }
}
EOF

    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
# test:run fails, others succeed
if [[ "${2:-}" == "test:run" ]]; then
    echo "FAIL: some tests failed" >&2
    exit 1
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"

    echo "$dir"
}

# Create repo where lint fails
create_repo_lint_fail() {
    local dir="$1"
    mkdir -p "$dir"

    cat > "$dir/package.json" << 'EOF'
{
  "scripts": {
    "test:run": "echo tests passed",
    "lint": "echo lint failed && exit 1",
    "typecheck": "echo typecheck passed"
  }
}
EOF

    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
if [[ "${2:-}" == "lint" ]]; then
    echo "FAIL: lint errors found" >&2
    exit 1
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"

    echo "$dir"
}

# Create repo with no lint script
create_repo_no_lint() {
    local dir="$1"
    mkdir -p "$dir"

    cat > "$dir/package.json" << 'EOF'
{
  "scripts": {
    "test:run": "echo tests passed",
    "typecheck": "echo typecheck passed"
  }
}
EOF

    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/usr/bin/env bash
# No lint script — npm run lint would fail with "missing script"
if [[ "${2:-}" == "lint" ]]; then
    echo "npm ERR! Missing script: \"lint\"" >&2
    exit 1
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"

    echo "$dir"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Validate Refactor Tests ==="
echo ""

# --------------------------------------------------
# Test 1: AllPass_ExitsZero
# --------------------------------------------------
setup
REPO="$(create_repo_all_pass "$TMPDIR_ROOT/repo1")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllPass_ExitsZero"
else
    fail "AllPass_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: TestsFail_ExitsOne
# --------------------------------------------------
setup
REPO="$(create_repo_tests_fail "$TMPDIR_ROOT/repo2")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "TestsFail_ExitsOne"
else
    fail "TestsFail_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: LintFails_ExitsOne
# --------------------------------------------------
setup
REPO="$(create_repo_lint_fail "$TMPDIR_ROOT/repo3")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "LintFails_ExitsOne"
else
    fail "LintFails_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: SkipLint_Works
# --------------------------------------------------
setup
REPO="$(create_repo_lint_fail "$TMPDIR_ROOT/repo4")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --skip-lint 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipLint_Works"
else
    fail "SkipLint_Works (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify SKIP marker in output
if echo "$OUTPUT" | grep -qi "SKIP.*lint"; then
    pass "SkipLint_ShowsSkipMarker"
else
    fail "SkipLint_ShowsSkipMarker (no SKIP marker for lint in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: SkipTypecheck_Works
# --------------------------------------------------
setup
REPO="$(create_repo_all_pass "$TMPDIR_ROOT/repo5")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" --skip-typecheck 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SkipTypecheck_Works"
else
    fail "SkipTypecheck_Works (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify SKIP marker in output
if echo "$OUTPUT" | grep -qi "SKIP.*typecheck"; then
    pass "SkipTypecheck_ShowsSkipMarker"
else
    fail "SkipTypecheck_ShowsSkipMarker (no SKIP marker for typecheck in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: MissingScript_Skipped
# --------------------------------------------------
setup
REPO="$(create_repo_no_lint "$TMPDIR_ROOT/repo6")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should pass (exit 0) because missing lint script is skipped, not failed
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MissingScript_Skipped"
else
    fail "MissingScript_Skipped (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify SKIP marker for lint
if echo "$OUTPUT" | grep -qi "SKIP.*lint"; then
    pass "MissingScript_ShowsSkipMarker"
else
    fail "MissingScript_ShowsSkipMarker (no SKIP marker for missing lint in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_ExitsTwo
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

# --------------------------------------------------
# Test 8: StructuredOutput_HasPassFailMarkers
# --------------------------------------------------
setup
REPO="$(create_repo_all_pass "$TMPDIR_ROOT/repo8")"
OUTPUT="$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "(PASS|FAIL)"; then
    pass "StructuredOutput_HasPassFailMarkers"
else
    fail "StructuredOutput_HasPassFailMarkers (no PASS/FAIL markers)"
    echo "  Output: $OUTPUT"
fi
# Check for markdown heading
if echo "$OUTPUT" | grep -qE "^## "; then
    pass "StructuredOutput_HasMarkdownHeading"
else
    fail "StructuredOutput_HasMarkdownHeading (no markdown heading)"
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
