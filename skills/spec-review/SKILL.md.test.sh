#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/spec-review/SKILL.md"

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: References integrated diff
if ! grep -q "integrated diff\|integration.*diff\|main\.\.\.integration\|integration branch" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to integrated diff"
    exit 1
fi

# Test 3: Mentions integration branch in review scope
if ! grep -q "feature/integration\|integration-branch" "$SKILL_FILE"; then
    echo "FAIL: Missing integration branch reference in review scope"
    exit 1
fi

# Test 4: Contains diff generation command for integration
if ! grep -q "git diff.*main.*integration\|review-diff.*integration" "$SKILL_FILE"; then
    echo "FAIL: Missing diff generation command for integration"
    exit 1
fi

# Test 5: Updated review scope mentions complete picture
if ! grep -q "complete\|full picture\|combined\|entire" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to reviewing complete/combined changes"
    exit 1
fi

echo "PASS: All tests passed"
