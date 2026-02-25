#!/usr/bin/env bash
# Validate Phase Coverage
# Ensures playbook registry covers all HSM phases and all scripts are wired.
#
# Usage: validate-phase-coverage.sh --playbook-json <path> --phases-json <path> --scripts-dir <path>
#
# Exit codes:
#   0 = all covered
#   1 = gaps found
#   2 = usage error
set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

PLAYBOOK_JSON=""
PHASES_JSON=""
SCRIPTS_DIR=""

usage() {
    cat << 'USAGE'
Usage: validate-phase-coverage.sh --playbook-json <path> --phases-json <path> --scripts-dir <path>

Required:
  --playbook-json <path>   Path to playbook registry JSON
  --phases-json <path>     Path to canonical phases JSON (workflowType -> phase[])
  --scripts-dir <path>     Directory containing validation scripts

Exit codes:
  0  All phases covered, all scripts wired
  1  Gaps found
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --playbook-json)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --playbook-json requires a path argument" >&2
                exit 2
            fi
            PLAYBOOK_JSON="$2"
            shift 2
            ;;
        --phases-json)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --phases-json requires a path argument" >&2
                exit 2
            fi
            PHASES_JSON="$2"
            shift 2
            ;;
        --scripts-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --scripts-dir requires a path argument" >&2
                exit 2
            fi
            SCRIPTS_DIR="$2"
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

if [[ -z "$PLAYBOOK_JSON" || -z "$PHASES_JSON" || -z "$SCRIPTS_DIR" ]]; then
    echo "Error: --playbook-json, --phases-json, and --scripts-dir are required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# INPUT EXISTENCE CHECKS
# ============================================================

if [[ ! -f "$PLAYBOOK_JSON" ]]; then
    echo "Error: playbook JSON not found: '$PLAYBOOK_JSON'" >&2
    exit 2
fi
if [[ ! -f "$PHASES_JSON" ]]; then
    echo "Error: phases JSON not found: '$PHASES_JSON'" >&2
    exit 2
fi
if [[ ! -d "$SCRIPTS_DIR" ]]; then
    echo "Error: scripts directory not found: '$SCRIPTS_DIR'" >&2
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
# VALIDATION
# ============================================================

ERRORS=()

# Check 1: Every phase in phases.json has a matching key in playbooks.json
#   Key format: "workflowType:phase"
workflow_types="$(jq -r 'keys[]' "$PHASES_JSON")"
while IFS= read -r wt; do
    [[ -z "$wt" ]] && continue
    phases="$(jq -r --arg wt "$wt" '.[$wt][]' "$PHASES_JSON")"
    while IFS= read -r phase; do
        [[ -z "$phase" ]] && continue
        key="${wt}:${phase}"
        has_key="$(jq -r --arg k "$key" 'has($k)' "$PLAYBOOK_JSON")"
        if [[ "$has_key" != "true" ]]; then
            ERRORS+=("Missing playbook entry for phase '$phase' in workflow '$wt' (expected key: '$key')")
        fi
    done <<< "$phases"
done <<< "$workflow_types"

# Check 2: Every validationScripts entry resolves to an existing file
#   Scripts are relative paths, resolve relative to scripts-dir parent
scripts_dir_parent="$(dirname "$SCRIPTS_DIR")"
referenced_scripts=()
all_script_refs="$(jq -r '.[].validationScripts[]?' "$PLAYBOOK_JSON" | sort -u)"
while IFS= read -r script_ref; do
    [[ -z "$script_ref" ]] && continue
    referenced_scripts+=("$script_ref")
    resolved_path="$scripts_dir_parent/$script_ref"
    if [[ ! -f "$resolved_path" ]]; then
        ERRORS+=("Playbook references script '$script_ref' but file not found at '$resolved_path'")
    fi
done <<< "$all_script_refs"

# Check 3: Every *.sh in scripts-dir is referenced by at least one playbook
#   Exclude known utility scripts and test files
EXCLUDED_SCRIPTS=(
    "validate-phase-coverage.sh"
    "setup-worktree.sh"
    "verify-worktree.sh"
    "review-diff.sh"
    "new-project.sh"
    "validate-frontmatter.sh"
)

for script_file in "$SCRIPTS_DIR"/*.sh; do
    [[ ! -f "$script_file" ]] && continue
    script_name="$(basename "$script_file")"

    # Skip test files
    if [[ "$script_name" == *.test.sh ]]; then
        continue
    fi

    # Skip excluded utility scripts
    skip=false
    for excluded in "${EXCLUDED_SCRIPTS[@]}"; do
        if [[ "$script_name" == "$excluded" ]]; then
            skip=true
            break
        fi
    done
    [[ "$skip" == true ]] && continue

    # Check if this script is referenced in any playbook validationScripts
    # The reference format is "scripts/<name>"
    script_ref="$(basename "$SCRIPTS_DIR")/$script_name"
    found=false
    for ref in "${referenced_scripts[@]+"${referenced_scripts[@]}"}"; do
        if [[ "$ref" == "$script_ref" ]]; then
            found=true
            break
        fi
    done

    if [[ "$found" != true ]]; then
        ERRORS+=("Script '$script_name' in scripts-dir is not referenced by any playbook (unreferenced/orphaned)")
    fi
done

# ============================================================
# OUTPUT
# ============================================================

echo "## Phase Coverage Report"
echo ""

if [[ ${#ERRORS[@]} -eq 0 ]]; then
    echo "All phases covered. All scripts wired."
    echo ""
    echo "**Result: PASS**"
    exit 0
else
    echo "**Issues found: ${#ERRORS[@]}**"
    echo ""
    for err in "${ERRORS[@]}"; do
        echo "- $err"
    done
    echo ""
    echo "**Result: FAIL**"
    exit 1
fi
