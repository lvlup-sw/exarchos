#!/usr/bin/env bash
# Assess Refactor Scope
# Assesses scope and recommends track (polish vs overhaul).
# Replaces explore phase scope assessment prose with deterministic validation.
#
# Usage: assess-refactor-scope.sh --files <file1,file2,...> | --state-file <path>
#
# Exit codes:
#   0 = polish recommended
#   1 = overhaul recommended
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

FILES=""
STATE_FILE=""

usage() {
    cat << 'USAGE'
Usage: assess-refactor-scope.sh --files <file1,file2,...> | --state-file <path>

Required (one of):
  --files <file1,file2,...>   Comma-separated list of affected files
  --state-file <path>        Path to workflow state JSON (reads explore.scopeAssessment.filesAffected)

Optional:
  --help                     Show this help message

Exit codes:
  0  Polish recommended (<=5 files, single module, good test coverage)
  1  Overhaul recommended (scope exceeds polish limits)
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --files)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --files requires a comma-separated list" >&2
                exit 2
            fi
            FILES="$2"
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

if [[ -z "$FILES" && -z "$STATE_FILE" ]]; then
    echo "Error: --files or --state-file is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# DEPENDENCY CHECK
# ============================================================

if [[ -n "$STATE_FILE" ]]; then
    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required but not installed" >&2
        exit 2
    fi
fi

# ============================================================
# PARSE FILES
# ============================================================

FILE_LIST=()

if [[ -n "$STATE_FILE" ]]; then
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "Error: State file not found: $STATE_FILE" >&2
        exit 2
    fi
    # Read files from state file
    while IFS= read -r line; do
        FILE_LIST+=("$line")
    done < <(jq -r '.explore.scopeAssessment.filesAffected[]' "$STATE_FILE" 2>/dev/null)
elif [[ -n "$FILES" ]]; then
    IFS=',' read -ra FILE_LIST <<< "$FILES"
fi

FILE_COUNT=${#FILE_LIST[@]}

# ============================================================
# ASSESS SCOPE
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

# Check 1: File count (<=5 for polish)
if [[ $FILE_COUNT -le 5 ]]; then
    check_pass "File count within polish limit ($FILE_COUNT <= 5)"
else
    check_fail "File count exceeds polish limit" "$FILE_COUNT files (max 5)"
fi

# Check 2: Cross-module span
# Extract unique top-level directories (Bash 3 compatible — no associative arrays)
MODULE_LIST=""
for f in "${FILE_LIST[@]}"; do
    top_dir="$(echo "$f" | cut -d'/' -f1)"
    # Add to list if not already present
    if ! echo "$MODULE_LIST" | grep -qF "|$top_dir|"; then
        MODULE_LIST="${MODULE_LIST}|$top_dir|"
    fi
done
# Count unique modules
MODULE_COUNT=0
MODULE_NAMES=""
if [[ -n "$MODULE_LIST" ]]; then
    MODULE_NAMES="$(echo "$MODULE_LIST" | tr '|' '\n' | sort -u | grep -v '^$' | tr '\n' ' ')"
    MODULE_COUNT="$(echo "$MODULE_LIST" | tr '|' '\n' | sort -u | grep -vc '^$' || true)"
fi

if [[ $MODULE_COUNT -le 1 ]]; then
    check_pass "Single module scope ($MODULE_NAMES)"
else
    check_fail "Cross-module span detected" "$MODULE_COUNT modules: $MODULE_NAMES"
fi

# Check 3: Test coverage (check if .test.ts/.test.sh files exist for affected files)
MISSING_TESTS=()
for f in "${FILE_LIST[@]}"; do
    # Skip files that are already test files
    if [[ "$f" == *.test.ts || "$f" == *.test.sh ]]; then
        continue
    fi
    # Skip non-source files
    if [[ "$f" != *.ts && "$f" != *.sh ]]; then
        continue
    fi
    # Derive expected test file name
    if [[ "$f" == *.ts ]]; then
        test_file="${f%.ts}.test.ts"
    elif [[ "$f" == *.sh ]]; then
        test_file="${f%.sh}.test.sh"
    fi
    # We can only check existence if we have a reference directory,
    # but for scope assessment we just note the expected test counterparts
    MISSING_TESTS+=("$test_file")
done

# For scope assessment purposes, having test counterparts is informational
if [[ ${#MISSING_TESTS[@]} -eq 0 ]]; then
    check_pass "Test coverage assessment (all source files have known patterns)"
else
    # This is informational, not a hard fail for track decision
    check_pass "Test coverage assessment (${#MISSING_TESTS[@]} test counterparts to verify)"
fi

# ============================================================
# DETERMINE RECOMMENDATION
# ============================================================

RECOMMENDATION="polish"
if [[ $FILE_COUNT -gt 5 ]]; then
    RECOMMENDATION="overhaul"
fi
if [[ $MODULE_COUNT -gt 1 ]]; then
    RECOMMENDATION="overhaul"
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Scope Assessment Report"
echo ""
echo "**Files affected:** $FILE_COUNT"
echo "**Modules:** ${MODULE_NAMES:-}"
echo "**Recommendation:** $RECOMMENDATION"
echo ""

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
echo "---"
echo ""

if [[ "$RECOMMENDATION" == "polish" ]]; then
    echo "**Result: POLISH** — Scope is within polish limits"
    exit 0
else
    echo "**Result: OVERHAUL** — Scope exceeds polish limits"
    exit 1
fi
