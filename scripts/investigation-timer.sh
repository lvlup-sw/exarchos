#!/usr/bin/env bash
# Investigation Timer
# Enforces the 15-minute investigation time-box for hotfix track.
# Replaces prose "15-Minute Investigation Checkpoint" with deterministic validation.
#
# Usage: investigation-timer.sh --started-at <ISO8601> [--budget-minutes 15]
#        investigation-timer.sh --state-file <path> [--budget-minutes 15]
#
# Exit codes:
#   0 = within budget
#   1 = budget exceeded
#   2 = usage error (missing required args, invalid input)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

STARTED_AT=""
STATE_FILE=""
BUDGET_MINUTES=15

usage() {
    cat << 'USAGE'
Usage: investigation-timer.sh --started-at <ISO8601> [--budget-minutes 15]
       investigation-timer.sh --state-file <path> [--budget-minutes 15]

Required (one of):
  --started-at <ISO8601>   Investigation start timestamp
  --state-file <path>      Path to workflow state JSON (reads investigation.startedAt)

Optional:
  --budget-minutes <N>     Investigation budget in minutes (default: 15)
  --help                   Show this help message

Exit codes:
  0  Within budget
  1  Budget exceeded — recommend escalating to thorough track
  2  Usage error (missing args, invalid timestamp)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --started-at)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --started-at requires an ISO8601 timestamp argument" >&2
                exit 2
            fi
            STARTED_AT="$2"
            shift 2
            ;;
        --state-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --state-file requires a path argument" >&2
                exit 2
            fi
            STATE_FILE="$2"
            shift 2
            ;;
        --budget-minutes)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --budget-minutes requires a number argument" >&2
                exit 2
            fi
            BUDGET_MINUTES="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument '$1'" >&2
            usage >&2
            exit 2
            ;;
    esac
done

# ============================================================
# RESOLVE STARTED_AT
# ============================================================

if [[ -z "$STARTED_AT" && -z "$STATE_FILE" ]]; then
    echo "Error: Either --started-at or --state-file is required" >&2
    usage >&2
    exit 2
fi

if [[ -n "$STATE_FILE" && -z "$STARTED_AT" ]]; then
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "Error: State file not found: $STATE_FILE" >&2
        exit 2
    fi

    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required but not installed" >&2
        exit 2
    fi

    STARTED_AT="$(jq -r '.investigation.startedAt // empty' "$STATE_FILE")"
    if [[ -z "$STARTED_AT" ]]; then
        echo "Error: No investigation.startedAt found in state file" >&2
        exit 2
    fi
fi

# ============================================================
# VALIDATE TIMESTAMP
# ============================================================

# Try to parse the timestamp to epoch seconds
# macOS date: date -j -f format
# GNU date:   date -d string
START_EPOCH=""

# Try GNU date first (Linux), then macOS date (with TZ=UTC to handle Z suffix correctly)
if START_EPOCH="$(date -d "$STARTED_AT" +%s 2>/dev/null)"; then
    : # success
elif START_EPOCH="$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%SZ" "$STARTED_AT" +%s 2>/dev/null)"; then
    : # success
elif START_EPOCH="$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S%z" "$STARTED_AT" +%s 2>/dev/null)"; then
    : # success
else
    echo "Error: Invalid timestamp: $STARTED_AT (expected ISO8601 format)" >&2
    exit 2
fi

# ============================================================
# CALCULATE ELAPSED TIME
# ============================================================

NOW_EPOCH="$(date +%s)"
ELAPSED_SECONDS=$(( NOW_EPOCH - START_EPOCH ))
BUDGET_SECONDS=$(( BUDGET_MINUTES * 60 ))

# Format elapsed time as Xm Ys
ELAPSED_MINUTES=$(( ELAPSED_SECONDS / 60 ))
ELAPSED_REMAINDER=$(( ELAPSED_SECONDS % 60 ))

# ============================================================
# DETERMINE STATUS
# ============================================================

if [[ $ELAPSED_SECONDS -le $BUDGET_SECONDS ]]; then
    REMAINING_SECONDS=$(( BUDGET_SECONDS - ELAPSED_SECONDS ))
    REMAINING_MINUTES=$(( REMAINING_SECONDS / 60 ))
    REMAINING_REMAINDER=$(( REMAINING_SECONDS % 60 ))
    STATUS="WITHIN BUDGET (${REMAINING_MINUTES}m ${REMAINING_REMAINDER}s remaining)"
    EXIT_CODE=0
else
    OVER_SECONDS=$(( ELAPSED_SECONDS - BUDGET_SECONDS ))
    OVER_MINUTES=$(( OVER_SECONDS / 60 ))
    OVER_REMAINDER=$(( OVER_SECONDS % 60 ))
    STATUS="BUDGET EXCEEDED by ${OVER_MINUTES}m ${OVER_REMAINDER}s — Recommend escalating to thorough track"
    EXIT_CODE=1
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Investigation Timer"
echo "- **Started:** $STARTED_AT"
echo "- **Elapsed:** ${ELAPSED_MINUTES}m ${ELAPSED_REMAINDER}s"
echo "- **Budget:** ${BUDGET_MINUTES}m"
echo "- **Status:** $STATUS"

exit $EXIT_CODE
