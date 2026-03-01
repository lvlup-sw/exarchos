#!/usr/bin/env bash
# validate-all-skills.sh — Discover and run all skill .test.sh files with aggregated reporting
#
# Usage: bash scripts/validate-all-skills.sh [--repo-root <path>]
#
# Discovers all *.test.sh files under skills/, executes each one,
# and reports per-file pass/fail status with an aggregated exit code.
#
# Exit codes:
#   0 — all tests passed (or no test files found)
#   1 — one or more tests failed
#   2 — usage error

set -euo pipefail

# ============================================================
# Argument parsing
# ============================================================

REPO_ROOT="."

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo-root)
            if [[ $# -lt 2 ]]; then
                echo "ERROR: --repo-root requires a path argument" >&2
                exit 2
            fi
            REPO_ROOT="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: bash scripts/validate-all-skills.sh [--repo-root <path>]"
            echo ""
            echo "Discovers and runs all *.test.sh files under skills/."
            echo ""
            echo "Options:"
            echo "  --repo-root <path>  Repository root directory (default: .)"
            echo "  --help, -h          Show this help message"
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

# Resolve to absolute path
if ! REPO_ROOT="$(cd "$REPO_ROOT" 2>/dev/null && pwd)"; then
    echo "ERROR: invalid --repo-root path: $REPO_ROOT" >&2
    exit 2
fi
SKILLS_DIR="$REPO_ROOT/skills"

if [[ ! -d "$SKILLS_DIR" ]]; then
    echo "ERROR: skills/ directory not found at $SKILLS_DIR" >&2
    exit 2
fi

# ============================================================
# Colors
# ============================================================

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

# ============================================================
# Discovery
# ============================================================

discover_test_files() {
    find "$SKILLS_DIR" -name '*.test.sh' -type f | sort
}

# ============================================================
# Execution and reporting
# ============================================================

run_all_tests() {
    local total=0
    local passed=0
    local failed=0

    local test_files
    test_files="$(discover_test_files)"

    if [[ -z "$test_files" ]]; then
        echo "No .test.sh files found under $SKILLS_DIR"
        echo ""
        echo "=== Summary: 0 run, 0 passed, 0 failed ==="
        return 0
    fi

    echo "=== Running skill tests ==="
    echo ""

    while IFS= read -r test_file; do
        total=$((total + 1))
        local relative_path="${test_file#"$REPO_ROOT/"}"

        local output=""
        local exit_code=0

        # Run each test from repo root so relative paths work
        set +e
        output="$(cd "$REPO_ROOT" && bash "$test_file" 2>&1)"
        exit_code=$?
        set -e

        if [[ "$exit_code" -eq 0 ]]; then
            passed=$((passed + 1))
            printf "  %b %s\n" "${GREEN}PASS${NC}" "$relative_path"
        else
            failed=$((failed + 1))
            printf "  %b %s\n" "${RED}FAIL${NC}" "$relative_path"
            # Show first line of output as context
            local first_line
            first_line="$(echo "$output" | head -n 1)"
            if [[ -n "$first_line" ]]; then
                printf "       %s\n" "$first_line"
            fi
        fi
    done <<< "$test_files"

    echo ""
    echo "=== Summary: ${total} run, ${passed} passed, ${failed} failed ==="

    if [[ "$failed" -gt 0 ]]; then
        return 1
    fi
    return 0
}

# ============================================================
# Main
# ============================================================

run_all_tests
