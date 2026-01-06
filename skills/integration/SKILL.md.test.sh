#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/integration/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Contains Overview section
if ! grep -q "## Overview" "$SKILL_FILE"; then
    echo "FAIL: Missing '## Overview' section"
    exit 1
fi

# Test 3: Contains Triggers section
if ! grep -q "## Triggers" "$SKILL_FILE"; then
    echo "FAIL: Missing '## Triggers' section"
    exit 1
fi

# Test 4: Contains Integration Process section
if ! grep -q "## Integration Process\|## Process" "$SKILL_FILE"; then
    echo "FAIL: Missing Integration Process section"
    exit 1
fi

# Test 5: Contains merge order logic
if ! grep -q "merge.*order\|dependency order" "$SKILL_FILE"; then
    echo "FAIL: Missing merge order logic"
    exit 1
fi

# Test 6: Contains test verification commands
if ! grep -q "npm run test\|test:run" "$SKILL_FILE"; then
    echo "FAIL: Missing test verification commands"
    exit 1
fi

# Test 7: Contains State Management section
if ! grep -q "## State Management" "$SKILL_FILE"; then
    echo "FAIL: Missing '## State Management' section"
    exit 1
fi

# Test 8: Contains Transition section
if ! grep -q "## Transition" "$SKILL_FILE"; then
    echo "FAIL: Missing '## Transition' section"
    exit 1
fi

# Test 9: Contains failure handling
if ! grep -q "FAIL\|failure\|On Fail" "$SKILL_FILE"; then
    echo "FAIL: Missing failure handling"
    exit 1
fi

# Test 10: Contains integration branch reference
if ! grep -q "integration.*branch\|feature/integration" "$SKILL_FILE"; then
    echo "FAIL: Missing integration branch reference"
    exit 1
fi

echo "PASS: All tests passed"
