#!/usr/bin/env bash
# Check Benchmark Regression
# Compare benchmark results against stored baselines and detect performance regressions.
#
# Usage: check-benchmark-regression.sh --results <path> --baselines <path> [--threshold 10]
#
# Exit codes:
#   0 = all benchmarks within threshold (or improved)
#   1 = regression detected (measured exceeds baseline by more than threshold)
#   2 = usage error (missing required args, missing file)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

RESULTS_FILE=""
BASELINES_FILE=""
THRESHOLD=10

usage() {
    cat << 'USAGE'
Usage: check-benchmark-regression.sh --results <path> --baselines <path> [--threshold 10]

Required:
  --results <path>       Path to benchmark results JSON file
  --baselines <path>     Path to baselines JSON file

Optional:
  --threshold <percent>  Regression threshold percentage (default: 10)
  --help                 Show this help message

Exit codes:
  0  All benchmarks within threshold (or improved)
  1  Regression detected
  2  Usage error (missing required args, missing file)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --results)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --results requires a path argument" >&2
                exit 2
            fi
            RESULTS_FILE="$2"
            shift 2
            ;;
        --baselines)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --baselines requires a path argument" >&2
                exit 2
            fi
            BASELINES_FILE="$2"
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

if [[ -z "$RESULTS_FILE" || -z "$BASELINES_FILE" ]]; then
    echo "Error: --results and --baselines are required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$RESULTS_FILE" ]]; then
    echo "Error: Results file not found: $RESULTS_FILE" >&2
    exit 2
fi

if [[ ! -f "$BASELINES_FILE" ]]; then
    echo "Error: Baselines file not found: $BASELINES_FILE" >&2
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
# VALIDATE JSON
# ============================================================

if ! jq empty "$RESULTS_FILE" 2>/dev/null; then
    echo "Error: Invalid JSON in results file: $RESULTS_FILE" >&2
    exit 2
fi

if ! jq empty "$BASELINES_FILE" 2>/dev/null; then
    echo "Error: Invalid JSON in baselines file: $BASELINES_FILE" >&2
    exit 2
fi

# ============================================================
# COMPARE BENCHMARKS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
CHECK_IMPROVED=0
RESULTS=()
TABLE_ROWS=()

# Get list of operations from results file
OPERATIONS=$(jq -r 'keys[]' "$RESULTS_FILE")

for op in $OPERATIONS; do
    # Get measured value — iterate over all metric keys in the result
    METRICS=$(jq -r --arg op "$op" '.[$op] | keys[]' "$RESULTS_FILE")

    for metric in $METRICS; do
        MEASURED=$(jq -r --arg op "$op" --arg m "$metric" '.[$op][$m]' "$RESULTS_FILE")
        BASELINE=$(jq -r --arg op "$op" --arg m "$metric" '.baselines[$op][$m] // empty' "$BASELINES_FILE")

        # Skip if no matching baseline
        if [[ -z "$BASELINE" ]]; then
            RESULTS+=("- **SKIP**: \`$op\` ($metric) — no baseline found")
            TABLE_ROWS+=("| $op | $metric | — | $MEASURED | — | SKIP |")
            continue
        fi

        # Validate BASELINE is numeric
        if ! awk -v val="$BASELINE" 'BEGIN { exit (val+0 == val) ? 0 : 1 }'; then
            RESULTS+=("- **SKIP**: \`$op\` ($metric) — non-numeric baseline: $BASELINE")
            TABLE_ROWS+=("| $op | $metric | $BASELINE | $MEASURED | — | SKIP |")
            continue
        fi

        # Skip if baseline is zero (cannot compute percentage change)
        if awk -v val="$BASELINE" 'BEGIN { exit (val+0 == 0) ? 0 : 1 }'; then
            RESULTS+=("- **SKIP**: \`$op\` ($metric) — zero baseline")
            TABLE_ROWS+=("| $op | $metric | 0 | $MEASURED | — | SKIP |")
            continue
        fi

        # Calculate regression percentage using awk (safe variable passing)
        CHANGE_PCT=$(awk -v m="$MEASURED" -v b="$BASELINE" 'BEGIN { printf "%.1f", (m - b) / b * 100 }')

        # Format change with sign prefix (awk printf already adds - for negatives)
        CHANGE_DISPLAY=$(awk -v m="$MEASURED" -v b="$BASELINE" 'BEGIN { v = (m - b) / b * 100; if (v >= 0) printf "+%.1f", v; else printf "%.1f", v }')

        # Check if regression exceeds threshold
        IS_REGRESSION=$(awk -v c="$CHANGE_PCT" -v t="$THRESHOLD" 'BEGIN { print (c > t) ? 1 : 0 }')
        IS_IMPROVEMENT=$(awk -v c="$CHANGE_PCT" -v t="$THRESHOLD" 'BEGIN { print (c < -t) ? 1 : 0 }')

        if [[ "$IS_REGRESSION" -eq 1 ]]; then
            RESULTS+=("- **FAIL**: \`$op\` ($metric) regressed from ${BASELINE} to ${MEASURED} (${CHANGE_DISPLAY}%, threshold ${THRESHOLD}%)")
            TABLE_ROWS+=("| $op | $metric | $BASELINE | $MEASURED | ${CHANGE_DISPLAY}% | FAIL |")
            CHECK_FAIL=$((CHECK_FAIL + 1))
        elif [[ "$IS_IMPROVEMENT" -eq 1 ]]; then
            RESULTS+=("- **INFO**: \`$op\` ($metric) improved from ${BASELINE} to ${MEASURED} (${CHANGE_DISPLAY}%), consider updating baseline")
            TABLE_ROWS+=("| $op | $metric | $BASELINE | $MEASURED | ${CHANGE_DISPLAY}% | IMPROVED |")
            CHECK_IMPROVED=$((CHECK_IMPROVED + 1))
            CHECK_PASS=$((CHECK_PASS + 1))
        else
            RESULTS+=("- **PASS**: \`$op\` ($metric) within bounds (${BASELINE} baseline, ${MEASURED} measured, ${CHANGE_DISPLAY}%)")
            TABLE_ROWS+=("| $op | $metric | $BASELINE | $MEASURED | ${CHANGE_DISPLAY}% | PASS |")
            CHECK_PASS=$((CHECK_PASS + 1))
        fi
    done
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Benchmark Regression Report"
echo ""
echo "**Results file:** \`$RESULTS_FILE\`"
echo "**Baselines file:** \`$BASELINES_FILE\`"
echo "**Threshold:** ${THRESHOLD}%"
echo ""

echo "### Summary Table"
echo ""
echo "| Operation | Metric | Baseline | Measured | Change | Status |"
echo "|-----------|--------|----------|----------|--------|--------|"
for row in "${TABLE_ROWS[@]}"; do
    echo "$row"
done
echo ""

echo "### Details"
echo ""
for result in "${RESULTS[@]}"; do
    echo "$result"
done
echo ""

TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_IMPROVED -gt 0 ]]; then
    echo "**Note:** $CHECK_IMPROVED metric(s) showed improvement — consider updating baselines."
    echo ""
fi

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL metrics within threshold)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL metrics regressed beyond ${THRESHOLD}% threshold)"
    exit 1
fi
