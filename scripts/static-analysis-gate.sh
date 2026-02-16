#!/usr/bin/env bash
# Static Analysis Gate
# Runs static analysis tools with structured pass/fail output for the quality-review workflow.
#
# Usage: static-analysis-gate.sh --repo-root <path> [--skip-lint] [--skip-typecheck]
#
# Exit codes:
#   0 = all checks pass (warnings OK)
#   1 = errors found
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

REPO_ROOT=""
SKIP_LINT=false
SKIP_TYPECHECK=false

usage() {
    cat << 'USAGE'
Usage: static-analysis-gate.sh --repo-root <path> [--skip-lint] [--skip-typecheck]

Run static analysis tools with structured pass/fail output.

Required:
  --repo-root <path>    Repository root containing package.json

Optional:
  --skip-lint           Skip lint check
  --skip-typecheck      Skip typecheck
  --help                Show this help message

Exit codes:
  0  All checks pass (warnings OK)
  1  Errors found in one or more tools
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

if [[ ! -f "$REPO_ROOT/package.json" ]]; then
    echo "Error: No package.json found at $REPO_ROOT" >&2
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
    local detail="${2:-}"
    if [[ -n "$detail" ]]; then
        RESULTS+=("- **PASS**: $name — $detail")
    else
        RESULTS+=("- **PASS**: $name")
    fi
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
    local detail="${2:-}"
    if [[ -n "$detail" ]]; then
        RESULTS+=("- **SKIP**: $name — $detail")
    else
        RESULTS+=("- **SKIP**: $name")
    fi
}

# Check if an npm script exists in package.json
has_npm_script() {
    local script_name="$1"
    local scripts_json
    scripts_json="$(node -e "
        const pkg = require('$REPO_ROOT/package.json');
        console.log(JSON.stringify(pkg.scripts || {}));
    " 2>/dev/null || echo '{}')"
    echo "$scripts_json" | node -e "
        let data = '';
        process.stdin.on('data', d => data += d);
        process.stdin.on('end', () => {
            const scripts = JSON.parse(data);
            process.exit(scripts['$script_name'] ? 0 : 1);
        });
    " 2>/dev/null
}

# ============================================================
# CHECK 1: Lint
# ============================================================

run_lint() {
    if [[ "$SKIP_LINT" == true ]]; then
        check_skip "Lint" "--skip-lint"
        return 0
    fi

    if ! has_npm_script "lint"; then
        check_skip "Lint" "no 'lint' script in package.json"
        return 0
    fi

    local output
    if output="$(cd "$REPO_ROOT" && npm run lint 2>&1)"; then
        check_pass "Lint"
        return 0
    else
        check_fail "Lint" "npm run lint failed"
        return 1
    fi
}

# ============================================================
# CHECK 2: Typecheck
# ============================================================

run_typecheck() {
    if [[ "$SKIP_TYPECHECK" == true ]]; then
        check_skip "Typecheck" "--skip-typecheck"
        return 0
    fi

    if ! has_npm_script "typecheck"; then
        check_skip "Typecheck" "no 'typecheck' script in package.json"
        return 0
    fi

    local output
    if output="$(cd "$REPO_ROOT" && npm run typecheck 2>&1)"; then
        check_pass "Typecheck"
        return 0
    else
        check_fail "Typecheck" "npm run typecheck failed"
        return 1
    fi
}

# ============================================================
# CHECK 3: Quality check
# ============================================================

run_quality_check() {
    if ! has_npm_script "quality-check"; then
        check_skip "Quality check" "no 'quality-check' script in package.json"
        return 0
    fi

    local output
    if output="$(cd "$REPO_ROOT" && npm run quality-check 2>&1)"; then
        check_pass "Quality check"
        return 0
    else
        check_fail "Quality check" "npm run quality-check failed"
        return 1
    fi
}

# ============================================================
# EXECUTE CHECKS
# ============================================================

run_lint || true
run_typecheck || true
run_quality_check || true

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Static Analysis Report"
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
