#!/usr/bin/env bash
# Verify Plan Coverage
# Cross-reference design document sections to plan tasks. Replaces "Plan Verification" prose.
#
# Usage: verify-plan-coverage.sh --design-file <path> --plan-file <path>
#
# Exit codes:
#   0 = complete coverage (every Technical Design subsection maps to >= 1 task)
#   1 = gaps found (unmapped sections) or no '### Task' headers found in plan
#   2 = usage error (missing required args, empty design, missing files)

set -euo pipefail

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

# Extract design subsections under ## Technical Design.
# Strategy:
#   1. Collect all ### headers and their child #### headers within ## Technical Design
#   2. For each ### that has #### children, use the #### headers (more granular)
#   3. For each ### that has NO #### children, use the ### header itself (fallback)

# Phase 1: Parse the hierarchical structure
H3_HEADERS=()          # All ### headers found
H4_BY_H3=()           # Pipe-delimited #### headers for each ### (empty string if none)
IN_TECH_DESIGN=false
CURRENT_H3_INDEX=-1

while IFS= read -r line; do
    # Detect start of Technical Design section
    if [[ "$line" =~ ^##[[:space:]]+Technical[[:space:]]+Design ]]; then
        IN_TECH_DESIGN=true
        continue
    fi

    # Skip lines outside Technical Design
    if [[ "$IN_TECH_DESIGN" != true ]]; then
        continue
    fi

    # Detect next ## section (end of Technical Design) — must NOT be ### or ####
    if [[ "$line" =~ ^##[[:space:]] && ! "$line" =~ ^### ]]; then
        IN_TECH_DESIGN=false
        continue
    fi

    # Collect #### headers under current ### (check BEFORE ### to avoid BASH_REMATCH clobber)
    if [[ "$line" =~ ^####[[:space:]]+(.+) && $CURRENT_H3_INDEX -ge 0 ]]; then
        subsection_name="${BASH_REMATCH[1]}"
        subsection_name="$(echo "$subsection_name" | sed 's/[[:space:]]*$//')"
        if [[ -n "${H4_BY_H3[$CURRENT_H3_INDEX]}" ]]; then
            H4_BY_H3[$CURRENT_H3_INDEX]="${H4_BY_H3[$CURRENT_H3_INDEX]}|${subsection_name}"
        else
            H4_BY_H3[$CURRENT_H3_INDEX]="$subsection_name"
        fi
        continue
    fi

    # Collect ### headers (only if NOT ####, since #### was handled above)
    if [[ "$line" =~ ^###[[:space:]]+(.+) ]]; then
        section_name="${BASH_REMATCH[1]}"
        section_name="$(echo "$section_name" | sed 's/[[:space:]]*$//')"
        H3_HEADERS+=("$section_name")
        H4_BY_H3+=("")
        CURRENT_H3_INDEX=$(( ${#H3_HEADERS[@]} - 1 ))
        continue
    fi
done < "$DESIGN_FILE"

# Phase 2: Build DESIGN_SECTIONS from the hierarchy
# Prefer #### subsections when they exist; fall back to ### headers
DESIGN_SECTIONS=()

for i in "${!H3_HEADERS[@]}"; do
    if [[ -n "${H4_BY_H3[$i]}" ]]; then
        # Split pipe-delimited #### headers
        IFS='|' read -ra subs <<< "${H4_BY_H3[$i]}"
        for sub in "${subs[@]}"; do
            DESIGN_SECTIONS+=("$sub")
        done
    else
        # No #### children — use the ### header
        DESIGN_SECTIONS+=("${H3_HEADERS[$i]}")
    fi
done

# Validate we found sections
if [[ -z "${DESIGN_SECTIONS+x}" ]] || [[ ${#DESIGN_SECTIONS[@]} -eq 0 ]]; then
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

# Validate we found tasks
if [[ -z "${PLAN_TASKS+x}" ]] || [[ ${#PLAN_TASKS[@]} -eq 0 ]]; then
    echo "ERROR: No '### Task' headers found in plan file: $PLAN_FILE" >&2
    exit 1
fi

# Also read the full plan content for free-text matching
PLAN_CONTENT="$(cat "$PLAN_FILE")"

# ============================================================
# KEYWORD EXTRACTION HELPER
# ============================================================

# Common words to skip during keyword matching
STOP_WORDS="a an and are as at be by for from has have in is it of on or the this to was were will with"

# Extract significant keywords from a string (lowercase, skip stop words, skip short words)
# Returns space-separated keywords
extract_keywords() {
    local text="$1"
    local words=()
    # Convert to lowercase, split on non-alpha
    for word in $(echo "$text" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alpha:]' ' '); do
        # Skip short words (< 3 chars) and stop words
        if [[ ${#word} -lt 3 ]]; then
            continue
        fi
        local is_stop=false
        for sw in $STOP_WORDS; do
            if [[ "$word" == "$sw" ]]; then
                is_stop=true
                break
            fi
        done
        if [[ "$is_stop" == false ]]; then
            words+=("$word")
        fi
    done
    echo "${words[*]}"
}

# Check if text matches by keywords: at least 2 significant keywords from section
# appear in the target text (case-insensitive)
keyword_match() {
    local section_keywords="$1"
    local target_text="$2"
    local target_lower
    target_lower="$(echo "$target_text" | tr '[:upper:]' '[:lower:]')"

    local match_count=0
    for kw in $section_keywords; do
        if echo "$target_lower" | grep -qiw "$kw"; then
            match_count=$((match_count + 1))
        fi
    done

    # Require at least 2 keyword matches (or all keywords if only 1 keyword)
    local kw_count
    kw_count=$(echo "$section_keywords" | wc -w | tr -d ' ')
    if [[ $kw_count -le 1 ]]; then
        [[ $match_count -ge 1 ]]
    else
        [[ $match_count -ge 2 ]]
    fi
}

# ============================================================
# EXTRACT DEFERRED SECTIONS FROM TRACEABILITY TABLE
# ============================================================

# Parse deferred section names from the plan's traceability table.
# Rows containing "Deferred" (case-insensitive) in any column are treated as
# explicitly deferred — the first column's text (with leading number prefixes
# like "1.4 " stripped) is the design section name.
DEFERRED_SECTIONS=()
while IFS= read -r line; do
    # Match table rows containing "Deferred" (case-insensitive) with pipe delimiters
    if echo "$line" | grep -qi "deferred" && [[ "$line" == *"|"* ]]; then
        # Skip table header/separator rows
        if echo "$line" | grep -qE '^\|[[:space:]]*[-]+'; then
            continue
        fi
        if echo "$line" | grep -qiE '^\|[[:space:]]*(Design Section|Section)'; then
            continue
        fi
        # Extract first column (design section name), strip leading number prefix like "1.4 "
        section_name="$(echo "$line" | sed 's/^[[:space:]]*|[[:space:]]*//' | sed 's/[[:space:]]*|.*//' | sed 's/^[0-9.]*[[:space:]]*//' | sed 's/[[:space:]]*$//')"
        if [[ -n "$section_name" ]]; then
            DEFERRED_SECTIONS+=("$section_name")
        fi
    fi
done < "$PLAN_FILE"

# ============================================================
# CROSS-REFERENCE: Design sections to plan tasks
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
CHECK_DEFERRED=0
GAPS=()
MATRIX_ROWS=()

for section in "${DESIGN_SECTIONS[@]}"; do
    # Extract keywords from the section name for keyword-based matching
    SECTION_KEYWORDS="$(extract_keywords "$section")"

    # Check if section is explicitly deferred in the traceability table FIRST.
    # Deferred sections take priority — they represent intentional exclusions
    # documented with rationale, not gaps.
    is_deferred=false
    for deferred in "${DEFERRED_SECTIONS[@]+${DEFERRED_SECTIONS[@]}}"; do
        # Try exact case-insensitive substring match (both directions)
        if echo "$deferred" | grep -qiF "$section"; then
            is_deferred=true
            break
        fi
        if echo "$section" | grep -qiF "$deferred"; then
            is_deferred=true
            break
        fi
        # Try keyword match
        deferred_keywords="$(extract_keywords "$deferred")"
        if keyword_match "$deferred_keywords" "$section" || keyword_match "$SECTION_KEYWORDS" "$deferred"; then
            is_deferred=true
            break
        fi
    done

    if [[ "$is_deferred" == true ]]; then
        MATRIX_ROWS+=("| $section | (Deferred in traceability) | Deferred |")
        CHECK_DEFERRED=$((CHECK_DEFERRED + 1))
        continue
    fi

    # Check if any task title or plan content references this design section
    MATCHED_TASKS=()

    for task in "${PLAN_TASKS[@]+${PLAN_TASKS[@]}}"; do
        # First try exact case-insensitive substring match
        if echo "$task" | grep -qiF "$section"; then
            MATCHED_TASKS+=("$task")
            continue
        fi
        # Fall back to keyword-based matching
        if keyword_match "$SECTION_KEYWORDS" "$task"; then
            MATCHED_TASKS+=("$task")
        fi
    done

    # If no task title matches, check the full plan content
    if [[ -z "${MATCHED_TASKS+x}" ]] || [[ ${#MATCHED_TASKS[@]} -eq 0 ]]; then
        # Try exact match first
        if echo "$PLAN_CONTENT" | grep -qiF "$section"; then
            MATCHED_TASKS+=("(referenced in plan body)")
        # Then try keyword match against plan content
        elif keyword_match "$SECTION_KEYWORDS" "$PLAN_CONTENT"; then
            MATCHED_TASKS+=("(keyword match in plan body)")
        fi
    fi

    if [[ -n "${MATCHED_TASKS+x}" ]] && [[ ${#MATCHED_TASKS[@]} -gt 0 ]]; then
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

TOTAL=$((CHECK_PASS + CHECK_FAIL + CHECK_DEFERRED))
echo "### Summary"
echo ""
echo "- Design sections: $TOTAL"
echo "- Covered: $CHECK_PASS"
echo "- Deferred: $CHECK_DEFERRED"
echo "- Gaps: $CHECK_FAIL"
echo ""

if [[ -n "${GAPS+x}" ]] && [[ ${#GAPS[@]} -gt 0 ]]; then
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
    if [[ $CHECK_DEFERRED -gt 0 ]]; then
        echo "**Result: PASS** (${CHECK_PASS}/${TOTAL} sections covered, ${CHECK_DEFERRED} deferred)"
    else
        echo "**Result: PASS** (${CHECK_PASS}/${TOTAL} sections covered)"
    fi
    exit 0
else
    echo "**Result: FAIL** (${CHECK_FAIL}/${TOTAL} sections have gaps)"
    exit 1
fi
