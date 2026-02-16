#!/usr/bin/env bash
# Reconcile State
# Compares workflow state file to git reality: verifies worktrees exist,
# branches exist, task statuses are consistent, and phase is valid.
#
# Usage: reconcile-state.sh --state-file <path> --repo-root <path>
#
# Exit codes:
#   0 = state is consistent with git
#   1 = discrepancies found
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

STATE_FILE=""
REPO_ROOT=""

usage() {
    cat << 'USAGE'
Usage: reconcile-state.sh --state-file <path> --repo-root <path>

Required:
  --state-file <path>   Path to the workflow state JSON file
  --repo-root <path>    Git repository root directory

Optional:
  --help                Show this help message

Exit codes:
  0  State is consistent with git
  1  Discrepancies found
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

if [[ -z "$STATE_FILE" || -z "$REPO_ROOT" ]]; then
    echo "Error: --state-file and --repo-root are required" >&2
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

if ! command -v git &>/dev/null; then
    echo "Error: git is required but not installed" >&2
    exit 2
fi

# ============================================================
# CHECK FUNCTIONS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
RESULTS=()

check_pass() {
    local name="$1"
    RESULTS+=("- **PASS**: $name")
    CHECK_PASS=$((CHECK_PASS + 1))
}

check_fail() {
    local name="$1"
    local detail="${2:-}"
    if [[ -n "$detail" ]]; then
        RESULTS+=("- **FAIL**: $name — $detail")
    else
        RESULTS+=("- **FAIL**: $name")
    fi
    CHECK_FAIL=$((CHECK_FAIL + 1))
}

# ============================================================
# CHECK 1: State file exists and is valid JSON
# ============================================================

check_state_file() {
    if [[ ! -f "$STATE_FILE" ]]; then
        check_fail "State file exists" "File not found: $STATE_FILE"
        return 1
    fi

    if ! jq empty "$STATE_FILE" 2>/dev/null; then
        check_fail "State file exists" "Invalid JSON: $STATE_FILE"
        return 1
    fi

    check_pass "State file exists"
    return 0
}

# ============================================================
# CHECK 2: Phase is valid for workflow type
# ============================================================

check_phase_valid() {
    local workflow_type
    local phase

    workflow_type="$(jq -r '.workflowType // "feature"' "$STATE_FILE")"
    phase="$(jq -r '.phase // "unknown"' "$STATE_FILE")"

    # Define valid phases per workflow type
    local -a valid_phases
    case "$workflow_type" in
        feature)
            valid_phases=(ideate plan plan-review delegate review synthesize complete cancelled)
            ;;
        debug)
            valid_phases=(triage investigate fix validate complete cancelled)
            ;;
        refactor)
            valid_phases=(explore brief implement validate complete cancelled)
            ;;
        *)
            check_fail "Phase is valid" "Unknown workflow type: $workflow_type"
            return 1
            ;;
    esac

    local found=false
    for valid_phase in "${valid_phases[@]}"; do
        if [[ "$phase" == "$valid_phase" ]]; then
            found=true
            break
        fi
    done

    if [[ "$found" == true ]]; then
        check_pass "Phase is valid ($phase for $workflow_type)"
        return 0
    else
        check_fail "Phase is valid" "Phase '$phase' is not valid for workflow type '$workflow_type' (valid: ${valid_phases[*]})"
        return 1
    fi
}

# ============================================================
# CHECK 3: Task branches exist in git
# ============================================================

check_task_branches() {
    local task_count
    task_count="$(jq '.tasks | length' "$STATE_FILE")"

    if [[ "$task_count" -eq 0 ]]; then
        check_pass "Task branches exist (no tasks to check)"
        return 0
    fi

    local missing_branches=()
    local branches_checked=0

    # Get all branches from the task array
    local task_branches
    task_branches="$(jq -r '.tasks[] | select(.branch != null and .branch != "") | .branch' "$STATE_FILE")"

    while IFS= read -r branch; do
        [[ -z "$branch" ]] && continue
        branches_checked=$((branches_checked + 1))

        # Check if branch exists in git
        if ! git -C "$REPO_ROOT" rev-parse --verify "refs/heads/$branch" &>/dev/null; then
            missing_branches+=("$branch")
        fi
    done <<< "$task_branches"

    if [[ ${#missing_branches[@]} -eq 0 ]]; then
        check_pass "Task branches exist ($branches_checked branches verified)"
        return 0
    else
        local missing_list
        missing_list="$(IFS=', '; echo "${missing_branches[*]}")"
        check_fail "Task branches exist" "Missing branches: $missing_list"
        return 1
    fi
}

# ============================================================
# CHECK 4: Worktrees listed in state exist on disk
# ============================================================

check_worktrees_exist() {
    local worktree_count
    worktree_count="$(jq '.worktrees | length' "$STATE_FILE")"

    if [[ "$worktree_count" -eq 0 ]]; then
        check_pass "Worktrees exist (no worktrees to check)"
        return 0
    fi

    # Get actual git worktrees
    local git_worktrees
    git_worktrees="$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep '^worktree ' | sed 's/^worktree //' || true)"

    local missing_worktrees=()
    local worktrees_checked=0

    # Check each worktree in state
    local worktree_paths
    worktree_paths="$(jq -r '.worktrees | to_entries[] | select(.value.status == "active") | .value.path // empty' "$STATE_FILE")"

    while IFS= read -r wt_path; do
        [[ -z "$wt_path" ]] && continue
        worktrees_checked=$((worktrees_checked + 1))

        if [[ ! -d "$wt_path" ]]; then
            missing_worktrees+=("$wt_path")
        fi
    done <<< "$worktree_paths"

    if [[ ${#missing_worktrees[@]} -eq 0 ]]; then
        check_pass "Worktrees exist ($worktrees_checked worktrees verified)"
        return 0
    else
        local missing_list
        missing_list="$(IFS=', '; echo "${missing_worktrees[*]}")"
        check_fail "Worktrees exist" "Missing worktree paths: $missing_list"
        return 1
    fi
}

# ============================================================
# CHECK 5: Task status consistency
# ============================================================

check_task_status_consistency() {
    local task_count
    task_count="$(jq '.tasks | length' "$STATE_FILE")"

    if [[ "$task_count" -eq 0 ]]; then
        check_pass "Task status consistency (no tasks to check)"
        return 0
    fi

    local inconsistencies=()

    # Check for in-progress tasks without branches
    local in_progress_no_branch
    in_progress_no_branch="$(jq -r '.tasks[] | select(.status == "in-progress" and (.branch == null or .branch == "")) | .id' "$STATE_FILE")"

    while IFS= read -r task_id; do
        [[ -z "$task_id" ]] && continue
        inconsistencies+=("Task $task_id is in-progress but has no branch")
    done <<< "$in_progress_no_branch"

    if [[ ${#inconsistencies[@]} -eq 0 ]]; then
        check_pass "Task status consistency ($task_count tasks checked)"
        return 0
    else
        local issue_list
        issue_list="$(IFS='; '; echo "${inconsistencies[*]}")"
        check_fail "Task status consistency" "$issue_list"
        return 1
    fi
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

if check_state_file; then
    check_phase_valid || true
    check_task_branches || true
    check_worktrees_exist || true
    check_task_status_consistency || true
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## State Reconciliation Report"
echo ""
echo "**State file:** \`$STATE_FILE\`"
echo "**Repo root:** \`$REPO_ROOT\`"
echo ""

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** — State is consistent with git ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    echo "**Result: FAIL** — Discrepancies found ($CHECK_FAIL/$TOTAL checks failed)"
    exit 1
fi
