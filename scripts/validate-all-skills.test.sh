#!/usr/bin/env bash
# validate-all-skills.test.sh — Tests for validate-all-skills.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-all-skills.sh"
PASS=0
FAIL=0

# Colors
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

    # Create a mock repo structure with skills/ containing .test.sh files
    MOCK_REPO="$TMPDIR_ROOT/mock-repo"
    mkdir -p "$MOCK_REPO/skills/alpha"
    mkdir -p "$MOCK_REPO/skills/beta"
    mkdir -p "$MOCK_REPO/skills/gamma"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper: create a passing .test.sh fixture
create_passing_test() {
    local dir="$1"
    local name="$2"
    cat > "$dir/$name" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "PASS: All tests passed"
exit 0
EOF
    chmod +x "$dir/$name"
}

# Helper: create a failing .test.sh fixture
create_failing_test() {
    local dir="$1"
    local name="$2"
    cat > "$dir/$name" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "FAIL: Something went wrong"
exit 1
EOF
    chmod +x "$dir/$name"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Validate All Skills Runner Tests ==="
echo ""

# --------------------------------------------------
# Test 1: TestRunner_DiscoversAllTestShFiles
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/gamma" "other.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should find all 3 .test.sh files
if echo "$OUTPUT" | grep -q "3 run"; then
    pass "TestRunner_DiscoversAllTestShFiles"
else
    fail "TestRunner_DiscoversAllTestShFiles (expected '3 run' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: TestRunner_RunsEachFile
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should show per-file output for both
ALPHA_MATCH=$(echo "$OUTPUT" | grep -c "alpha/SKILL.md.test.sh") || true
BETA_MATCH=$(echo "$OUTPUT" | grep -c "beta/SKILL.md.test.sh") || true
if [[ "$ALPHA_MATCH" -ge 1 && "$BETA_MATCH" -ge 1 ]]; then
    pass "TestRunner_RunsEachFile"
else
    fail "TestRunner_RunsEachFile (expected per-file output for alpha and beta)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: TestRunner_AnyFail_ExitsNonZero
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_failing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "TestRunner_AnyFail_ExitsNonZero"
else
    fail "TestRunner_AnyFail_ExitsNonZero (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: TestRunner_AllPass_ExitsZero
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "TestRunner_AllPass_ExitsZero"
else
    fail "TestRunner_AllPass_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: TestRunner_ReportsPerFileStatus
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_failing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should show PASS for alpha and FAIL for beta
ALPHA_PASS=$(echo "$OUTPUT" | grep "alpha/SKILL.md.test.sh" | grep -c "PASS") || true
BETA_FAIL=$(echo "$OUTPUT" | grep "beta/SKILL.md.test.sh" | grep -c "FAIL") || true
if [[ "$ALPHA_PASS" -ge 1 && "$BETA_FAIL" -ge 1 ]]; then
    pass "TestRunner_ReportsPerFileStatus"
else
    fail "TestRunner_ReportsPerFileStatus (expected PASS for alpha, FAIL for beta)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: TestRunner_SummaryShowsCounts
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/beta" "SKILL.md.test.sh"
create_failing_test "$MOCK_REPO/skills/gamma" "SKILL.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# Should show summary: 3 run, 2 passed, 1 failed
if echo "$OUTPUT" | grep -q "3 run" && echo "$OUTPUT" | grep -q "2 passed" && echo "$OUTPUT" | grep -q "1 failed"; then
    pass "TestRunner_SummaryShowsCounts"
else
    fail "TestRunner_SummaryShowsCounts (expected '3 run, 2 passed, 1 failed')"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: TestRunner_NoTestFiles_ExitsZero
# --------------------------------------------------
setup
# No .test.sh files at all — empty skills dir
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "TestRunner_NoTestFiles_ExitsZero"
else
    fail "TestRunner_NoTestFiles_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "0 run"; then
    pass "TestRunner_NoTestFiles_ShowsZeroRun"
else
    fail "TestRunner_NoTestFiles_ShowsZeroRun (expected '0 run' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: TestRunner_DefaultRepoRoot_UsesCurrentDir
# --------------------------------------------------
setup
create_passing_test "$MOCK_REPO/skills/alpha" "SKILL.md.test.sh"

# Run from the mock repo dir without --repo-root
OUTPUT="$(cd "$MOCK_REPO" && bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "TestRunner_DefaultRepoRoot_UsesCurrentDir"
else
    fail "TestRunner_DefaultRepoRoot_UsesCurrentDir (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: TestRunner_NestedTestFiles_Discovered
# --------------------------------------------------
setup
mkdir -p "$MOCK_REPO/skills/delegation/references"
create_passing_test "$MOCK_REPO/skills/delegation" "SKILL.md.test.sh"
create_passing_test "$MOCK_REPO/skills/delegation/references" "fixer-prompt.md.test.sh"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$MOCK_REPO" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "2 run"; then
    pass "TestRunner_NestedTestFiles_Discovered"
else
    fail "TestRunner_NestedTestFiles_Discovered (expected '2 run' in output)"
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
