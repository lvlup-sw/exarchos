#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# azd Hooks Test Suite
# Validates hook scripts without executing actual Azure operations
# -----------------------------------------------------------------------------
#
# Run with: ./hooks.test.sh
#
# Tests:
# - Script files exist and are executable
# - Shell syntax is valid
# - Required functions are defined
# - Help/usage works where applicable
#
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# Test Framework
# -----------------------------------------------------------------------------

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

skip() {
    echo -e "${YELLOW}SKIP${NC}: $1"
}

# -----------------------------------------------------------------------------
# File Existence Tests
# -----------------------------------------------------------------------------

test_preprovision_exists() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if [[ -f "$file" ]]; then
        pass "preprovision.sh exists"
    else
        fail "preprovision.sh not found"
    fi
}

test_postprovision_exists() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if [[ -f "$file" ]]; then
        pass "postprovision.sh exists"
    else
        fail "postprovision.sh not found"
    fi
}

test_setup_backend_exists() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if [[ -f "$file" ]]; then
        pass "setup-backend.sh exists"
    else
        fail "setup-backend.sh not found"
    fi
}

# -----------------------------------------------------------------------------
# Executable Tests
# -----------------------------------------------------------------------------

test_preprovision_executable() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if [[ -x "$file" ]]; then
        pass "preprovision.sh is executable"
    else
        fail "preprovision.sh is not executable"
    fi
}

test_postprovision_executable() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if [[ -x "$file" ]]; then
        pass "postprovision.sh is executable"
    else
        fail "postprovision.sh is not executable"
    fi
}

test_setup_backend_executable() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if [[ -x "$file" ]]; then
        pass "setup-backend.sh is executable"
    else
        fail "setup-backend.sh is not executable"
    fi
}

# -----------------------------------------------------------------------------
# Syntax Validation Tests
# -----------------------------------------------------------------------------

test_preprovision_syntax() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if bash -n "$file" 2>/dev/null; then
        pass "preprovision.sh has valid bash syntax"
    else
        fail "preprovision.sh has syntax errors"
    fi
}

test_postprovision_syntax() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if bash -n "$file" 2>/dev/null; then
        pass "postprovision.sh has valid bash syntax"
    else
        fail "postprovision.sh has syntax errors"
    fi
}

test_setup_backend_syntax() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if bash -n "$file" 2>/dev/null; then
        pass "setup-backend.sh has valid bash syntax"
    else
        fail "setup-backend.sh has syntax errors"
    fi
}

# -----------------------------------------------------------------------------
# Content Validation Tests
# -----------------------------------------------------------------------------

test_preprovision_has_shebang() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if head -1 "$file" | grep -q '^#!/usr/bin/env bash\|^#!/bin/bash'; then
        pass "preprovision.sh has proper shebang"
    else
        fail "preprovision.sh missing proper shebang"
    fi
}

test_postprovision_has_shebang() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if head -1 "$file" | grep -q '^#!/usr/bin/env bash\|^#!/bin/bash'; then
        pass "postprovision.sh has proper shebang"
    else
        fail "postprovision.sh missing proper shebang"
    fi
}

test_setup_backend_has_shebang() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if head -1 "$file" | grep -q '^#!/usr/bin/env bash\|^#!/bin/bash'; then
        pass "setup-backend.sh has proper shebang"
    else
        fail "setup-backend.sh missing proper shebang"
    fi
}

test_preprovision_has_set_options() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if grep -q 'set -.*e' "$file" && grep -q 'set -.*u' "$file"; then
        pass "preprovision.sh has error handling (set -eu)"
    else
        fail "preprovision.sh missing set -eu for error handling"
    fi
}

test_postprovision_has_set_options() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if grep -q 'set -.*e' "$file" && grep -q 'set -.*u' "$file"; then
        pass "postprovision.sh has error handling (set -eu)"
    else
        fail "postprovision.sh missing set -eu for error handling"
    fi
}

test_setup_backend_has_set_options() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if grep -q 'set -.*e' "$file" && grep -q 'set -.*u' "$file"; then
        pass "setup-backend.sh has error handling (set -eu)"
    else
        fail "setup-backend.sh missing set -eu for error handling"
    fi
}

# -----------------------------------------------------------------------------
# Function Definition Tests
# -----------------------------------------------------------------------------

test_preprovision_has_main() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if grep -q '^main()' "$file" || grep -q 'main \(\)' "$file"; then
        pass "preprovision.sh has main function"
    else
        fail "preprovision.sh missing main function"
    fi
}

