#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="skills/delegation"
SKILL_FILE="$SKILL_DIR/SKILL.md"
REFS_DIR="$SKILL_DIR/references"
ERRORS=0

fail() {
    echo "FAIL: $1"
    ERRORS=$((ERRORS + 1))
}

# ─── Structural Tests ─────────────────────────────────────────────────────────

# Test 1: SKILL.md exists
if [[ ! -f "$SKILL_FILE" ]]; then
    fail "$SKILL_FILE does not exist"
fi

# Test 2: Under 2,000 words (audit-enforced limit)
WORD_COUNT=$(wc -w < "$SKILL_FILE" | tr -d ' ')
if [[ "$WORD_COUNT" -ge 2000 ]]; then
    fail "SKILL.md is $WORD_COUNT words — must be under 2,000"
fi

# Test 3: 3-step structure (Prepare/Dispatch/Monitor)
if ! grep -q "## .*Prepare" "$SKILL_FILE"; then
    fail "Missing Prepare step in 3-step structure"
fi
if ! grep -q "## .*Dispatch" "$SKILL_FILE"; then
    fail "Missing Dispatch step in 3-step structure"
fi
if ! grep -q "## .*Monitor" "$SKILL_FILE"; then
    fail "Missing Monitor step in 3-step structure"
fi

# ─── Composite Action Tests ───────────────────────────────────────────────────

# Test 4: References prepare_delegation composite action
if ! grep -q "prepare_delegation" "$SKILL_FILE"; then
    fail "Missing reference to prepare_delegation composite action"
fi

# Test 5: No direct script invocations (setup-worktree.sh, post-delegation-check.sh)
if grep -q "setup-worktree\.sh" "$SKILL_FILE"; then
    fail "SKILL.md still references setup-worktree.sh (should use prepare_delegation)"
fi
if grep -q "post-delegation-check\.sh" "$SKILL_FILE"; then
    fail "SKILL.md still references post-delegation-check.sh (should use prepare_delegation)"
fi

# ─── R6: streamId → stream fix ────────────────────────────────────────────────

# Test 6: No occurrences of streamId in any .md skill files
BAD_PARAM="stream""Id"
STREAM_ID_FILES=$(grep -rl "$BAD_PARAM" "$SKILL_DIR" --include="*.md" 2>/dev/null || true)
if [[ -n "$STREAM_ID_FILES" ]]; then
    fail "Found '$BAD_PARAM' in skill .md files (R6 — must use 'stream'): $STREAM_ID_FILES"
fi

# ─── R1: Worked example ───────────────────────────────────────────────────────

# Test 7: worked-example.md exists
if [[ ! -f "$REFS_DIR/worked-example.md" ]]; then
    fail "references/worked-example.md does not exist (R1)"
fi

# Test 8: worked-example.md is linked from SKILL.md
if ! grep -q "worked-example" "$SKILL_FILE"; then
    fail "SKILL.md does not link to worked-example.md (R1)"
fi

# ─── R2: Rationalization refutation ───────────────────────────────────────────

# Test 9: rationalization-refutation.md exists
if [[ ! -f "$REFS_DIR/rationalization-refutation.md" ]]; then
    fail "references/rationalization-refutation.md does not exist (R2)"
fi

# Test 10: rationalization-refutation.md is linked from SKILL.md
if ! grep -q "rationalization-refutation" "$SKILL_FILE"; then
    fail "SKILL.md does not link to rationalization-refutation.md (R2)"
fi

# ─── R3: Adversarial posture in fixer-prompt ──────────────────────────────────

# Test 11: fixer-prompt.md has adversarial verification posture
if ! grep -q "Adversarial Verification Posture\|Adversarial.*Posture" "$REFS_DIR/fixer-prompt.md"; then
    fail "fixer-prompt.md missing Adversarial Verification Posture section (R3)"
fi

# ─── C3: Fresh Context Per Task ───────────────────────────────────────────────

# Test 12: Fresh context principle present
if ! grep -qi "fresh.context" "$SKILL_FILE"; then
    fail "Missing 'Fresh Context' principle in SKILL.md (C3)"
fi

# ─── C2: Persuasion-informed writing ──────────────────────────────────────────

# Test 13: Authority references present
if ! grep -qi "Anthropic\|best practice" "$SKILL_FILE"; then
    fail "Missing authority references for persuasion-informed writing (C2)"
fi

# ─── Legacy Tests (preserved) ─────────────────────────────────────────────────

# Test 14: Contains worktree enforcement language
if ! grep -q "MANDATORY\|REQUIRED\|MUST" "$SKILL_FILE"; then
    fail "Missing enforcement language (MANDATORY/REQUIRED/MUST)"
fi

# Test 15: Contains Fix Mode reference
if ! grep -q "Fix Mode\|fix.mode\|--fixes" "$SKILL_FILE"; then
    fail "Missing Fix Mode / --fixes reference"
fi

# Test 16: References fixer-prompt template
if ! grep -q "fixer-prompt" "$SKILL_FILE"; then
    fail "Missing reference to fixer-prompt template"
fi

# Test 17: Contains worktree-related content
if ! grep -q "worktree" "$SKILL_FILE"; then
    fail "Missing worktree references"
fi

# Test 18: Contains git worktree add or worktree setup reference
if ! grep -q "git worktree add\|worktree.*setup\|worktree.*creat\|prepare_delegation" "$SKILL_FILE"; then
    fail "Missing worktree creation mechanism"
fi

# ─── Result ────────────────────────────────────────────────────────────────────

if [[ "$ERRORS" -gt 0 ]]; then
    echo ""
    echo "FAIL: $ERRORS test(s) failed"
    exit 1
fi

echo "PASS: All tests passed"
