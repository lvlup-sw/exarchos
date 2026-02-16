#!/usr/bin/env bash
# extract-fix-tasks.sh — Parse review findings into fix tasks
# Replaces "Fix Mode Task Extraction" prose in delegation SKILL.md.
#
# Usage: extract-fix-tasks.sh --state-file <path> [--review-report <path>] [--repo-root <path>]
#
# Exit codes:
#   0 = tasks extracted (outputs JSON array to stdout)
#   1 = parse error
#   2 = usage error (missing required args)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================
# ARGUMENT PARSING
# ============================================================

STATE_FILE=""
REVIEW_REPORT=""
REPO_ROOT=""

usage() {
    cat << 'USAGE'
Usage: extract-fix-tasks.sh --state-file <path> [--review-report <path>] [--repo-root <path>]

Required:
  --state-file <path>       Path to the workflow state JSON file

Optional:
  --review-report <path>    External review report JSON file (overrides state findings)
  --repo-root <path>        Repository root for worktree resolution
  --help                    Show this help message

Output:
  JSON array of fix tasks to stdout. Each task has: id, file, line, worktree, description, severity

Exit codes:
  0  Tasks extracted (JSON array output, may be empty if no findings)
  1  Parse error (invalid JSON, missing file)
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --state-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --state-file requires a path argument" >&2
                exit 2
            fi
            STATE_FILE="$2"
            shift 2
            ;;
        --review-report)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --review-report requires a path argument" >&2
                exit 2
            fi
            REVIEW_REPORT="$2"
            shift 2
            ;;
        --repo-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 2
            fi
            REPO_ROOT="$2"
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

if [[ -z "$STATE_FILE" ]]; then
    echo "Error: --state-file is required" >&2
    usage >&2
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
# VALIDATE INPUTS
# ============================================================

if [[ ! -f "$STATE_FILE" ]]; then
    echo "Error: State file not found: $STATE_FILE" >&2
    exit 1
fi

if ! jq empty "$STATE_FILE" 2>/dev/null; then
    echo "Error: Invalid JSON in state file: $STATE_FILE" >&2
    exit 1
fi

if [[ -n "$REVIEW_REPORT" ]]; then
    if [[ ! -f "$REVIEW_REPORT" ]]; then
        echo "Error: Review report not found: $REVIEW_REPORT" >&2
        exit 1
    fi
    if ! jq empty "$REVIEW_REPORT" 2>/dev/null; then
        echo "Error: Invalid JSON in review report: $REVIEW_REPORT" >&2
        exit 1
    fi
fi

# ============================================================
# EXTRACT FINDINGS
# ============================================================

# Build a task-to-worktree mapping from state file
TASK_WORKTREE_MAP="$(jq -c '[.tasks[] | select(.worktree != null) | {file_hint: .id, worktree: .worktree}]' "$STATE_FILE" 2>/dev/null || echo '[]')"

# Collect all findings from either the review report or the state file
if [[ -n "$REVIEW_REPORT" ]]; then
    # Use external review report
    ALL_FINDINGS="$(jq -c '.findings // []' "$REVIEW_REPORT" 2>/dev/null || echo '[]')"
else
    # Extract findings from state file reviews
    ALL_FINDINGS="$(jq -c '
        [
            (.reviews // {} | to_entries[] | .value.findings // [] | .[])
        ]
    ' "$STATE_FILE" 2>/dev/null || echo '[]')"
fi

# ============================================================
# BUILD FIX TASKS
# ============================================================

# Get all worktrees from tasks for file-to-worktree mapping
WORKTREES_JSON="$(jq -c '[.tasks[] | select(.worktree != null) | {worktree: .worktree, branch: (.branch // "unknown")}]' "$STATE_FILE" 2>/dev/null || echo '[]')"

# Transform findings into fix tasks with IDs and worktree mapping
FIX_TASKS="$(echo "$ALL_FINDINGS" | jq -c --argjson worktrees "$WORKTREES_JSON" '
    [to_entries[] | {
        id: ("fix-\(.key + 1 | tostring | if length < 3 then ("00" + .)[-3:] else . end)"),
        file: .value.file,
        line: (.value.line // null),
        worktree: (
            ($worktrees | length) as $n |
            if $n == 1 then $worktrees[0].worktree else null end
        ),
        description: .value.description,
        severity: (.value.severity // "MEDIUM")
    }]
' 2>/dev/null)"

if [[ -z "$FIX_TASKS" || "$FIX_TASKS" == "null" ]]; then
    echo "[]"
    exit 0
fi

# Output the fix tasks JSON array
echo "$FIX_TASKS"
exit 0
