#!/usr/bin/env bash
# Check Context Economy (T-20)
# Scans code changes for context-economy concerns: oversized files, long functions,
# wide diffs, and large generated files.
#
# Usage: check-context-economy.sh --diff-file <path>
#        check-context-economy.sh --repo-root <path> --base-branch <branch>
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
Usage: check-context-economy.sh --diff-file <path>
       check-context-economy.sh --repo-root <path> --base-branch <branch>

Check code changes for complexity that impacts LLM context consumption.

Options:
  --diff-file <path>      Path to a unified diff file
  --repo-root <path>      Repository root (used with --base-branch)
  --base-branch <branch>  Base branch to diff against (used with --repo-root)
  --help                  Show this help message

Checks:
  - Source file length (>400 lines)          MEDIUM
  - Function/method length (>80 lines)       MEDIUM
  - Diff breadth (>30 files changed)         MEDIUM
  - Large generated files (>1000 lines)      LOW

Exit codes:
  0  No context-economy findings
  1  Context-economy findings detected
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
CHANGED_FILES=""

if [[ -n "$DIFF_FILE" ]]; then
    if [[ ! -f "$DIFF_FILE" ]]; then
        echo "Error: Diff file not found: $DIFF_FILE" >&2
        exit 2
    fi
    DIFF_CONTENT="$(cat "$DIFF_FILE")"
    # Extract file names from the diff
    CHANGED_FILES="$(echo "$DIFF_CONTENT" | grep -oP '^diff --git a/\K[^ ]+' || true)"
else
    if [[ ! -d "$REPO_ROOT/.git" ]]; then
        echo "Error: Not a git repository: $REPO_ROOT" >&2
        exit 2
    fi
    CHANGED_FILES=$(cd "$REPO_ROOT" && git diff --name-only "$BASE_BRANCH"...HEAD 2>/dev/null) || {
        echo "Error: Failed to generate diff from $BASE_BRANCH" >&2
        exit 2
    }
    DIFF_CONTENT="$(cd "$REPO_ROOT" && git diff "$BASE_BRANCH"...HEAD 2>/dev/null)" || true
fi

# ============================================================
# CHECKS
# ============================================================

FINDINGS=()
FINDING_COUNT=0
CHECKS_PASSED=0
TOTAL_CHECKS=4

add_finding() {
    local severity="$1"
    local message="$2"
    FINDINGS+=("- **${severity}** ${message}")
    FINDING_COUNT=$((FINDING_COUNT + 1))
}

# ----------------------------------------------------------
# Check 1: Source file length (>400 lines for .ts/.js files)
# ----------------------------------------------------------

check_source_file_length() {
    local has_finding=false

    if [[ -n "$REPO_ROOT" ]]; then
        # repo-root mode: check actual file sizes
        while IFS= read -r file; do
            [[ -z "$file" ]] && continue
            case "$file" in
                *.ts|*.js) ;;
                *) continue ;;
            esac
            local_path="$REPO_ROOT/$file"
            [[ -f "$local_path" ]] || continue

            line_count=$(wc -l < "$local_path")
            if [[ "$line_count" -gt 400 ]]; then
                add_finding "MEDIUM" "\`$file\` — Source file exceeds 400 lines ($line_count lines)"
                has_finding=true
            fi
        done <<< "$CHANGED_FILES"
    else
        # diff-file mode: count added lines per .ts/.js file as proxy
        local current_file=""
        local added_lines=0

        while IFS= read -r line; do
            if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/ ]]; then
                # Emit finding for previous file if applicable
                if [[ -n "$current_file" && "$added_lines" -gt 400 ]]; then
                    case "$current_file" in
                        *.ts|*.js)
                            add_finding "MEDIUM" "\`$current_file\` — Source file exceeds 400 lines ($added_lines added lines)"
                            has_finding=true
                            ;;
                    esac
                fi
                current_file="${BASH_REMATCH[1]}"
                added_lines=0
            fi
            if [[ "$line" =~ ^\+[^+] ]]; then
                added_lines=$((added_lines + 1))
            fi
        done <<< "$DIFF_CONTENT"
        # Check last file
        if [[ -n "$current_file" && "$added_lines" -gt 400 ]]; then
            case "$current_file" in
                *.ts|*.js)
                    add_finding "MEDIUM" "\`$current_file\` — Source file exceeds 400 lines ($added_lines added lines)"
                    has_finding=true
                    ;;
            esac
        fi
    fi

    if [[ "$has_finding" == "false" ]]; then
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
}

# ----------------------------------------------------------
# Check 2: Function/method length (>80 lines)
# ----------------------------------------------------------

