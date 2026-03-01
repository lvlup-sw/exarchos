#!/usr/bin/env bash
# Check Operational Resilience (T-21)
# Scans code changes for operational resilience anti-patterns in the quality-review workflow.
#
# Usage: check-operational-resilience.sh --diff-file <path>
#        check-operational-resilience.sh --repo-root <path> --base-branch <branch>
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
Usage: check-operational-resilience.sh --diff-file <path>
       check-operational-resilience.sh --repo-root <path> --base-branch <branch>

Scan code changes for operational resilience anti-patterns.

Options:
  --diff-file <path>      Path to a unified diff file
  --repo-root <path>      Repository root (used with --base-branch)
  --base-branch <branch>  Base branch to diff against (used with --repo-root)
  --help                  Show this help message

Detected patterns:
  - Empty catch blocks (HIGH)
  - Swallowed errors — catch without rethrow/log/return (MEDIUM)
  - console.log in non-test source files (MEDIUM)
  - npm audit high/critical vulnerabilities (HIGH)
  - Unbounded retries — while(true)/for(;;) without break/max (MEDIUM)

Exit codes:
  0  No findings
  1  Findings detected
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
# CHECKS
# ============================================================

FINDINGS=()
FINDING_COUNT=0

add_finding() {
    local severity="$1"
    local message="$2"
    FINDINGS+=("- **${severity}** ${message}")
    FINDING_COUNT=$((FINDING_COUNT + 1))
}

# Helper: check if a file is a test file
is_test_file() {
    local file="$1"
    case "$file" in
        *.test.ts|*.test.js|*.spec.ts|*.spec.js|*__tests__*) return 0 ;;
        *) return 1 ;;
    esac
}

# Helper: check if a file is a source file (.ts/.js)
is_source_file() {
    local file="$1"
    case "$file" in
        *.ts|*.js) return 0 ;;
        *) return 1 ;;
    esac
}

# Scan the diff for added lines and apply checks
CURRENT_FILE=""

# Build arrays of added lines per file for context-aware checks
declare -A FILE_ADDED_LINES

if [[ -n "$DIFF_CONTENT" ]]; then
    while IFS= read -r line; do
        if [[ "$line" =~ ^diff\ --git\ a/(.+)\ b/ ]]; then
            CURRENT_FILE="${BASH_REMATCH[1]}"
            continue
        fi

        # Skip non-addition lines
        if [[ ! "$line" =~ ^\+ ]]; then
            continue
        fi
        # Skip +++ header lines
        if [[ "$line" =~ ^\+\+\+ ]]; then
            continue
        fi

        local_line="${line:1}"  # Strip leading +
        FILE_ADDED_LINES["$CURRENT_FILE"]+="$local_line"$'\n'
    done <<< "$DIFF_CONTENT"
fi

# ----------------------------------------------------------
# Check 1: Empty catch blocks
# ----------------------------------------------------------

for file in "${!FILE_ADDED_LINES[@]}"; do
    is_source_file "$file" || continue
    added="${FILE_ADDED_LINES[$file]}"

    # Look for catch followed by empty body: catch (...) { } or catch { }
    if echo "$added" | grep -qE 'catch\s*(\([^)]*\))?\s*\{\s*\}'; then
        add_finding "HIGH" "\`$file\` — Empty catch block detected"
    fi
done

# ----------------------------------------------------------
# Check 2: Swallowed errors (catch blocks without rethrow/log/return)
# ----------------------------------------------------------

for file in "${!FILE_ADDED_LINES[@]}"; do
    is_source_file "$file" || continue
    added="${FILE_ADDED_LINES[$file]}"

    # Heuristic: find catch blocks that don't contain throw, console., return, or reject
    if echo "$added" | grep -qE '\bcatch\b'; then
        # Check if any of the handling patterns are present in the same file's additions
        if ! echo "$added" | grep -qE '\bthrow\b|console\.|return\b.*[Ee]rr|\breject\b'; then
            # Don't double-report if already flagged as empty catch
            is_empty=false
            if echo "$added" | grep -qE 'catch\s*(\([^)]*\))?\s*\{\s*\}'; then
                is_empty=true
            fi
            if [[ "$is_empty" == false ]]; then
                add_finding "MEDIUM" "\`$file\` — Possible swallowed error in catch block"
            fi
        fi
    fi
done

# ----------------------------------------------------------
# Check 3: console.log in non-test source files
# ----------------------------------------------------------

for file in "${!FILE_ADDED_LINES[@]}"; do
    is_source_file "$file" || continue
    is_test_file "$file" && continue
    added="${FILE_ADDED_LINES[$file]}"

    if echo "$added" | grep -qE '\bconsole\.log\b'; then
        add_finding "MEDIUM" "\`$file\` — console.log in source file"
    fi
done

# ----------------------------------------------------------
# Check 4: npm audit (graceful skip if unavailable)
# ----------------------------------------------------------

EFFECTIVE_ROOT="${REPO_ROOT:-}"
if [[ -n "$EFFECTIVE_ROOT" ]] && command -v npm &>/dev/null; then
    if [[ -f "$EFFECTIVE_ROOT/package-lock.json" ]] || [[ -f "$EFFECTIVE_ROOT/package.json" ]]; then
        audit_output=""
        audit_exit=0
        audit_output=$(cd "$EFFECTIVE_ROOT" && npm audit --audit-level=high --json 2>/dev/null) && audit_exit=$? || audit_exit=$?

        if [[ "$audit_exit" -ne 0 && -n "$audit_output" ]]; then
            # Check if there are actual high/critical vulnerabilities
            vuln_count=0
            if command -v jq &>/dev/null; then
                vuln_count=$(echo "$audit_output" | jq -r '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")
                crit_count=$(echo "$audit_output" | jq -r '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
                vuln_count=$((vuln_count + crit_count))
            fi
            if [[ "$vuln_count" -gt 0 ]]; then
                add_finding "HIGH" "— npm audit: $vuln_count high/critical vulnerabilities found"
            fi
        fi
    fi
fi

# ----------------------------------------------------------
# Check 5: Unbounded retries (while(true)/for(;;) without break/max)
# ----------------------------------------------------------

for file in "${!FILE_ADDED_LINES[@]}"; do
    is_source_file "$file" || continue
    is_test_file "$file" && continue
    added="${FILE_ADDED_LINES[$file]}"

    if echo "$added" | grep -qE 'while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)'; then
        # Check if break, maxRetries, MAX_ are nearby
        if ! echo "$added" | grep -qiE '\bbreak\b|maxRetries|MAX_|max_retries|maxAttempts'; then
            add_finding "MEDIUM" "\`$file\` — Unbounded retry loop (while(true)/for(;;) without break/max)"
        fi
    fi
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Operational Resilience Report"
echo ""

if [[ -n "$DIFF_FILE" ]]; then
    echo "**Source:** \`$DIFF_FILE\`"
else
    echo "**Source:** \`$REPO_ROOT\` (diff against \`$BASE_BRANCH\`)"
fi
echo ""

if [[ $FINDING_COUNT -eq 0 ]]; then
    echo "No operational resilience issues detected."
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** (0 findings)"
    exit 0
else
    echo "### Findings"
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
