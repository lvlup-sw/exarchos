#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/synthesis/SKILL.md"
REF_DIR="skills/synthesis/references"
FAIL=0

fail() {
    echo "FAIL: $1"
    FAIL=1
}

# ─── Structural Tests ──────────────────────────────────────────────────────────

# Test 1: File exists
if [[ ! -f "$SKILL_FILE" ]]; then
    fail "$SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Under 2,000 words
WORD_COUNT=$(wc -w < "$SKILL_FILE" | tr -d ' ')
if (( WORD_COUNT >= 2000 )); then
    fail "SKILL.md is $WORD_COUNT words (must be under 2,000)"
fi

# Test 3: Has valid frontmatter
if ! head -1 "$SKILL_FILE" | grep -q '^---$'; then
    fail "Missing frontmatter opening ---"
fi
if ! sed -n '2,/^---$/p' "$SKILL_FILE" | grep -q '^name: synthesis$'; then
    fail "Missing or incorrect frontmatter name field"
fi

# ─── Composite Action Tests ────────────────────────────────────────────────────

# Test 4: References prepare_synthesis composite action
if ! grep -q "prepare_synthesis" "$SKILL_FILE"; then
    fail "Missing reference to prepare_synthesis composite action"
fi

# Test 5: No direct references to removed scripts
for script in "pre-synthesis-check.sh" "check-benchmark-regression.sh" "reconstruct-stack.sh" "check-coderabbit.sh"; do
    if grep -q "$script" "$SKILL_FILE"; then
        fail "SKILL.md still references removed script: $script"
    fi
done

# ─── 3-Step Structure Tests ────────────────────────────────────────────────────

# Test 6: Has the 3 main steps
if ! grep -q "Verify Readiness" "$SKILL_FILE"; then
    fail "Missing 'Verify Readiness' step"
fi
if ! grep -q "Write PR Descriptions" "$SKILL_FILE"; then
    fail "Missing 'Write PR Descriptions' step"
fi
if ! grep -q "Submit" "$SKILL_FILE"; then
    fail "Missing 'Submit' step"
fi

# ─── Reference File Tests ──────────────────────────────────────────────────────

# Test 7: pr-descriptions.md reference exists
if [[ ! -f "$REF_DIR/pr-descriptions.md" ]]; then
    fail "Missing reference: $REF_DIR/pr-descriptions.md"
fi

# Test 8: merge-ordering.md reference exists
if [[ ! -f "$REF_DIR/merge-ordering.md" ]]; then
    fail "Missing reference: $REF_DIR/merge-ordering.md"
fi

# Test 9: SKILL.md links to reference files
if ! grep -q "references/pr-descriptions.md" "$SKILL_FILE"; then
    fail "SKILL.md does not link to references/pr-descriptions.md"
fi
if ! grep -q "references/merge-ordering.md" "$SKILL_FILE"; then
    fail "SKILL.md does not link to references/merge-ordering.md"
fi

# ─── Content Quality Tests ─────────────────────────────────────────────────────

# Test 10: References integration branch prerequisite
if ! grep -q "integration.*already\|integration.*exist\|prerequisite.*integration\|integration branch" "$SKILL_FILE"; then
    fail "Missing reference to integration branch already existing"
fi

# Test 11: References creating PR
if ! grep -q "PR\|pull request\|create.*PR" "$SKILL_FILE"; then
    fail "Missing reference to creating PR"
fi

# Test 12: References integration passing
if ! grep -q "integration.*pass\|integration.*complete\|after.*integration\|review.*pass\|review.*complete" "$SKILL_FILE"; then
    fail "Missing reference to integration/review phase passing"
fi

# ─── Result ─────────────────────────────────────────────────────────────────────

if (( FAIL )); then
    echo ""
    echo "FAIL: Some tests failed"
    exit 1
fi

echo "PASS: All tests passed (SKILL.md: $WORD_COUNT words)"