check_function_length() {
    local has_finding=false

    # Only works in --repo-root mode (need actual files for brace analysis)
    if [[ -z "$REPO_ROOT" ]]; then
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
        return
    fi

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        case "$file" in
            *.ts|*.js) ;;
            *) continue ;;
        esac
        local_path="$REPO_ROOT/$file"
        [[ -f "$local_path" ]] || continue

        # Find function/method signatures and measure distance between them
        func_lines=$(grep -nE '^\s*(export\s+)?(async\s+)?function\s|^\s*(public|private|protected|static|async)\s.*\(|^\s*\w+\s*[:=]\s*(async\s+)?\(' "$local_path" 2>/dev/null | cut -d: -f1 || true)

        if [[ -z "$func_lines" ]]; then
            continue
        fi

        total_lines=$(wc -l < "$local_path")
        prev_line=0

        while IFS= read -r func_line; do
            if [[ "$prev_line" -gt 0 ]]; then
                span=$((func_line - prev_line))
                if [[ "$span" -gt 80 ]]; then
                    add_finding "MEDIUM" "\`$file\` — Function/method exceeds 80 lines (~${span} lines starting at line $prev_line)"
                    has_finding=true
                    break  # Report once per file
                fi
            fi
            prev_line="$func_line"
        done <<< "$func_lines"

        # Check last function to end of file
        if [[ "$prev_line" -gt 0 ]]; then
            span=$((total_lines - prev_line))
            if [[ "$span" -gt 80 ]]; then
                # Only add if we haven't already reported for this file
                local already_reported=false
                for f in "${FINDINGS[@]+"${FINDINGS[@]}"}"; do
                    if echo "$f" | grep -qF "$file" && echo "$f" | grep -qF "Function/method"; then
                        already_reported=true
                        break
                    fi
                done
                if [[ "$already_reported" == false ]]; then
                    add_finding "MEDIUM" "\`$file\` — Function/method exceeds 80 lines (~${span} lines starting at line $prev_line)"
                    has_finding=true
                fi
            fi
        fi
    done <<< "$CHANGED_FILES"

    if [[ "$has_finding" == "false" ]]; then
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
}

# ----------------------------------------------------------
# Check 3: Diff breadth (>30 files changed)
# ----------------------------------------------------------

check_diff_breadth() {
    local file_count=0

    while IFS= read -r file; do
        [[ -z "$file" ]] && continue
        file_count=$((file_count + 1))
    done <<< "$CHANGED_FILES"

    if [[ "$file_count" -gt 30 ]]; then
        add_finding "MEDIUM" "Diff breadth: $file_count files changed (threshold: 30)"
    else
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
}

# ----------------------------------------------------------
# Check 4: Large generated files (>1000 lines with markers)
# ----------------------------------------------------------

check_large_generated_files() {
    local has_finding=false

    if [[ -n "$REPO_ROOT" ]]; then
        # repo-root mode: check actual files
        while IFS= read -r file; do
            [[ -z "$file" ]] && continue
            local_path="$REPO_ROOT/$file"
            [[ -f "$local_path" ]] || continue

            line_count=$(wc -l < "$local_path")
            if [[ "$line_count" -gt 1000 ]]; then
                # Check for auto-generated markers in first 20 lines
                if head -20 "$local_path" | grep -qiE '@generated|AUTO-GENERATED|eslint-disable|auto[- ]?generated|do not edit|generated by|this file is generated|machine generated' 2>/dev/null; then
                    add_finding "LOW" "\`$file\` — Large generated file ($line_count lines) with auto-generated marker"
                    has_finding=true
                fi
            fi
        done <<< "$CHANGED_FILES"
    else
        # diff-file mode: detect via added lines and markers
        local current_file=""
        local added_lines=0
        local has_generated_marker=false

        while IFS= read -r line; do
            if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/ ]]; then
                # Check previous file
                if [[ -n "$current_file" ]]; then
                    if [[ "$has_generated_marker" == "true" && "$added_lines" -gt 0 ]]; then
                        add_finding "LOW" "\`$current_file\` — Generated file detected in diff ($added_lines added lines)"
                        has_finding=true
                    elif [[ "$added_lines" -gt 1000 ]]; then
                        add_finding "LOW" "\`$current_file\` — $added_lines added lines (possible generated file, threshold: 1000)"
                        has_finding=true
                    fi
                fi
                current_file="${BASH_REMATCH[1]}"
                added_lines=0
                has_generated_marker=false
                continue
            fi

            if [[ "$line" =~ ^\+[^+] ]]; then
                added_lines=$((added_lines + 1))
                if echo "$line" | grep -qiE '(auto[- ]?generated|do not edit|generated by|this file is generated|machine generated)'; then
                    has_generated_marker=true
                fi
            fi
        done <<< "$DIFF_CONTENT"

        # Check last file
        if [[ -n "$current_file" ]]; then
            if [[ "$has_generated_marker" == "true" && "$added_lines" -gt 0 ]]; then
                add_finding "LOW" "\`$current_file\` — Generated file detected in diff ($added_lines added lines)"
                has_finding=true
            elif [[ "$added_lines" -gt 1000 ]]; then
                add_finding "LOW" "\`$current_file\` — $added_lines added lines (possible generated file, threshold: 1000)"
                has_finding=true
            fi
        fi
    fi

    if [[ "$has_finding" == "false" ]]; then
        CHECKS_PASSED=$((CHECKS_PASSED + 1))
    fi
}

# Run all checks
check_source_file_length
check_function_length
check_diff_breadth
check_large_generated_files

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Context Economy Report"
echo ""

if [[ -n "$DIFF_FILE" ]]; then
    echo "**Source:** \`$DIFF_FILE\`"
else
    echo "**Source:** \`$REPO_ROOT\` (diff against \`$BASE_BRANCH\`)"
fi
echo ""

if [[ $FINDING_COUNT -eq 0 ]]; then
    echo "No context-economy concerns detected."
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** ($CHECKS_PASSED/$TOTAL_CHECKS checks passed)"
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
