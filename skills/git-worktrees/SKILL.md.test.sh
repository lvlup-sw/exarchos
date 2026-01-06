#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/git-worktrees/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Contains Validation section
if ! grep -q "## Worktree Validation" "$SKILL_FILE"; then
    echo "FAIL: Missing '## Worktree Validation' section"
    exit 1
fi

# Test 3: Contains pwd verification command
if ! grep -q 'pwd.*grep.*\.worktrees' "$SKILL_FILE"; then
    echo "FAIL: Missing pwd verification command"
    exit 1
fi

# Test 4: Contains abort instructions
if ! grep -q "STOP\|abort\|ERROR" "$SKILL_FILE"; then
    echo "FAIL: Missing abort instructions"
    exit 1
fi

# Test 5: Contains verification function/script
if ! grep -q "verify_worktree\|Verification Script" "$SKILL_FILE"; then
    echo "FAIL: Missing verification function or script"
    exit 1
fi

echo "PASS: All tests passed"
