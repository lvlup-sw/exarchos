#!/usr/bin/env bash
#
# reconstruct-stack.sh - Detect and reconstruct broken Graphite stacks
#
# Detects diverged/broken Graphite stacks and reconstructs them idempotently.
# Three phases: Detection, Reconstruction, Validation.
#
# Usage: reconstruct-stack.sh --repo-root <path> [--state-file <path>] [--dry-run] [--help]
#
# Exit codes:
#   0 = stack healthy or successfully reconstructed
#   1 = reconstruction failed (validation failed after attempt)
#   2 = usage error
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT=""
STATE_FILE=""
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# ============================================================
# USAGE & ARGUMENT PARSING
# ============================================================

usage() {
    cat <<EOF
Usage: $(basename "$0") --repo-root <path> [--state-file <path>] [--dry-run] [--help]

Detect and reconstruct broken Graphite stacks.

Options:
  --repo-root <path>    Path to the git repository root (required)
  --state-file <path>   Path to workflow state JSON file (optional, auto-detected)
  --dry-run             Report actions without making changes
  --help                Show this help message

Exit codes:
  0 = stack healthy or successfully reconstructed
  1 = reconstruction failed (validation failed after attempt)
  2 = usage error

Dependencies: jq, gt (Graphite CLI)
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --repo-root)
                REPO_ROOT="${2:-}"
                if [[ -z "$REPO_ROOT" ]]; then
                    echo -e "${RED}ERROR${NC}: --repo-root requires a value" >&2
                    exit 2
                fi
                shift 2
                ;;
            --state-file)
                STATE_FILE="${2:-}"
                if [[ -z "$STATE_FILE" ]]; then
                    echo -e "${RED}ERROR${NC}: --state-file requires a value" >&2
                    exit 2
                fi
                shift 2
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                echo -e "${RED}ERROR${NC}: Unknown argument: $1" >&2
                usage >&2
                exit 2
                ;;
        esac
    done

    if [[ -z "$REPO_ROOT" ]]; then
        echo -e "${RED}ERROR${NC}: --repo-root is required" >&2
        usage >&2
        exit 2
    fi

    if [[ ! -d "$REPO_ROOT/.git" ]] && [[ ! -f "$REPO_ROOT/.git" ]]; then
        echo -e "${RED}ERROR${NC}: $REPO_ROOT is not a git repository" >&2
        exit 2
    fi
}

# ============================================================
# DEPENDENCY CHECKS
# ============================================================

check_dependencies() {
    if ! command -v jq >/dev/null 2>&1; then
        echo -e "${RED}ERROR${NC}: jq is required but not found. Install with: brew install jq" >&2
        exit 2
    fi

    if ! command -v gt >/dev/null 2>&1; then
        echo -e "${RED}ERROR${NC}: gt (Graphite CLI) is required but not found. Install with: npm install -g @withgraphite/graphite-cli" >&2
        exit 2
    fi
}

# ============================================================
# HELPERS
# ============================================================

# Read task branches from state file in order
# Output: one branch name per line, in task order
get_expected_branches() {
    if [[ -z "$STATE_FILE" || ! -f "$STATE_FILE" ]]; then
        return 0
    fi
    jq -r '.tasks[]? | .branch // empty' "$STATE_FILE" 2>/dev/null || true
}

# Get task count from state file
get_task_count() {
    if [[ -z "$STATE_FILE" || ! -f "$STATE_FILE" ]]; then
        echo "0"
        return 0
    fi
    jq -r '.tasks | length' "$STATE_FILE" 2>/dev/null || echo "0"
}

# Parse gt log output for branch names (strip whitespace, annotations)
# Input: gt log output on stdin
# Output: branch names, one per line (top = newest)
parse_gt_log_branches() {
    # gt log lines: "  branch-name", "  branch-name (diverged)", etc.
    sed -E 's/^[[:space:]]*//; s/[[:space:]]*\(.*\)[[:space:]]*$//' | grep -v '^$' || true
}

# Check if a gt log line has a problem annotation
# Args: $1 = gt log line
get_line_status() {
    local line="$1"
    if echo "$line" | grep -q "(diverged)"; then
        echo "diverged"
    elif echo "$line" | grep -q "(needs restack)"; then
        echo "needs restack"
    else
        echo "clean"
    fi
}

# Get the SHA that a branch currently points to
# Args: $1 = branch name
# Output: SHA or empty string
get_branch_sha() {
    local branch="$1"
    (cd "$REPO_ROOT" && git rev-parse "$branch" 2>/dev/null) || true
}

