#!/usr/bin/env bash
set -euo pipefail

PROMPT_FILE="skills/delegation/references/fixer-prompt.md"

# Test 1: File exists
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "FAIL: $PROMPT_FILE does not exist"
    exit 1
fi

# Test 2: Contains Issue to Fix section
if ! grep -q "Issue to Fix\|Issues* to Fix" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Issue to Fix' section"
    exit 1
fi

# Test 3: Contains Working Directory section
if ! grep -q "Working Directory" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Working Directory' section"
    exit 1
fi

# Test 4: Contains Verification section
if ! grep -q "Verification" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Verification' section"
    exit 1
fi

# Test 5: Contains worktree reference
if ! grep -q "worktree\|\.worktrees" "$PROMPT_FILE"; then
    echo "FAIL: Missing worktree reference"
    exit 1
fi

# Test 6: Contains TDD guidance
if ! grep -q "TDD\|test" "$PROMPT_FILE"; then
    echo "FAIL: Missing TDD/test guidance"
    exit 1
fi

# Test 7: Contains Success Criteria
if ! grep -q "Success Criteria" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Success Criteria' section"
    exit 1
fi

echo "PASS: All tests passed"
