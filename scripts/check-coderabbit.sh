#!/usr/bin/env bash
#
# check-coderabbit.sh - Query CodeRabbit review state on GitHub PRs
#
# Classifies each PR deterministically:
#   APPROVED         → pass
#   CHANGES_REQUESTED → fail
#   PENDING          → fail
#   No CodeRabbit review → pass (CodeRabbit not installed or hasn't reviewed)
#
# When multiple CodeRabbit reviews exist, the latest by submitted_at wins.
#
# Usage:
#   check-coderabbit.sh --owner <owner> --repo <repo> <pr-number> [<pr-number>...]
#   check-coderabbit.sh --help
#
# Exit codes:
#   0 = all PRs pass (APPROVED or no CodeRabbit review)
#   1 = at least one PR has CHANGES_REQUESTED, PENDING, or API error
#   2 = usage error (missing required args)
#
# Dependencies: gh (authenticated), jq
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

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
Usage: check-coderabbit.sh --owner <owner> --repo <repo> <pr-number> [<pr-number>...]

Query CodeRabbit review state on GitHub PRs and classify them deterministically.

Options:
  --owner <owner>   GitHub repository owner (required)
  --repo <repo>     GitHub repository name (required)
  --json            Output machine-readable JSON instead of markdown table
  --help            Show this help message

Arguments:
  <pr-number>       One or more PR numbers to check

Exit codes:
  0   All PRs pass (APPROVED or no CodeRabbit review)
  1   At least one PR has CHANGES_REQUESTED, PENDING, or API error
  2   Usage error (missing required arguments)

Examples:
  check-coderabbit.sh --owner myorg --repo myrepo 123
  check-coderabbit.sh --owner myorg --repo myrepo 100 101 102
  check-coderabbit.sh --owner myorg --repo myrepo --json 123 456
EOF
}

# ============================================================
# ARGUMENT PARSING
# ============================================================

OWNER=""
REPO=""
JSON_OUTPUT=false
PR_NUMBERS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --owner)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --owner requires a value" >&2
                exit 2
            fi
            OWNER="$2"
            shift 2
            ;;
        --repo)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --repo requires a value" >&2
                exit 2
            fi
            REPO="$2"
            shift 2
            ;;
        --json)
            JSON_OUTPUT=true
            shift
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
            PR_NUMBERS+=("$1")
            shift
            ;;
    esac
done

# Validate GitHub owner/repo name format
validate_github_name() {
    local name="$1"
    local label="$2"
    if ! [[ "$name" =~ ^[a-zA-Z0-9._-]+$ ]]; then
        echo -e "${RED}ERROR${NC}: Invalid $label: $name (must match ^[a-zA-Z0-9._-]+$)" >&2
        exit 2
    fi
}

# Validate required arguments
if [[ -z "$OWNER" ]]; then
    echo -e "${RED}ERROR${NC}: --owner is required" >&2
    usage >&2
    exit 2
fi
validate_github_name "$OWNER" "owner"

if [[ -z "$REPO" ]]; then
    echo -e "${RED}ERROR${NC}: --repo is required" >&2
    usage >&2
    exit 2
fi
validate_github_name "$REPO" "repo"

if [[ -z "${PR_NUMBERS+x}" ]] || [[ ${#PR_NUMBERS[@]} -eq 0 ]]; then
    echo -e "${RED}ERROR${NC}: At least one PR number is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# DEPENDENCY CHECKS
# ============================================================

if ! command -v gh &> /dev/null; then
    echo -e "${RED}ERROR${NC}: gh CLI is not installed" >&2
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo -e "${RED}ERROR${NC}: jq is not installed" >&2
    exit 1
fi

# ============================================================
# REVIEW CLASSIFICATION
# ============================================================

# Classify a CodeRabbit review state into pass/fail
# APPROVED → pass, NONE (no review) → pass, everything else → fail
classify_state() {
    local state="$1"
    case "$state" in
        APPROVED)  echo "pass" ;;
        NONE)      echo "pass" ;;
        *)         echo "fail" ;;
    esac
}

