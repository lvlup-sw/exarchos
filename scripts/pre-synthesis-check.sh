#!/usr/bin/env bash
# Pre-Synthesis Readiness Check
# Validates all readiness conditions before PR submission in the synthesis workflow.
#
# Usage: pre-synthesis-check.sh --state-file <path> [--repo-root <path>] [--skip-tests] [--skip-stack]
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed
#   2 = usage error (missing required args)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

STATE_FILE=""
SKIP_TESTS=false
SKIP_STACK=false

usage() {
    cat << 'USAGE'
Usage: pre-synthesis-check.sh --state-file <path> [--repo-root <path>] [--skip-tests] [--skip-stack]

Required:
  --state-file <path>   Path to the workflow state JSON file

Optional:
  --repo-root <path>    Repository root (default: parent of script directory)
  --skip-tests          Skip test execution check (npm run test:run && npm run typecheck)
  --skip-stack          Skip Graphite stack existence check (gt log --short)
  --help                Show this help message

Exit codes:
  0  All checks pass
  1  One or more checks failed
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
        --skip-stack)
            SKIP_STACK=true
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
# CHECK 2: All tasks complete
# ============================================================

check_all_tasks_complete() {
    local task_count
    local incomplete_count
    local incomplete_tasks

    task_count="$(jq '.tasks | length' "$STATE_FILE")"
    if [[ "$task_count" -eq 0 ]]; then
        check_fail "All tasks complete" "No tasks found in state file"
        return 1
    fi

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
# CHECK 3: Reviews passed
# ============================================================

check_reviews_passed() {
    local reviews_obj
    local spec_status
    local quality_status

    reviews_obj="$(jq '.reviews // {}' "$STATE_FILE")"

    # Check specReview exists and passed
    spec_status="$(jq -r '.reviews.specReview.status // "missing"' "$STATE_FILE")"
    if [[ "$spec_status" != "pass" && "$spec_status" != "approved" ]]; then
        check_fail "Reviews passed" "specReview status: $spec_status (expected pass or approved)"
        return 1
    fi

    # Check qualityReview exists and passed
    quality_status="$(jq -r '.reviews.qualityReview.status // "missing"' "$STATE_FILE")"
    if [[ "$quality_status" != "pass" && "$quality_status" != "approved" ]]; then
        check_fail "Reviews passed" "qualityReview status: $quality_status (expected pass or approved)"
        return 1
    fi

    check_pass "Reviews passed (spec=$spec_status, quality=$quality_status)"
    return 0
}

# ============================================================
# CHECK 4: No outstanding fix requests
# ============================================================

check_no_fix_requests() {
    local fix_count
    local fix_tasks

    fix_count="$(jq '[.tasks[] | select(.status == "needs_fixes")] | length' "$STATE_FILE")"
    if [[ "$fix_count" -gt 0 ]]; then
        fix_tasks="$(jq -r '[.tasks[] | select(.status == "needs_fixes") | .id] | join(", ")' "$STATE_FILE")"
        check_fail "No outstanding fix requests" "$fix_count tasks need fixes: $fix_tasks"
        return 1
    fi

    check_pass "No outstanding fix requests"
    return 0
}

# ============================================================
# CHECK 5: Graphite stack exists
# ============================================================

check_graphite_stack() {
    if [[ "$SKIP_STACK" == true ]]; then
        check_skip "Graphite stack exists (--skip-stack)"
        return 0
    fi

    if ! command -v gt &>/dev/null; then
        check_fail "Graphite stack exists" "gt CLI not found in PATH"
        return 1
    fi

    local gt_output
    gt_output="$(gt log --short 2>&1)" || true

    # Check that gt log produced at least one branch line
    local branch_count
    branch_count="$(echo "$gt_output" | grep -cE '\S' || true)"
    if [[ "$branch_count" -lt 2 ]]; then
        check_fail "Graphite stack exists" "No stack branches found (gt log --short returned $branch_count lines)"
        return 1
    fi

    check_pass "Graphite stack exists ($branch_count branches)"
    return 0
}

# ============================================================
# CHECK 6: Tests pass
# ============================================================

check_tests_pass() {
    if [[ "$SKIP_TESTS" == true ]]; then
        check_skip "Tests pass (--skip-tests)"
        return 0
    fi

    local test_output
    if ! test_output="$(cd "$REPO_ROOT" && npm run test:run 2>&1)"; then
        check_fail "Tests pass" "npm run test:run failed"
        return 1
    fi

    local typecheck_output
    if ! typecheck_output="$(cd "$REPO_ROOT" && npm run typecheck 2>&1)"; then
        check_fail "Tests pass" "npm run typecheck failed"
        return 1
    fi

    check_pass "Tests pass"
    return 0
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

# Check 1: State file — all other checks depend on this
if check_state_file; then
    # Check 2: All tasks complete
    check_all_tasks_complete || true

    # Check 3: Reviews passed
    check_reviews_passed || true

    # Check 4: No outstanding fix requests
    check_no_fix_requests || true
fi

# Check 5: Graphite stack (independent of state file)
check_graphite_stack || true

# Check 6: Tests (independent of state file)
check_tests_pass || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Pre-Synthesis Readiness Report"
echo ""
echo "**State file:** \`$STATE_FILE\`"
echo ""

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
