#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/delegation/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Contains Worktree Enforcement section
if ! grep -q "Worktree Enforcement\|## Worktree Setup" "$SKILL_FILE"; then
    echo "FAIL: Missing Worktree Enforcement/Setup section"
    exit 1
fi

# Test 3: Contains gitignore check
if ! grep -q "gitignore\|git check-ignore" "$SKILL_FILE"; then
    echo "FAIL: Missing gitignore verification"
    exit 1
fi

# Test 4: Contains worktree creation command
if ! grep -q "git worktree add" "$SKILL_FILE"; then
    echo "FAIL: Missing 'git worktree add' command"
    exit 1
fi

# Test 5: Contains state tracking for worktrees
if ! grep -q "worktrees.*state\|state.*worktree" "$SKILL_FILE"; then
    echo "FAIL: Missing worktree state tracking"
    exit 1
fi

# Test 6: Contains MANDATORY or REQUIRED language
if ! grep -q "MANDATORY\|REQUIRED\|MUST" "$SKILL_FILE"; then
    echo "FAIL: Missing enforcement language (MANDATORY/REQUIRED/MUST)"
    exit 1
fi

echo "PASS: All tests passed"