# Get the latest CodeRabbit review state for a PR
# Returns: STATE or "NONE" if no CodeRabbit review found
# Exit code: 0 on success, 1 on API error
get_coderabbit_state() {
    local owner="$1"
    local repo="$2"
    local pr_number="$3"

    local reviews_json
    if ! reviews_json=$(gh api --paginate "repos/$owner/$repo/pulls/$pr_number/reviews" 2>&1); then
        echo "API_ERROR: $reviews_json" >&2
        return 1
    fi

    # Filter to CodeRabbit reviews only
    # Match both official (coderabbitai) and legacy (coderabbit-ai) login variants
    # Sort by submitted_at descending, take the first (latest)
    # Use jq -s to slurp paginated output (multiple JSON arrays) into one
    local latest_state
    latest_state=$(echo "$reviews_json" | jq -s -r '
        add | [.[] | select(
            .user.login == "coderabbitai[bot]"
            or .user.login == "coderabbitai"
            or .user.login == "coderabbit-ai[bot]"
            or .user.login == "coderabbit-ai"
        )]
        | sort_by(.submitted_at)
        | reverse
        | .[0].state // "NONE"
    ')

    echo "$latest_state"
}

# ============================================================
# MAIN
# ============================================================

HAS_FAILURE=false
RESULTS=()

for pr in "${PR_NUMBERS[@]}"; do
    # Validate PR number is numeric
    if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
        echo -e "${YELLOW}WARNING${NC}: Skipping invalid PR number: $pr" >&2
        RESULTS+=("$pr|INVALID|skip")
        continue
    fi

    # Query the API
    STATE=$(get_coderabbit_state "$OWNER" "$REPO" "$pr" 2>&1) || {
        echo -e "${RED}ERROR${NC}: Failed to query PR #$pr: $STATE" >&2
        RESULTS+=("$pr|API_ERROR|fail")
        HAS_FAILURE=true
        continue
    }

    # Handle API_ERROR messages that came through stdout
    if [[ "$STATE" == API_ERROR* ]]; then
        echo -e "${RED}ERROR${NC}: Failed to query PR #$pr: $STATE" >&2
        RESULTS+=("$pr|API_ERROR|fail")
        HAS_FAILURE=true
        continue
    fi

    # Classify
    VERDICT=$(classify_state "$STATE")
    RESULTS+=("$pr|$STATE|$VERDICT")

    if [[ "$VERDICT" == "fail" ]]; then
        HAS_FAILURE=true
    fi
done

# ============================================================
# OUTPUT
# ============================================================

if [[ "$JSON_OUTPUT" == true ]]; then
    # JSON output mode
    echo "["
    for (( i=0; i<${#RESULTS[@]}; i++ )); do
        IFS='|' read -r pr state verdict <<< "${RESULTS[$i]}"
        COMMA=""
        if [[ $i -lt $((${#RESULTS[@]} - 1)) ]]; then
            COMMA=","
        fi
        echo "  {\"pr\": \"$pr\", \"state\": \"$state\", \"verdict\": \"$verdict\"}$COMMA"
    done
    echo "]"
else
    # Markdown table output
    echo "| PR | State | Verdict |"
    echo "|----|-------|---------|"
    for result in "${RESULTS[@]}"; do
        IFS='|' read -r pr state verdict <<< "$result"
        if [[ "$verdict" == "pass" ]]; then
            echo "| #$pr | $state | ${verdict} |"
        elif [[ "$verdict" == "skip" ]]; then
            echo "| $pr | $state | ${verdict} |"
        else
            echo "| #$pr | $state | ${verdict} |"
        fi
    done
fi

# ============================================================
# EXIT CODE
# ============================================================

if [[ "$HAS_FAILURE" == true ]]; then
    exit 1
else
    exit 0
fi
