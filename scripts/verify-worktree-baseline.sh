#!/usr/bin/env bash
# verify-worktree-baseline.sh — Run baseline tests in a worktree before dispatch
# Usage: verify-worktree-baseline.sh --worktree-path <path> [--help]
# Exit codes: 0=baseline pass, 1=baseline fail, 2=project type unknown or usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

WORKTREE_PATH=""

usage() {
    cat << 'USAGE'
Usage: verify-worktree-baseline.sh --worktree-path <path> [--help]

Run baseline tests in a worktree to verify it is ready for implementation.
Auto-detects project type and runs the appropriate test command.

Required:
  --worktree-path <path>   Path to the worktree directory

Optional:
  --help                   Show this help message

Supported project types:
  Node.js     package.json     → npm run test:run
  .NET        *.csproj         → dotnet test
  Rust        Cargo.toml       → cargo test

Exit codes:
  0  Baseline tests pass — worktree is ready
  1  Baseline tests failed — investigate before proceeding
  2  Unknown project type or usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --worktree-path)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --worktree-path requires a path argument" >&2
                exit 2
            fi
            WORKTREE_PATH="$2"
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

if [[ -z "$WORKTREE_PATH" ]]; then
    echo "Error: --worktree-path is required" >&2
    usage >&2
    exit 2
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
    echo "Error: Worktree path does not exist: $WORKTREE_PATH" >&2
    exit 2
fi

# ============================================================
# PROJECT TYPE DETECTION
# ============================================================

PROJECT_TYPE=""
TEST_CMD=""

detect_project_type() {
    if [[ -f "$WORKTREE_PATH/package.json" ]]; then
        PROJECT_TYPE="Node.js"
        TEST_CMD="npm run test:run"
    elif ls "$WORKTREE_PATH"/*.csproj 1>/dev/null 2>&1; then
        PROJECT_TYPE=".NET"
        TEST_CMD="dotnet test"
    elif [[ -f "$WORKTREE_PATH/Cargo.toml" ]]; then
        PROJECT_TYPE="Rust"
        TEST_CMD="cargo test"
    fi
}

detect_project_type

# ============================================================
# RUN BASELINE TESTS
# ============================================================

TEST_OUTPUT=""
TEST_EXIT=0

if [[ -z "$PROJECT_TYPE" ]]; then
    echo "## Baseline Verification Report"
    echo ""
    echo "**Worktree:** \`$WORKTREE_PATH\`"
    echo "**Project type detected:** Unknown"
    echo ""
    echo "No recognized project files found (package.json, *.csproj, Cargo.toml)."
    echo "Manual verification required."
    echo ""
    echo "---"
    echo ""
    echo "**Result: UNKNOWN** — could not detect project type"
    exit 2
fi

TEST_OUTPUT="$(cd "$WORKTREE_PATH" && $TEST_CMD 2>&1)" && TEST_EXIT=0 || TEST_EXIT=$?

# ============================================================
# STRUCTURED MARKDOWN OUTPUT
# ============================================================

echo "## Baseline Verification Report"
echo ""
echo "**Worktree:** \`$WORKTREE_PATH\`"
echo "**Project type detected:** $PROJECT_TYPE"
echo "**Test command:** \`$TEST_CMD\`"
echo ""

if [[ $TEST_EXIT -eq 0 ]]; then
    echo "### Test Output"
    echo ""
    echo '```'
    echo "$TEST_OUTPUT"
    echo '```'
    echo ""
    echo "---"
    echo ""
    echo "**Result: PASS** — baseline tests succeeded"
    exit 0
else
    echo "### Test Output"
    echo ""
    echo '```'
    echo "$TEST_OUTPUT"
    echo '```'
    echo ""
    echo "---"
    echo ""
    echo "**Result: FAIL** — baseline tests failed (exit code $TEST_EXIT)"
    exit 1
fi
