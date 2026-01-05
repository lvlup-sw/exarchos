#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ERRORS=0

echo "=== Terraform Infrastructure Validation ==="

# Test: main.tf exists
echo -n "Test: main.tf exists... "
if [ -f "$SCRIPT_DIR/main.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: backend.tf exists
echo -n "Test: backend.tf exists... "
if [ -f "$SCRIPT_DIR/backend.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: variables.tf exists
echo -n "Test: variables.tf exists... "
if [ -f "$SCRIPT_DIR/variables.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: outputs.tf exists
echo -n "Test: outputs.tf exists... "
if [ -f "$SCRIPT_DIR/outputs.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: Container Apps module exists
echo -n "Test: modules/container-apps/main.tf exists... "
if [ -f "$SCRIPT_DIR/modules/container-apps/main.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: Container Apps module variables exists
echo -n "Test: modules/container-apps/variables.tf exists... "
if [ -f "$SCRIPT_DIR/modules/container-apps/variables.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: Container Apps module outputs exists
echo -n "Test: modules/container-apps/outputs.tf exists... "
if [ -f "$SCRIPT_DIR/modules/container-apps/outputs.tf" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: main.tfvars.json template exists
echo -n "Test: main.tfvars.json exists... "
if [ -f "$SCRIPT_DIR/main.tfvars.json" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: provider.conf.json template exists
echo -n "Test: provider.conf.json exists... "
if [ -f "$SCRIPT_DIR/provider.conf.json" ]; then
    echo "PASS"
else
    echo "FAIL"
    ((ERRORS++))
fi

# Test: Terraform syntax valid (if terraform available)
echo -n "Test: Terraform validate... "
if command -v terraform &>/dev/null; then
    if (cd "$SCRIPT_DIR" && terraform init -backend=false >/dev/null 2>&1 && terraform validate >/dev/null 2>&1); then
        echo "PASS"
    else
        echo "FAIL (terraform validate failed)"
        ((ERRORS++))
    fi
else
    echo "SKIP (terraform not installed)"
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
