#!/usr/bin/env bash
# Generate Traceability Matrix
# Pre-populate traceability matrix from design and plan headers.
#
# Usage: generate-traceability.sh --design-file <path> --plan-file <path> [--output <path>]
#
# Exit codes:
#   0 = generated successfully
#   1 = parse error (no sections found)
#   2 = usage error (missing required args, missing files)

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
OUTPUT_FILE=""

usage() {
    cat << 'USAGE'
Usage: generate-traceability.sh --design-file <path> --plan-file <path> [--output <path>]

Required:
  --design-file <path>   Path to the design document markdown file
  --plan-file <path>     Path to the implementation plan markdown file

Optional:
  --output <path>        Write output to file instead of stdout
  --help                 Show this help message

Exit codes:
  0  Generated successfully
  1  Parse error (no sections found in design)
  2  Usage error (missing required args, missing files)
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
        --output)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --output requires a path argument" >&2
                exit 2
            fi
            OUTPUT_FILE="$2"
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
# EXTRACT DESIGN SECTIONS (## and ### headers)
# ============================================================

DESIGN_SECTIONS=()
DESIGN_LEVELS=()

while IFS= read -r line; do
    if [[ "$line" =~ ^(#{2,3})[[:space:]]+(.+) ]]; then
        level="${BASH_REMATCH[1]}"
        section_name="${BASH_REMATCH[2]}"
        section_name="$(echo "$section_name" | sed 's/[[:space:]]*$//')"
        DESIGN_SECTIONS+=("$section_name")
        DESIGN_LEVELS+=("$level")
    fi
done < "$DESIGN_FILE"

if [[ ${#DESIGN_SECTIONS[@]} -eq 0 ]]; then
    echo "Error: No ## or ### headers found in design document" >&2
    exit 1
fi

# ============================================================
# EXTRACT PLAN TASKS (### Task headers)
# ============================================================

PLAN_TASKS=()
PLAN_TASK_IDS=()

while IFS= read -r line; do
    if [[ "$line" =~ ^###[[:space:]]+Task[[:space:]]+([0-9]+) ]]; then
        task_id="${BASH_REMATCH[1]}"
        # Extract the full task title
        task_title="${line#*: }"
        if [[ -n "$task_title" && "$task_title" != "$line" ]]; then
            PLAN_TASKS+=("$task_title")
        else
            PLAN_TASKS+=("$line")
        fi
        PLAN_TASK_IDS+=("$task_id")
    fi
done < "$PLAN_FILE"

# Read full plan content for matching
PLAN_CONTENT="$(cat "$PLAN_FILE")"

# ============================================================
# GENERATE TRACEABILITY TABLE
# ============================================================

generate_table() {
    echo "## Spec Traceability"
    echo ""
    echo "### Traceability Matrix"
    echo ""
    echo "| Design Section | Key Requirements | Task ID(s) | Status |"
    echo "|----------------|-----------------|------------|--------|"

    for i in "${!DESIGN_SECTIONS[@]}"; do
        section="${DESIGN_SECTIONS[$i]}"
        level="${DESIGN_LEVELS[$i]}"

        # Find matching tasks
        matched_ids=()
        for j in "${!PLAN_TASKS[@]}"; do
            task="${PLAN_TASKS[$j]}"
            tid="${PLAN_TASK_IDS[$j]}"
            if echo "$task" | grep -qiF "$section"; then
                matched_ids+=("$tid")
            fi
        done

        # Also check plan body
        if [[ ${#matched_ids[@]} -eq 0 ]]; then
            if echo "$PLAN_CONTENT" | grep -qiF "$section"; then
                matched_ids+=("?")
            fi
        fi

        # Format output
        if [[ ${#matched_ids[@]} -gt 0 ]]; then
            ids="$(printf '%s, ' "${matched_ids[@]}")"
            ids="${ids%, }"
            echo "| $section | (to be filled) | $ids | Covered |"
        else
            echo "| $section | (to be filled) | — | Uncovered |"
        fi
    done
    echo ""
    echo "### Scope Declaration"
    echo ""
    echo "**Target:** (to be filled)"
    echo "**Excluded:** (to be filled)"
}

# ============================================================
# OUTPUT
# ============================================================

if [[ -n "$OUTPUT_FILE" ]]; then
    generate_table > "$OUTPUT_FILE"
    echo "Traceability matrix written to: $OUTPUT_FILE"
else
    generate_table
fi

exit 0
