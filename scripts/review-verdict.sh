#!/usr/bin/env bash
# Review Verdict Classification
# Classifies review findings into a routing verdict for the quality-review workflow.
#
# Usage: review-verdict.sh --high <n> --medium <n> --low <n> [--blocked <reason>]
#        review-verdict.sh --findings-file <path>
#
# Exit codes:
#   0 = APPROVED (no HIGH findings)
#   1 = NEEDS_FIXES (HIGH findings present)
#   2 = BLOCKED (--blocked flag) or usage error

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

HIGH_COUNT=""
MEDIUM_COUNT=""
LOW_COUNT=""
BLOCKED_REASON=""
FINDINGS_FILE=""

usage() {
    cat << 'USAGE'
Usage: review-verdict.sh --high <n> --medium <n> --low <n> [--blocked <reason>]
       review-verdict.sh --findings-file <path>

Classify review findings into a routing verdict.

Options:
  --high <n>            Number of HIGH-severity findings
  --medium <n>          Number of MEDIUM-severity findings
  --low <n>             Number of LOW-severity findings
  --blocked <reason>    Mark as BLOCKED with the given reason
  --findings-file <path> JSON file with {high:N, medium:N, low:N}
  --help                Show this help message

Exit codes:
  0  APPROVED (no HIGH findings)
  1  NEEDS_FIXES (HIGH findings present)
  2  BLOCKED or usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --high)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --high requires a number argument" >&2
                exit 2
            fi
            HIGH_COUNT="$2"
            shift 2
            ;;
        --medium)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --medium requires a number argument" >&2
                exit 2
            fi
            MEDIUM_COUNT="$2"
            shift 2
            ;;
        --low)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --low requires a number argument" >&2
                exit 2
            fi
            LOW_COUNT="$2"
            shift 2
            ;;
        --blocked)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --blocked requires a reason argument" >&2
                exit 2
            fi
            BLOCKED_REASON="$2"
            shift 2
            ;;
        --findings-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --findings-file requires a path argument" >&2
                exit 2
            fi
            FINDINGS_FILE="$2"
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
# INPUT RESOLUTION
# ============================================================

# If --findings-file provided, parse JSON
if [[ -n "$FINDINGS_FILE" ]]; then
    if [[ ! -f "$FINDINGS_FILE" ]]; then
        echo "Error: Findings file not found: $FINDINGS_FILE" >&2
        exit 2
    fi

    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required to parse findings file" >&2
        exit 2
    fi

    HIGH_COUNT="$(jq -r '.high // 0' "$FINDINGS_FILE")"
    MEDIUM_COUNT="$(jq -r '.medium // 0' "$FINDINGS_FILE")"
    LOW_COUNT="$(jq -r '.low // 0' "$FINDINGS_FILE")"

    # Ensure numeric values (guard against malformed JSON)
    [[ "$HIGH_COUNT" =~ ^[0-9]+$ ]] || HIGH_COUNT=0
    [[ "$MEDIUM_COUNT" =~ ^[0-9]+$ ]] || MEDIUM_COUNT=0
    [[ "$LOW_COUNT" =~ ^[0-9]+$ ]] || LOW_COUNT=0
fi

# Validate we have the required inputs (either via flags or file)
if [[ -z "$HIGH_COUNT" && -z "$BLOCKED_REASON" ]]; then
    echo "Error: Must provide --high/--medium/--low counts, --findings-file, or --blocked" >&2
    usage >&2
    exit 2
fi

# Default counts to 0 if not set
HIGH_COUNT="${HIGH_COUNT:-0}"
MEDIUM_COUNT="${MEDIUM_COUNT:-0}"
LOW_COUNT="${LOW_COUNT:-0}"

# ============================================================
# VERDICT LOGIC
# ============================================================

# Priority: BLOCKED > NEEDS_FIXES > APPROVED
if [[ -n "$BLOCKED_REASON" ]]; then
    echo "## Review Verdict: BLOCKED"
    echo ""
    echo "**Reason:** $BLOCKED_REASON"
    echo ""
    echo "Return to design phase. Route to \`/ideate --redesign\`."
    exit 2
fi

if [[ "$HIGH_COUNT" -gt 0 ]]; then
    TOTAL=$((HIGH_COUNT + MEDIUM_COUNT + LOW_COUNT))
    echo "## Review Verdict: NEEDS_FIXES"
    echo ""
    echo "Found $HIGH_COUNT HIGH-severity findings. Route to \`/delegate --fixes\`."
    echo ""
    echo "**Finding summary:** $HIGH_COUNT high, $MEDIUM_COUNT medium, $LOW_COUNT low ($TOTAL total)"
    exit 1
fi

TOTAL=$((HIGH_COUNT + MEDIUM_COUNT + LOW_COUNT))
echo "## Review Verdict: APPROVED"
echo ""
echo "No HIGH-severity findings. Proceed to synthesis."
echo ""
echo "**Finding summary:** $HIGH_COUNT high, $MEDIUM_COUNT medium, $LOW_COUNT low ($TOTAL total)"
exit 0
