#!/usr/bin/env bash
set -euo pipefail

PROMPT_FILE="skills/integration/references/integrator-prompt.md"

# Test 1: File exists
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "FAIL: $PROMPT_FILE does not exist"
    exit 1
fi

# Test 2: Contains Working Directory section
if ! grep -q "Working Directory\|## Working" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Working Directory' section"
    exit 1
fi

# Test 3: Contains Branches to Merge section
if ! grep -q "Branches to Merge\|Merge Order" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Branches to Merge' section"
    exit 1
fi

# Test 4: Contains Commands/Steps section
if ! grep -q "Commands\|## Steps\|## Process" "$PROMPT_FILE"; then
    echo "FAIL: Missing Commands/Steps section"
    exit 1
fi

# Test 5: Contains Success Criteria
if ! grep -q "Success Criteria" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Success Criteria' section"
    exit 1
fi

# Test 6: Contains git merge command
if ! grep -q "git merge" "$PROMPT_FILE"; then
    echo "FAIL: Missing git merge command"
    exit 1
fi

# Test 7: Contains test run command
if ! grep -q "npm run test\|test:run" "$PROMPT_FILE"; then
    echo "FAIL: Missing test run command"
    exit 1
fi

# Test 8: Contains On Failure section
if ! grep -q "On Failure\|Failure\|If.*fail" "$PROMPT_FILE"; then
    echo "FAIL: Missing failure handling section"
    exit 1
fi

echo "PASS: All tests passed"
