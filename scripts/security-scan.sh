#!/usr/bin/env bash
# Security Scan
# Scans code changes for common security anti-patterns in the quality-review workflow.
#
# Usage: security-scan.sh --diff-file <path>
#        security-scan.sh --repo-root <path> --base-branch <branch>
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
Usage: security-scan.sh --diff-file <path>
       security-scan.sh --repo-root <path> --base-branch <branch>

Scan code changes for common security anti-patterns.

Options:
  --diff-file <path>      Path to a unified diff file
  --repo-root <path>      Repository root (used with --base-branch)
  --base-branch <branch>  Base branch to diff against (used with --repo-root)
  --help                  Show this help message

Detected patterns:
  - Hardcoded secrets (API keys, passwords, tokens)
  - eval() usage
  - SQL string concatenation
  - innerHTML assignment
  - dangerouslySetInnerHTML
  - child_process.exec with variable input

Exit codes:
  0  No security findings
  1  Security findings detected
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
# SECURITY PATTERN SCANNING
# ============================================================

FINDINGS=()
FINDING_COUNT=0
CURRENT_FILE=""

# Extract only added lines from the diff (lines starting with +, excluding +++ headers)
# Track file names from diff headers
scan_diff() {
    local line_num=0
    local diff_line_num=0

    while IFS= read -r line; do
        # Track current file from diff headers
        if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/ ]]; then
            CURRENT_FILE="${BASH_REMATCH[1]}"
            diff_line_num=0
            continue
        fi

        # Track line numbers from hunk headers
        if [[ "$line" =~ ^@@\ -[0-9]+(,[0-9]+)?\ \+([0-9]+)(,[0-9]+)?\ @@ ]]; then
            diff_line_num="${BASH_REMATCH[2]}"
            continue
        fi

        # Skip non-addition lines
        if [[ ! "$line" =~ ^\+ ]]; then
            if [[ "$line" =~ ^[^-] ]]; then
                diff_line_num=$((diff_line_num + 1))
            fi
            continue
        fi

        # Skip +++ header lines
        if [[ "$line" =~ ^\+\+\+ ]]; then
            continue
        fi

        local added_line="${line:1}"  # Strip leading +

        # Pattern 1: Hardcoded secrets (API keys, passwords, tokens in string literals)
        if echo "$added_line" | grep -qEi '(API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*["\x27]'; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "Hardcoded secret/credential" "HIGH" "$added_line"
        fi

        # Pattern 2: eval() usage
        if echo "$added_line" | grep -qE '\beval\s*\('; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "eval() usage" "HIGH" "$added_line"
        fi

        # Pattern 3: SQL string concatenation
        if echo "$added_line" | grep -qEi '"SELECT\b.*"\s*\+|`SELECT\b.*\$\{'; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "SQL string concatenation" "HIGH" "$added_line"
        fi

        # Pattern 4: innerHTML assignment
        if echo "$added_line" | grep -qE '\.innerHTML\s*='; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "innerHTML assignment" "MEDIUM" "$added_line"
        fi

        # Pattern 5: dangerouslySetInnerHTML
        if echo "$added_line" | grep -qE 'dangerouslySetInnerHTML'; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "dangerouslySetInnerHTML usage" "MEDIUM" "$added_line"
        fi

        # Pattern 6: child_process.exec with variable
        if echo "$added_line" | grep -qE 'child_process.*exec\s*\(|exec\s*\(\s*[^"'\''`]'; then
            add_finding "$CURRENT_FILE" "$diff_line_num" "child_process.exec with variable input" "HIGH" "$added_line"
        fi

        diff_line_num=$((diff_line_num + 1))
    done <<< "$DIFF_CONTENT"
}

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

# Run the scan
scan_diff

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Security Scan Report"
echo ""

if [[ -n "$DIFF_FILE" ]]; then
    echo "**Source:** \`$DIFF_FILE\`"
else
    echo "**Source:** \`$REPO_ROOT\` (diff against \`$BASE_BRANCH\`)"
fi
echo ""

if [[ $FINDING_COUNT -eq 0 ]]; then
    echo "No security patterns detected."
    echo ""
    echo "---"
    echo ""
    echo "**Result: CLEAN** (0 findings)"
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
    echo "**Result: FINDINGS** ($FINDING_COUNT security patterns detected)"
    exit 1
fi
