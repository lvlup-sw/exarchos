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

# Test 6: Worked example file exists
WORKED_EXAMPLE="skills/spec-review/references/worked-example.md"
if [[ ! -f "$WORKED_EXAMPLE" ]]; then
    echo "FAIL: $WORKED_EXAMPLE does not exist"
    exit 1
fi

# Test 7: SKILL.md links to worked example
if ! grep -q "references/worked-example.md" "$SKILL_FILE"; then
    echo "FAIL: $SKILL_FILE does not link to worked example"
    exit 1
fi

# Test 8: Worked example is under 500 words
WORD_COUNT=$(wc -w < "$WORKED_EXAMPLE")
if [[ "$WORD_COUNT" -ge 500 ]]; then
    echo "FAIL: Worked example is $WORD_COUNT words (must be under 500)"
    exit 1
fi

# Test 9: Worked example has frontmatter
if ! head -1 "$WORKED_EXAMPLE" | grep -q "^---"; then
    echo "FAIL: Worked example missing frontmatter"
    exit 1
fi

echo "PASS: All tests passed"
