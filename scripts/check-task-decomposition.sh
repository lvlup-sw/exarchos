#!/usr/bin/env bash
# Check Task Decomposition
# Validate plan task structure quality, dependency DAG, and parallel safety.
# D5 (Workflow Determinism) gate for the plan→plan-review boundary.
#
# Usage: check-task-decomposition.sh --plan-file <path>
#
# Exit codes:
#   0 = all tasks well-decomposed, valid DAG, no parallel conflicts
#   1 = decomposition gaps found (missing fields, cycles, or conflicts)
#   2 = input error (missing args, missing file, no task headers)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

PLAN_FILE=""

usage() {
    cat << 'USAGE'
Usage: check-task-decomposition.sh --plan-file <path>

Required:
  --plan-file <path>   Path to the implementation plan markdown file

Optional:
  --help               Show this help message

Exit codes:
  0  All tasks well-decomposed (description, files, tests present; valid DAG; no parallel conflicts)
  1  Decomposition gaps found
  2  Input error (missing required args, missing file, no task headers)
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

if [[ -z "$PLAN_FILE" ]]; then
    echo "Error: --plan-file is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Error: Plan file not found: $PLAN_FILE" >&2
    exit 2
fi

# ============================================================
# PARSE TASK BLOCKS
# ============================================================

# Extract task IDs and their content blocks.
# Each task starts with "### Task T-XX:" and ends at the next "### Task" or EOF.

TASK_IDS=()
TASK_BLOCKS=()
CURRENT_BLOCK=""
CURRENT_ID=""

while IFS= read -r line; do
    if [[ "$line" =~ ^###[[:space:]]+Task[[:space:]]+(T-[0-9]+) ]]; then
        # Save the previous block if any
        if [[ -n "$CURRENT_ID" ]]; then
            TASK_IDS+=("$CURRENT_ID")
            TASK_BLOCKS+=("$CURRENT_BLOCK")
        fi
        CURRENT_ID="${BASH_REMATCH[1]}"
        CURRENT_BLOCK="$line"
    elif [[ -n "$CURRENT_ID" ]]; then
        CURRENT_BLOCK="${CURRENT_BLOCK}
${line}"
    fi
done < "$PLAN_FILE"

# Save the last block
if [[ -n "$CURRENT_ID" ]]; then
    TASK_IDS+=("$CURRENT_ID")
    TASK_BLOCKS+=("$CURRENT_BLOCK")
fi

# Validate we found tasks
if [[ ${#TASK_IDS[@]} -eq 0 ]]; then
    echo "Error: No '### Task T-XX' headers found in plan file: $PLAN_FILE" >&2
    exit 2
fi

# ============================================================
# TASK STRUCTURE VALIDATION
# ============================================================

# For each task, check:
#   - Description: >10 words of substantive text after the title line
#   - File targets: patterns like `path/file.ext`, File:, .ts, .sh, etc.
#   - Test expectations: [RED], Test:, .test.ts, Method_Scenario_Outcome patterns

WELL_DECOMPOSED=0
NEEDS_REWORK=0
STRUCTURE_ROWS=()

for i in "${!TASK_IDS[@]}"; do
    task_id="${TASK_IDS[$i]}"
    block="${TASK_BLOCKS[$i]}"

    # --- Check description ---
    # Extract text after **Description:** up to next **field:** or section header
    desc_text=""
    in_desc=false
    while IFS= read -r bline; do
        if [[ "$bline" =~ ^\*\*Description:\*\* ]]; then
            # Inline text after **Description:**
            inline="${bline#*\*\*Description:\*\*}"
            inline="$(echo "$inline" | sed 's/^[[:space:]]*//')"
            desc_text="$inline"
            in_desc=true
            continue
        fi
        if [[ "$in_desc" == true ]]; then
            # Stop at next field header or section
            if [[ "$bline" =~ ^\*\* || "$bline" =~ ^### ]]; then
                break
            fi
            desc_text="${desc_text} ${bline}"
        fi
    done <<< "$block"

    # Count words in description
    desc_word_count=$(echo "$desc_text" | wc -w | tr -d ' ')
    has_desc=false
    if [[ $desc_word_count -gt 10 ]]; then
        has_desc=true
    fi

    # --- Check file targets ---
    # Look for backtick-quoted paths, File: lines, or file extension patterns
    file_count=0
    while IFS= read -r bline; do
        # Match backtick-quoted paths like `src/foo/bar.ts`
        if echo "$bline" | grep -qE '`[a-zA-Z0-9_./-]+\.[a-zA-Z]+`'; then
            file_count=$((file_count + $(echo "$bline" | grep -oE '`[a-zA-Z0-9_./-]+\.[a-zA-Z]+`' | wc -l | tr -d ' ')))
        fi
    done <<< "$block"
    has_files=false
    if [[ $file_count -gt 0 ]]; then
        has_files=true
    fi

    # --- Check test expectations ---
    # Look for [RED], Test:, .test.ts, or Method_Scenario_Outcome patterns
    test_count=0
    while IFS= read -r bline; do
        if echo "$bline" | grep -qE '\[RED\]'; then
            test_count=$((test_count + $(echo "$bline" | grep -oE '\[RED\]' | wc -l | tr -d ' ')))
        elif echo "$bline" | grep -qE '[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+_[A-Z][a-zA-Z]+'; then
            test_count=$((test_count + 1))
        fi
    done <<< "$block"
    has_tests=false
    if [[ $test_count -gt 0 ]]; then
        has_tests=true
    fi

    # --- Build row ---
    desc_status="✗ (${desc_word_count} words)"
    if [[ "$has_desc" == true ]]; then
        desc_status="✓ (${desc_word_count} words)"
    fi

    files_status="✗ (0 files)"
    if [[ "$has_files" == true ]]; then
        files_status="✓ (${file_count} files)"
    fi

    tests_status="✗ (0 tests)"
    if [[ "$has_tests" == true ]]; then
        tests_status="✓ (${test_count} tests)"
    fi

    task_status="PASS"
    if [[ "$has_desc" != true || "$has_files" != true || "$has_tests" != true ]]; then
        task_status="FAIL"
        NEEDS_REWORK=$((NEEDS_REWORK + 1))
    else
        WELL_DECOMPOSED=$((WELL_DECOMPOSED + 1))
    fi

    STRUCTURE_ROWS+=("| ${task_id} | ${desc_status} | ${files_status} | ${tests_status} | ${task_status} |")
done

TOTAL_TASKS=${#TASK_IDS[@]}

# ============================================================
# DEPENDENCY DAG VALIDATION
# ============================================================

# Extract dependencies for each task and build adjacency list.
# Detect cycles using iterative DFS with explicit stack tracking.

# Associative arrays for adjacency list
declare -A TASK_DEPS

for i in "${!TASK_IDS[@]}"; do
    task_id="${TASK_IDS[$i]}"
    block="${TASK_BLOCKS[$i]}"

    # Extract **Dependencies:** field
    deps_line=""
    while IFS= read -r bline; do
        if [[ "$bline" =~ ^\*\*Dependencies:\*\* ]]; then
            deps_line="${bline#*\*\*Dependencies:\*\*}"
            deps_line="$(echo "$deps_line" | sed 's/^[[:space:]]*//')"
            break
        fi
    done <<< "$block"

    # Parse T-XX references from deps_line
    dep_refs=""
    if [[ -n "$deps_line" && "$deps_line" != "None" && "$deps_line" != "none" ]]; then
        dep_refs="$(echo "$deps_line" | grep -oE 'T-[0-9]+' || true)"
    fi

    TASK_DEPS["$task_id"]="$dep_refs"
done

# DFS cycle detection
# States: 0=unvisited, 1=in-progress (on stack), 2=done
declare -A VISIT_STATE
for tid in "${TASK_IDS[@]}"; do
    VISIT_STATE["$tid"]=0
done

DAG_VALID=true
CYCLE_PATH=""

# Iterative DFS
dfs_check_cycle() {
    local start="$1"
    # Stack entries: "node:phase" where phase is "enter" or "exit"
    local stack=("${start}:enter")

    while [[ ${#stack[@]} -gt 0 ]]; do
        local entry="${stack[-1]}"
        unset 'stack[-1]'

        local node="${entry%%:*}"
        local phase="${entry##*:}"

        if [[ "$phase" == "exit" ]]; then
            VISIT_STATE["$node"]=2
            continue
        fi

        # Skip already-completed nodes
        if [[ "${VISIT_STATE[$node]}" -eq 2 ]]; then
            continue
        fi

        # Cycle detected: node is already in-progress
        if [[ "${VISIT_STATE[$node]}" -eq 1 ]]; then
            DAG_VALID=false
            CYCLE_PATH="$node"
            return
        fi

        VISIT_STATE["$node"]=1
        stack+=("${node}:exit")

        # Push dependencies onto stack
        local deps="${TASK_DEPS[$node]:-}"
        for dep in $deps; do
            # Only process deps that are known tasks
            if [[ -n "${VISIT_STATE[$dep]+x}" ]]; then
                if [[ "${VISIT_STATE[$dep]}" -eq 1 ]]; then
                    DAG_VALID=false
                    CYCLE_PATH="${node} → ${dep}"
                    return
                elif [[ "${VISIT_STATE[$dep]}" -eq 0 ]]; then
                    stack+=("${dep}:enter")
                fi
            fi
        done
    done
}

for tid in "${TASK_IDS[@]}"; do
    if [[ "${VISIT_STATE[$tid]}" -eq 0 ]]; then
        dfs_check_cycle "$tid"
        if [[ "$DAG_VALID" == false ]]; then
            break
        fi
    fi
done

# ============================================================
# PARALLEL SAFETY CHECK
# ============================================================

# Find tasks marked Parallelizable: Yes, extract their file targets,
# and check for overlapping files.

declare -A PARALLEL_TASK_FILES

for i in "${!TASK_IDS[@]}"; do
    task_id="${TASK_IDS[$i]}"
    block="${TASK_BLOCKS[$i]}"

    # Check if task is parallelizable
    is_parallel=false
    while IFS= read -r bline; do
        if [[ "$bline" =~ ^\*\*Parallelizable:\*\*[[:space:]]*[Yy]es ]]; then
            is_parallel=true
            break
        fi
    done <<< "$block"

    if [[ "$is_parallel" != true ]]; then
        continue
    fi

    # Extract file paths from backtick-quoted paths
    files=""
    while IFS= read -r bline; do
        if echo "$bline" | grep -qE '`[a-zA-Z0-9_./-]+\.[a-zA-Z]+`'; then
            matched="$(echo "$bline" | grep -oE '`[a-zA-Z0-9_./-]+\.[a-zA-Z]+`' | tr -d '`')"
            if [[ -n "$files" ]]; then
                files="${files} ${matched}"
            else
                files="$matched"
            fi
        fi
    done <<< "$block"

    PARALLEL_TASK_FILES["$task_id"]="$files"
done

PARALLEL_SAFE=true
CONFLICT_DETAILS=()

# Compare file lists between all pairs of parallel tasks
parallel_ids=("${!PARALLEL_TASK_FILES[@]}")
for ((a=0; a<${#parallel_ids[@]}; a++)); do
    for ((b=a+1; b<${#parallel_ids[@]}; b++)); do
        id_a="${parallel_ids[$a]}"
        id_b="${parallel_ids[$b]}"
        files_a="${PARALLEL_TASK_FILES[$id_a]}"
        files_b="${PARALLEL_TASK_FILES[$id_b]}"

        for fa in $files_a; do
            for fb in $files_b; do
                if [[ "$fa" == "$fb" ]]; then
                    PARALLEL_SAFE=false
                    CONFLICT_DETAILS+=("CONFLICT: ${id_a} and ${id_b} both modify \`${fa}\`")
                fi
            done
        done
    done
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Task Decomposition Report"
echo ""
echo "**Plan:** \`$PLAN_FILE\`"
echo ""

echo "### Task Structure"
echo ""
echo "| Task | Description | Files | Tests | Status |"
echo "|------|-------------|-------|-------|--------|"
for row in "${STRUCTURE_ROWS[@]}"; do
    echo "$row"
done
echo ""

echo "### Dependency Analysis"
if [[ "$DAG_VALID" == true ]]; then
    echo "- Dependency graph: valid DAG ✓"
else
    echo "- Dependency graph: CYCLE DETECTED: ${CYCLE_PATH}"
fi
echo ""

echo "### Parallel Safety"
if [[ "$PARALLEL_SAFE" == true ]]; then
    echo "- No file conflicts detected ✓"
else
    for conflict in "${CONFLICT_DETAILS[@]}"; do
        echo "- ${conflict}"
    done
fi
echo ""

echo "### Summary"
echo "- Well-decomposed: ${WELL_DECOMPOSED}/${TOTAL_TASKS} tasks"
echo "- Needs rework: ${NEEDS_REWORK}/${TOTAL_TASKS} tasks"
if [[ "$DAG_VALID" == true ]]; then
    echo "- Dependency: valid DAG"
else
    echo "- Dependency: CYCLE DETECTED"
fi
if [[ "$PARALLEL_SAFE" == true ]]; then
    echo "- Parallel safety: clean"
else
    echo "- Parallel safety: ${#CONFLICT_DETAILS[@]} conflict(s)"
fi
echo ""

# ============================================================
# EXIT CODE DETERMINATION
# ============================================================

if [[ $NEEDS_REWORK -gt 0 || "$DAG_VALID" == false || "$PARALLEL_SAFE" == false ]]; then
    echo "**Result: FAIL** — ${NEEDS_REWORK} tasks need rework"
    exit 1
else
    echo "**Result: PASS**"
    exit 0
fi
