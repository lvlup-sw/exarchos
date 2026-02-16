#!/usr/bin/env bash
# Verify Plan Coverage
# Cross-reference design document sections to plan tasks. Replaces "Plan Verification" prose.
#
# Usage: verify-plan-coverage.sh --design-file <path> --plan-file <path>
#
# Exit codes:
#   0 = complete coverage (every Technical Design subsection maps to >= 1 task)
#   1 = gaps found (unmapped sections)
#   2 = usage error (missing required args, empty design, missing files)

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

DESIGN_FILE=""
PLAN_FILE=""

usage() {
    cat << 'USAGE'
Usage: verify-plan-coverage.sh --design-file <path> --plan-file <path>

Required:
  --design-file <path>   Path to the design document markdown file
  --plan-file <path>     Path to the implementation plan markdown file

Optional:
  --help                 Show this help message

Exit codes:
  0  Complete coverage (all Technical Design subsections mapped to tasks)
  1  Gaps found (unmapped design sections)
  2  Usage error (missing required args, empty design, missing files)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --design-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --design-file requires a path argument" >&2
                exit 2
            fi
            DESIGN_FILE="$2"
            shift 2
            ;;
        --plan-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --plan-file requires a path argument" >&2
                exit 2
            fi
            PLAN_FILE="$2"
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

if [[ -z "$DESIGN_FILE" || -z "$PLAN_FILE" ]]; then
    echo "Error: --design-file and --plan-file are required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$DESIGN_FILE" ]]; then
    echo "Error: Design file not found: $DESIGN_FILE" >&2
    exit 2
fi

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Error: Plan file not found: $PLAN_FILE" >&2
    exit 2
fi

# ============================================================
# EXTRACT DESIGN SECTIONS
# ============================================================

# Extract ### subsections under ## Technical Design
# We look for "## Technical Design" then collect all ### headers until the next ## header
DESIGN_SECTIONS=()
IN_TECH_DESIGN=false

while IFS= read -r line; do
    # Detect start of Technical Design section
    if [[ "$line" =~ ^##[[:space:]]+Technical[[:space:]]+Design ]]; then
        IN_TECH_DESIGN=true
        continue
    fi

    # Detect next ## section (end of Technical Design)
    if [[ "$IN_TECH_DESIGN" == true && "$line" =~ ^##[[:space:]] && ! "$line" =~ ^###[[:space:]] ]]; then
        IN_TECH_DESIGN=false
        continue
    fi

    # Collect ### subsection headers within Technical Design
    if [[ "$IN_TECH_DESIGN" == true && "$line" =~ ^###[[:space:]]+(.+) ]]; then
        section_name="${BASH_REMATCH[1]}"
        # Trim trailing whitespace
        section_name="$(echo "$section_name" | sed 's/[[:space:]]*$//')"
        DESIGN_SECTIONS+=("$section_name")
    fi
done < "$DESIGN_FILE"

# Validate we found sections
if [[ ${#DESIGN_SECTIONS[@]} -eq 0 ]]; then
    echo "Error: No Technical Design subsections found in design document" >&2
    echo "Expected ### headers under '## Technical Design'" >&2
    exit 2
fi

# ============================================================
# EXTRACT PLAN TASKS
# ============================================================

# Extract ### Task headers from plan
PLAN_TASKS=()
while IFS= read -r line; do
    if [[ "$line" =~ ^###[[:space:]]+Task[[:space:]]+[0-9]+ ]]; then
        # Extract the full task title (everything after "### Task NNN: ")
        task_title="${line#*: }"
        if [[ -n "$task_title" && "$task_title" != "$line" ]]; then
            PLAN_TASKS+=("$task_title")
        else
            PLAN_TASKS+=("$line")
        fi
    fi
done < "$PLAN_FILE"

# Also read the full plan content for free-text matching
PLAN_CONTENT="$(cat "$PLAN_FILE")"

# ============================================================
# CROSS-REFERENCE: Design sections to plan tasks
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
GAPS=()
MATRIX_ROWS=()

for section in "${DESIGN_SECTIONS[@]}"; do
    # Check if any task title or plan content references this design section
    MATCHED_TASKS=()

    for task in "${PLAN_TASKS[@]}"; do
        # Case-insensitive substring match
        if echo "$task" | grep -qi "$section"; then
            MATCHED_TASKS+=("$task")
        fi
    done

    # If no task title matches, check the full plan content for the section name
    if [[ ${#MATCHED_TASKS[@]} -eq 0 ]]; then
        if echo "$PLAN_CONTENT" | grep -qi "$section"; then
            MATCHED_TASKS+=("(referenced in plan body)")
        fi
    fi

    if [[ ${#MATCHED_TASKS[@]} -gt 0 ]]; then
        task_list="$(printf '%s, ' "${MATCHED_TASKS[@]}")"
        task_list="${task_list%, }"
        MATRIX_ROWS+=("| $section | $task_list | Covered |")
        CHECK_PASS=$((CHECK_PASS + 1))
    else
        MATRIX_ROWS+=("| $section | — | **GAP** |")
        GAPS+=("$section")
        CHECK_FAIL=$((CHECK_FAIL + 1))
    fi
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Plan Coverage Report"
echo ""
echo "**Design file:** \`$DESIGN_FILE\`"
echo "**Plan file:** \`$PLAN_FILE\`"
echo ""

echo "### Coverage Matrix"
echo ""
echo "| Design Section | Task(s) | Status |"
echo "|----------------|---------|--------|"
for row in "${MATRIX_ROWS[@]}"; do
    echo "$row"
done
echo ""

TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "### Summary"
echo ""
echo "- Design sections: $TOTAL"
echo "- Covered: $CHECK_PASS"
echo "- Gaps: $CHECK_FAIL"
echo ""

if [[ ${#GAPS[@]} -gt 0 ]]; then
    echo "### Unmapped Sections"
    echo ""
    for gap in "${GAPS[@]}"; do
        echo "- **$gap** — No task maps to this design section"
    done
    echo ""
fi

echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** (${CHECK_PASS}/${TOTAL} sections covered)"
    exit 0
else
    echo "**Result: FAIL** (${CHECK_FAIL}/${TOTAL} sections have gaps)"
    exit 1
fi
