#!/usr/bin/env bash
set -euo pipefail

PROMPT_FILE="skills/delegation/references/implementer-prompt.md"

# Test 1: File exists
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "FAIL: $PROMPT_FILE does not exist"
    exit 1
fi

# Test 2: Contains CRITICAL Worktree Verification header
if ! grep -q "CRITICAL.*Worktree Verification" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'CRITICAL: Worktree Verification' section"
    exit 1
fi

# Test 3: Contains pwd check instruction
if ! grep -q "pwd" "$PROMPT_FILE"; then
    echo "FAIL: Missing pwd check instruction"
    exit 1
fi

# Test 4: Contains .worktrees verification
if ! grep -q "\.worktrees" "$PROMPT_FILE"; then
    echo "FAIL: Missing .worktrees path verification"
    exit 1
fi

# Test 5: Contains abort/STOP instruction
if ! grep -q "STOP\|abort\|DO NOT proceed" "$PROMPT_FILE"; then
    echo "FAIL: Missing abort instructions"
    exit 1
fi

# Test 6: Contains Commit Strategy section
if ! grep -q "Commit Strategy" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Commit Strategy' section"
    exit 1
fi

# Test 7: Contains git commit instruction
if ! grep -q "git commit" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'git commit' instruction in Commit Strategy"
    exit 1
fi

# Test 8: Contains git push instruction
if ! grep -q "git push" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'git push' instruction in Commit Strategy"
    exit 1
fi

# Test 9: Contains git add instruction
if ! grep -q "git add" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'git add' instruction in Commit Strategy"
    exit 1
fi

# Test 10: Verification appears BEFORE TDD Requirements
TDD_LINE=$(grep -n "TDD Requirements" "$PROMPT_FILE" | head -1 | cut -d: -f1)
VERIFY_LINE=$(grep -n "Worktree Verification" "$PROMPT_FILE" | head -1 | cut -d: -f1)

if [[ -n "$TDD_LINE" && -n "$VERIFY_LINE" ]]; then
    if [[ "$VERIFY_LINE" -gt "$TDD_LINE" ]]; then
        echo "FAIL: Worktree Verification must appear BEFORE TDD Requirements"
        exit 1
    fi
fi

echo "PASS: All tests passed"
