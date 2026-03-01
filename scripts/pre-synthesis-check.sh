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
  --skip-stack          Skip PR stack existence check
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
# CHECK 2: Phase readiness (is workflow at or near synthesize?)
# ============================================================

check_phase_readiness() {
    local phase
    local workflow_type
    phase="$(jq -r '.phase // "unknown"' "$STATE_FILE")"
    workflow_type="$(jq -r '.workflowType // "feature"' "$STATE_FILE")"

    if [[ "$phase" == "synthesize" ]]; then
        check_pass "Phase is synthesize"
        return 0
    fi

    # Determine the transition path and missing prerequisites
    local missing=()

    case "$workflow_type" in
        feature)
            case "$phase" in
                review)
                    missing+=("Transition: review → synthesize (guard: allReviewsPassed)")
                    ;;
                *)
                    check_fail "Phase is synthesize" "Current phase '$phase' — manual phase advancement needed for $workflow_type workflow"
                    return 1
                    ;;
            esac
            ;;
        refactor)
            case "$phase" in
                # Polish track — no synthesize step, goes directly to completed
                polish-implement|polish-validate|polish-update-docs)
                    check_fail "Phase is synthesize" \
                      "Current phase '$phase' — polish track completes directly (no synthesize). Use exarchos_workflow cleanup."
                    return 1
                    ;;
                # Overhaul track — has synthesize step
                overhaul-plan)
                    missing+=("Transition: overhaul-plan → overhaul-delegate (guard: planArtifactExists)")
                    missing+=("Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)")
                    missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
                    missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
                    ;;
                overhaul-delegate)
                    missing+=("Transition: overhaul-delegate → overhaul-review (guard: allTasksComplete)")
                    missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
                    missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
                    ;;
                overhaul-review)
                    missing+=("Transition: overhaul-review → overhaul-update-docs (guard: allReviewsPassed)")
                    missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated)")
                    ;;
                overhaul-update-docs)
                    missing+=("Transition: overhaul-update-docs → synthesize (guard: docsUpdated — set validation.docsUpdated=true)")
                    ;;
                *)
                    check_fail "Phase is synthesize" \
                      "Current phase '$phase' — not on a synthesis-eligible path for $workflow_type workflow"
                    return 1
                    ;;
            esac
            ;;
        debug)
            case "$phase" in
                debug-validate)
                    missing+=("Transition: debug-validate → debug-review (guard: validationPassed)")
                    missing+=("Transition: debug-review → synthesize (guard: reviewPassed)")
                    ;;
                debug-review)
                    missing+=("Transition: debug-review → synthesize (guard: reviewPassed)")
                    ;;
                hotfix-validate)
                    missing+=("Transition: hotfix-validate → synthesize (guard: validationPassed + prRequested)")
                    ;;
                triage|investigate|rca|design|debug-implement|hotfix-implement)
                    check_fail "Phase is synthesize" \
                      "Current phase '$phase' — multiple transitions needed before synthesize for $workflow_type workflow"
                    return 1
                    ;;
                *)
                    check_fail "Phase is synthesize" \
                      "Current phase '$phase' — not on a synthesis-eligible path for $workflow_type workflow"
                    return 1
                    ;;
            esac
            ;;
    esac

    if [[ -n "${missing+x}" ]] && [[ ${#missing[@]} -gt 0 ]]; then
        local detail
        detail="Phase is '$phase', need ${#missing[@]} transition(s):"
        for m in "${missing[@]}"; do
            detail+="\n  - $m"
        done
        check_fail "Phase is synthesize" "$detail"
        return 1
    fi
}

# ============================================================
# CHECK 3: All tasks complete
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
# CHECK 4: Reviews passed
# ============================================================

check_reviews_passed() {
    local reviews_json
    reviews_json="$(jq '.reviews // {}' "$STATE_FILE")"

    # Count review entries
    local entry_count
    entry_count="$(echo "$reviews_json" | jq 'keys | length')"
    if [[ "$entry_count" -eq 0 ]]; then
        check_fail "Reviews passed" "No review entries found in state.reviews"
        return 1
    fi

    # Collect all statuses from both flat and nested review shapes:
    #   Flat:   reviews.overhaul = { status: "approved" }
    #   Nested: reviews.T1 = { specReview: { status: "pass" }, qualityReview: { status: "approved" } }
    #   Legacy: reviews.T1 = { passed: true }
    local failed_reviews
    failed_reviews="$(echo "$reviews_json" | jq -r '
        to_entries[] |
        .key as $key |
        .value |
        if .status then
            # Flat shape
            if (.status | test("^(pass|passed|approved)$")) then empty
            else "\($key) (status: \(.status))"
            end
        elif .specReview or .qualityReview then
            # Nested shape — check both sub-reviews
            [
                (if .specReview.status then
                    if (.specReview.status | test("^(pass|passed|approved)$")) then empty
                    else "\($key).specReview (status: \(.specReview.status))"
                    end
                else empty end),
                (if .qualityReview.status then
                    if (.qualityReview.status | test("^(pass|passed|approved)$")) then empty
                    else "\($key).qualityReview (status: \(.qualityReview.status))"
                    end
                else empty end)
            ][]
        elif .passed == true then
            # Legacy shape
            empty
        elif .passed == false then
            "\($key) (passed: false)"
        else
            "\($key) (no recognizable status)"
        end
    ')"

    if [[ -n "$failed_reviews" ]]; then
        check_fail "Reviews passed" "Failing reviews: $failed_reviews"
        return 1
    fi

    check_pass "Reviews passed ($entry_count review entries, all passing)"
    return 0
}

# ============================================================
# CHECK 5: No outstanding fix requests
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
# CHECK 6: PR stack exists
# ============================================================

check_pr_stack() {
    if [[ "$SKIP_STACK" == true ]]; then
        check_skip "PR stack exists (--skip-stack)"
        return 0
    fi

    if ! command -v gh &>/dev/null; then
        check_fail "PR stack exists" "gh CLI not found in PATH"
        return 1
    fi

    # Check for open PRs associated with the current branch
    local current_branch
    current_branch="$(cd "$REPO_ROOT" && git branch --show-current 2>/dev/null || echo "")"
    if [[ -z "$current_branch" ]]; then
        check_fail "PR stack exists" "Could not determine current branch"
        return 1
    fi

    local pr_count
    pr_count="$(cd "$REPO_ROOT" && gh pr list --state open --head "$current_branch" --json number --jq 'length' 2>/dev/null)" || {
        check_fail "PR stack exists" "Failed querying GitHub PRs (gh pr list error)"
        return 1
    }
    pr_count="${pr_count:-0}"
    if [[ "$pr_count" -lt 1 ]]; then
        check_fail "PR stack exists" "No open PRs found for branch '$current_branch'"
        return 1
    fi

    check_pass "PR stack exists ($pr_count open PRs for '$current_branch')"
    return 0
}

# ============================================================
# CHECK 7: Tests pass
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
    # Check 2: Phase readiness
    check_phase_readiness || true

    # Check 3: All tasks complete
    check_all_tasks_complete || true

    # Check 4: Reviews passed
    check_reviews_passed || true

    # Check 5: No outstanding fix requests
    check_no_fix_requests || true
fi

# Check 6: PR stack (independent of state file)
check_pr_stack || true

# Check 7: Tests (independent of state file)
check_tests_pass || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Pre-Synthesis Readiness Report"
echo ""
echo "**State file:** \`$STATE_FILE\`"
echo ""

for result in "${RESULTS[@]}"; do
    printf '%b\n' "$result"
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
