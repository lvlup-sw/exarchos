#!/usr/bin/env bash
# Check PR Comments — Test Script
# Tests check-pr-comments.sh argument parsing and help output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-pr-comments.sh"
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

run_test() {
    local name="$1"; shift
    if "$@" >/dev/null 2>&1; then
        pass "$name"
    else
        fail "$name"
    fi
}

run_test_expect_exit() {
    local name="$1"; local expected_exit="$2"; shift 2
    local actual_exit=0
    "$@" >/dev/null 2>&1 || actual_exit=$?
    if [[ "$actual_exit" -eq "$expected_exit" ]]; then
        pass "$name"
    else
        fail "$name (expected exit $expected_exit, got $actual_exit)"
    fi
}

# ============================================================
# ARGUMENT PARSING TESTS
# ============================================================

# Test: No arguments → exit 2
run_test_expect_exit "no_args_exit_2" 2 bash "$SCRIPT"

# Test: Missing --pr value → exit 2
run_test_expect_exit "missing_pr_value_exit_2" 2 bash "$SCRIPT" --pr

# Test: Unknown argument → exit 2
run_test_expect_exit "unknown_arg_exit_2" 2 bash "$SCRIPT" --bogus

# Test: --help → exit 0
run_test "help_exit_0" bash "$SCRIPT" --help

# Test: --help output contains usage info
if bash "$SCRIPT" --help 2>&1 | grep -q "Usage:"; then
    pass "help_contains_usage"
else
    fail "help_contains_usage"
fi

# Test: --help output mentions exit codes
if bash "$SCRIPT" --help 2>&1 | grep -q "Exit codes"; then
    pass "help_contains_exit_codes"
else
    fail "help_contains_exit_codes"
fi

# ============================================================
# MOCK-BASED TESTS
# ============================================================

# Create temporary directory for mock gh CLI
MOCK_DIR="$(mktemp -d)"
MOCK_GH="$MOCK_DIR/gh"

cleanup() {
    rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Test: All comments addressed (each top-level has reply) → exit 0
cat > "$MOCK_GH" << 'MOCK'
#!/usr/bin/env bash
# Mock gh that returns comments with all threads replied to
if [[ "$*" == *"pulls"*"comments"* ]]; then
    echo '[
        {"id": 100, "in_reply_to_id": null, "user": {"login": "sentry[bot]"}, "path": "src/foo.ts", "line": 10, "body": "Potential bug here"},
        {"id": 101, "in_reply_to_id": 100, "user": {"login": "developer"}, "path": "src/foo.ts", "line": 10, "body": "Fixed in next commit"}
    ]'
elif [[ "$*" == *"nameWithOwner"* ]]; then
    echo "owner/repo"
fi
MOCK
chmod +x "$MOCK_GH"

if PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" --pr 123 --repo owner/repo 2>&1 | grep -q "PASS"; then
    pass "all_addressed_exit_0"
else
    fail "all_addressed_exit_0"
fi

# Test: Unaddressed comment → exit 1
cat > "$MOCK_GH" << 'MOCK'
#!/usr/bin/env bash
if [[ "$*" == *"pulls"*"comments"* ]]; then
    echo '[
        {"id": 200, "in_reply_to_id": null, "user": {"login": "graphite-app[bot]"}, "path": "src/bar.ts", "line": 5, "body": "Consider DI here"},
        {"id": 201, "in_reply_to_id": null, "user": {"login": "sentry[bot]"}, "path": "src/baz.ts", "line": 20, "body": "Potential null deref"}
    ]'
elif [[ "$*" == *"nameWithOwner"* ]]; then
    echo "owner/repo"
fi
MOCK
chmod +x "$MOCK_GH"

run_test_expect_exit "unaddressed_comments_exit_1" 1 env PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" --pr 456 --repo owner/repo

UNADDR_OUTPUT=$(PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" --pr 456 --repo owner/repo 2>&1 || true)
if echo "$UNADDR_OUTPUT" | grep -q "Unaddressed: 2"; then
    pass "reports_unaddressed_count"
else
    fail "reports_unaddressed_count"
fi

# Test: No comments at all → exit 0 (nothing to address)
cat > "$MOCK_GH" << 'MOCK'
#!/usr/bin/env bash
if [[ "$*" == *"pulls"*"comments"* ]]; then
    echo '[]'
elif [[ "$*" == *"nameWithOwner"* ]]; then
    echo "owner/repo"
fi
MOCK
chmod +x "$MOCK_GH"

if PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" --pr 789 --repo owner/repo 2>&1 | grep -q "PASS"; then
    pass "no_comments_exit_0"
else
    fail "no_comments_exit_0"
fi

# ────────────────────────────────────────────────────────────
# Test: gh api failure → exit 2
# ────────────────────────────────────────────────────────────

cat > "$MOCK_GH" << 'MOCK'
#!/usr/bin/env bash
if [[ "$*" == *"pulls"*"comments"* ]]; then
    echo "Error: API request failed" >&2
    exit 1
elif [[ "$*" == *"nameWithOwner"* ]]; then
    echo "owner/repo"
fi
MOCK
chmod +x "$MOCK_GH"

exit_code=0
output=$(PATH="$MOCK_DIR:$PATH" bash "$SCRIPT" --pr 999 --repo owner/repo 2>&1) || exit_code=$?
if [[ $exit_code -eq 2 ]]; then
    pass "gh_api_failure_exit_2"
else
    fail "gh_api_failure_exit_2 (expected exit 2, got $exit_code)"
fi

# ============================================================
# RESULTS
# ============================================================

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
