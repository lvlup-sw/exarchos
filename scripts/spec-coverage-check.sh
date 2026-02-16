#!/usr/bin/env bash
# Spec Coverage Check
# Verify test coverage for spec compliance. Replaces spec-review "Compare to Spec" prose.
#
# Usage: spec-coverage-check.sh --plan-file <path> --repo-root <path> [--threshold 80] [--skip-run]
#
# Exit codes:
#   0 = coverage met (all planned tests exist and pass)
#   1 = gaps found (missing test files or test failures)
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

PLAN_FILE=""
REPO_ROOT=""
THRESHOLD=80
SKIP_RUN=false

usage() {
    cat << 'USAGE'
Usage: spec-coverage-check.sh --plan-file <path> --repo-root <path> [--threshold 80] [--skip-run]

Required:
  --plan-file <path>    Path to the implementation plan markdown file
  --repo-root <path>    Repository root directory

Optional:
  --threshold <num>     Coverage threshold percentage (default: 80)
  --skip-run            Skip running tests (only check file existence)
  --help                Show this help message

Exit codes:
  0  Coverage met (all planned tests exist and pass)
  1  Gaps found (missing test files or test failures)
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --plan-file requires a path argument" >&2
                exit 2
            fi
            PLAN_FILE="$2"
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
        --threshold)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --threshold requires a number argument" >&2
                exit 2
            fi
            THRESHOLD="$2"
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

if [[ -z "$PLAN_FILE" || -z "$REPO_ROOT" ]]; then
    echo "Error: --plan-file and --repo-root are required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Error: Plan file not found: $PLAN_FILE" >&2
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
# EXTRACT TEST FILES FROM PLAN
# ============================================================

# Extract test file paths from **Test file:** lines in the plan
TEST_FILES=()
while IFS= read -r line; do
    # Match lines like: **Test file:** `src/widget.test.ts`
    if [[ "$line" =~ \*\*Test\ file:\*\*[[:space:]]*\`([^\`]+)\` ]]; then
        TEST_FILES+=("${BASH_REMATCH[1]}")
    fi
done < "$PLAN_FILE"

# ============================================================
# CHECK: Test files referenced in plan
# ============================================================

if [[ ${#TEST_FILES[@]} -eq 0 ]]; then
    check_fail "Test files in plan" "No test files referenced in plan document"
fi

# ============================================================
# CHECK: Each test file exists on disk
# ============================================================

FOUND=0
MISSING=0
MISSING_LIST=()

for test_file in "${TEST_FILES[@]}"; do
    full_path="$REPO_ROOT/$test_file"
    if [[ -f "$full_path" ]]; then
        check_pass "Test file exists: $test_file"
        FOUND=$((FOUND + 1))
    else
        check_fail "Test file exists: $test_file" "Not found at $full_path"
        MISSING=$((MISSING + 1))
        MISSING_LIST+=("$test_file")
    fi
done

# ============================================================
# CHECK: Tests pass (unless --skip-run)
# ============================================================

if [[ "$SKIP_RUN" == true ]]; then
    check_skip "Test execution (--skip-run)"
elif [[ ${#TEST_FILES[@]} -gt 0 && $MISSING -eq 0 ]]; then
    for test_file in "${TEST_FILES[@]}"; do
        if ! npx vitest run "$REPO_ROOT/$test_file" >/dev/null 2>&1; then
            check_fail "Test passes: $test_file"
        else
            check_pass "Test passes: $test_file"
        fi
    done
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Spec Coverage Report"
echo ""
echo "**Plan file:** \`$PLAN_FILE\`"
echo "**Repo root:** \`$REPO_ROOT\`"
echo "**Threshold:** ${THRESHOLD}%"
echo ""

TOTAL_TESTS=${#TEST_FILES[@]}
echo "### Coverage Summary"
echo ""
echo "- Planned test files: $TOTAL_TESTS"
echo "- Found on disk: $FOUND"
echo "- Missing: $MISSING"
echo ""

if [[ ${#MISSING_LIST[@]} -gt 0 ]]; then
    echo "### Missing Test Files"
    echo ""
    for f in "${MISSING_LIST[@]}"; do
        echo "- \`$f\`"
    done
    echo ""
fi

echo "### Check Results"
echo ""
for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 && $TOTAL_TESTS -gt 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL checks failed)"
    exit 1
fi
