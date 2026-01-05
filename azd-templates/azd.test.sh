#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# azd Template Validation Test Suite
# Validates Azure Developer CLI template structure and configuration
# -----------------------------------------------------------------------------
#
# This script validates:
#   - azure.yaml manifest exists and has required fields
#   - .azure/config.json exists and is valid JSON
#   - Terraform provider is configured
#   - Provisioning hooks are defined
#
# Usage: ./azd.test.sh
# Exit codes: 0 = all tests passed, 1 = one or more tests failed
# -----------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ERRORS=0

# -----------------------------------------------------------------------------
# Test Helper Functions
# -----------------------------------------------------------------------------

# Increments error counter in a set -e compatible way
# Usage: increment_errors
increment_errors() {
    ERRORS=$((ERRORS + 1))
}

echo "=== azd Template Validation ==="
echo ""

# Test 1: azure.yaml exists
echo -n "Test: azure.yaml exists... "
if [ -f "$SCRIPT_DIR/azure.yaml" ]; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

# Test 2: azure.yaml has required fields
echo -n "Test: azure.yaml has name field... "
if grep -q "^name:" "$SCRIPT_DIR/azure.yaml"; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

# Test 3: Terraform provider configured
echo -n "Test: Terraform provider configured... "
if grep -q "provider: terraform" "$SCRIPT_DIR/azure.yaml"; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

# Test 4: .azure/config.json exists
echo -n "Test: .azure/config.json exists... "
if [ -f "$SCRIPT_DIR/.azure/config.json" ]; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

# Test 5: config.json is valid JSON
echo -n "Test: config.json is valid JSON... "
if jq empty "$SCRIPT_DIR/.azure/config.json" 2>/dev/null; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

# Test 6: Hooks defined
echo -n "Test: Hooks defined... "
if grep -q "hooks:" "$SCRIPT_DIR/azure.yaml"; then
    echo "PASS"
else
    echo "FAIL"
    increment_errors
fi

echo ""
echo "=== Results ==="
if [ $ERRORS -eq 0 ]; then
    echo "All tests passed!"
    exit 0
else
    echo "$ERRORS test(s) failed"
    exit 1
fi
