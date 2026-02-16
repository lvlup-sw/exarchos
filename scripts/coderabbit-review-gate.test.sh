#!/usr/bin/env bash
# CodeRabbit Review Gate — Test Script
# Tests coderabbit-review-gate.sh with mocked gh CLI responses

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/coderabbit-review-gate.sh"

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
MOCK_CALL_LOG="$MOCK_DIR/call_log"
mkdir -p "$MOCK_RESPONSES_DIR"
touch "$MOCK_CALL_LOG"

cleanup() {
    rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Create the mock gh script
# Handles both GraphQL (gh api graphql) and REST (gh api repos/...) calls
cat > "$MOCK_GH" << 'MOCK_SCRIPT'
#!/usr/bin/env bash
# Mock gh CLI — returns pre-configured JSON responses for GraphQL and REST

CALL_LOG="CALL_LOG_PLACEHOLDER"
RESPONSES_DIR="RESPONSES_DIR_PLACEHOLDER"

if [[ "$1" == "api" ]]; then
    shift
    if [[ "$1" == "graphql" ]]; then
        shift
        # Parse -f and -F flags to extract variables and query
        QUERY=""
        VARS=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -f)
                    # Check if this is the query= parameter
                    if [[ "$2" == query=* ]]; then
                        QUERY="${2#query=}"
                    else
                        VARS="$VARS $2"
                    fi
                    shift 2
                    ;;
                -F)
                    VARS="$VARS $2"
                    shift 2
                    ;;
                -f*)
                    if [[ "${1#-f}" == query=* ]]; then
                        QUERY="${1#-fquery=}"
                    else
                        VARS="$VARS ${1#-f}"
                    fi
                    shift
                    ;;
                -F*)
                    VARS="$VARS ${1#-F}"
                    shift
                    ;;
                *)
                    QUERY="$1"
                    shift
                    ;;
            esac
        done

        # Log the call
        echo "GRAPHQL|$VARS|$QUERY" >> "$CALL_LOG"

        # Detect mutation vs query
        if echo "$QUERY" | grep -q "mutation"; then
            # Check for mutation response file
            if [[ -f "$RESPONSES_DIR/mutation.json" ]]; then
                cat "$RESPONSES_DIR/mutation.json"
            else
                echo '{"data":{"resolveReviewThread":{"thread":{"id":"T_1","isResolved":true}}}}'
            fi
            exit 0
        fi

        # Detect what query is being made based on content
        if echo "$QUERY" | grep -q "reviewThreads"; then
            if [[ -f "$RESPONSES_DIR/threads.json" ]]; then
                cat "$RESPONSES_DIR/threads.json"
            else
                echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
            fi
            exit 0
        elif echo "$QUERY" | grep -q "reviews"; then
            if [[ -f "$RESPONSES_DIR/reviews.json" ]]; then
                cat "$RESPONSES_DIR/reviews.json"
            else
                echo '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]}}}}}'
            fi
            exit 0
        else
            echo '{"data":{}}'
            exit 0
        fi
    else
        # REST API call (e.g., posting comments)
        API_PATH="$1"
        shift
        # Capture request body if present
        BODY=""
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -f|-F)
                    BODY="$BODY $2"
                    shift 2
                    ;;
                --input|-)
                    # Read from stdin
                    BODY="$(cat)"
                    shift
                    ;;
                *)
                    shift
                    ;;
            esac
        done
        echo "REST|$API_PATH|$BODY" >> "$CALL_LOG"
        echo '{"id":1,"body":"comment"}'
        exit 0
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

# Replace placeholders with actual paths
sed -i.bak "s|CALL_LOG_PLACEHOLDER|$MOCK_CALL_LOG|g" "$MOCK_GH" && rm -f "${MOCK_GH}.bak"
sed -i.bak "s|RESPONSES_DIR_PLACEHOLDER|$MOCK_RESPONSES_DIR|g" "$MOCK_GH" && rm -f "${MOCK_GH}.bak"
chmod +x "$MOCK_GH"

# Emoji constants for severity markers
EMOJI_RED=$(printf '\xf0\x9f\x94\xb4')       # Red circle (U+1F534)
EMOJI_ORANGE=$(printf '\xf0\x9f\x9f\xa0')     # Orange circle (U+1F7E0)
EMOJI_YELLOW=$(printf '\xf0\x9f\x9f\xa1')     # Yellow circle (U+1F7E1)

