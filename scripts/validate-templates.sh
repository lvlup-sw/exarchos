#!/usr/bin/env bash
#
# validate-templates.sh - Validate all CI/CD templates
#
# Usage: ./scripts/validate-templates.sh [--verbose]
#
# Exit codes:
#   0 - All validations passed
#   1 - One or more validations failed
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
VERBOSE="${1:-}"
ERRORS=0

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_pass() { echo -e "${GREEN}PASS${NC}: $1"; }
log_fail() { echo -e "${RED}FAIL${NC}: $1"; ERRORS=$((ERRORS + 1)); }
log_skip() { echo -e "${YELLOW}SKIP${NC}: $1"; }
log_info() { [ "$VERBOSE" = "--verbose" ] && echo "INFO: $1" || true; }

echo "=== CI/CD Template Validation ==="
echo ""

# --- YAML Validation ---
echo "## YAML Files"
validate_yaml() {
    local file="$1"
    if command -v yq &> /dev/null; then
        if yq eval '.' "$file" > /dev/null 2>&1; then
            log_pass "$file"
        else
            log_fail "$file - invalid YAML syntax"
        fi
    else
        # Fallback: basic syntax check with Python
        if python3 -c "import yaml; yaml.safe_load(open('$file'))" 2>/dev/null; then
            log_pass "$file (python fallback)"
        else
            log_fail "$file - invalid YAML syntax"
        fi
    fi
}

for f in "$REPO_ROOT"/ci-templates/workflows/*.yml; do
    [ -f "$f" ] && validate_yaml "$f"
done

for f in "$REPO_ROOT"/coderabbit-config/*.yaml; do
    [ -f "$f" ] && validate_yaml "$f"
done

echo ""

# --- JSON Validation ---
echo "## JSON Files"
validate_json() {
    local file="$1"
    if jq empty "$file" 2>/dev/null; then
        log_pass "$file"
    else
        log_fail "$file - invalid JSON syntax"
    fi
}

for f in "$REPO_ROOT"/ci-templates/templates/*.json; do
    [ -f "$f" ] && validate_json "$f"
done

# Renovate config if exists
if [ -d "$REPO_ROOT/renovate-config" ]; then
    for f in "$REPO_ROOT"/renovate-config/*.json "$REPO_ROOT"/renovate-config/presets/*.json; do
        [ -f "$f" ] && validate_json "$f"
    done
fi

echo ""

# --- Shell Script Validation ---
echo "## Shell Scripts"
validate_shell() {
    local file="$1"
    if command -v shellcheck &> /dev/null; then
        # Only fail on errors, not warnings/info/style
        if shellcheck --severity=error "$file" > /dev/null 2>&1; then
            log_pass "$file"
        else
            log_fail "$file - shellcheck errors"
            if [ "$VERBOSE" = "--verbose" ]; then
                shellcheck --severity=error "$file"
            fi
        fi
    else
        # Fallback: basic bash syntax check
        if bash -n "$file" 2>/dev/null; then
            log_pass "$file (syntax only)"
        else
            log_fail "$file - bash syntax error"
        fi
    fi
}

for f in "$REPO_ROOT"/ci-templates/coverage-gate/*.sh; do
    [ -f "$f" ] && validate_shell "$f"
done

for f in "$REPO_ROOT"/scripts/*.sh; do
    [ -f "$f" ] && validate_shell "$f"
done

# azd scripts if exist
if [ -d "$REPO_ROOT/azd-templates/infra/scripts" ]; then
    for f in "$REPO_ROOT"/azd-templates/infra/scripts/*.sh; do
        [ -f "$f" ] && validate_shell "$f"
    done
fi

echo ""

# --- Terraform Validation ---
echo "## Terraform Files"
if [ -d "$REPO_ROOT/azd-templates/infra" ]; then
    if command -v terraform &> /dev/null; then
        cd "$REPO_ROOT/azd-templates/infra"
        if terraform init -backend=false > /dev/null 2>&1 && terraform validate > /dev/null 2>&1; then
            log_pass "azd-templates/infra/"
        else
            log_fail "azd-templates/infra/ - terraform validate failed"
        fi
        cd "$REPO_ROOT"
    else
        log_skip "Terraform not installed"
    fi
else
    log_skip "No Terraform files found"
fi

echo ""

# --- Required Files Check ---
echo "## Required Files"
check_exists() {
    local file="$1"
    if [ -f "$REPO_ROOT/$file" ]; then
        log_pass "$file exists"
    else
        log_fail "$file missing"
    fi
}

check_exists "ci-templates/workflows/ci-dotnet.yml"
check_exists "ci-templates/coverage-gate/coverage-gate.sh"
check_exists "coderabbit-config/config.yaml"

echo ""

# --- Summary ---
echo "=== Summary ==="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All validations passed!${NC}"
    exit 0
else
    echo -e "${RED}$ERRORS validation(s) failed${NC}"
    exit 1
fi
