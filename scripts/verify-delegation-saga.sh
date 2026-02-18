#!/usr/bin/env bash
# verify-delegation-saga.sh — Verify saga step ordering in delegation event streams
# Reads a JSONL event file and validates that delegation saga events appear in correct order.
#
# Usage: verify-delegation-saga.sh --feature-id <id> [--state-dir <path>]
#
# Exit codes:
#   0 = valid saga (or no team events to validate)
#   1 = violations found
#   2 = usage error (missing args, no event file, empty stream)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

FEATURE_ID=""
STATE_DIR="${HOME}/.claude/workflow-state"

usage() {
    cat >&2 << 'USAGE'
Usage: verify-delegation-saga.sh --feature-id <id> [--state-dir <path>]

Required:
  --feature-id <id>    Feature identifier (used to locate events JSONL file)

Optional:
  --state-dir <path>   Directory containing event files (default: ~/.claude/workflow-state/)
  --help               Show this help message

Exit codes:
  0  Valid saga ordering (or no team events to validate)
  1  Saga ordering violations found
  2  Usage error (missing args, no event file, empty stream)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --feature-id)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --feature-id requires a value" >&2
                exit 2
            fi
            FEATURE_ID="$2"
            shift 2
            ;;
        --state-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --state-dir requires a path argument" >&2
                exit 2
            fi
            STATE_DIR="$2"
            shift 2
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument '$1'" >&2
            usage
            exit 2
            ;;
    esac
done

if [[ -z "$FEATURE_ID" ]]; then
    echo "Error: --feature-id is required" >&2
    usage
    exit 2
fi

# ============================================================
# DEPENDENCY CHECK
# ============================================================

if ! command -v jq &>/dev/null; then
    echo "Error: jq is required but not installed" >&2
    exit 2
fi

# ============================================================
# LOCATE EVENT FILE
# ============================================================

EVENT_FILE="${STATE_DIR}/${FEATURE_ID}.events.jsonl"

if [[ ! -f "$EVENT_FILE" ]]; then
    echo "Error: Event file not found: $EVENT_FILE" >&2
    exit 2
fi

# Check for empty file
if [[ ! -s "$EVENT_FILE" ]]; then
    echo "Error: Event file is empty: $EVENT_FILE" >&2
    exit 2
fi

# ============================================================
# EXTRACT TEAM EVENTS
# ============================================================

# Filter to only team.* events, preserving order
TEAM_EVENTS="$(jq -c 'select(.type | startswith("team."))' "$EVENT_FILE")"

# If no team events exist, nothing to validate — exit clean
if [[ -z "$TEAM_EVENTS" ]]; then
    echo "No team events found in event stream. Skipping saga validation."
    exit 0
fi

# ============================================================
# VALIDATION STATE
# ============================================================

VIOLATIONS=()
HAS_SPAWNED=false
HAS_PLANNED=false
HAS_DISBANDED=false
DISBANDED_SEQUENCE=0

# Track planned task IDs
declare -a PLANNED_TASK_IDS=()

# Track dispatched task IDs (from assignedTaskIds)
declare -a DISPATCHED_TASK_IDS=()

# ============================================================
# RULE VALIDATION — Process events in sequence order
# ============================================================

while IFS= read -r event; do
    event_type="$(echo "$event" | jq -r '.type')"
    event_seq="$(echo "$event" | jq -r '.sequence')"

    case "$event_type" in
        team.spawned)
            HAS_SPAWNED=true
            ;;

        team.task.planned)
            # Rule 1: team.spawned must appear before any team.task.planned
            if [[ "$HAS_SPAWNED" != true ]]; then
                VIOLATIONS+=("VIOLATION: team.task.planned (seq $event_seq) appeared before team.spawned")
            fi

            # Rule 4: team.disbanded must be the last team event
            if [[ "$HAS_DISBANDED" == true ]]; then
                VIOLATIONS+=("VIOLATION: team.task.planned (seq $event_seq) appeared after team.disbanded (seq $DISBANDED_SEQUENCE)")
            fi

            # Track planned task ID
            task_id="$(echo "$event" | jq -r '.data.taskId')"
            PLANNED_TASK_IDS+=("$task_id")
            HAS_PLANNED=true
            ;;

        team.teammate.dispatched)
            # Rule 1: team.spawned must appear before dispatch
            if [[ "$HAS_SPAWNED" != true ]]; then
                VIOLATIONS+=("VIOLATION: team.teammate.dispatched (seq $event_seq) appeared before team.spawned")
            fi

            # Rule 2: team.task.planned must appear before any team.teammate.dispatched
            if [[ "$HAS_PLANNED" != true ]]; then
                VIOLATIONS+=("VIOLATION: team.teammate.dispatched (seq $event_seq) appeared before any team.task.planned")
            fi

            # Rule 4: team.disbanded must be the last team event
            if [[ "$HAS_DISBANDED" == true ]]; then
                VIOLATIONS+=("VIOLATION: team.teammate.dispatched (seq $event_seq) appeared after team.disbanded (seq $DISBANDED_SEQUENCE)")
            fi

            # Track dispatched task IDs for coverage check
            while IFS= read -r tid; do
                DISPATCHED_TASK_IDS+=("$tid")
            done < <(echo "$event" | jq -r '.data.assignedTaskIds[]')
            ;;

        team.disbanded)
            HAS_DISBANDED=true
            DISBANDED_SEQUENCE="$event_seq"
            ;;

        # Other team.* events — no specific rules yet, but check disbanded constraint
        team.*)
            if [[ "$HAS_DISBANDED" == true && "$event_type" != "team.disbanded" ]]; then
                VIOLATIONS+=("VIOLATION: $event_type (seq $event_seq) appeared after team.disbanded (seq $DISBANDED_SEQUENCE)")
            fi
            ;;
    esac
done <<< "$TEAM_EVENTS"

# ============================================================
# RULE 3: All dispatched task IDs must have been planned
# ============================================================

if [[ ${#DISPATCHED_TASK_IDS[@]} -gt 0 ]]; then
    for dispatched_id in "${DISPATCHED_TASK_IDS[@]}"; do
        found=false
        if [[ ${#PLANNED_TASK_IDS[@]} -gt 0 ]]; then
            for planned_id in "${PLANNED_TASK_IDS[@]}"; do
                if [[ "$dispatched_id" == "$planned_id" ]]; then
                    found=true
                    break
                fi
            done
        fi
        if [[ "$found" != true ]]; then
            VIOLATIONS+=("VIOLATION: Dispatched task '$dispatched_id' was never planned (no team.task.planned event with this taskId)")
        fi
    done
fi

# ============================================================
# OUTPUT AND EXIT
# ============================================================

if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
    echo "Delegation saga validation FAILED for feature '$FEATURE_ID':"
    echo ""
    for v in "${VIOLATIONS[@]}"; do
        echo "  $v"
    done
    echo ""
    echo "${#VIOLATIONS[@]} violation(s) found."
    exit 1
fi

echo "Delegation saga validation PASSED for feature '$FEATURE_ID'."
exit 0
