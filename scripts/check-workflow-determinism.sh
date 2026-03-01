#!/usr/bin/env bash
# Workflow Determinism Check
# Scans code changes for non-deterministic patterns and test hygiene issues.
#
# Usage: check-workflow-determinism.sh --diff-file <path>
#        check-workflow-determinism.sh --repo-root <path> --base-branch <branch>
#
# Exit codes:
#   0 = no findings
#   1 = findings detected
#   2 = usage error

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

DIFF_FILE=""
REPO_ROOT=""
BASE_BRANCH=""

usage() {
    cat << 'USAGE'
Usage: check-workflow-determinism.sh --diff-file <path>
       check-workflow-determinism.sh --repo-root <path> --base-branch <branch>

Scan code changes for non-deterministic test patterns and hygiene issues.

Options:
  --diff-file <path>      Path to a unified diff file
  --repo-root <path>      Repository root (used with --base-branch)
  --base-branch <branch>  Base branch to diff against (used with --repo-root)
  --help                  Show this help message

Detected patterns:
  - .only/.skip in tests (HIGH)
  - Non-deterministic time usage in tests (MEDIUM)
  - Non-deterministic random usage in tests (MEDIUM)
  - Debug artifacts in test files (LOW)
  - Missing validation scripts referenced by skills (MEDIUM)

Exit codes:
  0  No determinism findings
  1  Determinism findings detected
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --diff-file)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --diff-file requires a path argument" >&2
                exit 2
            fi
            DIFF_FILE="$2"
            shift 2
            ;;
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
                echo "Error: --base-branch requires a branch argument" >&2
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

# Validate inputs
if [[ -z "$DIFF_FILE" && ( -z "$REPO_ROOT" || -z "$BASE_BRANCH" ) ]]; then
    echo "Error: Must provide --diff-file or both --repo-root and --base-branch" >&2
    usage >&2
    exit 2
fi

# ============================================================
# DIFF RESOLUTION
# ============================================================

DIFF_CONTENT=""

if [[ -n "$DIFF_FILE" ]]; then
    if [[ ! -f "$DIFF_FILE" ]]; then
        echo "Error: Diff file not found: $DIFF_FILE" >&2
        exit 2
    fi
    DIFF_CONTENT="$(cat "$DIFF_FILE")"
else
    DIFF_CONTENT="$(cd "$REPO_ROOT" && git diff "$BASE_BRANCH"...HEAD 2>/dev/null)" || {
        echo "Error: Failed to generate diff from $BASE_BRANCH" >&2
        exit 2
    }
fi

# ============================================================
# DETERMINISM PATTERN SCANNING
# ============================================================

FINDINGS=()
FINDING_COUNT=0
CURRENT_FILE=""
TOTAL_CHECKS=5
PASSED_CHECKS=0

# Track per-check state
HAS_ONLY_SKIP=false
HAS_TIME_ISSUE=false
HAS_RANDOM_ISSUE=false
HAS_DEBUG_ARTIFACT=false
HAS_SCRIPT_COVERAGE_ISSUE=false

