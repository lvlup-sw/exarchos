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

SKILL_DIR="skills/spec-review"
REFUTATION_FILE="$SKILL_DIR/references/rationalization-refutation.md"
CHECKLIST_FILE="$SKILL_DIR/references/review-checklist.md"

# Test 10: Rationalization refutation reference exists
if [[ ! -f "$REFUTATION_FILE" ]]; then
    echo "FAIL: $REFUTATION_FILE does not exist"
    exit 1
fi

# Test 11: Refutation file has at least 5 table rows (pipe-delimited, excluding header/separator)
ROW_COUNT=$(grep -cE '^\|[^-]' "$REFUTATION_FILE" | head -1)
TABLE_ROWS=$((ROW_COUNT - 1))
if [[ "$TABLE_ROWS" -lt 5 ]]; then
    echo "FAIL: Refutation file has $TABLE_ROWS entries, need at least 5"
    exit 1
fi

# Test 12: SKILL.md links to rationalization-refutation.md
if ! grep -q 'references/rationalization-refutation\.md' "$SKILL_FILE"; then
    echo "FAIL: SKILL.md does not link to references/rationalization-refutation.md"
    exit 1
fi

# Test 13: Refutation file has the expected table columns
if ! grep -q 'Rationalization.*Counter-argument.*What to do instead' "$REFUTATION_FILE"; then
    echo "FAIL: Refutation file missing expected table columns"
    exit 1
fi

# Test 14: Adversarial review posture section exists in review-checklist.md
if ! grep -q '## Adversarial Review Posture' "$CHECKLIST_FILE"; then
    echo "FAIL: Missing Adversarial Review Posture section in review-checklist.md"
    exit 1
fi

# Test 15: Adversarial posture appears before Automated Verification
POSTURE_LINE=$(grep -n 'Adversarial Review Posture' "$CHECKLIST_FILE" | head -1 | cut -d: -f1)
AUTOMATED_LINE=$(grep -n 'Automated Verification' "$CHECKLIST_FILE" | head -1 | cut -d: -f1)
if [[ "$POSTURE_LINE" -ge "$AUTOMATED_LINE" ]]; then
    echo "FAIL: Adversarial Review Posture must appear before Automated Verification"
    exit 1
fi

echo "PASS: All tests passed"
