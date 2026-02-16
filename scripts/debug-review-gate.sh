#!/usr/bin/env bash
# Debug Review Gate
# Verifies that a debug fix has proper test coverage for the bug scenario.
# Replaces "Thorough Track Review" prose with deterministic validation.
#
# Usage: debug-review-gate.sh --repo-root <path> --base-branch <branch> [--state-file <path>] [--skip-run]
#
# Exit codes:
#   0 = review passed (tests added, tests pass, no regressions)
#   1 = gaps found (missing tests or regressions)
#   2 = usage error (missing required args)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================================================
# COLORS
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT=""
BASE_BRANCH=""
STATE_FILE=""
SKIP_RUN=false

usage() {
    cat << 'USAGE'
Usage: debug-review-gate.sh --repo-root <path> --base-branch <branch> [--state-file <path>] [--skip-run]

Required:
  --repo-root <path>      Repository root directory
  --base-branch <branch>  Base branch to diff against (e.g., main)

Optional:
  --state-file <path>     Path to workflow state JSON (for bug keywords)
  --skip-run              Skip test execution (only check for new test files)
  --help                  Show this help message

Exit codes:
  0  Review passed — tests added, tests pass, no regressions
  1  Gaps found — missing tests or test failures
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
                echo "Error: --base-branch requires a branch name argument" >&2
                exit 2
            fi
            BASE_BRANCH="$2"
            shift 2
            ;;
        --state-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --state-file requires a path argument" >&2
                exit 2
            fi
            STATE_FILE="$2"
            shift 2
            ;;
        --skip-run)
            SKIP_RUN=true
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

if [[ -z "$REPO_ROOT" || -z "$BASE_BRANCH" ]]; then
    echo "Error: --repo-root and --base-branch are required" >&2
    usage >&2
    exit 2
fi

if [[ ! -d "$REPO_ROOT" ]]; then
    echo "Error: Repository root not found: $REPO_ROOT" >&2
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
# CHECK 1: New test files added in the fix branch
# ============================================================

check_new_tests() {
    local changed_files
    changed_files="$(cd "$REPO_ROOT" && git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || \
                     cd "$REPO_ROOT" && git diff --name-only "$BASE_BRANCH" HEAD 2>/dev/null || true)"

    if [[ -z "$changed_files" ]]; then
        check_fail "New test files added" "No changed files found between $BASE_BRANCH and HEAD"
        return 1
    fi

    # Look for test files: .test.ts, .test.sh, .spec.ts, .test.js, .spec.js
    local test_files
    test_files="$(echo "$changed_files" | grep -E '\.(test|spec)\.(ts|js|sh)$' || true)"

    if [[ -z "$test_files" ]]; then
        check_fail "New test files added" "No test files found in changed files"
        return 1
    fi

    local test_count
    test_count="$(echo "$test_files" | wc -l | tr -d ' ')"
    check_pass "New test files added ($test_count test file(s): $(echo "$test_files" | tr '\n' ', ' | sed 's/,$//'))"
    return 0
}

# ============================================================
# CHECK 2: Tests pass (npm run test:run)
# ============================================================

check_tests_pass() {
    if [[ "$SKIP_RUN" == true ]]; then
        check_skip "Tests pass (--skip-run)"
        return 0
    fi

    local test_output
    if ! test_output="$(cd "$REPO_ROOT" && npm run test:run 2>&1)"; then
        check_fail "Tests pass" "npm run test:run failed"
        return 1
    fi

    check_pass "Tests pass"
    return 0
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

# Check 1: New test files
check_new_tests || true

# Check 2: Tests pass
check_tests_pass || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Debug Review Gate"
echo ""
echo "**Repository:** \`$REPO_ROOT\`"
echo "**Base branch:** \`$BASE_BRANCH\`"
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
