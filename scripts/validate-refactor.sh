#!/usr/bin/env bash
# Validate Refactor
# Runs tests/lint/typecheck with structured pass/fail output.
# Replaces validate phase prose checklist with deterministic validation.
#
# Usage: validate-refactor.sh --repo-root <path> [--skip-lint] [--skip-typecheck]
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed
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
SKIP_LINT=false
SKIP_TYPECHECK=false

usage() {
    cat << 'USAGE'
Usage: validate-refactor.sh --repo-root <path> [--skip-lint] [--skip-typecheck]

Required:
  --repo-root <path>    Path to the repository root (must contain package.json)

Optional:
  --skip-lint           Skip lint check
  --skip-typecheck      Skip typecheck
  --help                Show this help message

Exit codes:
  0  All checks pass
  1  One or more checks failed
  2  Usage error (missing required args)

Checks performed:
  - npm run test:run (required)
  - npm run lint (skipped if missing or --skip-lint)
  - npm run typecheck (skipped if missing or --skip-typecheck)
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
        --skip-lint)
            SKIP_LINT=true
            shift
            ;;
        --skip-typecheck)
            SKIP_TYPECHECK=true
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
# HELPER: Check if npm script exists in package.json
# ============================================================

has_npm_script() {
    local script_name="$1"
    if [[ -f "$REPO_ROOT/package.json" ]]; then
        # Use node or jq to check; fall back to grep
        if command -v jq &>/dev/null; then
            jq -e ".scripts[\"$script_name\"]" "$REPO_ROOT/package.json" &>/dev/null
            return $?
        else
            grep -q "\"$script_name\"" "$REPO_ROOT/package.json" 2>/dev/null
            return $?
        fi
    fi
    return 1
}

# ============================================================
# CHECK 1: Tests (npm run test:run)
# ============================================================

check_tests() {
    local output
    if ! output="$(cd "$REPO_ROOT" && npm run test:run 2>&1)"; then
        check_fail "Tests (npm run test:run)" "Tests failed"
        return 1
    fi
    check_pass "Tests (npm run test:run)"
    return 0
}

# ============================================================
# CHECK 2: Lint (npm run lint)
# ============================================================

check_lint() {
    if [[ "$SKIP_LINT" == true ]]; then
        check_skip "Lint (--skip-lint)"
        return 0
    fi

    if ! has_npm_script "lint"; then
        check_skip "Lint (no lint script in package.json)"
        return 0
    fi

    local output
    if ! output="$(cd "$REPO_ROOT" && npm run lint 2>&1)"; then
        check_fail "Lint (npm run lint)" "Lint errors found"
        return 1
    fi
    check_pass "Lint (npm run lint)"
    return 0
}

# ============================================================
# CHECK 3: Typecheck (npm run typecheck)
# ============================================================

check_typecheck() {
    if [[ "$SKIP_TYPECHECK" == true ]]; then
        check_skip "Typecheck (--skip-typecheck)"
        return 0
    fi

    if ! has_npm_script "typecheck"; then
        check_skip "Typecheck (no typecheck script in package.json)"
        return 0
    fi

    local output
    if ! output="$(cd "$REPO_ROOT" && npm run typecheck 2>&1)"; then
        check_fail "Typecheck (npm run typecheck)" "Type errors found"
        return 1
    fi
    check_pass "Typecheck (npm run typecheck)"
    return 0
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

check_tests || true
check_lint || true
check_typecheck || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Refactor Validation Report"
echo ""
echo "**Repository:** \`$REPO_ROOT\`"
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
