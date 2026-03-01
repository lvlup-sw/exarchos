#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="skills/implementation-planning"
SKILL_FILE="$SKILL_DIR/SKILL.md"
WORKED_EXAMPLE="$SKILL_DIR/references/worked-example.md"

# Test 1: SKILL.md exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Worked example file exists
if [[ ! -f "$WORKED_EXAMPLE" ]]; then
    echo "FAIL: $WORKED_EXAMPLE does not exist"
    exit 1
fi

# Test 3: SKILL.md links to worked example
if ! grep -q "references/worked-example.md" "$SKILL_FILE"; then
    echo "FAIL: $SKILL_FILE does not link to worked example"
    exit 1
fi

# Test 4: Worked example is under 500 words
WORD_COUNT=$(wc -w < "$WORKED_EXAMPLE")
if [[ "$WORD_COUNT" -ge 500 ]]; then
    echo "FAIL: Worked example is $WORD_COUNT words (must be under 500)"
    exit 1
fi

# Test 5: Worked example has frontmatter
if ! head -1 "$WORKED_EXAMPLE" | grep -q "^---"; then
    echo "FAIL: Worked example missing frontmatter"
    exit 1
fi

echo "PASS: All implementation-planning skill tests passed"
