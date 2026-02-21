#!/usr/bin/env bash
# check-property-tests.sh
# Verifies that tasks requiring property-based tests have PBT patterns in the implementation.
# Exit 0 = pass, 1 = fail (missing PBT), 2 = usage error

set -euo pipefail

# ─── Usage ──────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: check-property-tests.sh --plan-file <path> --worktree-dir <path>

Verifies that plan tasks with propertyTests: true have property-based test
patterns in the worktree.

Arguments:
  --plan-file      Path to plan JSON file containing tasks with testingStrategy
  --worktree-dir   Path to the worktree directory to scan for PBT patterns

Exit Codes:
  0  All PBT-required tasks have property test patterns
  1  One or more PBT-required tasks lack property test patterns
  2  Usage error (missing arguments)
EOF
}

# ─── Arg Parsing ────────────────────────────────────────────────────────────

PLAN_FILE=""
WORKTREE_DIR=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --plan-file)
            PLAN_FILE="${2:-}"
            shift 2 || { echo "Error: --plan-file requires a value" >&2; exit 2; }
            ;;
        --worktree-dir)
            WORKTREE_DIR="${2:-}"
            shift 2 || { echo "Error: --worktree-dir requires a value" >&2; exit 2; }
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [[ -z "$PLAN_FILE" || -z "$WORKTREE_DIR" ]]; then
    echo "Error: Both --plan-file and --worktree-dir are required." >&2
    usage >&2
    exit 2
fi

if [[ ! -f "$PLAN_FILE" ]]; then
    echo "Error: Plan file not found: $PLAN_FILE" >&2
    exit 2
fi

if [[ ! -d "$WORKTREE_DIR" ]]; then
    echo "Error: Worktree directory not found: $WORKTREE_DIR" >&2
    exit 2
fi

# ─── Plan JSON Extraction ──────────────────────────────────────────────────

# Extract task IDs where testingStrategy.propertyTests is true
PBT_TASK_IDS=()
while IFS= read -r task_id; do
    [[ -n "$task_id" ]] && PBT_TASK_IDS+=("$task_id")
done < <(
    # Use python3 for reliable JSON parsing (available on macOS and most Linux)
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    plan = json.load(f)
for task in plan.get('tasks', []):
    strategy = task.get('testingStrategy', {})
    if strategy.get('propertyTests', False):
        print(task.get('id', ''))
" "$PLAN_FILE" 2>/dev/null
)

if [[ -z "${PBT_TASK_IDS+x}" ]] || [[ ${#PBT_TASK_IDS[@]} -eq 0 ]]; then
    echo "## PBT Check: PASS"
    echo "No tasks require property-based tests."
    exit 0
fi

echo "## PBT Check"
echo "Tasks requiring property-based tests: ${PBT_TASK_IDS[*]}"
echo ""

# ─── PBT Pattern Detection ─────────────────────────────────────────────────

# TypeScript patterns: fast-check library usage
TS_PBT_PATTERN="fc\.property|fc\.assert|it\.prop|test\.prop|from 'fast-check'|from \"fast-check\"|@fast-check"

# .NET patterns: FsCheck library usage
DOTNET_PBT_PATTERN="Prop\.ForAll|using FsCheck|\[Property\]"

# Combined pattern
COMBINED_PATTERN="$TS_PBT_PATTERN|$DOTNET_PBT_PATTERN"

# Find all test files with PBT patterns
PBT_FILES=()
while IFS= read -r file; do
    [[ -n "$file" ]] && PBT_FILES+=("$file")
done < <(
    grep -rlE "$COMBINED_PATTERN" "$WORKTREE_DIR" \
        --include="*.test.ts" \
        --include="*.test.tsx" \
        --include="*.spec.ts" \
        --include="*.Tests.cs" \
        --include="*Tests.cs" \
        --include="*.test.js" \
        2>/dev/null || true
)

# ─── Cross-Reference ───────────────────────────────────────────────────────

HAS_PBT=false
if [[ -n "${PBT_FILES+x}" ]] && [[ ${#PBT_FILES[@]} -gt 0 ]]; then
    HAS_PBT=true
    echo "Found PBT patterns in:"
    for f in "${PBT_FILES[@]}"; do
        echo "  - $f"
    done
    echo ""
fi

# For each PBT-required task, check if any PBT file exists in the worktree
UNCOVERED_TASKS=()
if [[ "$HAS_PBT" == "true" ]]; then
    # If any PBT patterns exist in the worktree, consider all tasks covered
    # (task-to-file mapping is coarse-grained; presence of PBT patterns is the gate)
    echo "All PBT-required tasks have coverage."
else
    # No PBT patterns found at all
    for task_id in "${PBT_TASK_IDS[@]}"; do
        UNCOVERED_TASKS+=("$task_id")
    done
fi

# ─── Result ─────────────────────────────────────────────────────────────────

if [[ -n "${UNCOVERED_TASKS+x}" ]] && [[ ${#UNCOVERED_TASKS[@]} -gt 0 ]]; then
    echo "## PBT Check: FAIL"
    echo ""
    echo "The following tasks require property-based tests but none were found:"
    for task_id in "${UNCOVERED_TASKS[@]}"; do
        echo "  - $task_id"
    done
    echo ""
    echo "Expected patterns (TypeScript): fc.property, fc.assert, it.prop, test.prop, from 'fast-check'"
    echo "Expected patterns (.NET): Prop.ForAll, using FsCheck, [Property]"
    exit 1
else
    echo "## PBT Check: PASS"
    exit 0
fi
