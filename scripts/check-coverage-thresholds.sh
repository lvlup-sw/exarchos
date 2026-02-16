#!/usr/bin/env bash
# Check Coverage Thresholds
# Parse test coverage output (Vitest/Istanbul JSON format) and compare against thresholds.
#
# Usage: check-coverage-thresholds.sh --coverage-file <path> [--line-threshold 80] [--branch-threshold 70] [--function-threshold 100]
#
# Exit codes:
#   0 = all thresholds met
#   1 = below threshold
#   2 = usage error (missing required args, missing file)

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

COVERAGE_FILE=""
LINE_THRESHOLD=80
BRANCH_THRESHOLD=70
FUNCTION_THRESHOLD=100

usage() {
    cat << 'USAGE'
Usage: check-coverage-thresholds.sh --coverage-file <path> [--line-threshold 80] [--branch-threshold 70] [--function-threshold 100]

Required:
  --coverage-file <path>       Path to coverage JSON file (Istanbul/Vitest format)

Optional:
  --line-threshold <num>       Line coverage threshold percentage (default: 80)
  --branch-threshold <num>     Branch coverage threshold percentage (default: 70)
  --function-threshold <num>   Function coverage threshold percentage (default: 100)
  --help                       Show this help message

Exit codes:
  0  All thresholds met
  1  Below threshold
  2  Usage error (missing required args, missing file)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --coverage-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --coverage-file requires a path argument" >&2
                exit 2
            fi
            COVERAGE_FILE="$2"
            shift 2
            ;;
        --line-threshold)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --line-threshold requires a number argument" >&2
                exit 2
            fi
            LINE_THRESHOLD="$2"
            shift 2
            ;;
        --branch-threshold)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --branch-threshold requires a number argument" >&2
                exit 2
            fi
            BRANCH_THRESHOLD="$2"
            shift 2
            ;;
        --function-threshold)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --function-threshold requires a number argument" >&2
                exit 2
            fi
            FUNCTION_THRESHOLD="$2"
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

if [[ -z "$COVERAGE_FILE" ]]; then
    echo "Error: --coverage-file is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$COVERAGE_FILE" ]]; then
    echo "Error: Coverage file not found: $COVERAGE_FILE" >&2
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
# PARSE COVERAGE DATA
# ============================================================

# Validate JSON
if ! jq empty "$COVERAGE_FILE" 2>/dev/null; then
    echo "Error: Invalid JSON in coverage file: $COVERAGE_FILE" >&2
    exit 2
fi

# Extract percentages from Istanbul/Vitest coverage-summary.json format
LINE_PCT="$(jq '.total.lines.pct // 0' "$COVERAGE_FILE")"
BRANCH_PCT="$(jq '.total.branches.pct // 0' "$COVERAGE_FILE")"
FUNCTION_PCT="$(jq '.total.functions.pct // 0' "$COVERAGE_FILE")"

# ============================================================
# CHECK THRESHOLDS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
RESULTS=()

check_threshold() {
    local name="$1"
    local actual="$2"
    local threshold="$3"

    # Use awk for floating-point comparison
    if awk "BEGIN { exit !($actual >= $threshold) }"; then
        RESULTS+=("- **PASS**: $name — ${actual}% >= ${threshold}%")
        CHECK_PASS=$((CHECK_PASS + 1))
    else
        RESULTS+=("- **FAIL**: $name — ${actual}% < ${threshold}%")
        CHECK_FAIL=$((CHECK_FAIL + 1))
    fi
}

check_threshold "lines" "$LINE_PCT" "$LINE_THRESHOLD"
check_threshold "branches" "$BRANCH_PCT" "$BRANCH_THRESHOLD"
check_threshold "functions" "$FUNCTION_PCT" "$FUNCTION_THRESHOLD"

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Coverage Threshold Report"
echo ""
echo "**Coverage file:** \`$COVERAGE_FILE\`"
echo ""

echo "### Thresholds"
echo ""
echo "| Metric | Actual | Threshold | Status |"
echo "|--------|--------|-----------|--------|"
echo "| lines | ${LINE_PCT}% | ${LINE_THRESHOLD}% | $(awk "BEGIN { print ($LINE_PCT >= $LINE_THRESHOLD) ? \"PASS\" : \"FAIL\" }") |"
echo "| branches | ${BRANCH_PCT}% | ${BRANCH_THRESHOLD}% | $(awk "BEGIN { print ($BRANCH_PCT >= $BRANCH_THRESHOLD) ? \"PASS\" : \"FAIL\" }") |"
echo "| functions | ${FUNCTION_PCT}% | ${FUNCTION_THRESHOLD}% | $(awk "BEGIN { print ($FUNCTION_PCT >= $FUNCTION_THRESHOLD) ? \"PASS\" : \"FAIL\" }") |"
echo ""

echo "### Check Results"
echo ""
for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL metrics meet thresholds)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL metrics below threshold)"
    exit 1
fi
