#!/usr/bin/env bash
# verify-review-triage.sh
# Verifies review triage was applied correctly to a stack of PRs.
#
# Usage: verify-review-triage.sh --state-file <path> --event-stream <path>
#
# Checks:
#   1. All PRs in state file have a review.routed event in the event stream
#   2. High-risk PRs (riskScore >= 0.4) were sent to CodeRabbit
#   3. Self-hosted review ran for all PRs (destination is "self-hosted" or "both")
#   4. No PR is missing review routing
#
# Exit codes:
#   0  All checks pass
#   1  Verification failed (details in output)
#   2  Usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# USAGE
# ============================================================

usage() {
    cat <<'EOF'
Usage: verify-review-triage.sh --state-file <path> --event-stream <path>

Verifies review triage was applied correctly to a stack of PRs.

Options:
  --state-file <path>     Path to workflow state JSON file (required)
  --event-stream <path>   Path to event stream JSONL file (required)
  --help                  Show this help message

Checks:
  1. All PRs have a review.routed event
  2. High-risk PRs (score >= 0.4) sent to CodeRabbit
  3. Self-hosted review ran for all PRs
  4. No PR missing review routing

Exit codes:
  0   All checks pass
  1   Verification failed (details in output)
  2   Usage error (missing required arguments)
EOF
}

# ============================================================
# ARGUMENT PARSING
# ============================================================

STATE_FILE=""
EVENT_STREAM=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --state-file)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --state-file requires a value" >&2
                exit 2
            fi
            STATE_FILE="$2"
            shift 2
            ;;
        --event-stream)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --event-stream requires a value" >&2
                exit 2
            fi
            EVENT_STREAM="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        -*)
            echo -e "${RED}ERROR${NC}: Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
        *)
            echo -e "${RED}ERROR${NC}: Unexpected argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

# ============================================================
# VALIDATION
# ============================================================

if [[ -z "$STATE_FILE" ]]; then
    echo -e "${RED}ERROR${NC}: --state-file is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$STATE_FILE" ]]; then
    echo -e "${RED}ERROR${NC}: State file not found: $STATE_FILE" >&2
    exit 2
fi

if [[ -z "$EVENT_STREAM" ]]; then
    echo -e "${RED}ERROR${NC}: --event-stream is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$EVENT_STREAM" ]]; then
    echo -e "${RED}ERROR${NC}: Event stream file not found: $EVENT_STREAM" >&2
    exit 2
fi

# ============================================================
# DEPENDENCY CHECKS
# ============================================================

if ! command -v jq &> /dev/null; then
    echo -e "${RED}ERROR${NC}: jq is not installed" >&2
    exit 1
fi

# ============================================================
# VERIFICATION LOGIC
# ============================================================

HAS_FAILURE=false
CHECKS_PASSED=0
CHECKS_FAILED=0
REPORT_LINES=()

report_pass() {
    local msg="$1"
    REPORT_LINES+=("| PASS | $msg |")
    CHECKS_PASSED=$((CHECKS_PASSED + 1))
}

report_fail() {
    local msg="$1"
    REPORT_LINES+=("| FAIL | $msg |")
    CHECKS_FAILED=$((CHECKS_FAILED + 1))
    HAS_FAILURE=true
}

# Extract PR numbers from state file
PR_NUMBERS=$(jq -r '.prs[].number' "$STATE_FILE" 2>/dev/null)
if [[ -z "$PR_NUMBERS" ]]; then
    echo -e "${RED}ERROR${NC}: No PRs found in state file" >&2
    exit 1
fi

# Build a lookup of review.routed events from the event stream (one per line JSONL)
# Parse each line that is a review.routed event
for pr in $PR_NUMBERS; do
    # Check 1: review.routed event exists for this PR
    ROUTED_EVENT=$(jq -c "select(.type == \"review.routed\" and .data.pr == $pr)" "$EVENT_STREAM" 2>/dev/null | tail -1)

    if [[ -z "$ROUTED_EVENT" ]]; then
        report_fail "PR #$pr: missing review.routed event"
        continue
    fi

    report_pass "PR #$pr: review.routed event exists"

    # Check 2: High-risk PRs (riskScore >= 0.4) sent to CodeRabbit
    RISK_SCORE=$(echo "$ROUTED_EVENT" | jq -r '.data.riskScore // 0')
    IS_HIGH_RISK=$(echo "$RISK_SCORE" | jq -Rr 'tonumber >= 0.4')

    if [[ "$IS_HIGH_RISK" == "true" ]]; then
        HAS_CODERABBIT=$(echo "$ROUTED_EVENT" | jq -r '.data.destination == "coderabbit" or .data.destination == "both"')
        if [[ "$HAS_CODERABBIT" == "true" ]]; then
            report_pass "PR #$pr: high-risk (score=$RISK_SCORE) sent to CodeRabbit"
        else
            report_fail "PR #$pr: high-risk (score=$RISK_SCORE) NOT sent to CodeRabbit"
        fi
    fi

    # Check 3: Self-hosted review ran for all PRs
    SELF_HOSTED=$(echo "$ROUTED_EVENT" | jq -r '.data.destination == "self-hosted" or .data.destination == "both"')
    if [[ "$SELF_HOSTED" == "true" ]]; then
        report_pass "PR #$pr: self-hosted review enabled"
    else
        report_fail "PR #$pr: self-hosted review NOT enabled"
    fi
done

# ============================================================
# OUTPUT REPORT
# ============================================================

echo "## Review Triage Verification"
echo ""
echo "| Status | Check |"
echo "|--------|-------|"
for line in "${REPORT_LINES[@]}"; do
    echo "$line"
done
echo ""
echo "**Passed:** $CHECKS_PASSED | **Failed:** $CHECKS_FAILED"

# ============================================================
# EXIT CODE
# ============================================================

if [[ "$HAS_FAILURE" == true ]]; then
    exit 1
else
    exit 0
fi
