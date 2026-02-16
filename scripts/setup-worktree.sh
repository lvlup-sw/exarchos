#!/usr/bin/env bash
# setup-worktree.sh — Atomic worktree creation with validation
# Replaces the "Pre-Dispatch Checklist" prose in delegation SKILL.md.
#
# Usage: setup-worktree.sh --repo-root <path> --task-id <id> --task-name <name> [--base-branch main] [--skip-tests]
#
# Exit codes:
#   0 = worktree ready
#   1 = setup failed
#   2 = usage error (missing required args)

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT=""
TASK_ID=""
TASK_NAME=""
BASE_BRANCH="main"
SKIP_TESTS=false

usage() {
    cat << 'USAGE'
Usage: setup-worktree.sh --repo-root <path> --task-id <id> --task-name <name> [--base-branch main] [--skip-tests]

Required:
  --repo-root <path>    Repository root directory
  --task-id <id>        Task identifier (e.g., task-001)
  --task-name <name>    Task name slug (e.g., user-model)

Optional:
  --base-branch <name>  Base branch to create from (default: main)
  --skip-tests          Skip baseline test verification
  --help                Show this help message

Exit codes:
  0  Worktree ready
  1  Setup failed
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
        --task-id)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --task-id requires an argument" >&2
                exit 2
            fi
            TASK_ID="$2"
            shift 2
            ;;
        --task-name)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --task-name requires an argument" >&2
                exit 2
            fi
            TASK_NAME="$2"
            shift 2
            ;;
        --base-branch)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --base-branch requires an argument" >&2
                exit 2
            fi
            BASE_BRANCH="$2"
            shift 2
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
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

if [[ -z "$TASK_ID" ]]; then
    echo "Error: --task-id is required" >&2
    usage >&2
    exit 2
fi

if [[ -z "$TASK_NAME" ]]; then
    echo "Error: --task-name is required" >&2
    usage >&2
    exit 2
fi

# ============================================================
# DERIVED VALUES
# ============================================================

WORKTREE_NAME="${TASK_ID}-${TASK_NAME}"
BRANCH_NAME="feature/${WORKTREE_NAME}"
WORKTREE_PATH="$REPO_ROOT/.worktrees/$WORKTREE_NAME"

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

check_skip() {
    local name="$1"
    RESULTS+=("- **SKIP**: $name")
}

# ============================================================
# STEP 1: Ensure .worktrees is gitignored
# ============================================================

ensure_gitignored() {
    # git check-ignore requires trailing slash for directory patterns
    if (cd "$REPO_ROOT" && git check-ignore -q .worktrees/) 2>/dev/null; then
        check_pass ".worktrees is gitignored"
        return 0
    fi

    # Add to .gitignore
    local gitignore="$REPO_ROOT/.gitignore"
    if [[ -f "$gitignore" ]]; then
        echo ".worktrees/" >> "$gitignore"
    else
        echo ".worktrees/" > "$gitignore"
    fi

    # Verify it worked
    if (cd "$REPO_ROOT" && git check-ignore -q .worktrees/) 2>/dev/null; then
        check_pass ".worktrees is gitignored (added to .gitignore)"
        return 0
    else
        check_fail ".worktrees is gitignored" "Failed to add to .gitignore"
        return 1
    fi
}

# ============================================================
# STEP 2: Create feature branch
# ============================================================

create_branch() {
    # Check if branch already exists
    if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
        check_pass "Branch created ($BRANCH_NAME already exists)"
        return 0
    fi

    if git -C "$REPO_ROOT" branch "$BRANCH_NAME" "$BASE_BRANCH" 2>/dev/null; then
        check_pass "Branch created ($BRANCH_NAME from $BASE_BRANCH)"
        return 0
    else
        check_fail "Branch created" "Failed to create $BRANCH_NAME from $BASE_BRANCH"
        return 1
    fi
}

# ============================================================
# STEP 3: Create worktree
# ============================================================

create_worktree() {
    # Check if worktree already exists
    if [[ -d "$WORKTREE_PATH" ]]; then
        # Verify it's a valid worktree
        if git -C "$WORKTREE_PATH" rev-parse --git-dir &>/dev/null; then
            check_pass "Worktree created ($WORKTREE_PATH already exists)"
            return 0
        else
            check_fail "Worktree created" "$WORKTREE_PATH exists but is not a valid worktree"
            return 1
        fi
    fi

    if git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH_NAME" 2>/dev/null; then
        check_pass "Worktree created ($WORKTREE_PATH)"
        return 0
    else
        check_fail "Worktree created" "git worktree add failed for $WORKTREE_PATH"
        return 1
    fi
}

# ============================================================
# STEP 4: Run npm install
# ============================================================

run_npm_install() {
    # Only run if package.json exists in worktree
    if [[ ! -f "$WORKTREE_PATH/package.json" ]]; then
        check_skip "npm install (no package.json in worktree)"
        return 0
    fi

    if (cd "$WORKTREE_PATH" && npm install --silent 2>/dev/null); then
        check_pass "npm install completed"
        return 0
    else
        check_fail "npm install completed" "npm install failed in $WORKTREE_PATH"
        return 1
    fi
}

# ============================================================
# STEP 5: Baseline tests
# ============================================================

run_baseline_tests() {
    if [[ "$SKIP_TESTS" == true ]]; then
        check_skip "Baseline tests pass (--skip-tests)"
        return 0
    fi

    if [[ ! -f "$WORKTREE_PATH/package.json" ]]; then
        check_skip "Baseline tests pass (no package.json in worktree)"
        return 0
    fi

    if (cd "$WORKTREE_PATH" && npm run test:run 2>/dev/null); then
        check_pass "Baseline tests pass"
        return 0
    else
        check_fail "Baseline tests pass" "npm run test:run failed in $WORKTREE_PATH"
        return 1
    fi
}

# ============================================================
# EXECUTE STEPS
# ============================================================

# Step 1: Gitignore
ensure_gitignored || true

# Step 2: Branch (depends on step 1 not fatally failing)
create_branch || true

# Step 3: Worktree (depends on branch existing)
create_worktree || true

# Step 4: npm install (depends on worktree existing)
if [[ -d "$WORKTREE_PATH" ]]; then
    run_npm_install || true
else
    check_skip "npm install (worktree not available)"
fi

# Step 5: Baseline tests (depends on npm install)
if [[ -d "$WORKTREE_PATH" ]]; then
    run_baseline_tests || true
else
    check_skip "Baseline tests pass (worktree not available)"
fi

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Worktree Setup Report"
echo ""
echo "**Task:** \`$TASK_ID\` — $TASK_NAME"
echo "**Branch:** \`$BRANCH_NAME\`"
echo "**Worktree:** \`$WORKTREE_PATH\`"
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
