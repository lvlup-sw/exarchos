#!/usr/bin/env bash
set -euo pipefail

RULE_FILE="rules/orchestrator-constraints.md"

# Test 1: File exists
if [[ ! -f "$RULE_FILE" ]]; then
    echo "FAIL: $RULE_FILE does not exist"
    exit 1
fi

# Test 2: Contains MUST NOT section
if ! grep -q "MUST NOT" "$RULE_FILE"; then
    echo "FAIL: Missing 'MUST NOT' section"
    exit 1
fi

# Test 3: Contains SHOULD section
if ! grep -q "SHOULD" "$RULE_FILE"; then
    echo "FAIL: Missing 'SHOULD' section"
    exit 1
fi

# Test 4: Contains key constraints
if ! grep -q "Write implementation code" "$RULE_FILE"; then
    echo "FAIL: Missing constraint about writing implementation code"
    exit 1
fi

if ! grep -q "Fix review findings directly" "$RULE_FILE"; then
    echo "FAIL: Missing constraint about fixing directly"
    exit 1
fi

if ! grep -q "Run integration tests inline" "$RULE_FILE"; then
    echo "FAIL: Missing constraint about inline tests"
    exit 1
fi

echo "PASS: All tests passed"
