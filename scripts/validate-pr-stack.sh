#!/usr/bin/env bash
#
# validate-pr-stack.sh - Validate GitHub-native PR stack integrity
#
# Discovers open PRs for the current repo and validates that they form
# a proper chain where each PR's base branch is either the target base
# branch or another PR's head branch.
#
# Usage: validate-pr-stack.sh <base-branch>
#
# Exit codes:
#   0 = stack is healthy (all PRs properly chained) or no open PRs
#   1 = chain has gaps or mismatched bases
#   2 = usage error
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# USAGE & ARGUMENT PARSING
# ============================================================

usage() {
    cat <<EOF
Usage: $(basename "$0") <base-branch>

Validate that open PRs form a properly chained stack.

Arguments:
  base-branch    The root branch of the stack (e.g., main)

Exit codes:
  0 = stack is healthy or no open PRs
  1 = chain has gaps or mismatched bases
  2 = usage error
EOF
}

if [[ $# -lt 1 ]]; then
    echo -e "${RED}ERROR${NC}: Missing required argument: base-branch" >&2
    usage >&2
    exit 2
fi

BASE_BRANCH="$1"

# ============================================================
# DISCOVER OPEN PRs
# ============================================================

PR_JSON=$(gh pr list --state open --json number,baseRefName,headRefName,state 2>/dev/null) || {
    echo -e "${RED}ERROR${NC}: gh pr list failed — verify gh CLI is authenticated and has repo access" >&2
    exit 2
}

PR_COUNT=$(echo "$PR_JSON" | jq 'length')

if [[ "$PR_COUNT" -eq 0 ]]; then
    echo -e "${GREEN}No open PRs found${NC} — nothing to validate"
    exit 0
fi

# ============================================================
# VALIDATE CHAIN
# ============================================================

# Build sets of base and head branch names
HEAD_BRANCHES=$(echo "$PR_JSON" | jq -r '.[].headRefName')
BASE_REFS=$(echo "$PR_JSON" | jq -r '.[].baseRefName')

ERRORS=()

# Check 1: Each PR's base must be the stack base or another PR's head
while IFS= read -r pr_line; do
    pr_number=$(echo "$pr_line" | jq -r '.number')
    pr_base=$(echo "$pr_line" | jq -r '.baseRefName')
    pr_head=$(echo "$pr_line" | jq -r '.headRefName')

    if [[ "$pr_base" == "$BASE_BRANCH" ]]; then
        continue
    fi

    if echo "$HEAD_BRANCHES" | grep -qx "$pr_base"; then
        continue
    fi

    ERRORS+=("PR #${pr_number} (${pr_head}): base '${pr_base}' is not '${BASE_BRANCH}' and not a head branch of any other open PR")
done < <(echo "$PR_JSON" | jq -c '.[]')

# Check 2: Exactly one PR should target the base branch (linear chain root)
ROOT_COUNT=$(echo "$BASE_REFS" | grep -cx "$BASE_BRANCH" || true)
if [[ "$ROOT_COUNT" -eq 0 ]]; then
    ERRORS+=("No PR targets '${BASE_BRANCH}' directly — stack root is missing (cyclic or disconnected)")
elif [[ "$ROOT_COUNT" -gt 1 ]]; then
    ERRORS+=("Multiple PRs target '${BASE_BRANCH}' directly (found ${ROOT_COUNT}) — stack is not a linear chain")
fi

# Check 3: No branch should be used as a base by more than one PR (no forks)
while IFS= read -r head; do
    dep_count=$(echo "$BASE_REFS" | grep -cx "$head" || true)
    if [[ "$dep_count" -gt 1 ]]; then
        ERRORS+=("Branch '${head}' is used as base by ${dep_count} PRs — stack has a fork")
    fi
done <<< "$HEAD_BRANCHES"

# ============================================================
# REPORT RESULTS
# ============================================================

if [[ ${#ERRORS[@]} -eq 0 ]]; then
    echo -e "${GREEN}Stack is healthy${NC} — ${PR_COUNT} open PR(s) properly chained on '${BASE_BRANCH}'"

    # Show the chain
    echo ""
    echo "Chain:"
    while IFS= read -r pr_line; do
        pr_number=$(echo "$pr_line" | jq -r '.number')
        pr_base=$(echo "$pr_line" | jq -r '.baseRefName')
        pr_head=$(echo "$pr_line" | jq -r '.headRefName')
        echo "  #${pr_number}: ${pr_base} <- ${pr_head}"
    done < <(echo "$PR_JSON" | jq -c '.[]')

    exit 0
fi

echo -e "${RED}Stack validation failed${NC} — ${#ERRORS[@]} issue(s) found:" >&2
for error in "${ERRORS[@]}"; do
    echo -e "  ${YELLOW}-${NC} $error" >&2
done

echo "" >&2
echo "All open PRs:" >&2
while IFS= read -r pr_line; do
    pr_number=$(echo "$pr_line" | jq -r '.number')
    pr_base=$(echo "$pr_line" | jq -r '.baseRefName')
    pr_head=$(echo "$pr_line" | jq -r '.headRefName')
    echo "  #${pr_number}: ${pr_base} <- ${pr_head}" >&2
done < <(echo "$PR_JSON" | jq -c '.[]')

exit 1
