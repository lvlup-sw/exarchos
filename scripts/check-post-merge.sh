#!/usr/bin/env bash
# Check Post-Merge Regression
# Gate check for the synthesize → cleanup boundary.
# Verifies CI passed on the merge commit and runs the test suite to detect regressions.
#
# Usage: check-post-merge.sh --pr-url <url> --merge-sha <sha>
#
# Exit codes:
#   0 = pass (CI green, tests pass)
#   1 = findings (CI failure or test regression)
#   2 = usage error (missing required args)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

PR_URL=""
MERGE_SHA=""

usage() {
    cat << 'USAGE'
Usage: check-post-merge.sh --pr-url <url> --merge-sha <sha>

Required:
  --pr-url <url>       PR URL for CI check lookup
  --merge-sha <sha>    Merge commit SHA for test verification

Optional:
  --help               Show this help message

Exit codes:
  0  Pass (CI green, tests pass)
  1  Findings (CI failure or test regression detected)
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --pr-url)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --pr-url requires a URL argument" >&2
                exit 2
            fi
            PR_URL="$2"
            shift 2
            ;;
        --merge-sha)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --merge-sha requires a SHA argument" >&2
                exit 2
            fi
            MERGE_SHA="$2"
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

if [[ -z "$PR_URL" || -z "$MERGE_SHA" ]]; then
    echo "Error: --pr-url and --merge-sha are required" >&2
    usage >&2
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
        RESULTS+=("- **FAIL**: $name -- $detail")
    else
        RESULTS+=("- **FAIL**: $name")
    fi
    CHECK_FAIL=$((CHECK_FAIL + 1))
}

# ============================================================
# CHECK 1: CI Status via gh pr checks
# ============================================================

check_ci_status() {
    if ! command -v gh &>/dev/null; then
        echo "FINDING [D4] [HIGH] criterion=\"ci-green\" evidence=\"gh CLI not found in PATH\"" >&2
        check_fail "CI green" "gh CLI not found in PATH"
        return 1
    fi

    local checks_json
    checks_json="$(gh pr checks "$PR_URL" --json name,state 2>/dev/null)" || {
        echo "FINDING [D4] [HIGH] criterion=\"ci-green\" evidence=\"gh pr checks command failed for $PR_URL\"" >&2
        check_fail "CI green" "gh pr checks command failed"
        return 1
    }

    # Check if all states are SUCCESS or NEUTRAL
    local failed_checks
    failed_checks="$(echo "$checks_json" | jq -r '[.[] | select(.state != "SUCCESS" and .state != "NEUTRAL")] | map("\(.name) (\(.state))") | join(", ")' 2>/dev/null)" || {
        echo "FINDING [D4] [HIGH] criterion=\"ci-green\" evidence=\"Failed to parse CI check results\"" >&2
        check_fail "CI green" "Failed to parse CI check results"
        return 1
    }

    if [[ -n "$failed_checks" ]]; then
        echo "FINDING [D4] [HIGH] criterion=\"ci-green\" evidence=\"Failed checks: $failed_checks\"" >&2
        check_fail "CI green" "Failed checks: $failed_checks"
        return 1
    fi

    check_pass "CI green (all checks SUCCESS or NEUTRAL)"
    return 0
}

# ============================================================
# CHECK 2: Test Suite
# ============================================================

check_test_suite() {
    local test_output
    if ! test_output="$(npm run test:run 2>&1)"; then
        echo "FINDING [D4] [HIGH] criterion=\"test-suite\" evidence=\"npm run test:run failed (merge-sha: $MERGE_SHA)\"" >&2
        check_fail "Test suite" "npm run test:run failed"
        return 1
    fi

    check_pass "Test suite (npm run test:run passed)"
    return 0
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

check_ci_status || true
check_test_suite || true

# ============================================================
# SUMMARY REPORT (stdout)
# ============================================================

echo "## Post-Merge Regression Report"
echo ""
echo "**PR:** \`$PR_URL\`"
echo "**Merge SHA:** \`$MERGE_SHA\`"
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
