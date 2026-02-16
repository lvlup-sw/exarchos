#!/usr/bin/env bash
# needs-schema-sync.sh — Detect API file modifications requiring schema sync
# Replaces "Schema Sync Auto-Detection" prose in delegation SKILL.md.
#
# Usage: needs-schema-sync.sh --repo-root <path> [--base-branch main] [--diff-file <path>]
#
# Exit codes:
#   0 = no sync needed
#   1 = sync needed (API files modified)
#   2 = usage error (missing required args)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT=""
BASE_BRANCH="main"
DIFF_FILE=""

usage() {
    cat << 'USAGE'
Usage: needs-schema-sync.sh --repo-root <path> [--base-branch main] [--diff-file <path>]

Required:
  --repo-root <path>      Repository root directory

Optional:
  --base-branch <name>    Base branch/commit to diff against (default: main)
  --diff-file <path>      Use pre-computed diff file instead of git diff
  --help                  Show this help message

Detects modifications to API files matching these patterns:
  *Endpoints.cs, Models/*.cs, Requests/*.cs, Responses/*.cs, Dtos/*.cs

Exit codes:
  0  No sync needed (no API files modified)
  1  Sync needed (API files modified — lists them)
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 2
            fi
            REPO_ROOT="$2"
            shift 2
            ;;
        --base-branch)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --base-branch requires an argument" >&2
                exit 2
            fi
            BASE_BRANCH="$2"
            shift 2
            ;;
        --diff-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --diff-file requires a path argument" >&2
                exit 2
            fi
            DIFF_FILE="$2"
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

if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: --repo-root is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# API FILE PATTERNS
# ============================================================

# Patterns that trigger schema sync
# These match: *Endpoints.cs, Models/*.cs, Requests/*.cs, Responses/*.cs, Dtos/*.cs
API_PATTERNS=(
    'Endpoints\.cs$'
    'Models/[^/]*\.cs$'
    'Requests/[^/]*\.cs$'
    'Responses/[^/]*\.cs$'
    'Dtos/[^/]*\.cs$'
)

# ============================================================
# GET CHANGED FILES
# ============================================================

CHANGED_FILES=""

if [[ -n "$DIFF_FILE" ]]; then
    # Extract file paths from diff file
    if [[ ! -f "$DIFF_FILE" ]]; then
        echo "Error: Diff file not found: $DIFF_FILE" >&2
        exit 2
    fi
    # Parse diff headers to get file names (lines starting with +++ b/)
    CHANGED_FILES="$(
        grep -E '^\+\+\+ b/|^--- a/' "$DIFF_FILE" \
        | sed -E 's|^\+\+\+ b/||; s|^--- a/||' \
        | grep -v '^/dev/null$' \
        | sort -u || true
    )"
else
    # Use git diff to get changed files
    CHANGED_FILES="$(git -C "$REPO_ROOT" diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || \
                     git -C "$REPO_ROOT" diff --name-only "$BASE_BRANCH" HEAD 2>/dev/null || \
                     git -C "$REPO_ROOT" diff --name-only "$BASE_BRANCH" 2>/dev/null || true)"
fi

# ============================================================
# MATCH API FILES
# ============================================================

API_FILES=()

while IFS= read -r file; do
    [[ -z "$file" ]] && continue

    for pattern in "${API_PATTERNS[@]}"; do
        if echo "$file" | grep -qE "$pattern"; then
            API_FILES+=("$file")
            break
        fi
    done
done <<< "$CHANGED_FILES"

# ============================================================
# OUTPUT
# ============================================================

if [[ ${#API_FILES[@]} -eq 0 ]]; then
    echo "## Schema Sync Check"
    echo ""
    echo "**Result: No sync needed** — No API files modified"
    exit 0
else
    echo "## Schema Sync Check"
    echo ""
    echo "**Result: Sync needed** — ${#API_FILES[@]} API file(s) modified:"
    echo ""
    for f in "${API_FILES[@]}"; do
        echo "- \`$f\`"
    done
    exit 1
fi
