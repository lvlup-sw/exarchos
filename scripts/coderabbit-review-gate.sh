#!/usr/bin/env bash
#
# coderabbit-review-gate.sh - Automated CodeRabbit review cycle gate
#
# Counts review rounds, classifies thread severity, auto-resolves outdated
# threads, and decides whether to approve, wait, or escalate.
#
# Usage:
#   coderabbit-review-gate.sh --owner <owner> --repo <repo> --pr <number> [options]
#   coderabbit-review-gate.sh --help
#
# Options:
#   --owner <owner>      GitHub repository owner (required)
#   --repo <repo>        GitHub repository name (required)
#   --pr <number>        PR number to check (required)
#   --dry-run            Suppress PR comments (show what would happen)
#   --max-rounds <n>     Max review rounds before escalation (default: 4)
#   --help               Show this help message
#
# Exit codes:
#   0 = approve or wait (no human intervention needed yet)
#   1 = escalate (human review needed) or error
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
Usage: coderabbit-review-gate.sh --owner <owner> --repo <repo> --pr <number> [options]

Automated CodeRabbit review cycle gate. Counts review rounds, classifies
thread severity, auto-resolves outdated threads, and decides whether to
approve, wait, or escalate.

Options:
  --owner <owner>      GitHub repository owner (required)
  --repo <repo>        GitHub repository name (required)
  --pr <number>        PR number to check (required)
  --dry-run            Suppress PR comments (show what would happen)
  --max-rounds <n>     Max review rounds before escalation (default: 4)
  --help               Show this help message

Exit codes:
  0   Approve or wait (no human intervention needed yet)
  1   Escalate (human review needed) or error
  2   Usage error (missing required arguments)

Examples:
  coderabbit-review-gate.sh --owner myorg --repo myrepo --pr 123
  coderabbit-review-gate.sh --owner myorg --repo myrepo --pr 123 --dry-run
  coderabbit-review-gate.sh --owner myorg --repo myrepo --pr 123 --max-rounds 3
EOF
}

# ============================================================
# ARGUMENT PARSING
# ============================================================

OWNER=""
REPO=""
PR_NUMBER=""
DRY_RUN=false
MAX_ROUNDS=4

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
        --pr)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --pr requires a value" >&2
                exit 2
            fi
            PR_NUMBER="$2"
            shift 2
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --max-rounds)
            if [[ $# -lt 2 ]]; then
                echo -e "${RED}ERROR${NC}: --max-rounds requires a value" >&2
                exit 2
            fi
            MAX_ROUNDS="$2"
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

if [[ -z "$PR_NUMBER" ]]; then
    echo -e "${RED}ERROR${NC}: --pr is required" >&2
    usage >&2
    exit 2
fi

if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}ERROR${NC}: PR number must be numeric: $PR_NUMBER" >&2
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
# GRAPHQL WRAPPER
# ============================================================

# Wrapper for gh api graphql calls — facilitates mock injection via PATH
gh_graphql() {
    gh api graphql "$@"
}

# ============================================================
# REVIEW ROUND COUNTING
# ============================================================

count_review_rounds() {
    local reviews_json
    reviews_json=$(gh_graphql -f query='
        query($owner: String!, $repo: String!, $pr: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                    reviews(first: 100) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            author { login }
                            submittedAt
                        }
                    }
                }
            }
        }
    ' -f "owner=$OWNER" -f "repo=$REPO" -F "pr=$PR_NUMBER") || {
        echo -e "${YELLOW}WARNING${NC}: Failed to query reviews" >&2
        echo "0"
        return
    }

    # Validate response structure
    if ! echo "$reviews_json" | jq -e '.data.repository.pullRequest' > /dev/null 2>&1; then
        echo -e "${YELLOW}WARNING${NC}: Malformed reviews response" >&2
        echo "0"
        return
    fi

    # Warn if there are more pages (>100 reviews is rare; pagination not implemented)
    local has_next
    has_next=$(echo "$reviews_json" | jq -r '.data.repository.pullRequest.reviews.pageInfo.hasNextPage' 2>/dev/null || echo "false")
    if [[ "$has_next" == "true" ]]; then
        echo -e "${YELLOW}WARNING${NC}: More than 100 reviews found; count may be incomplete" >&2
    fi

    echo "$reviews_json" | jq '[.data.repository.pullRequest.reviews.nodes[] | select(.author.login == "coderabbitai[bot]")] | length' 2>/dev/null || echo "0"
}

# ============================================================
# THREAD QUERYING
# ============================================================

