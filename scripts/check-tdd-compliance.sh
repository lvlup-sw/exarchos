#!/usr/bin/env bash
# Check TDD Compliance
# Verify test-first git history order for commits on a branch.
#
# Usage: check-tdd-compliance.sh --repo-root <path> --branch <name> [--base-branch main]
#
# Exit codes:
#   0 = compliant (test files committed before or alongside implementation)
#   1 = violations found (implementation committed without test)
#   2 = usage error (missing required args)

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

REPO_ROOT=""
BRANCH=""
BASE_BRANCH="main"

usage() {
    cat << 'USAGE'
Usage: check-tdd-compliance.sh --repo-root <path> --branch <name> [--base-branch main]

Required:
  --repo-root <path>     Repository root directory
  --branch <name>        Branch to check

Optional:
  --base-branch <name>   Base branch to compare against (default: main)
  --help                 Show this help message

Exit codes:
  0  Compliant (test files committed before or alongside implementation)
  1  Violations found (implementation without test in same/prior commit)
  2  Usage error (missing required args)
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
        --branch)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --branch requires a name argument" >&2
                exit 2
            fi
            BRANCH="$2"
            shift 2
            ;;
        --base-branch)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --base-branch requires a name argument" >&2
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

if [[ -z "$REPO_ROOT" || -z "$BRANCH" ]]; then
    echo "Error: --repo-root and --branch are required" >&2
    usage >&2
    exit 2
fi

if [[ ! -d "$REPO_ROOT/.git" ]]; then
    echo "Error: Not a git repository: $REPO_ROOT" >&2
    exit 2
fi

# ============================================================
# HELPER: Classify a file as test or implementation
# ============================================================

is_test_file() {
    local file="$1"
    case "$file" in
        *.test.ts|*.test.sh|*.spec.ts|*.test.js|*.spec.js|*.test.tsx|*.spec.tsx)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

is_impl_file() {
    local file="$1"
    # Implementation files: source code that isn't a test, config, or docs
    case "$file" in
        *.ts|*.js|*.tsx|*.jsx|*.sh)
            # Exclude test files
            if is_test_file "$file"; then
                return 1
            fi
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# ============================================================
# ANALYZE COMMITS
# ============================================================

CHECK_PASS=0
CHECK_FAIL=0
VIOLATIONS=()
RESULTS=()

# Track test files seen across all commits (cumulative)
# Use a delimiter-separated string for bash 3.x compatibility (no associative arrays)
TESTS_SEEN=""

# Get commits from base..branch in chronological order (oldest first)
cd "$REPO_ROOT"
COMMITS=()
while IFS= read -r commit_hash; do
    [[ -n "$commit_hash" ]] && COMMITS+=("$commit_hash")
done < <(git log --reverse --format="%H" "${BASE_BRANCH}..${BRANCH}" 2>/dev/null)

if [[ ${#COMMITS[@]} -eq 0 ]]; then
    echo "## TDD Compliance Report"
    echo ""
    echo "**Branch:** $BRANCH"
    echo "**Base:** $BASE_BRANCH"
    echo ""
    echo "No commits found between $BASE_BRANCH and $BRANCH"
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** (no commits to check)"
    exit 0
fi

for commit_hash in "${COMMITS[@]}"; do
    commit_msg="$(git log -1 --format="%s" "$commit_hash")"
    commit_short="$(git log -1 --format="%h" "$commit_hash")"

    # Get files changed in this commit
    FILES_IN_COMMIT=()
    while IFS= read -r file; do
        [[ -n "$file" ]] && FILES_IN_COMMIT+=("$file")
    done < <(git diff-tree --no-commit-id --name-only -r "$commit_hash" 2>/dev/null)

    # Classify files in this commit
    HAS_TEST=false
    HAS_IMPL=false
    IMPL_FILES=()
    TEST_FILES=()

    for file in "${FILES_IN_COMMIT[@]}"; do
        if is_test_file "$file"; then
            HAS_TEST=true
            TEST_FILES+=("$file")
            TESTS_SEEN="${TESTS_SEEN}|${file}"
        elif is_impl_file "$file"; then
            HAS_IMPL=true
            IMPL_FILES+=("$file")
        fi
    done

    # A commit with implementation files is compliant if:
    # 1. It also contains test files (mixed commit), OR
    # 2. Corresponding test files were seen in prior commits
    if [[ "$HAS_IMPL" == true ]]; then
        if [[ "$HAS_TEST" == true ]]; then
            # Mixed commit: test and impl together — OK
            RESULTS+=("- **PASS**: \`$commit_short\` — $commit_msg (test+impl)")
            CHECK_PASS=$((CHECK_PASS + 1))
        else
            # Check if test files were seen before this commit
            FOUND_PRIOR_TEST=false
            for impl_file in "${IMPL_FILES[@]}"; do
                # Derive expected test file name(s)
                base="${impl_file%.*}"
                ext="${impl_file##*.}"
                test_candidate="${base}.test.${ext}"

                if echo "$TESTS_SEEN" | grep -qF "|${test_candidate}"; then
                    FOUND_PRIOR_TEST=true
                    break
                fi
            done

            if [[ "$FOUND_PRIOR_TEST" == true ]]; then
                RESULTS+=("- **PASS**: \`$commit_short\` — $commit_msg (test in prior commit)")
                CHECK_PASS=$((CHECK_PASS + 1))
            else
                RESULTS+=("- **FAIL**: \`$commit_short\` — $commit_msg (implementation without test)")
                VIOLATIONS+=("$commit_short: $commit_msg")
                CHECK_FAIL=$((CHECK_FAIL + 1))
            fi
        fi
    elif [[ "$HAS_TEST" == true ]]; then
        # Test-only commit — always compliant
        RESULTS+=("- **PASS**: \`$commit_short\` — $commit_msg (test-only)")
        CHECK_PASS=$((CHECK_PASS + 1))
    else
        # Non-code commit (docs, config, etc.) — skip
        RESULTS+=("- **SKIP**: \`$commit_short\` — $commit_msg (non-code)")
    fi
done

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## TDD Compliance Report"
echo ""
echo "**Branch:** $BRANCH"
echo "**Base:** $BASE_BRANCH"
echo "**Commits analyzed:** ${#COMMITS[@]}"
echo ""

echo "### Per-commit Analysis"
echo ""
for result in "${RESULTS[@]}"; do
    echo "$result"
done
echo ""

if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
    echo "### Violations"
    echo ""
    for v in "${VIOLATIONS[@]}"; do
        echo "- $v"
    done
    echo ""
fi

TOTAL=$((CHECK_PASS + CHECK_FAIL))
echo "---"
echo ""

if [[ $CHECK_FAIL -eq 0 ]]; then
    echo "**Result: PASS** ($CHECK_PASS/$TOTAL commits compliant)"
    exit 0
else
    echo "**Result: FAIL** ($CHECK_FAIL/$TOTAL commits have violations)"
    exit 1
fi
