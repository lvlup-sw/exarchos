#!/usr/bin/env bash
# Verify Review Triage — Test Script
# Tests verify-review-triage.sh with mocked state files and event streams

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-review-triage.sh"

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

MOCK_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$MOCK_DIR"
}
trap cleanup EXIT

# Helper: create a state file with PRs and review dispatch events
# Args: state_file_path, json_content
write_state_file() {
    local path="$1"
    local json="$2"
    echo "$json" > "$path"
}

# Helper: create an event stream JSONL file
# Args: stream_file_path, events (each line is a JSON event)
write_event_stream() {
    local path="$1"
    shift
    : > "$path"
    for event in "$@"; do
        echo "$event" >> "$path"
    done
}

# Helper: run the script under test
run_script() {
    bash "$SCRIPT_UNDER_TEST" "$@" 2>&1
}

# Helper: get just the exit code
run_script_exit_code() {
    set +e
    bash "$SCRIPT_UNDER_TEST" "$@" > /dev/null 2>&1
    local ec=$?
    set -e
    echo "$ec"
}

# Helper: run script and capture both output and exit code
run_script_full() {
    set +e
    local output
    output=$(bash "$SCRIPT_UNDER_TEST" "$@" 2>&1)
    local ec=$?
    set -e
    echo "EXIT_CODE=$ec"
    echo "$output"
}

# ============================================================
# TEST: validState_AllPRsRouted_Passes
# ============================================================
echo "=== Verify Review Triage Tests ==="

# Setup: state file with 2 PRs, both routed, high-risk one sent to coderabbit
STATE_FILE="$MOCK_DIR/valid-state.json"
EVENT_STREAM="$MOCK_DIR/valid-events.jsonl"

write_state_file "$STATE_FILE" '{
  "featureId": "test-feature",
  "stack": "test-stack",
  "prs": [
    {"number": 100, "branch": "task-1"},
    {"number": 101, "branch": "task-2"}
  ]
}'

write_event_stream "$EVENT_STREAM" \
    '{"type":"review.routed","data":{"pr":100,"riskScore":0.5,"destination":["coderabbit","self-hosted"],"selfHosted":true}}' \
    '{"type":"review.routed","data":{"pr":101,"riskScore":0.2,"destination":["self-hosted"],"selfHosted":true}}'

EXIT_CODE=$(run_script_exit_code --state-file "$STATE_FILE" --event-stream "$EVENT_STREAM")
if [[ "$EXIT_CODE" -eq 0 ]]; then
    pass "validState_AllPRsRouted_Passes"
else
    OUTPUT=$(run_script --state-file "$STATE_FILE" --event-stream "$EVENT_STREAM")
    fail "validState_AllPRsRouted_Passes (expected exit 0, got $EXIT_CODE) — output: $OUTPUT"
fi

# ============================================================
# TEST: missingRoutedEvent_Fails
# ============================================================

STATE_FILE_MISSING="$MOCK_DIR/missing-routed-state.json"
EVENT_STREAM_MISSING="$MOCK_DIR/missing-routed-events.jsonl"

write_state_file "$STATE_FILE_MISSING" '{
  "featureId": "test-feature",
  "stack": "test-stack",
  "prs": [
    {"number": 200, "branch": "task-1"},
    {"number": 201, "branch": "task-2"}
  ]
}'

# Only PR 200 has a routed event — PR 201 is missing
write_event_stream "$EVENT_STREAM_MISSING" \
    '{"type":"review.routed","data":{"pr":200,"riskScore":0.3,"destination":["self-hosted"],"selfHosted":true}}'

EXIT_CODE=$(run_script_exit_code --state-file "$STATE_FILE_MISSING" --event-stream "$EVENT_STREAM_MISSING")
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "missingRoutedEvent_Fails"
else
    OUTPUT=$(run_script --state-file "$STATE_FILE_MISSING" --event-stream "$EVENT_STREAM_MISSING")
    fail "missingRoutedEvent_Fails (expected exit 1, got $EXIT_CODE) — output: $OUTPUT"
fi

# ============================================================
# TEST: highRiskPR_NotSentToCodeRabbit_Fails
# ============================================================

STATE_FILE_HIGHRISK="$MOCK_DIR/highrisk-state.json"
EVENT_STREAM_HIGHRISK="$MOCK_DIR/highrisk-events.jsonl"

write_state_file "$STATE_FILE_HIGHRISK" '{
  "featureId": "test-feature",
  "stack": "test-stack",
  "prs": [
    {"number": 300, "branch": "task-1"},
    {"number": 301, "branch": "task-2"}
  ]
}'

# PR 300 is high-risk (score >= 0.4) but only sent to self-hosted, not coderabbit
write_event_stream "$EVENT_STREAM_HIGHRISK" \
    '{"type":"review.routed","data":{"pr":300,"riskScore":0.6,"destination":["self-hosted"],"selfHosted":true}}' \
    '{"type":"review.routed","data":{"pr":301,"riskScore":0.2,"destination":["self-hosted"],"selfHosted":true}}'

EXIT_CODE=$(run_script_exit_code --state-file "$STATE_FILE_HIGHRISK" --event-stream "$EVENT_STREAM_HIGHRISK")
if [[ "$EXIT_CODE" -eq 1 ]]; then
    pass "highRiskPR_NotSentToCodeRabbit_Fails"
else
    OUTPUT=$(run_script --state-file "$STATE_FILE_HIGHRISK" --event-stream "$EVENT_STREAM_HIGHRISK")
    fail "highRiskPR_NotSentToCodeRabbit_Fails (expected exit 1, got $EXIT_CODE) — output: $OUTPUT"
fi

# ============================================================
# TEST: missingArgs_ExitsUsageError
# ============================================================

EXIT_CODE=$(run_script_exit_code)
if [[ "$EXIT_CODE" -eq 2 ]]; then
    pass "missingArgs_ExitsUsageError"
else
    fail "missingArgs_ExitsUsageError (expected exit 2, got $EXIT_CODE)"
fi

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "## Test Summary"
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