# Helper: write a mock response for reviews query
write_reviews_response() {
    local json="$1"
    echo "$json" > "$MOCK_RESPONSES_DIR/reviews.json"
}

# Helper: write a mock response for threads query
write_threads_response() {
    local json="$1"
    echo "$json" > "$MOCK_RESPONSES_DIR/threads.json"
}

# Helper: write a mock response for mutations
write_mutation_response() {
    local json="$1"
    echo "$json" > "$MOCK_RESPONSES_DIR/mutation.json"
}

# Helper: clear all mock responses and call log
clear_mocks() {
    rm -f "$MOCK_RESPONSES_DIR"/*.json
    : > "$MOCK_CALL_LOG"
}

# Helper: get call log contents
get_call_log() {
    cat "$MOCK_CALL_LOG"
}

# Helper: count calls matching a pattern
count_calls() {
    local pattern="$1"
    local count
    count=$(grep -c "$pattern" "$MOCK_CALL_LOG" 2>/dev/null) || count=0
    echo "$count"
}

# Helper: run the script under test with mock gh on PATH
run_script() {
    PATH="$MOCK_DIR:$PATH" bash "$SCRIPT_UNDER_TEST" "$@" 2>&1
}

# Helper: get just the exit code
run_script_exit_code() {
    set +e
    PATH="$MOCK_DIR:$PATH" bash "$SCRIPT_UNDER_TEST" "$@" > /dev/null 2>&1
    local ec=$?
    set -e
    echo "$ec"
}

# Helper: run script and capture both output and exit code
run_script_full() {
    set +e
    local output
    output=$(PATH="$MOCK_DIR:$PATH" bash "$SCRIPT_UNDER_TEST" "$@" 2>&1)
    local ec=$?
    set -e
    echo "EXIT_CODE=$ec"
    echo "$output"
}

# ============================================================
# TASK 1: SKELETON AND ARGUMENT PARSING TESTS
# ============================================================
echo "=== Task 1: Skeleton and Argument Parsing ==="

# Test: MissingOwner_ExitsTwo
clear_mocks
EXIT_CODE=$(run_script_exit_code --repo testrepo --pr 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "MissingOwner_ExitsTwo"
else
    fail "MissingOwner_ExitsTwo (expected exit 2, got $EXIT_CODE)"
fi

# Test: MissingRepo_ExitsTwo
clear_mocks
EXIT_CODE=$(run_script_exit_code --owner testowner --pr 100)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "MissingRepo_ExitsTwo"
else
    fail "MissingRepo_ExitsTwo (expected exit 2, got $EXIT_CODE)"
fi

# Test: MissingPR_ExitsTwo
clear_mocks
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "MissingPR_ExitsTwo"
else
    fail "MissingPR_ExitsTwo (expected exit 2, got $EXIT_CODE)"
fi

# Test: HelpFlag_ShowsUsage
clear_mocks
OUTPUT=$(run_script --help || true)
if echo "$OUTPUT" | grep -qi 'usage\|help'; then
    pass "HelpFlag_ShowsUsage"
else
    fail "HelpFlag_ShowsUsage — no usage info in output"
fi

# Test: ValidArgs_ExitsZero
clear_mocks
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo --pr 100)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "ValidArgs_ExitsZero"
else
    fail "ValidArgs_ExitsZero (expected exit 0, got $EXIT_CODE)"
fi

# Test: DryRun_NoComment
clear_mocks
EXIT_CODE=$(run_script_exit_code --owner testowner --repo testrepo --pr 100 --dry-run)
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "DryRun_NoComment"
else
    fail "DryRun_NoComment (expected exit 0, got $EXIT_CODE)"
fi

# ============================================================
# TASK 2: REVIEW ROUND COUNTING TESTS
# ============================================================
echo ""
echo "=== Task 2: Review Round Counting ==="

# Test: CountRounds_OneReview_ReturnsOne
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Round:** 1'; then
    pass "CountRounds_OneReview_ReturnsOne"
else
    fail "CountRounds_OneReview_ReturnsOne — output: $OUTPUT"
fi

# Test: CountRounds_ThreeReviews_ReturnsThree
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T08:00:00Z"},{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"},{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T12:00:00Z"}]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Round:** 3'; then
    pass "CountRounds_ThreeReviews_ReturnsThree"
else
    fail "CountRounds_ThreeReviews_ReturnsThree — output: $OUTPUT"
fi

# Test: CountRounds_MixedReviewers_OnlyCountsCodeRabbit
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T08:00:00Z"},{"author":{"login":"humanreviewer"},"submittedAt":"2026-01-15T09:00:00Z"},{"author":{"login":"otherbot[bot]"},"submittedAt":"2026-01-15T10:00:00Z"},{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T11:00:00Z"}]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Round:** 2'; then
    pass "CountRounds_MixedReviewers_OnlyCountsCodeRabbit"
else
    fail "CountRounds_MixedReviewers_OnlyCountsCodeRabbit — output: $OUTPUT"
fi

# Test: CountRounds_NoReviews_ReturnsZero
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Round:** 0'; then
    pass "CountRounds_NoReviews_ReturnsZero"
else
    fail "CountRounds_NoReviews_ReturnsZero — output: $OUTPUT"
fi

# ============================================================
# TASK 3: THREAD QUERYING AND SEVERITY CLASSIFICATION TESTS
# ============================================================
echo ""
echo "=== Task 3: Thread Querying and Severity Classification ==="

# Test: GetThreads_NoThreads_ReturnsEmpty
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Active Threads:** 0'; then
    pass "GetThreads_NoThreads_ReturnsEmpty"
else
    fail "GetThreads_NoThreads_ReturnsEmpty — output: $OUTPUT"
fi

# Test: GetThreads_ResolvedExcluded
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_1","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"body":"Resolved issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_2","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Active issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_3","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"body":"Another resolved","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Active Threads:** 1'; then
    pass "GetThreads_ResolvedExcluded"
else
    fail "GetThreads_ResolvedExcluded — output: $OUTPUT"
fi

# Test: ClassifySeverity_CriticalMarker_ReturnsCritical
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_RED} Critical: SQL injection vulnerability detected\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** true'; then
    pass "ClassifySeverity_CriticalMarker_ReturnsCritical"
else
    fail "ClassifySeverity_CriticalMarker_ReturnsCritical — output: $OUTPUT"
fi

# Test: ClassifySeverity_MajorMarker_ReturnsMajor
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_ORANGE} Major: Missing error handling in async function\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** true'; then
    pass "ClassifySeverity_MajorMarker_ReturnsMajor"
else
    fail "ClassifySeverity_MajorMarker_ReturnsMajor — output: $OUTPUT"
fi

# Test: ClassifySeverity_MinorOnly_NoBlockers
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_YELLOW} Minor: Consider renaming variable for clarity\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** false'; then
    pass "ClassifySeverity_MinorOnly_NoBlockers"
else
    fail "ClassifySeverity_MinorOnly_NoBlockers — output: $OUTPUT"
fi

# Test: ClassifySeverity_NonBotEmoji_Ignored
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_RED} Critical: not from bot\",\"author\":{\"login\":\"humanreviewer\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** false'; then
    pass "ClassifySeverity_NonBotEmoji_Ignored"
else
    fail "ClassifySeverity_NonBotEmoji_Ignored — output: $OUTPUT"
fi

# Test: GetThreads_OutdatedExcluded
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_1","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Outdated issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_2","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Active issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_3","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Another outdated","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Active Threads:** 1'; then
    pass "GetThreads_OutdatedExcluded"
else
    fail "GetThreads_OutdatedExcluded — output: $OUTPUT"
fi

# ============================================================
# TASK 4: AUTO-RESOLVE OUTDATED THREADS TESTS
# ============================================================
echo ""
echo "=== Task 4: Auto-Resolve Outdated Threads ==="

# Test: ResolveOutdated_OutdatedThreads_CallsMutation
# Mock returns threads with some outdated+unresolved; script should call resolveReviewThread mutation
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_outdated_1","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Old finding","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_outdated_2","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Another old finding","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_active","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Current finding","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
MUTATION_COUNT=$(count_calls "mutation")
if [[ "$MUTATION_COUNT" -eq 2 ]]; then
    pass "ResolveOutdated_OutdatedThreads_CallsMutation"
else
    fail "ResolveOutdated_OutdatedThreads_CallsMutation (expected 2 mutation calls, got $MUTATION_COUNT)"
fi

# Test: ResolveOutdated_NoOutdated_NoMutation
# All threads are either resolved or not outdated — no mutation calls expected
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_resolved","isResolved":true,"isOutdated":true,"comments":{"nodes":[{"body":"Already resolved","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_active","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Active finding","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
MUTATION_COUNT=$(count_calls "mutation")
if [[ "$MUTATION_COUNT" -eq 0 ]]; then
    pass "ResolveOutdated_NoOutdated_NoMutation"
else
    fail "ResolveOutdated_NoOutdated_NoMutation (expected 0 mutation calls, got $MUTATION_COUNT)"
fi

# Test: DryRun_OutdatedThreads_NoMutation
# With --dry-run, outdated threads should NOT be resolved (no mutation calls)
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_outdated_1","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Old finding","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_active","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Current finding","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100 --dry-run)
MUTATION_COUNT=$(count_calls "mutation")
if [[ "$MUTATION_COUNT" -eq 0 ]]; then
    pass "DryRun_OutdatedThreads_NoMutation"
else
    fail "DryRun_OutdatedThreads_NoMutation (expected 0 mutation calls, got $MUTATION_COUNT)"
fi

# Test: ResolveOutdated_NonBotThread_NotResolved
# Outdated threads from non-CodeRabbit authors should NOT be auto-resolved
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_bot_outdated","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Old bot finding","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_human_outdated","isResolved":false,"isOutdated":true,"comments":{"nodes":[{"body":"Old human comment","author":{"login":"humanreviewer"}}]}},
  {"id":"T_active","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Current finding","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
MUTATION_COUNT=$(count_calls "mutation")
if [[ "$MUTATION_COUNT" -eq 1 ]]; then
    pass "ResolveOutdated_NonBotThread_NotResolved"
else
    fail "ResolveOutdated_NonBotThread_NotResolved (expected 1 mutation call for bot thread only, got $MUTATION_COUNT)"
fi

# ============================================================
# TASK 3: THREAD QUERYING AND SEVERITY CLASSIFICATION TESTS
# ============================================================
echo ""
echo "=== Task 3: Thread Querying and Severity Classification ==="

# Test: GetThreads_NoThreads_ReturnsEmpty
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Active Threads:** 0'; then
    pass "GetThreads_NoThreads_ReturnsEmpty"
else
    fail "GetThreads_NoThreads_ReturnsEmpty — output: $OUTPUT"
fi

# Test: GetThreads_ResolvedExcluded
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
  {"id":"T_1","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"body":"Resolved issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_2","isResolved":false,"isOutdated":false,"comments":{"nodes":[{"body":"Active issue","author":{"login":"coderabbitai[bot]"}}]}},
  {"id":"T_3","isResolved":true,"isOutdated":false,"comments":{"nodes":[{"body":"Another resolved","author":{"login":"coderabbitai[bot]"}}]}}
]}}}}}'
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Active Threads:** 1'; then
    pass "GetThreads_ResolvedExcluded"
else
    fail "GetThreads_ResolvedExcluded — output: $OUTPUT"
fi

# Test: ClassifySeverity_CriticalMarker_ReturnsCritical
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_RED} Critical: SQL injection vulnerability detected\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** true'; then
    pass "ClassifySeverity_CriticalMarker_ReturnsCritical"
else
    fail "ClassifySeverity_CriticalMarker_ReturnsCritical — output: $OUTPUT"
fi

# Test: ClassifySeverity_MajorMarker_ReturnsMajor
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_ORANGE} Major: Missing error handling in async function\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** true'; then
    pass "ClassifySeverity_MajorMarker_ReturnsMajor"
else
    fail "ClassifySeverity_MajorMarker_ReturnsMajor — output: $OUTPUT"
fi

# Test: ClassifySeverity_MinorOnly_NoBlockers
clear_mocks
write_reviews_response '{"data":{"repository":{"pullRequest":{"reviews":{"nodes":[{"author":{"login":"coderabbitai[bot]"},"submittedAt":"2026-01-15T10:00:00Z"}]}}}}}'
write_threads_response "{\"data\":{\"repository\":{\"pullRequest\":{\"reviewThreads\":{\"nodes\":[
  {\"id\":\"T_1\",\"isResolved\":false,\"isOutdated\":false,\"comments\":{\"nodes\":[{\"body\":\"${EMOJI_YELLOW} Minor: Consider renaming variable for clarity\",\"author\":{\"login\":\"coderabbitai[bot]\"}}]}}
]}}}}}"
OUTPUT=$(run_script --owner testowner --repo testrepo --pr 100)
if echo "$OUTPUT" | grep -qF '**Blocking Findings:** false'; then
    pass "ClassifySeverity_MinorOnly_NoBlockers"
else
    fail "ClassifySeverity_MinorOnly_NoBlockers — output: $OUTPUT"
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
