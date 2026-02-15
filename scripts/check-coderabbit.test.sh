#!/usr/bin/env bash
# CodeRabbit Review Check — Test Script
# Tests check-coderabbit.sh with mocked gh CLI responses

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-coderabbit.sh"

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
# MOCK SETUP
# ============================================================

# Create a temporary directory for mock gh CLI
MOCK_DIR="$(mktemp -d)"
MOCK_GH="$MOCK_DIR/gh"
MOCK_RESPONSES_DIR="$MOCK_DIR/responses"
mkdir -p "$MOCK_RESPONSES_DIR"

cleanup() {
    rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Create the mock gh script
# It reads responses from files keyed by the PR number in the API path
cat > "$MOCK_GH" << 'MOCK_SCRIPT'
#!/usr/bin/env bash
# Mock gh CLI — returns pre-configured JSON responses

# Parse the API path to extract PR number
# Expected call: gh api [--paginate] repos/{owner}/{repo}/pulls/{number}/reviews
if [[ "$1" == "api" ]]; then
    shift
    # Skip --paginate flag if present
    if [[ "${1:-}" == "--paginate" ]]; then shift; fi
    API_PATH="$1"
    # Extract PR number from path like repos/owner/repo/pulls/123/reviews
    PR_NUMBER=$(echo "$API_PATH" | sed -n 's|.*pulls/\([0-9]*\)/reviews.*|\1|p')

    RESPONSE_FILE="MOCK_RESPONSES_DIR_PLACEHOLDER/$PR_NUMBER.json"
    if [[ -f "$RESPONSE_FILE" ]]; then
        cat "$RESPONSE_FILE"
        exit 0
    else
        echo "Not Found" >&2
        exit 1
    fi
elif [[ "$1" == "auth" && "$2" == "status" ]]; then
    echo "github.com"
    echo "  Logged in to github.com account testuser"
    exit 0
else
    echo "mock gh: unexpected command: $*" >&2
    exit 1
fi
MOCK_SCRIPT

# Replace placeholder with actual path
sed -i.bak "s|MOCK_RESPONSES_DIR_PLACEHOLDER|$MOCK_RESPONSES_DIR|g" "$MOCK_GH" && rm -f "${MOCK_GH}.bak"
chmod +x "$MOCK_GH"

# Helper: write a mock response for a given PR number
write_mock_response() {
    local pr_number="$1"
    local json="$2"
    echo "$json" > "$MOCK_RESPONSES_DIR/$pr_number.json"
}

# Helper: clear all mock responses
clear_mock_responses() {
    rm -f "$MOCK_RESPONSES_DIR"/*.json
}

# Helper: run the script under test with mock gh on PATH
run_script() {
    PATH="$MOCK_DIR:$PATH" bash "$SCRIPT_UNDER_TEST" "$@" 2>&1
}

# Helper: get just the exit code (disable errexit so non-zero exits don't abort)
run_script_exit_code() {
    set +e
    PATH="$MOCK_DIR:$PATH" bash "$SCRIPT_UNDER_TEST" "$@" > /dev/null 2>&1
    local ec=$?
    set -e
    echo "$ec"
}

# ============================================================
# HAPPY PATH TESTS
# ============================================================
echo "=== Happy Path Tests ==="

# Test: Approved_SinglePR_ExitsZero (uses official coderabbitai[bot] login)
clear_mock_responses
write_mock_response 100 '[
  {
    "user": {"login": "coderabbitai[bot]"},
    "state": "APPROVED",
    "submitted_at": "2026-01-15T10:00:00Z"
  }
]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 100)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "Approved_SinglePR_ExitsZero"
else
    fail "Approved_SinglePR_ExitsZero (expected exit 0, got $EXIT_CODE)"
fi

# Test: NoReview_SinglePR_ExitsZero
clear_mock_responses
write_mock_response 101 '[]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 101)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "NoReview_SinglePR_ExitsZero"
else
    fail "NoReview_SinglePR_ExitsZero (expected exit 0, got $EXIT_CODE)"
fi

# Test: MultiPR_AllApproved_ExitsZero
clear_mock_responses
write_mock_response 200 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
write_mock_response 201 '[{"user":{"login":"coderabbit-ai"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
write_mock_response 202 '[]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 200 201 202)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "MultiPR_AllApproved_ExitsZero"
else
    fail "MultiPR_AllApproved_ExitsZero (expected exit 0, got $EXIT_CODE)"
fi

# ============================================================
# FAILURE TESTS
# ============================================================
echo ""
echo "=== Failure Tests ==="

# Test: ChangesRequested_SinglePR_ExitsOne
clear_mock_responses
write_mock_response 300 '[
  {
    "user": {"login": "coderabbit-ai[bot]"},
    "state": "CHANGES_REQUESTED",
    "submitted_at": "2026-01-15T10:00:00Z"
  }
]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 300)
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "ChangesRequested_SinglePR_ExitsOne"
else
    fail "ChangesRequested_SinglePR_ExitsOne (expected exit 1, got $EXIT_CODE)"
fi

# Test: Pending_SinglePR_ExitsOne
clear_mock_responses
write_mock_response 301 '[
  {
    "user": {"login": "coderabbit-ai[bot]"},
    "state": "PENDING",
    "submitted_at": "2026-01-15T10:00:00Z"
  }
]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 301)
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "Pending_SinglePR_ExitsOne"
else
    fail "Pending_SinglePR_ExitsOne (expected exit 1, got $EXIT_CODE)"
fi

# Test: MultiPR_OneChangesRequested_ExitsOne
clear_mock_responses
write_mock_response 400 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
write_mock_response 401 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"CHANGES_REQUESTED","submitted_at":"2026-01-15T10:00:00Z"}]'
write_mock_response 402 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 400 401 402)
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "MultiPR_OneChangesRequested_ExitsOne"
else
    fail "MultiPR_OneChangesRequested_ExitsOne (expected exit 1, got $EXIT_CODE)"
fi

# ============================================================
# EDGE CASE TESTS
# ============================================================
echo ""
echo "=== Edge Case Tests ==="

# Test: MixedReviews_LatestStateWins
# Multiple reviews from CodeRabbit — the latest (by submitted_at) should win
clear_mock_responses
write_mock_response 500 '[
  {
    "user": {"login": "coderabbit-ai[bot]"},
    "state": "CHANGES_REQUESTED",
    "submitted_at": "2026-01-15T08:00:00Z"
  },
  {
    "user": {"login": "coderabbit-ai[bot]"},
    "state": "APPROVED",
    "submitted_at": "2026-01-15T12:00:00Z"
  }
]'
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 500)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "MixedReviews_LatestStateWins"
else
    fail "MixedReviews_LatestStateWins (expected exit 0, got $EXIT_CODE)"
fi

# Test: StructuredOutput_PerPRVerdict
# Output should contain a markdown table with per-PR verdicts
clear_mock_responses
write_mock_response 600 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
write_mock_response 601 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"CHANGES_REQUESTED","submitted_at":"2026-01-15T10:00:00Z"}]'
OUTPUT=$(run_script --owner testowner --repo testrepo 600 601 || true)
# Check that output contains table header markers
if echo "$OUTPUT" | grep -q '|.*PR.*|.*State.*|.*Verdict.*|'; then
    pass "StructuredOutput_PerPRVerdict — has table header"
else
    fail "StructuredOutput_PerPRVerdict — missing table header in output: $OUTPUT"
fi
# Check that output contains PR 600 verdict
if echo "$OUTPUT" | grep -q '|.*600.*|.*APPROVED.*|.*pass.*|'; then
    pass "StructuredOutput_PerPRVerdict — PR 600 approved"
else
    fail "StructuredOutput_PerPRVerdict — missing PR 600 verdict in output: $OUTPUT"
fi
# Check that output contains PR 601 verdict
if echo "$OUTPUT" | grep -q '|.*601.*|.*CHANGES_REQUESTED.*|.*fail.*|'; then
    pass "StructuredOutput_PerPRVerdict — PR 601 changes_requested"
else
    fail "StructuredOutput_PerPRVerdict — missing PR 601 verdict in output: $OUTPUT"
fi

# Test: NoPRNumbers_UsageError
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "NoPRNumbers_UsageError"
else
    fail "NoPRNumbers_UsageError (expected exit 2, got $EXIT_CODE)"
fi

# Test: MissingOwner_UsageError
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --repo testrepo 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "MissingOwner_UsageError"
else
    fail "MissingOwner_UsageError (expected exit 2, got $EXIT_CODE)"
fi

# Test: MissingRepo_UsageError
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --owner testowner 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "MissingRepo_UsageError"
else
    fail "MissingRepo_UsageError (expected exit 2, got $EXIT_CODE)"
fi

# Test: InvalidOwnerFormat_UsageError
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --owner "test/owner" --repo testrepo 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "InvalidOwnerFormat_UsageError"
else
    fail "InvalidOwnerFormat_UsageError (expected exit 2, got $EXIT_CODE)"
fi

# Test: InvalidRepoFormat_UsageError
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --owner testowner --repo "test repo" 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "InvalidRepoFormat_UsageError"
else
    fail "InvalidRepoFormat_UsageError (expected exit 2, got $EXIT_CODE)"
fi

# Test: ValidOwnerFormats_Accepted (dots, hyphens, underscores allowed)
clear_mock_responses
write_mock_response 100 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
EXIT_CODE=$(run_script_exit_code --owner "my-org.name_here" --repo "my-repo.v2" 100)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "ValidOwnerFormats_Accepted"
else
    fail "ValidOwnerFormats_Accepted (expected exit 0, got $EXIT_CODE)"
fi

# Test: InvalidPRNumber_SkipsWithWarning
clear_mock_responses
write_mock_response 700 '[{"user":{"login":"coderabbit-ai[bot]"},"state":"APPROVED","submitted_at":"2026-01-15T10:00:00Z"}]'
OUTPUT=$(run_script --owner testowner --repo testrepo abc 700 || true)
if echo "$OUTPUT" | grep -qi 'warn.*abc\|skip.*abc\|invalid.*abc'; then
    pass "InvalidPRNumber_SkipsWithWarning — warning for 'abc'"
else
    fail "InvalidPRNumber_SkipsWithWarning — no warning for 'abc' in output: $OUTPUT"
fi
# PR 700 should still be processed
if echo "$OUTPUT" | grep -q '|.*700.*|.*APPROVED.*|'; then
    pass "InvalidPRNumber_SkipsWithWarning — PR 700 still processed"
else
    fail "InvalidPRNumber_SkipsWithWarning — PR 700 not in output: $OUTPUT"
fi

# Test: GitHubAPIError_ExitsNonZero
# Remove mock response file so gh api returns error
clear_mock_responses
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo 999)
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "GitHubAPIError_ExitsNonZero"
else
    fail "GitHubAPIError_ExitsNonZero (expected exit 1, got $EXIT_CODE)"
fi

# Test: HelpFlag_ExitsZero
OUTPUT=$(run_script --help || true)
EXIT_CODE=$(run_script_exit_code --help || echo "0")
if echo "$OUTPUT" | grep -qi 'usage\|help'; then
    pass "HelpFlag_ShowsUsage"
else
    fail "HelpFlag_ShowsUsage — no usage info in output"
fi

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
