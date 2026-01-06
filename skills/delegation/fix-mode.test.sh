#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/delegation/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Contains --fixes flag reference
if ! grep -q "\-\-fixes" "$SKILL_FILE"; then
    echo "FAIL: Missing '--fixes' flag reference"
    exit 1
fi

# Test 3: Contains fix task extraction
if ! grep -q "extract.*fix\|fix.*task\|fix.*issue" "$SKILL_FILE"; then
    echo "FAIL: Missing fix task extraction logic"
    exit 1
fi

# Test 4: Contains re-integrate flow
if ! grep -q "re-integrate\|back to integrate\|integration phase" "$SKILL_FILE"; then
    echo "FAIL: Missing re-integrate flow after fixes"
    exit 1
fi

# Test 5: Contains Fix Mode section
if ! grep -q "Fix Mode\|## Fix\|### Fix" "$SKILL_FILE"; then
    echo "FAIL: Missing Fix Mode section"
    exit 1
fi

# Test 6: References fixer-prompt template
if ! grep -q "fixer-prompt\|fixer prompt" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to fixer-prompt template"
    exit 1
fi

echo "PASS: All tests passed"