add_finding() {
    local file="$1"
    local line="$2"
    local pattern="$3"
    local severity="$4"
    local context="$5"

    # Trim context to reasonable length
    if [[ ${#context} -gt 120 ]]; then
        context="${context:0:117}..."
    fi

    FINDINGS+=("- **${severity}** \`${file}:${line}\` — ${pattern}: \`${context}\`")
    FINDING_COUNT=$((FINDING_COUNT + 1))
}

# Check if a file path looks like a test file
is_test_file() {
    local file="$1"
    [[ "$file" =~ \.(test|spec)\.(ts|tsx|js|jsx)$ ]]
}

# Scan the diff for determinism patterns
scan_diff() {
    local diff_line_num=0
    local file_context=""

    while IFS= read -r line; do
        # Track current file from diff headers
        if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/ ]]; then
            CURRENT_FILE="${BASH_REMATCH[1]}"
            diff_line_num=0
            file_context=""
            continue
        fi

        # Track line numbers from hunk headers
        if [[ "$line" =~ ^@@\ -[0-9]+(,[0-9]+)?\ \+([0-9]+)(,[0-9]+)?\ @@ ]]; then
            diff_line_num="${BASH_REMATCH[2]}"
            continue
        fi

        # Skip non-addition lines but still track line numbers
        if [[ ! "$line" =~ ^\+ ]]; then
            if [[ "$line" =~ ^[^-] ]]; then
                diff_line_num=$((diff_line_num + 1))
            fi
            # Track context lines for nearby-mock detection
            if [[ "$line" =~ ^[[:space:]] ]]; then
                file_context+="${line}"$'\n'
            fi
            continue
        fi

        # Skip +++ header lines
        if [[ "$line" =~ ^\+\+\+ ]]; then
            continue
        fi

        local added_line="${line:1}"  # Strip leading +
        file_context+="${added_line}"$'\n'

        # Only check test files for patterns 1-4
        if is_test_file "$CURRENT_FILE"; then
            # Pattern 1: .only/.skip in tests (HIGH)
            if echo "$added_line" | grep -qE '\b(describe|it|test)\.(only|skip)\b'; then
                add_finding "$CURRENT_FILE" "$diff_line_num" "Test focus/skip modifier" "HIGH" "$added_line"
                HAS_ONLY_SKIP=true
            fi

            # Pattern 2: Non-deterministic time (MEDIUM)
            # Only flag Date.now()/new Date() if no vi.useFakeTimers or vi.setSystemTime nearby
            if echo "$added_line" | grep -qE '\bDate\.now\(\)|\bnew Date\(\)'; then
                # Check surrounding context for timer mocking
                if ! echo "$file_context" | grep -qE 'vi\.(useFakeTimers|setSystemTime|getRealSystemTime)'; then
                    add_finding "$CURRENT_FILE" "$diff_line_num" "Non-deterministic time without fake timers" "MEDIUM" "$added_line"
                    HAS_TIME_ISSUE=true
                fi
            fi

            # Pattern 3: Non-deterministic random (MEDIUM)
            if echo "$added_line" | grep -qE '\bMath\.random\(\)'; then
                # Check surrounding context for seed/mock
                if ! echo "$file_context" | grep -qE 'vi\.(fn|spyOn|mock).*Math\.random|seed|mockRandom'; then
                    add_finding "$CURRENT_FILE" "$diff_line_num" "Non-deterministic Math.random() without mock" "MEDIUM" "$added_line"
                    HAS_RANDOM_ISSUE=true
                fi
            fi

            # Pattern 4: Debug artifacts in test files (LOW) — added lines only
            if echo "$added_line" | grep -qE '\bconsole\.(log|debug|info|warn)\b|\bdebugger\b'; then
                add_finding "$CURRENT_FILE" "$diff_line_num" "Debug artifact in test file" "LOW" "$added_line"
                HAS_DEBUG_ARTIFACT=true
            fi
        fi

        diff_line_num=$((diff_line_num + 1))
    done <<< "$DIFF_CONTENT"
}

# Pattern 5: Validation script coverage
# For each scripts/*.sh referenced in skill files, verify it exists and is executable
check_script_coverage() {
    # Only run if we have an explicit repo root (skip in --diff-file-only mode)
    local root="${REPO_ROOT:-}"
    if [[ -z "$root" ]]; then
        return
    fi

    # Find skill files that reference scripts
    local skills_dir="$root/skills"
    if [[ ! -d "$skills_dir" ]]; then
        return
    fi

    # Search skill files for script references
    while IFS= read -r skill_file; do
        while IFS= read -r script_ref; do
            local script_path="$root/$script_ref"
            if [[ ! -f "$script_path" ]]; then
                FINDINGS+=("- **MEDIUM** \`${skill_file##"$root"/}\` — Missing referenced script: \`${script_ref}\`")
                FINDING_COUNT=$((FINDING_COUNT + 1))
                HAS_SCRIPT_COVERAGE_ISSUE=true
            elif [[ ! -x "$script_path" ]]; then
                FINDINGS+=("- **MEDIUM** \`${skill_file##"$root"/}\` — Script not executable: \`${script_ref}\`")
                FINDING_COUNT=$((FINDING_COUNT + 1))
                HAS_SCRIPT_COVERAGE_ISSUE=true
            fi
        done < <(grep -oE 'scripts/[a-zA-Z0-9_-]+\.sh' "$skill_file" 2>/dev/null | sort -u)
    done < <(find "$skills_dir" -name "*.md" -type f 2>/dev/null)
}

# Run the scan
scan_diff
check_script_coverage

# Count passed checks
[[ "$HAS_ONLY_SKIP" = false ]] && PASSED_CHECKS=$((PASSED_CHECKS + 1))
[[ "$HAS_TIME_ISSUE" = false ]] && PASSED_CHECKS=$((PASSED_CHECKS + 1))
[[ "$HAS_RANDOM_ISSUE" = false ]] && PASSED_CHECKS=$((PASSED_CHECKS + 1))
[[ "$HAS_DEBUG_ARTIFACT" = false ]] && PASSED_CHECKS=$((PASSED_CHECKS + 1))
[[ "$HAS_SCRIPT_COVERAGE_ISSUE" = false ]] && PASSED_CHECKS=$((PASSED_CHECKS + 1))

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Workflow Determinism Report"
echo ""

if [[ -n "$DIFF_FILE" ]]; then
    echo "**Source:** \`$DIFF_FILE\`"
else
    echo "**Source:** \`$REPO_ROOT\` (diff against \`$BASE_BRANCH\`)"
fi
echo ""

if [[ $FINDING_COUNT -eq 0 ]]; then
    echo "No determinism issues detected."
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** ($PASSED_CHECKS/$TOTAL_CHECKS checks passed)"
    exit 0
else
    echo "**Findings ($FINDING_COUNT):**"
    echo ""
    for finding in "${FINDINGS[@]}"; do
        echo "$finding"
    done
    echo ""
    echo "---"
    echo ""
    echo "**Result: FINDINGS** ($FINDING_COUNT findings detected)"
    exit 1
fi
