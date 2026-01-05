#!/usr/bin/env bash
#
# review-diff.sh - Generate context-efficient diff for code review
#
# Usage: review-diff.sh <worktree-path> [base-branch]
#
# Output: Structured diff with only changed sections
#   - Stats summary
#   - Unified diff with 3-line context
#
# This reduces context consumption by 80-90% compared to full file contents.
#

set -euo pipefail

WORKTREE="${1:-.}"
BASE="${2:-main}"

if [ ! -d "$WORKTREE" ]; then
    echo "ERROR: Directory not found: $WORKTREE" >&2
    exit 1
fi

cd "$WORKTREE"

# Check if we're in a git repository
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "ERROR: Not a git repository: $WORKTREE" >&2
    exit 1
fi

# Get current branch
CURRENT_BRANCH=$(git branch --show-current)

echo "## Review Diff"
echo ""
echo "**Worktree:** $WORKTREE"
echo "**Branch:** $CURRENT_BRANCH"
echo "**Base:** $BASE"
echo ""

# Stats summary
echo "### Changed Files"
echo ""
echo '```'
git diff "$BASE"...HEAD --stat 2>/dev/null || git diff "$BASE"..HEAD --stat
echo '```'
echo ""

# File list for quick reference
echo "### Files Modified"
echo ""
git diff "$BASE"...HEAD --name-only 2>/dev/null || git diff "$BASE"..HEAD --name-only | while read -r file; do
    echo "- \`$file\`"
done
echo ""

# Unified diff with context
echo "### Diff Content"
echo ""
echo '```diff'
git diff "$BASE"...HEAD --unified=3 2>/dev/null || git diff "$BASE"..HEAD --unified=3
echo '```'