get_review_threads() {
    local cursor=""
    local all_nodes="[]"
    local page_json has_next

    while :; do
        local -a gql_args=(
            -f query='
            query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
                repository(owner: $owner, name: $repo) {
                    pullRequest(number: $pr) {
                        reviewThreads(first: 100, after: $cursor) {
                            pageInfo { hasNextPage endCursor }
                            nodes {
                                id
                                isResolved
                                isOutdated
                                comments(first: 1) {
                                    nodes {
                                        body
                                        author { login }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            '
            -f "owner=$OWNER" -f "repo=$REPO" -F "pr=$PR_NUMBER"
        )
        if [[ -n "$cursor" ]]; then
            gql_args+=(-f "cursor=$cursor")
        fi

        page_json=$(gh_graphql "${gql_args[@]}") || {
            echo -e "${YELLOW}WARNING${NC}: Failed to query review threads" >&2
            echo "[]"
            return
        }

        # Validate response structure
        if ! echo "$page_json" | jq -e '.data.repository.pullRequest' > /dev/null 2>&1; then
            echo -e "${YELLOW}WARNING${NC}: Malformed threads response" >&2
            # Return what we have so far
            echo "$all_nodes" | jq '[.[] | select(.isResolved == false and .isOutdated == false)]'
            return
        fi

        all_nodes=$(jq -s '.[0] + .[1]' <(echo "$all_nodes") <(echo "$page_json" | jq '.data.repository.pullRequest.reviewThreads.nodes'))

        has_next=$(echo "$page_json" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
        if [[ "$has_next" != "true" ]]; then
            break
        fi
        cursor=$(echo "$page_json" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
    done

    # Filter: unresolved and non-outdated threads only
    echo "$all_nodes" | jq '[.[] | select(.isResolved == false and .isOutdated == false)]'
}

# ============================================================
# OUTDATED THREAD RESOLUTION
# ============================================================

resolve_outdated_threads() {
    # Stub — no-op
    :
}

# ============================================================
# SEVERITY CLASSIFICATION
# ============================================================

has_blocking_findings() {
    local threads_json="$1"
    # Check if any thread's first comment body contains critical (red circle) or major (orange circle) severity markers
    # Use printf to generate actual emoji bytes for the jq regex
    local red_circle orange_circle
    red_circle=$(printf '\xf0\x9f\x94\xb4')       # U+1F534
    orange_circle=$(printf '\xf0\x9f\x9f\xa0')     # U+1F7E0
    local blocker_count
    blocker_count=$(echo "$threads_json" | jq --arg rc "$red_circle" --arg oc "$orange_circle" '[.[] | select(.comments.nodes[0] | (.author.login == "coderabbitai[bot]") and (.body != null) and (.body | test($rc) or test($oc)))] | length' 2>/dev/null || echo "0")

    if [[ "$blocker_count" -gt 0 ]]; then
        return 0  # has blockers
    else
        return 1  # no blockers
    fi
}

# ============================================================
# DECISION LOGIC
# ============================================================

decide_action() {
    local round_count="$1"
    local active_thread_count="$2"
    local has_blockers="$3"  # "true" or "false"
    # Stub — returns "approve"
    echo "approve"
}

# ============================================================
# PR COMMENTING
# ============================================================

post_action_comment() {
    local action="$1"
    local round_count="$2"
    # Stub — no-op
    :
}

# ============================================================
# MAIN
# ============================================================

# 1. Count review rounds
ROUND_COUNT=$(count_review_rounds)

# 2. Get active review threads
ACTIVE_THREADS_JSON=$(get_review_threads)
ACTIVE_THREAD_COUNT=$(echo "$ACTIVE_THREADS_JSON" | jq 'length')

# 3. Resolve outdated threads
resolve_outdated_threads

# 4. Classify severity
HAS_BLOCKERS="false"
if has_blocking_findings "$ACTIVE_THREADS_JSON"; then
    HAS_BLOCKERS="true"
fi

# 5. Decide action
ACTION=$(decide_action "$ROUND_COUNT" "$ACTIVE_THREAD_COUNT" "$HAS_BLOCKERS")

# 6. Post comment (unless dry-run)
if [[ "$DRY_RUN" == false ]]; then
    post_action_comment "$ACTION" "$ROUND_COUNT"
fi

# 7. Output structured summary
cat <<SUMMARY
## CodeRabbit Review Gate

- **PR:** ${OWNER}/${REPO}#${PR_NUMBER}
- **Round:** ${ROUND_COUNT}
- **Active Threads:** ${ACTIVE_THREAD_COUNT}
- **Blocking Findings:** ${HAS_BLOCKERS}
- **Action:** ${ACTION}
SUMMARY

# 8. Exit code based on action
case "$ACTION" in
    approve|wait) exit 0 ;;
    escalate)     exit 1 ;;
    *)            exit 1 ;;
esac