test_postprovision_has_main() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if grep -q '^main()' "$file" || grep -q 'main \(\)' "$file"; then
        pass "postprovision.sh has main function"
    else
        fail "postprovision.sh missing main function"
    fi
}

test_setup_backend_has_main() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if grep -q '^main()' "$file" || grep -q 'main \(\)' "$file"; then
        pass "setup-backend.sh has main function"
    else
        fail "setup-backend.sh missing main function"
    fi
}

test_preprovision_verifies_azure_auth() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if grep -q 'az account show\|verify_azure_auth\|az login' "$file"; then
        pass "preprovision.sh verifies Azure authentication"
    else
        fail "preprovision.sh should verify Azure authentication"
    fi
}

test_preprovision_sets_tf_vars() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if grep -q 'TF_VAR_' "$file"; then
        pass "preprovision.sh sets Terraform variables"
    else
        fail "preprovision.sh should set TF_VAR_* variables"
    fi
}

test_postprovision_extracts_outputs() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if grep -q 'terraform output' "$file"; then
        pass "postprovision.sh extracts Terraform outputs"
    else
        fail "postprovision.sh should extract Terraform outputs"
    fi
}

test_setup_backend_creates_storage() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if grep -q 'az storage account create\|storage account' "$file"; then
        pass "setup-backend.sh creates storage account"
    else
        fail "setup-backend.sh should create storage account"
    fi
}

# -----------------------------------------------------------------------------
# ShellCheck Tests (if available)
# -----------------------------------------------------------------------------

test_shellcheck_preprovision() {
    local file="$SCRIPT_DIR/preprovision.sh"
    if ! command -v shellcheck &>/dev/null; then
        skip "shellcheck not installed - skipping preprovision.sh lint"
        return
    fi
    if shellcheck -e SC1091 "$file" 2>/dev/null; then
        pass "preprovision.sh passes shellcheck"
    else
        fail "preprovision.sh has shellcheck warnings"
    fi
}

test_shellcheck_postprovision() {
    local file="$SCRIPT_DIR/postprovision.sh"
    if ! command -v shellcheck &>/dev/null; then
        skip "shellcheck not installed - skipping postprovision.sh lint"
        return
    fi
    if shellcheck -e SC1091 "$file" 2>/dev/null; then
        pass "postprovision.sh passes shellcheck"
    else
        fail "postprovision.sh has shellcheck warnings"
    fi
}

test_shellcheck_setup_backend() {
    local file="$SCRIPT_DIR/setup-backend.sh"
    if ! command -v shellcheck &>/dev/null; then
        skip "shellcheck not installed - skipping setup-backend.sh lint"
        return
    fi
    if shellcheck -e SC1091 "$file" 2>/dev/null; then
        pass "setup-backend.sh passes shellcheck"
    else
        fail "setup-backend.sh has shellcheck warnings"
    fi
}

# -----------------------------------------------------------------------------
# Main Test Runner
# -----------------------------------------------------------------------------

main() {
    echo ""
    echo "=============================================="
    echo "  azd Hooks Test Suite"
    echo "=============================================="
    echo ""

    # File existence tests
    echo "--- File Existence ---"
    test_preprovision_exists
    test_postprovision_exists
    test_setup_backend_exists
    echo ""

    # Executable tests
    echo "--- Executable Permissions ---"
    test_preprovision_executable
    test_postprovision_executable
    test_setup_backend_executable
    echo ""

    # Syntax tests
    echo "--- Syntax Validation ---"
    test_preprovision_syntax
    test_postprovision_syntax
    test_setup_backend_syntax
    echo ""

    # Content tests
    echo "--- Content Validation ---"
    test_preprovision_has_shebang
    test_postprovision_has_shebang
    test_setup_backend_has_shebang
    test_preprovision_has_set_options
    test_postprovision_has_set_options
    test_setup_backend_has_set_options
    echo ""

    # Function tests
    echo "--- Function Definitions ---"
    test_preprovision_has_main
    test_postprovision_has_main
    test_setup_backend_has_main
    test_preprovision_verifies_azure_auth
    test_preprovision_sets_tf_vars
    test_postprovision_extracts_outputs
    test_setup_backend_creates_storage
    echo ""

    # ShellCheck tests
    echo "--- Linting (shellcheck) ---"
    test_shellcheck_preprovision
    test_shellcheck_postprovision
    test_shellcheck_setup_backend
    echo ""

    # Summary
    echo "=============================================="
    echo "  Results: $PASS passed, $FAIL failed"
    echo "=============================================="
    echo ""

    if [[ $FAIL -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