# Find worktree path for a given branch, if any
# Args: $1 = branch name
# Output: worktree path or empty string
find_worktree_for_branch() {
    local branch="$1"
    (cd "$REPO_ROOT" && git worktree list --porcelain 2>/dev/null) | \
        grep -A2 "^worktree " | grep -B1 "branch refs/heads/$branch" | \
        head -1 | sed 's/^worktree //' || true
}

# ============================================================
# PHASE 1: DETECTION
# ============================================================

detect_problems() {
    local gt_log_output="$1"
    local problems=()
    local diverged_branches=()
    local restack_branches=()
    local missing_branches=()

    # Parse gt log for status annotations
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        local branch_name
        branch_name=$(echo "$line" | sed -E 's/^[[:space:]]*//' | sed -E 's/[[:space:]]*\(.*\)[[:space:]]*$//')
        local status
        status=$(get_line_status "$line")

        case "$status" in
            "diverged")
                diverged_branches+=("$branch_name")
                problems+=("Branch '$branch_name' is diverged")
                ;;
            "needs restack")
                restack_branches+=("$branch_name")
                problems+=("Branch '$branch_name' needs restack")
                ;;
        esac
    done <<< "$gt_log_output"

    # Check expected branches from state file against gt log
    local gt_branches
    gt_branches=$(echo "$gt_log_output" | parse_gt_log_branches)

    while IFS= read -r expected_branch; do
        [[ -z "$expected_branch" ]] && continue
        if ! echo "$gt_branches" | grep -qx "$expected_branch"; then
            missing_branches+=("$expected_branch")
            problems+=("Branch '$expected_branch' not tracked in Graphite (missing)")
        fi
    done < <(get_expected_branches)

    # Output results
    DETECTED_PROBLEMS=("${problems[@]+"${problems[@]}"}")
    DETECTED_DIVERGED=("${diverged_branches[@]+"${diverged_branches[@]}"}")
    DETECTED_RESTACK=("${restack_branches[@]+"${restack_branches[@]}"}")
    DETECTED_MISSING=("${missing_branches[@]+"${missing_branches[@]}"}")
}

# ============================================================
# PHASE 2: RECONSTRUCTION
# ============================================================

