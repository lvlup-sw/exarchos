#!/usr/bin/env bash
# Select Debug Track
# Deterministic track selection from urgency and root-cause knowledge.
# Replaces prose-based decision-making with a clear decision tree.
#
# Usage: select-debug-track.sh --urgency <critical|high|medium|low> --root-cause-known <yes|no>
#        select-debug-track.sh --state-file <path>
#
# Exit codes:
#   0 = hotfix track selected
#   1 = thorough track selected
#   2 = usage error (missing required args, invalid input)

set -euo pipefail

# ============================================================
# COLORS
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

URGENCY=""
ROOT_CAUSE_KNOWN=""
STATE_FILE=""

usage() {
    cat << 'USAGE'
Usage: select-debug-track.sh --urgency <critical|high|medium|low> --root-cause-known <yes|no>
       select-debug-track.sh --state-file <path>

Required (one of):
  --urgency <level>            Urgency level: critical, high, medium, low
  --root-cause-known <yes|no>  Whether the root cause is known
  --state-file <path>          Path to workflow state JSON (reads urgency.level and investigation.rootCauseKnown)

Optional:
  --help                       Show this help message

Exit codes:
  0  Hotfix track selected
  1  Thorough track selected
  2  Usage error (missing args, invalid input)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --urgency)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --urgency requires a level argument" >&2
                exit 2
            fi
            URGENCY="$2"
            shift 2
            ;;
        --root-cause-known)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --root-cause-known requires yes or no" >&2
                exit 2
            fi
            ROOT_CAUSE_KNOWN="$2"
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
# RESOLVE FROM STATE FILE
# ============================================================

if [[ -n "$STATE_FILE" && -z "$URGENCY" ]]; then
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "Error: State file not found: $STATE_FILE" >&2
        exit 2
    fi

    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required but not installed" >&2
        exit 2
    fi

    URGENCY="$(jq -r '.urgency.level // empty' "$STATE_FILE")"
    ROOT_CAUSE_KNOWN="$(jq -r '.investigation.rootCauseKnown // empty' "$STATE_FILE")"

    if [[ -z "$URGENCY" ]]; then
        echo "Error: No urgency.level found in state file" >&2
        exit 2
    fi
    if [[ -z "$ROOT_CAUSE_KNOWN" ]]; then
        echo "Error: No investigation.rootCauseKnown found in state file" >&2
        exit 2
    fi
fi

# ============================================================
# VALIDATE INPUTS
# ============================================================

if [[ -z "$URGENCY" || -z "$ROOT_CAUSE_KNOWN" ]]; then
    echo "Error: Both --urgency and --root-cause-known are required (or use --state-file)" >&2
    usage >&2
    exit 2
fi

case "$URGENCY" in
    critical|high|medium|low) ;;
    *)
        echo "Error: Invalid urgency level '$URGENCY' (expected: critical, high, medium, low)" >&2
        exit 2
        ;;
esac

case "$ROOT_CAUSE_KNOWN" in
    yes|no) ;;
    *)
        echo "Error: Invalid root-cause-known value '$ROOT_CAUSE_KNOWN' (expected: yes, no)" >&2
        exit 2
        ;;
esac

# ============================================================
# DECISION TREE
# ============================================================

SELECTED_TRACK=""
REASONING=""

case "$URGENCY" in
    critical)
        if [[ "$ROOT_CAUSE_KNOWN" == "yes" ]]; then
            SELECTED_TRACK="HOTFIX"
            REASONING="Critical urgency with known root cause — hotfix is appropriate"
        else
            SELECTED_TRACK="THOROUGH"
            REASONING="Critical urgency but unknown root cause — can't fix what you don't understand"
        fi
        ;;
    high)
        if [[ "$ROOT_CAUSE_KNOWN" == "yes" ]]; then
            SELECTED_TRACK="HOTFIX"
            REASONING="High urgency with known root cause — hotfix is appropriate"
        else
            SELECTED_TRACK="THOROUGH"
            REASONING="High urgency but unknown root cause — thorough investigation needed"
        fi
        ;;
    medium)
        SELECTED_TRACK="THOROUGH"
        REASONING="Medium urgency — thorough track always applies for non-critical issues"
        ;;
    low)
        SELECTED_TRACK="THOROUGH"
        REASONING="Low urgency — thorough track always applies for non-critical issues"
        ;;
esac

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Debug Track Selection"
echo "- **Urgency:** $URGENCY"
echo "- **Root cause known:** $ROOT_CAUSE_KNOWN"
echo "- **Selected track:** $SELECTED_TRACK"
echo "- **Reasoning:** $REASONING"

if [[ "$SELECTED_TRACK" == "HOTFIX" ]]; then
    exit 0
else
    exit 1
fi
