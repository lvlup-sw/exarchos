#!/usr/bin/env bash
# Check Polish Scope
# Checks if polish scope has expanded beyond limits.
# Replaces "Scope Expansion Triggers" prose with deterministic validation.
#
# Usage: check-polish-scope.sh --repo-root <path> [--base-branch main]
#
# Exit codes:
#   0 = scope OK (stay polish)
#   1 = scope expanded (switch to overhaul)
#   2 = usage error (missing required args)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT=""
BASE_BRANCH="main"

usage() {
    cat << 'USAGE'
Usage: check-polish-scope.sh --repo-root <path> [--base-branch main]

Required:
  --repo-root <path>      Path to the git repository root

Optional:
  --base-branch <branch>  Base branch to diff against (default: main)
  --help                  Show this help message

Exit codes:
  0  Scope OK — within polish limits
  1  Scope expanded — switch to overhaul
  2  Usage error (missing required args)

Expansion triggers checked:
  - File count > 5 (modified files via git diff)
  - Module boundaries crossed (>2 top-level dirs modified)
  - New test files needed (impl files without test counterparts)
  - Architectural docs needed (detected heuristically)

  Note: Assumes co-located tests (foo.test.ts alongside foo.ts)
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --repo-root requires a path argument" >&2
                exit 2
            fi
            REPO_ROOT="$2"
            shift 2
            ;;
        --base-branch)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --base-branch requires a branch name" >&2
                exit 2
            fi
            BASE_BRANCH="$2"
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

if [[ -z "$REPO_ROOT" ]]; then
    echo "Error: --repo-root is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# DEPENDENCY CHECK
# ============================================================

if ! command -v git &>/dev/null; then
    echo "Error: git is required but not installed" >&2
    exit 2
fi

# ============================================================
# CHECK FUNCTIONS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
RESULTS=()
TRIGGERS_FIRED=()

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
# GET MODIFIED FILES
# ============================================================

cd "$REPO_ROOT"

# Get list of files modified compared to base branch
MODIFIED_FILES=()
while IFS= read -r line; do
    [[ -n "$line" ]] && MODIFIED_FILES+=("$line")
done < <(git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null || git diff --name-only "$BASE_BRANCH" HEAD 2>/dev/null || true)

FILE_COUNT=${#MODIFIED_FILES[@]}

# ============================================================
# TRIGGER 1: File count > 5
# ============================================================

if [[ $FILE_COUNT -le 5 ]]; then
    check_pass "File count within limit ($FILE_COUNT <= 5)"
else
    check_fail "File count exceeds limit" "$FILE_COUNT files modified (max 5)"
    TRIGGERS_FIRED+=("File count ($FILE_COUNT) exceeds limit of 5")
fi

# ============================================================
# TRIGGER 2: Module boundaries crossed (>2 top-level dirs)
# ============================================================

# Bash 3 compatible — no associative arrays
MODULE_LIST=""
for f in "${MODIFIED_FILES[@]}"; do
    top_dir="$(echo "$f" | cut -d'/' -f1)"
    if ! echo "$MODULE_LIST" | grep -qF "|$top_dir|"; then
        MODULE_LIST="${MODULE_LIST}|$top_dir|"
    fi
done
MODULE_COUNT=0
MODULE_NAMES=""
if [[ -n "$MODULE_LIST" ]]; then
    MODULE_NAMES="$(echo "$MODULE_LIST" | tr '|' '\n' | sort -u | grep -v '^$' | tr '\n' ' ')"
    MODULE_COUNT="$(echo "$MODULE_LIST" | tr '|' '\n' | sort -u | grep -vc '^$' || true)"
fi

if [[ $MODULE_COUNT -le 2 ]]; then
    check_pass "Module boundaries OK ($MODULE_COUNT top-level dirs)"
else
    check_fail "Module boundaries crossed" "$MODULE_COUNT top-level dirs: $MODULE_NAMES"
    TRIGGERS_FIRED+=("Module boundaries crossed ($MODULE_COUNT dirs: $MODULE_NAMES)")
fi

# ============================================================
# TRIGGER 3: New test files needed
# ============================================================

MISSING_TESTS=()
for f in "${MODIFIED_FILES[@]}"; do
    # Only check .ts implementation files
    if [[ "$f" == *.ts && "$f" != *.test.ts && "$f" != *.d.ts ]]; then
        test_file="${f%.ts}.test.ts"
        if [[ ! -f "$test_file" ]]; then
            MISSING_TESTS+=("$f")
        fi
    fi
done

if [[ -z "${MISSING_TESTS+x}" ]] || [[ ${#MISSING_TESTS[@]} -eq 0 ]]; then
    check_pass "Test coverage OK (all impl files have test counterparts)"
else
    check_fail "New test files needed" "${#MISSING_TESTS[@]} impl files without tests: ${MISSING_TESTS[*]}"
    TRIGGERS_FIRED+=("New test files needed for ${#MISSING_TESTS[@]} files")
fi

# ============================================================
# TRIGGER 4: Architectural docs needed (heuristic)
# ============================================================

NEEDS_ARCH_DOCS=false
for f in "${MODIFIED_FILES[@]}"; do
    # Heuristic: if modifying files in multiple top-level dirs with structural changes
    if [[ "$f" == *"index.ts" || "$f" == *"types.ts" || "$f" == *"interface"* ]]; then
        if [[ $MODULE_COUNT -gt 1 ]]; then
            NEEDS_ARCH_DOCS=true
            break
        fi
    fi
done

if [[ "$NEEDS_ARCH_DOCS" == false ]]; then
    check_pass "No architectural docs needed"
else
    check_fail "Architectural documentation likely needed" "Structural files modified across modules"
    TRIGGERS_FIRED+=("Architectural documentation needed")
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Polish Scope Check Report"
echo ""
echo "**Repository:** \`$REPO_ROOT\`"
echo "**Base branch:** $BASE_BRANCH"
echo "**Files modified:** $FILE_COUNT"
echo "**Modules touched:** $MODULE_COUNT (${MODULE_NAMES:-none})"
echo ""

for result in "${RESULTS[@]}"; do
    echo "$result"
done

echo ""
echo "---"
echo ""

if [[ -z "${TRIGGERS_FIRED+x}" ]] || [[ ${#TRIGGERS_FIRED[@]} -eq 0 ]]; then
    echo "**Result: SCOPE OK** — All within polish limits"
    exit 0
else
    echo "**Result: SCOPE EXPANDED** — Switch to overhaul track"
    echo ""
    echo "Triggers fired:"
    for trigger in "${TRIGGERS_FIRED[@]}"; do
        echo "  - $trigger"
    done
    exit 1
fi