reconstruct_stack() {
    local expected_branches=()
    while IFS= read -r branch; do
        [[ -z "$branch" ]] && continue
        expected_branches+=("$branch")
    done < <(get_expected_branches)

    if [[ ${#expected_branches[@]} -eq 0 ]]; then
        echo -e "${YELLOW}No task branches to reconstruct${NC}"
        return 0
    fi

    echo -e "${BLUE}## Reconstruction${NC}"
    echo ""

    # Step 1: Untrack all task branches from Graphite
    echo -e "${BLUE}### Step 1: Untrack stale branches${NC}"
    for branch in "${expected_branches[@]}"; do
        if $DRY_RUN; then
            echo -e "  ${YELLOW}[dry-run]${NC} Would untrack: $branch"
        else
            echo "  Untracking: $branch"
            gt untrack "$branch" 2>/dev/null || true
        fi
    done
    echo ""

    # Step 2: Remove worktrees that might block branch resets
    echo -e "${BLUE}### Step 2: Check for blocking worktrees${NC}"
    for branch in "${expected_branches[@]}"; do
        local worktree_path=""
        worktree_path=$(find_worktree_for_branch "$branch")
        if [[ -n "$worktree_path" ]]; then
            if $DRY_RUN; then
                echo -e "  ${YELLOW}[dry-run]${NC} Would remove worktree: $worktree_path (branch: $branch)"
            else
                echo "  Removing worktree: $worktree_path (branch: $branch)"
                (cd "$REPO_ROOT" && git worktree remove "$worktree_path" --force 2>/dev/null || true)
            fi
        fi
    done
    echo ""

    # Step 3: Reset branch pointers
    echo -e "${BLUE}### Step 3: Reset branch pointers${NC}"
    for branch in "${expected_branches[@]}"; do
        local target_sha=""
        target_sha=$(get_branch_sha "$branch")
        if [[ -n "$target_sha" ]]; then
            if $DRY_RUN; then
                echo -e "  ${YELLOW}[dry-run]${NC} Would reset: $branch -> ${target_sha:0:8}"
            else
                echo "  Resetting: $branch -> ${target_sha:0:8}"
                (cd "$REPO_ROOT" && git branch -f "$branch" "$target_sha" 2>/dev/null || true)
            fi
        else
            echo -e "  ${YELLOW}Skipping${NC}: $branch (no commit mapping found)"
        fi
    done
    echo ""

    # Step 4: Re-track with correct parent chain
    echo -e "${BLUE}### Step 4: Re-track with parent chain${NC}"
    local prev_branch="main"
    for branch in "${expected_branches[@]}"; do
        if $DRY_RUN; then
            echo -e "  ${YELLOW}[dry-run]${NC} Would track: $branch --parent $prev_branch"
        else
            echo "  Tracking: $branch --parent $prev_branch"
            gt track --parent "$prev_branch" --branch "$branch" 2>/dev/null || true
        fi
        prev_branch="$branch"
    done
    echo ""
}

# ============================================================
# PHASE 3: VALIDATION
# ============================================================

validate_stack() {
    local gt_log_output="$1"
    local issues=()

    # Check for any remaining problem annotations
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        local status
        status=$(get_line_status "$line")
        if [[ "$status" != "clean" ]]; then
            local branch_name
            branch_name=$(echo "$line" | sed -E 's/^[[:space:]]*//' | sed -E 's/[[:space:]]*\(.*\)[[:space:]]*$//')
            issues+=("Branch '$branch_name' still shows: $status")
        fi
    done <<< "$gt_log_output"

    # Check expected branches are all tracked
    local gt_branches
    gt_branches=$(echo "$gt_log_output" | parse_gt_log_branches)

    while IFS= read -r expected_branch; do
        [[ -z "$expected_branch" ]] && continue
        if ! echo "$gt_branches" | grep -qx "$expected_branch"; then
            issues+=("Branch '$expected_branch' still not tracked after reconstruction")
        fi
    done < <(get_expected_branches)

    VALIDATION_ISSUES=("${issues[@]+"${issues[@]}"}")
}

# ============================================================
# MAIN
# ============================================================

main() {
    parse_args "$@"
    check_dependencies

    local task_count
    task_count=$(get_task_count)

    # Early exit if no tasks
    if [[ "$task_count" -eq 0 ]]; then
        echo -e "${GREEN}Stack is healthy${NC} (no tasks defined)"
        exit 0
    fi

    echo -e "${BLUE}# Stack Reconstruction${NC}"
    echo ""

    # Phase 1: Detection
    echo -e "${BLUE}## Detection${NC}"
    echo ""

    local gt_log_output
    gt_log_output=$(cd "$REPO_ROOT" && gt log 2>/dev/null || true)

    DETECTED_PROBLEMS=()
    DETECTED_DIVERGED=()
    DETECTED_RESTACK=()
    DETECTED_MISSING=()
    detect_problems "$gt_log_output"

    if [[ ${#DETECTED_PROBLEMS[@]} -eq 0 ]]; then
        echo -e "${GREEN}Stack is healthy${NC} — all ${task_count} task branches tracked and clean"
        exit 0
    fi

    echo "Detected ${#DETECTED_PROBLEMS[@]} problem(s):"
    for problem in "${DETECTED_PROBLEMS[@]}"; do
        echo -e "  - ${YELLOW}$problem${NC}"
    done
    echo ""

    if [[ ${#DETECTED_DIVERGED[@]} -gt 0 ]]; then
        echo "Diverged branches: ${DETECTED_DIVERGED[*]}"
    fi
    if [[ ${#DETECTED_RESTACK[@]} -gt 0 ]]; then
        echo "Needs restack: ${DETECTED_RESTACK[*]}"
    fi
    if [[ ${#DETECTED_MISSING[@]} -gt 0 ]]; then
        echo "Missing from stack: ${DETECTED_MISSING[*]}"
    fi
    echo ""

    # Phase 2: Reconstruction
    reconstruct_stack

    # Phase 3: Validation
    echo -e "${BLUE}## Validation${NC}"
    echo ""

    if $DRY_RUN; then
        echo -e "${YELLOW}Skipping validation (dry-run mode)${NC}"
        echo ""
        echo -e "${GREEN}Dry run complete${NC} — no changes were made"
        exit 0
    fi

    local post_gt_log
    post_gt_log=$(cd "$REPO_ROOT" && gt log 2>/dev/null || true)

    VALIDATION_ISSUES=()
    validate_stack "$post_gt_log"

    if [[ ${#VALIDATION_ISSUES[@]} -eq 0 ]]; then
        echo -e "${GREEN}Validation passed${NC} — stack is clean after reconstruction"
        exit 0
    fi

    echo -e "${RED}Validation failed${NC} — ${#VALIDATION_ISSUES[@]} issue(s) remain:"
    for issue in "${VALIDATION_ISSUES[@]}"; do
        echo -e "  - ${RED}$issue${NC}"
    done
    echo ""
    echo "Manual intervention may be required."
    exit 1
}

main "$@"
