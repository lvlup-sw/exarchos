#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/synthesis/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Expects integration branch already exists
if ! grep -q "integration branch.*exist\|assume.*integration\|integration.*already\|prerequisite.*integration" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to integration branch already existing"
    exit 1
fi

# Test 3: Does NOT contain primary merge logic (integration handles this now)
# This is an inverse test - we want to ensure merge steps are simplified/moved
if grep -q "### Step 5: Merge Branches" "$SKILL_FILE"; then
    echo "FAIL: Still contains 'Step 5: Merge Branches' - merge should be in integration phase"
    exit 1
fi

# Test 4: References creating PR from integration branch
if ! grep -q "PR.*integration\|pull request.*integration\|create.*PR" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to creating PR from integration branch"
    exit 1
fi

# Test 5: Simplified prerequisite mentions integration passed
if ! grep -q "integration.*pass\|integration.*complete\|after.*integration" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to integration phase passing"
    exit 1
fi

echo "PASS: All tests passed"
