#!/usr/bin/env bash
# Verify Provenance Chain
# Cross-reference design requirement identifiers (DR-N) to plan task Implements: fields.
# Ensures every design requirement is traceable to at least one plan task.
#
# Usage: verify-provenance-chain.sh --design-file <path> --plan-file <path>
#
# Exit codes:
#   0 = complete traceability (every DR-N maps to >= 1 task)
#   1 = gaps found (unmapped requirements or orphan references)
#   2 = usage error (missing required args, no DR-N identifiers, missing files)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

DESIGN_FILE=""
PLAN_FILE=""

usage() {
    cat << 'USAGE'
Usage: verify-provenance-chain.sh --design-file <path> --plan-file <path>

Required:
  --design-file <path>   Path to the design document markdown file
  --plan-file <path>     Path to the implementation plan markdown file

Optional:
  --help                 Show this help message

Exit codes:
  0  Complete traceability (all DR-N identifiers mapped to tasks)
  1  Gaps found (unmapped requirements or orphan references)
  2  Usage error (missing required args, no DR-N identifiers, missing files)
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
# EXTRACT DESIGN REQUIREMENTS (DR-N identifiers)
# ============================================================

# Extract unique DR-N identifiers from the design document.
# Scans the entire document — DR-N can appear in any section.
DESIGN_REQS=()
while IFS= read -r req; do
    # Deduplicate
    local_found=false
    for existing in "${DESIGN_REQS[@]+${DESIGN_REQS[@]}}"; do
        if [[ "$existing" == "$req" ]]; then
            local_found=true
            break
        fi
    done
    if [[ "$local_found" == false ]]; then
        DESIGN_REQS+=("$req")
    fi
done < <(grep -oE 'DR-[0-9]+' "$DESIGN_FILE" | sort -t- -k2 -n | uniq)

if [[ -z "${DESIGN_REQS+x}" ]] || [[ ${#DESIGN_REQS[@]} -eq 0 ]]; then
    echo "Error: No DR-N identifiers found in design document" >&2
    echo "Expected identifiers like DR-1, DR-2, etc." >&2
    exit 2
fi

# ============================================================
# EXTRACT PLAN TASK IMPLEMENTS FIELDS
# ============================================================

# Parse ### Task blocks and extract Implements: lines.
# Build a map: task title → list of DR-N references.
TASK_TITLES=()
TASK_IMPLEMENTS=()   # Pipe-delimited DR-N refs per task

CURRENT_TASK=""
IN_TASK=false

while IFS= read -r line; do
    # Detect task header
    if [[ "$line" =~ ^###[[:space:]]+Task[[:space:]] ]]; then
        # Save previous task if any
        if [[ "$IN_TASK" == true && -n "$CURRENT_TASK" ]]; then
            TASK_TITLES+=("$CURRENT_TASK")
            TASK_IMPLEMENTS+=("${CURRENT_IMPL:-}")
        fi
        # Start new task — extract title after "### Task N: "
        CURRENT_TASK="${line#*: }"
        if [[ "$CURRENT_TASK" == "$line" ]]; then
            CURRENT_TASK="$line"
        fi
        CURRENT_IMPL=""
        IN_TASK=true
        continue
    fi

    # If inside a task block, look for Implements: line
    if [[ "$IN_TASK" == true ]]; then
        # Match **Implements:** or Implements: patterns
        if [[ "$line" =~ [Ii]mplements:?[[:space:]]*(.*) ]]; then
            impl_text="${BASH_REMATCH[1]}"
            # Extract DR-N references from the implements line
            while IFS= read -r ref; do
                if [[ -n "$ref" ]]; then
                    if [[ -n "$CURRENT_IMPL" ]]; then
                        CURRENT_IMPL="${CURRENT_IMPL}|${ref}"
                    else
                        CURRENT_IMPL="$ref"
                    fi
                fi
            done < <(echo "$impl_text" | grep -oE 'DR-[0-9]+')
        fi
    fi
done < "$PLAN_FILE"

# Save the last task
if [[ "$IN_TASK" == true && -n "$CURRENT_TASK" ]]; then
    TASK_TITLES+=("$CURRENT_TASK")
    TASK_IMPLEMENTS+=("${CURRENT_IMPL:-}")
fi

# ============================================================
# CROSS-REFERENCE: Design requirements to plan tasks
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
GAPS=()
MATRIX_ROWS=()

for req in "${DESIGN_REQS[@]}"; do
    MATCHED_TASKS=()

    for i in "${!TASK_TITLES[@]}"; do
        impl="${TASK_IMPLEMENTS[$i]}"
        if [[ -n "$impl" ]]; then
            # Check if this task implements the requirement
            IFS='|' read -ra refs <<< "$impl"
            for ref in "${refs[@]}"; do
                if [[ "$ref" == "$req" ]]; then
                    MATCHED_TASKS+=("${TASK_TITLES[$i]}")
                    break
                fi
            done
        fi
    done

    if [[ ${#MATCHED_TASKS[@]} -gt 0 ]]; then
        task_list="$(printf '%s, ' "${MATCHED_TASKS[@]}")"
        task_list="${task_list%, }"
        MATRIX_ROWS+=("| $req | $task_list | Covered |")
        CHECK_PASS=$((CHECK_PASS + 1))
    else
        MATRIX_ROWS+=("| $req | — | **GAP** |")
        GAPS+=("$req")
        CHECK_FAIL=$((CHECK_FAIL + 1))
    fi
done

# ============================================================
# DETECT ORPHAN REFERENCES
# ============================================================

# Find DR-N references in plan tasks that don't exist in the design
ORPHAN_REFS=()

for i in "${!TASK_TITLES[@]}"; do
    impl="${TASK_IMPLEMENTS[$i]}"
    if [[ -n "$impl" ]]; then
        IFS='|' read -ra refs <<< "$impl"
        for ref in "${refs[@]}"; do
            # Check if this ref exists in design requirements
            found=false
            for req in "${DESIGN_REQS[@]}"; do
                if [[ "$req" == "$ref" ]]; then
                    found=true
                    break
                fi
            done
            if [[ "$found" == false ]]; then
                # Deduplicate
                already=false
                for existing in "${ORPHAN_REFS[@]+${ORPHAN_REFS[@]}}"; do
                    if [[ "$existing" == "$ref (in ${TASK_TITLES[$i]})" ]]; then
                        already=true
                        break
                    fi
                done
                if [[ "$already" == false ]]; then
                    ORPHAN_REFS+=("$ref (in ${TASK_TITLES[$i]})")
                fi
            fi
        done
    fi
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Provenance Chain Report"
echo ""
echo "**Design file:** \`$DESIGN_FILE\`"
echo "**Plan file:** \`$PLAN_FILE\`"
echo ""

echo "### Traceability Matrix"
echo ""
echo "| Requirement | Task(s) | Status |"
echo "|-------------|---------|--------|"
for row in "${MATRIX_ROWS[@]}"; do
    echo "$row"
done
echo ""

TOTAL=$((CHECK_PASS + CHECK_FAIL))
ORPHAN_COUNT=${#ORPHAN_REFS[@]}

echo "### Summary"
echo ""
echo "- Requirements: $TOTAL"
echo "- Covered: $CHECK_PASS"
echo "- Gaps: $CHECK_FAIL"
echo "- Orphan refs: $ORPHAN_COUNT"
echo ""

if [[ ${#GAPS[@]} -gt 0 ]]; then
    echo "### Unmapped Requirements"
    echo ""
    for gap in "${GAPS[@]}"; do
        echo "- **$gap** — No task implements this requirement"
    done
    echo ""
fi

if [[ $ORPHAN_COUNT -gt 0 ]]; then
    echo "### Orphan References"
    echo ""
    for orphan in "${ORPHAN_REFS[@]}"; do
        echo "- **$orphan** — References a requirement not found in design"
    done
    echo ""
fi

echo "---"
echo ""

HAS_ISSUES=false

if [[ $CHECK_FAIL -gt 0 ]]; then
    HAS_ISSUES=true
fi

if [[ $ORPHAN_COUNT -gt 0 ]]; then
    HAS_ISSUES=true
fi

if [[ "$HAS_ISSUES" == true ]]; then
    echo "**Result: FAIL** (${CHECK_FAIL}/${TOTAL} requirements unmapped, ${ORPHAN_COUNT} orphan references)"
    exit 1
else
    echo "**Result: PASS** (${CHECK_PASS}/${TOTAL} requirements traced)"
    exit 0
fi
