#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/quality-review/SKILL.md"

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
    echo "FAIL: Missing integration branch reference"
    exit 1
fi

# Test 4: Contains diff generation command for integration
if ! grep -q "git diff.*main.*integration\|review-diff.*integration" "$SKILL_FILE"; then
    echo "FAIL: Missing diff generation command for integration"
    exit 1
fi

# Test 5: Mentions reviewing complete/combined changes
if ! grep -q "complete\|full picture\|combined\|entire" "$SKILL_FILE"; then
    echo "FAIL: Missing reference to reviewing complete/combined changes"
    exit 1
fi

SKILL_DIR="skills/quality-review"
REFUTATION_FILE="$SKILL_DIR/references/rationalization-refutation.md"
CHECKLIST_FILE="$SKILL_DIR/references/code-quality-checklist.md"

# Test 6: Rationalization refutation reference exists
if [[ ! -f "$REFUTATION_FILE" ]]; then
    echo "FAIL: $REFUTATION_FILE does not exist"
    exit 1
fi

# Test 7: Refutation file has at least 5 table rows (pipe-delimited, excluding header/separator)
ROW_COUNT=$(grep -cE '^\|[^-]' "$REFUTATION_FILE" | head -1)
TABLE_ROWS=$((ROW_COUNT - 1))
if [[ "$TABLE_ROWS" -lt 5 ]]; then
    echo "FAIL: Refutation file has $TABLE_ROWS entries, need at least 5"
    exit 1
fi

# Test 8: SKILL.md links to rationalization-refutation.md
if ! grep -q 'references/rationalization-refutation\.md' "$SKILL_FILE"; then
    echo "FAIL: SKILL.md does not link to references/rationalization-refutation.md"
    exit 1
fi

# Test 9: Refutation file has the expected table columns
if ! grep -q 'Rationalization.*Counter-argument.*What to do instead' "$REFUTATION_FILE"; then
    echo "FAIL: Refutation file missing expected table columns"
    exit 1
fi

# Test 10: Adversarial review posture section exists in code-quality-checklist.md
if ! grep -q '## Adversarial Review Posture' "$CHECKLIST_FILE"; then
    echo "FAIL: Missing Adversarial Review Posture section in code-quality-checklist.md"
    exit 1
fi

# Test 11: Adversarial posture appears before "## 1. Code Quality"
POSTURE_LINE=$(grep -n 'Adversarial Review Posture' "$CHECKLIST_FILE" | head -1 | cut -d: -f1)
QUALITY_LINE=$(grep -n '## 1\. Code Quality' "$CHECKLIST_FILE" | head -1 | cut -d: -f1)
if [[ "$POSTURE_LINE" -ge "$QUALITY_LINE" ]]; then
    echo "FAIL: Adversarial Review Posture must appear before ## 1. Code Quality"
    exit 1
fi

echo "PASS: All tests passed"
