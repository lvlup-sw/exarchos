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
                        nodes {
                            author { login }
                            submittedAt
                        }
                    }
                }
            }
        }
    ' -f "owner=$OWNER" -f "repo=$REPO" -F "pr=$PR_NUMBER")

    echo "$reviews_json" | jq '[.data.repository.pullRequest.reviews.nodes[] | select(.author.login == "coderabbitai[bot]")] | length'
}

# ============================================================
# THREAD QUERYING
# ============================================================

query_all_threads() {
    gh_graphql -f query='
        query($owner: String!, $repo: String!, $pr: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $pr) {
                    reviewThreads(first: 100) {
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
    ' -f "owner=$OWNER" -f "repo=$REPO" -F "pr=$PR_NUMBER"
}

get_active_threads() {
    local all_threads_json="$1"
    # Filter: unresolved and non-outdated threads only
    echo "$all_threads_json" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false)]'
}

# ============================================================
# OUTDATED THREAD RESOLUTION
# ============================================================

resolve_outdated_threads() {
    local all_threads_json="$1"
    # Find unresolved outdated threads
    local outdated_thread_ids
    outdated_thread_ids=$(echo "$all_threads_json" | jq -r '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == true) | .id')

    if [[ -z "$outdated_thread_ids" ]]; then
        return 0
    fi

    # Resolve each outdated thread
    while IFS= read -r thread_id; do
        if [[ -z "$thread_id" ]]; then
            continue
        fi
        gh_graphql -f query='
            mutation($threadId: ID!) {
                resolveReviewThread(input: { threadId: $threadId }) {
                    thread { id isResolved }
                }
            }
        ' -f "threadId=$thread_id" > /dev/null 2>&1 || {
            echo -e "${YELLOW}WARNING${NC}: Failed to resolve outdated thread $thread_id" >&2
        }
    done <<< "$outdated_thread_ids"
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
    blocker_count=$(echo "$threads_json" | jq --arg rc "$red_circle" --arg oc "$orange_circle" '[.[] | select(.comments.nodes[0].body | test($rc) or test($oc))] | length' 2>/dev/null || echo "0")

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

    # Decision matrix:
    # At or past max rounds with blockers → escalate
    # At or past max rounds without blockers → approve
    # Round 1 with no active threads → approve
    # Round 2+ without blockers → approve
    # Otherwise → wait
    if [[ "$round_count" -ge "$MAX_ROUNDS" && "$has_blockers" == "true" ]]; then
        echo "escalate"
    elif [[ "$round_count" -ge "$MAX_ROUNDS" && "$has_blockers" != "true" ]]; then
        echo "approve"
    elif [[ "$round_count" -eq 1 && "$active_thread_count" -eq 0 ]]; then
        echo "approve"
    elif [[ "$round_count" -ge 2 && "$has_blockers" != "true" ]]; then
        echo "approve"
    else
        echo "wait"
    fi
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

# 2. Query all review threads
ALL_THREADS_JSON=$(query_all_threads)

# 3. Resolve outdated threads
resolve_outdated_threads "$ALL_THREADS_JSON"

# 4. Get active review threads (unresolved, non-outdated)
ACTIVE_THREADS_JSON=$(get_active_threads "$ALL_THREADS_JSON")
ACTIVE_THREAD_COUNT=$(echo "$ACTIVE_THREADS_JSON" | jq 'length')

# 5. Classify severity
HAS_BLOCKERS="false"
if has_blocking_findings "$ACTIVE_THREADS_JSON"; then
    HAS_BLOCKERS="true"
fi

# 6. Decide action
ACTION=$(decide_action "$ROUND_COUNT" "$ACTIVE_THREAD_COUNT" "$HAS_BLOCKERS")

# 7. Post comment (unless dry-run)
if [[ "$DRY_RUN" == false ]]; then
    post_action_comment "$ACTION" "$ROUND_COUNT"
fi

# 8. Output structured summary
cat <<SUMMARY
## CodeRabbit Review Gate

- **PR:** ${OWNER}/${REPO}#${PR_NUMBER}
- **Round:** ${ROUND_COUNT}
- **Active Threads:** ${ACTIVE_THREAD_COUNT}
- **Blocking Findings:** ${HAS_BLOCKERS}
- **Action:** ${ACTION}
SUMMARY

# 9. Exit code based on action
case "$ACTION" in
    approve|wait) exit 0 ;;
    escalate)     exit 1 ;;
    *)            exit 1 ;;
esac
