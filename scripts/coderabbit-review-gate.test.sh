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
                    VARS="$VARS $2"
                    shift 2
                    ;;
                -F)
                    VARS="$VARS $2"
                    shift 2
                    ;;
                -f*)
                    VARS="$VARS ${1#-f}"
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
    grep -c "$pattern" "$MOCK_CALL_LOG" 2>/dev/null || echo "0"
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
