#!/usr/bin/env bash
# post-delegation-check.sh — Post-delegation result collection and validation
# Replaces the "Collect Results" prose in delegation SKILL.md.
#
# Usage: post-delegation-check.sh --state-file <path> --repo-root <path> [--skip-tests]
#
# Exit codes:
#   0 = all pass
#   1 = failures detected
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
SKIP_TESTS=false

usage() {
    cat << 'USAGE'
Usage: post-delegation-check.sh --state-file <path> --repo-root <path> [--skip-tests]

Required:
  --state-file <path>   Path to the workflow state JSON file
  --repo-root <path>    Repository root directory

Optional:
  --skip-tests          Skip per-worktree test execution
  --help                Show this help message

Exit codes:
  0  All checks pass
  1  Failures detected
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
        --skip-tests)
            SKIP_TESTS=true
            shift
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

if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: --repo-root is required" >&2
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

check_skip() {
    local name="$1"
    RESULTS+=("- **SKIP**: $name")
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
# CHECK 2: Tasks array has entries
# ============================================================

check_tasks_exist() {
    local task_count
    task_count="$(jq '.tasks | length' "$STATE_FILE")"

    if [[ "$task_count" -eq 0 ]]; then
        check_fail "Tasks exist" "No tasks found in state file"
        return 1
    fi

    check_pass "Tasks exist ($task_count tasks)"
    return 0
}

# ============================================================
# CHECK 3: All tasks report completion
# ============================================================

check_all_tasks_complete() {
    local task_count
    local incomplete_count
    local incomplete_tasks

    task_count="$(jq '.tasks | length' "$STATE_FILE")"
    incomplete_count="$(jq '[.tasks[] | select(.status != "complete")] | length' "$STATE_FILE")"

    if [[ "$incomplete_count" -gt 0 ]]; then
        incomplete_tasks="$(jq -r '[.tasks[] | select(.status != "complete") | "\(.id) (\(.status))"] | join(", ")' "$STATE_FILE")"
        check_fail "All tasks complete" "$incomplete_count incomplete: $incomplete_tasks"
        return 1
    fi

    check_pass "All tasks complete ($task_count/$task_count)"
    return 0
}

# ============================================================
# CHECK 4: Per-worktree test runs
# ============================================================

check_worktree_tests() {
    if [[ "$SKIP_TESTS" == true ]]; then
        check_skip "Worktree tests (--skip-tests)"
        return 0
    fi

    local worktree_count=0
    local worktree_pass=0
    local worktree_fail=0

    # Get worktree paths from tasks
    local worktrees
    worktrees="$(jq -r '.tasks[] | select(.worktree != null) | .worktree' "$STATE_FILE" 2>/dev/null | sort -u)"

    if [[ -z "$worktrees" ]]; then
        check_skip "Worktree tests (no worktree paths in tasks)"
        return 0
    fi

    while IFS= read -r wt_rel; do
        [[ -z "$wt_rel" ]] && continue
        local wt_path="$REPO_ROOT/$wt_rel"
        worktree_count=$((worktree_count + 1))

        if [[ ! -d "$wt_path" ]]; then
            check_fail "Worktree tests: $wt_rel" "Directory not found"
            worktree_fail=$((worktree_fail + 1))
            continue
        fi

        if [[ ! -f "$wt_path/package.json" ]]; then
            check_skip "Worktree tests: $wt_rel (no package.json)"
            continue
        fi

        if (cd "$wt_path" && npm run test:run 2>/dev/null 1>/dev/null); then
            check_pass "Worktree tests: $wt_rel"
            worktree_pass=$((worktree_pass + 1))
        else
            check_fail "Worktree tests: $wt_rel" "npm run test:run failed"
            worktree_fail=$((worktree_fail + 1))
        fi
    done <<< "$worktrees"

    return 0
}

# ============================================================
# CHECK 5: State file consistency
# ============================================================

check_state_consistency() {
    # Verify tasks array has required fields
    local invalid_tasks
    invalid_tasks="$(jq '[.tasks[] | select(.id == null or .status == null)] | length' "$STATE_FILE")"

    if [[ "$invalid_tasks" -gt 0 ]]; then
        check_fail "State consistency" "$invalid_tasks tasks missing id or status"
        return 1
    fi

    check_pass "State consistency (all tasks have id and status)"
    return 0
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

# Check 1: State file — all other checks depend on this
if check_state_file; then
    # Check 2: Tasks exist
    if check_tasks_exist; then
        # Check 3: All tasks complete
        check_all_tasks_complete || true

        # Check 4: Per-worktree tests
        check_worktree_tests || true

        # Check 5: State consistency
        check_state_consistency || true
    fi
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Post-Delegation Results Report"
echo ""
echo "**State file:** \`$STATE_FILE\`"
echo ""

# Per-task status table
if [[ -f "$STATE_FILE" ]] && jq empty "$STATE_FILE" 2>/dev/null; then
    local_task_count="$(jq '.tasks | length' "$STATE_FILE")"
    if [[ "$local_task_count" -gt 0 ]]; then
        echo "### Task Status"
        echo ""
        echo "| Task | Status | Branch |"
        echo "|------|--------|--------|"
        jq -r '.tasks[] | "| \(.id) | \(.status) | \(.branch // "n/a") |"' "$STATE_FILE"
        echo ""
    fi
fi

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL checks failed)"
    exit 1
fi
