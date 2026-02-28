#!/usr/bin/env bash
# Verify Flywheel Activation Prerequisites
# Checks that gold standard dataset exists and meets minimum requirements.
#
# Usage: verify-flywheel-activation.sh --gold-standard <path>
#
# Exit codes:
#   0 = all checks pass
#   1 = checks failed (reports which)
#   2 = usage error

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

GOLD_STANDARD=""
MIN_CASES=20

usage() {
    cat << 'USAGE'
Usage: verify-flywheel-activation.sh --gold-standard <path>

Required:
  --gold-standard <path>   Path to gold-standard.jsonl file

Optional:
  --min-cases <N>          Minimum case count (default: 20)
  --help                   Show this help message

Exit codes:
  0  All checks pass
  1  Checks failed (reports which)
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gold-standard)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --gold-standard requires a path argument" >&2
                exit 2
            fi
            GOLD_STANDARD="$2"
            shift 2
            ;;
        --min-cases)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --min-cases requires a numeric argument" >&2
                exit 2
            fi
            MIN_CASES="$2"
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

if [[ -z "$GOLD_STANDARD" ]]; then
    echo "Error: --gold-standard is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# VALIDATION
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
REQUIRED_FIELDS=("caseId" "skill" "rubricName" "humanVerdict" "humanScore" "humanRationale")

echo "## Flywheel Activation Check"
echo ""

# ----------------------------------------------------------
# Check 1: Gold standard file exists
# ----------------------------------------------------------
if [[ -f "$GOLD_STANDARD" ]]; then
    echo "PASS: Gold standard file exists: $GOLD_STANDARD"
    CHECK_PASS=$((CHECK_PASS + 1))
else
    echo "FAIL: Gold standard file not found: $GOLD_STANDARD"
    CHECK_FAIL=$((CHECK_FAIL + 1))
    echo ""
    echo "---"
    echo "**Result: FAIL** ($CHECK_FAIL checks failed)"
    exit 1
fi

# ----------------------------------------------------------
# Check 2: Case count >= MIN_CASES
# ----------------------------------------------------------
CASE_COUNT=$(wc -l < "$GOLD_STANDARD" | tr -d ' ')
if [[ $CASE_COUNT -ge $MIN_CASES ]]; then
    echo "PASS: Gold standard has $CASE_COUNT cases (minimum: $MIN_CASES)"
    CHECK_PASS=$((CHECK_PASS + 1))
else
    echo "FAIL: Gold standard has $CASE_COUNT cases (minimum: $MIN_CASES)"
    CHECK_FAIL=$((CHECK_FAIL + 1))
fi

# ----------------------------------------------------------
# Check 3: All lines are valid JSON
# ----------------------------------------------------------
INVALID_JSON=0
LINE_NUM=0
while IFS= read -r line; do
    LINE_NUM=$((LINE_NUM + 1))
    # Skip empty lines
    [[ -z "$line" ]] && continue
    if ! echo "$line" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
        INVALID_JSON=$((INVALID_JSON + 1))
        if [[ $INVALID_JSON -le 3 ]]; then
            echo "  Invalid JSON on line $LINE_NUM"
        fi
    fi
done < "$GOLD_STANDARD"

if [[ $INVALID_JSON -eq 0 ]]; then
    echo "PASS: All $CASE_COUNT lines are valid JSON"
    CHECK_PASS=$((CHECK_PASS + 1))
else
    echo "FAIL: $INVALID_JSON lines have invalid JSON"
    CHECK_FAIL=$((CHECK_FAIL + 1))
fi

# ----------------------------------------------------------
# Check 4: Required fields present in all cases
# ----------------------------------------------------------
MISSING_FIELDS_COUNT=0
LINE_NUM=0
while IFS= read -r line; do
    LINE_NUM=$((LINE_NUM + 1))
    # Skip empty lines
    [[ -z "$line" ]] && continue
    for field in "${REQUIRED_FIELDS[@]}"; do
        if ! echo "$line" | python3 -c "import json,sys; d=json.load(sys.stdin); assert '$field' in d" 2>/dev/null; then
            MISSING_FIELDS_COUNT=$((MISSING_FIELDS_COUNT + 1))
            if [[ $MISSING_FIELDS_COUNT -le 3 ]]; then
                echo "  Line $LINE_NUM: missing field '$field'"
            fi
        fi
    done
done < "$GOLD_STANDARD"

if [[ $MISSING_FIELDS_COUNT -eq 0 ]]; then
    echo "PASS: All cases have required fields (${REQUIRED_FIELDS[*]})"
    CHECK_PASS=$((CHECK_PASS + 1))
else
    echo "FAIL: $MISSING_FIELDS_COUNT missing fields across all cases"
    CHECK_FAIL=$((CHECK_FAIL + 1))
fi

# ============================================================
# SUMMARY
# ============================================================

echo ""
echo "### Summary"
echo "- Checks passed: $CHECK_PASS"
echo "- Checks failed: $CHECK_FAIL"
echo ""
echo "---"

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** (all checks passed)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL checks failed)"
    exit 1
fi
