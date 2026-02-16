#!/usr/bin/env bash
# Verify Ideate Artifacts
# Checks brainstorming/ideation completion by validating design document existence,
# required sections, option evaluation, and state file consistency.
#
# Usage: verify-ideate-artifacts.sh --state-file <path> [--docs-dir <path>] [--design-file <path>]
#
# Exit codes:
#   0 = all checks pass (ideation complete)
#   1 = one or more checks failed (missing sections or artifacts)
#   2 = usage error (missing required args)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

STATE_FILE=""
DOCS_DIR=""
DESIGN_FILE=""

usage() {
    cat << 'USAGE'
Usage: verify-ideate-artifacts.sh --state-file <path> [--docs-dir <path>] [--design-file <path>]

Required:
  --state-file <path>    Path to the workflow state JSON file

Optional:
  --docs-dir <path>      Directory to search for design documents (e.g., docs/designs)
  --design-file <path>   Direct path to the design document (overrides --docs-dir)
  --help                 Show this help message

Exit codes:
  0  All completion criteria met
  1  Missing artifacts or sections
  2  Usage error (missing required args)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --state-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --state-file requires a path argument" >&2
                exit 2
            fi
            STATE_FILE="$2"
            shift 2
            ;;
        --docs-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --docs-dir requires a path argument" >&2
                exit 2
            fi
            DOCS_DIR="$2"
            shift 2
            ;;
        --design-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --design-file requires a path argument" >&2
                exit 2
            fi
            DESIGN_FILE="$2"
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

if [[ -z "$STATE_FILE" ]]; then
    echo "Error: --state-file is required" >&2
    usage >&2
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
# CHECK FUNCTIONS
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

# ============================================================
# RESOLVE DESIGN FILE
# ============================================================

resolve_design_file() {
    # If --design-file was given, use it directly
    if [[ -n "$DESIGN_FILE" ]]; then
        if [[ -f "$DESIGN_FILE" ]]; then
            return 0
        else
            check_fail "Design document exists" "File not found: $DESIGN_FILE"
            return 1
        fi
    fi

    # Try to get design path from state file
    if [[ -f "$STATE_FILE" ]] && jq empty "$STATE_FILE" 2>/dev/null; then
        local state_design_path
        state_design_path="$(jq -r '.artifacts.design // empty' "$STATE_FILE")"
        if [[ -n "$state_design_path" && -f "$state_design_path" ]]; then
            DESIGN_FILE="$state_design_path"
            return 0
        fi
    fi

    # Search in docs dir for YYYY-MM-DD-*.md pattern
    if [[ -n "$DOCS_DIR" && -d "$DOCS_DIR" ]]; then
        local found_files
        found_files="$(find "$DOCS_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*.md' -type f 2>/dev/null | sort -r | head -1)"
        if [[ -n "$found_files" ]]; then
            DESIGN_FILE="$found_files"
            return 0
        fi
    fi

    check_fail "Design document exists" "No design document found in ${DOCS_DIR:-<no docs-dir>}"
    return 1
}

# ============================================================
# CHECK 1: Design document exists
# ============================================================

check_design_exists() {
    if resolve_design_file; then
        check_pass "Design document exists ($DESIGN_FILE)"
        return 0
    fi
    return 1
}

# ============================================================
# CHECK 2: Required sections present
# ============================================================

REQUIRED_SECTIONS=(
    "Problem Statement"
    "Chosen Approach"
    "Technical Design"
    "Integration Points"
    "Testing Strategy"
    "Open Questions"
)

check_required_sections() {
    local missing=()
    local content
    content="$(cat "$DESIGN_FILE")"

    for section in "${REQUIRED_SECTIONS[@]}"; do
        if ! echo "$content" | grep -qi "##.*$section"; then
            missing+=("$section")
        fi
    done

    if [[ ${#missing[@]} -eq 0 ]]; then
        check_pass "Required sections present (${#REQUIRED_SECTIONS[@]}/${#REQUIRED_SECTIONS[@]})"
        return 0
    else
        local missing_list
        missing_list="$(IFS=', '; echo "${missing[*]}")"
        check_fail "Required sections present" "Missing: $missing_list"
        return 1
    fi
}

# ============================================================
# CHECK 3: Multiple options evaluated (2-3)
# ============================================================

check_multiple_options() {
    local content
    content="$(cat "$DESIGN_FILE")"

    # Count "Option N" or "Option [N]" patterns in headings
    local option_count
    option_count="$(echo "$content" | grep -ciE '#+\s*(option\s+[0-9]|option\s+\[?[0-9])' || true)"

    if [[ "$option_count" -ge 2 ]]; then
        check_pass "Multiple options evaluated ($option_count options found)"
        return 0
    else
        check_fail "Multiple options evaluated" "Found $option_count option(s), expected at least 2"
        return 1
    fi
}

# ============================================================
# CHECK 4: State file has design path recorded
# ============================================================

check_state_design_path() {
    if [[ ! -f "$STATE_FILE" ]]; then
        check_fail "State file has design path" "State file not found: $STATE_FILE"
        return 1
    fi

    if ! jq empty "$STATE_FILE" 2>/dev/null; then
        check_fail "State file has design path" "Invalid JSON: $STATE_FILE"
        return 1
    fi

    local design_path
    design_path="$(jq -r '.artifacts.design // empty' "$STATE_FILE")"

    if [[ -n "$design_path" ]]; then
        check_pass "State file has design path ($design_path)"
        return 0
    else
        check_fail "State file has design path" "artifacts.design is empty or missing"
        return 1
    fi
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

if check_design_exists; then
    check_required_sections || true
    check_multiple_options || true
fi

check_state_design_path || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Ideation Artifact Verification Report"
echo ""
echo "**State file:** \`$STATE_FILE\`"
if [[ -n "$DESIGN_FILE" ]]; then
    echo "**Design file:** \`$DESIGN_FILE\`"
fi
echo ""

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL checks passed)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL checks failed)"
    exit 1
fi
