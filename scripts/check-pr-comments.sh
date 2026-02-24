#!/usr/bin/env bash
# Check PR Comments — validates all inline review comments have replies
#
# Usage: check-pr-comments.sh --pr <number> [--repo owner/repo]
#
# Fetches all review comments on a PR via `gh api` and checks whether
# each top-level comment thread has at least one reply.
#
# Exit codes:
#   0 = all comments addressed (or no comments)
#   1 = unaddressed comments found
#   2 = usage error
#
# Dependencies: gh (authenticated), jq

set -euo pipefail

for dep in gh jq; do
    command -v "$dep" >/dev/null 2>&1 || {
        echo "Error: Missing dependency: $dep" >&2
        exit 2
    }
done

PR_NUMBER=""
REPO=""

# ============================================================
# USAGE
# ============================================================

usage() {
    cat << 'USAGE'
Usage: check-pr-comments.sh --pr <number> [--repo owner/repo]

Required:
  --pr <number>        PR number to check

Optional:
  --repo <owner/repo>  Repository (default: auto-detect from git remote)
  --help               Show this help message

Exit codes:
  0  All inline comments have replies (or no comments)
  1  Unaddressed comments found
  2  Usage error
USAGE
}

# ============================================================
# ARGUMENT PARSING
# ============================================================

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr)
            [[ -z "${2:-}" ]] && { echo "Error: --pr requires a number" >&2; exit 2; }
            PR_NUMBER="$2"; shift 2 ;;
        --repo)
            [[ -z "${2:-}" ]] && { echo "Error: --repo requires owner/repo" >&2; exit 2; }
            REPO="$2"; shift 2 ;;
        --help) usage; exit 0 ;;
        *) echo "Error: Unknown argument '$1'" >&2; usage >&2; exit 2 ;;
    esac
done

[[ -z "$PR_NUMBER" ]] && { echo "Error: --pr is required" >&2; usage >&2; exit 2; }

# ============================================================
# REPO DETECTION
# ============================================================

if [[ -z "$REPO" ]]; then
    REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
    [[ -z "$REPO" ]] && { echo "Error: Could not detect repository. Use --repo" >&2; exit 2; }
fi

# ============================================================
# FETCH COMMENTS
# ============================================================

if ! COMMENTS=$(gh api "repos/$REPO/pulls/$PR_NUMBER/comments" --paginate); then
    echo "Error: Failed to fetch PR comments via gh api" >&2
    exit 2
fi

# ============================================================
# ANALYZE COMMENT THREADS
# ============================================================

# Count top-level comments (no in_reply_to_id)
TOP_LEVEL=$(echo "$COMMENTS" | jq '[.[] | select(.in_reply_to_id == null)] | length')

# Count unique top-level IDs that have at least one reply
REPLIED_TO=$(echo "$COMMENTS" | jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] | unique | length')

UNADDRESSED=$((TOP_LEVEL - REPLIED_TO))
[[ $UNADDRESSED -lt 0 ]] && UNADDRESSED=0

# ============================================================
# REPORT
# ============================================================

echo "## PR #$PR_NUMBER Comment Status"
echo ""
echo "Top-level comments: $TOP_LEVEL"
echo "With replies: $REPLIED_TO"
echo "Unaddressed: $UNADDRESSED"

if [[ $UNADDRESSED -eq 0 ]]; then
    echo ""
    echo "**Result: PASS** — all comments addressed"
    exit 0
else
    echo ""
    # List unaddressed comments
    REPLIED_IDS=$(echo "$COMMENTS" | jq '[.[] | select(.in_reply_to_id != null) | .in_reply_to_id] | unique')
    echo "### Unaddressed Comments"
    echo "$COMMENTS" | jq -r --argjson replied "$REPLIED_IDS" '
        .[] | select(.in_reply_to_id == null) |
        select(.id as $id | ($replied | index($id)) == null) |
        "- [\(.user.login)] \(.path):\(.line // .original_line // "?"): \(.body | split("\n")[0] | .[0:100])"
    '
    echo ""
    echo "**Result: FAIL** — $UNADDRESSED unaddressed comment(s)"
    exit 1
fi
