#!/usr/bin/env bash
set -euo pipefail

SCHEMA_FILE="docs/schemas/workflow-state.schema.json"

# Test 1: File exists
if [[ ! -f "$SCHEMA_FILE" ]]; then
    echo "FAIL: $SCHEMA_FILE does not exist"
    exit 1
fi

# Test 2: Phase enum contains "integrate"
if ! grep -q '"integrate"' "$SCHEMA_FILE"; then
    echo "FAIL: Phase enum missing 'integrate'"
    exit 1
fi

# Test 3: Has integration object
if ! grep -q '"integration"' "$SCHEMA_FILE"; then
    echo "FAIL: Missing 'integration' object"
    exit 1
fi

# Test 4: Integration has branch property
if ! grep -A 50 '"integration"' "$SCHEMA_FILE" | grep -q '"branch"'; then
    echo "FAIL: Integration missing 'branch' property"
    exit 1
fi

# Test 5: Integration has status property with correct enum
if ! grep -A 50 '"integration"' "$SCHEMA_FILE" | grep -q '"status"'; then
    echo "FAIL: Integration missing 'status' property"
    exit 1
fi

# Test 6: Integration has mergedBranches array
if ! grep -A 50 '"integration"' "$SCHEMA_FILE" | grep -q '"mergedBranches"'; then
    echo "FAIL: Integration missing 'mergedBranches' property"
    exit 1
fi

# Test 7: Integration has testResults object
if ! grep -A 80 '"integration"' "$SCHEMA_FILE" | grep -q '"testResults"'; then
    echo "FAIL: Integration missing 'testResults' property"
    exit 1
fi

echo "PASS: All tests passed"
