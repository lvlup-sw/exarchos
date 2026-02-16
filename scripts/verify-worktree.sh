#!/usr/bin/env bash
# verify-worktree.sh — Verify execution is inside a git worktree
# Usage: verify-worktree.sh [--cwd <path>] [--help]
# Exit codes: 0=in worktree, 1=not in worktree, 2=usage error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# ============================================================
# ARGUMENT PARSING
# ============================================================

CWD=""

usage() {
    cat << 'USAGE'
Usage: verify-worktree.sh [--cwd <path>] [--help]

Verify that the current (or provided) working directory is inside a git worktree.

Optional:
  --cwd <path>    Directory to check (default: current working directory)
  --help          Show this help message

Exit codes:
  0  In a valid worktree (path contains .worktrees/)
  1  Not in a worktree
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cwd)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --cwd requires a path argument" >&2
                exit 2
            fi
            CWD="$2"
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

# Default to current working directory if --cwd not provided
if [[ -z "$CWD" ]]; then
    CWD="$(pwd)"
fi

# Validate path exists and normalize to absolute
if [[ ! -d "$CWD" ]]; then
    echo "Error: Directory does not exist: $CWD" >&2
    exit 2
fi
CWD="$(cd "$CWD" && pwd)"

# ============================================================
# WORKTREE CHECK
# ============================================================

if [[ "$CWD" =~ \.worktrees/ ]]; then
    echo -e "${GREEN}OK:${NC} Working in worktree at ${CWD}"
    exit 0
else
    echo -e "${RED}ERROR:${NC} Not in a worktree! Current directory: ${CWD}"
    echo "Expected: path containing '.worktrees/'"
    echo "ABORTING — DO NOT proceed with file modifications"
    exit 1
fi
