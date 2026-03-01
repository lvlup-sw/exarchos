#!/usr/bin/env bash
set -euo pipefail

SKILL_FILE="skills/shepherd/SKILL.md"
FIXES_REF="skills/shepherd/references/fix-strategies.md"
GATE_REF="skills/shepherd/references/gate-event-emission.md"
ESCALATION_REF="skills/shepherd/references/escalation-criteria.md"

FAIL=0

fail() {
    echo "FAIL: $1"
    FAIL=1
}

# Test 1: SKILL.md exists
if [[ ! -f "$SKILL_FILE" ]]; then
    echo "FAIL: $SKILL_FILE does not exist"
    exit 1
fi

# Test 2: Under 2,000 words (R9)
WORD_COUNT=$(wc -w < "$SKILL_FILE" | tr -d ' ')
if (( WORD_COUNT > 2000 )); then
    fail "SKILL.md has $WORD_COUNT words (limit: 2,000)"
fi

# Test 3: Step 0 queries code_quality view (flywheel)
if ! grep -q 'code_quality' "$SKILL_FILE"; then
    fail "Step 0 must query code_quality view (flywheel touchpoint)"
fi

# Test 4: References assess_stack composite action
if ! grep -q 'assess_stack' "$SKILL_FILE"; then
    fail "Must reference assess_stack composite action"
fi

# Test 5: Fix step includes remediation.attempted event (flywheel)
if ! grep -q 'remediation\.attempted' "$SKILL_FILE"; then
    fail "Fix step must reference remediation.attempted event (flywheel)"
fi

# Test 6: Fix step includes remediation.succeeded event (flywheel)
if ! grep -q 'remediation\.succeeded' "$SKILL_FILE"; then
    fail "Fix step must reference remediation.succeeded event (flywheel)"
fi

# Test 7: References gate-event-emission.md
if ! grep -q 'gate-event-emission' "$SKILL_FILE"; then
    fail "Must reference gate-event-emission.md"
fi

# Test 8: Does NOT contain direct CI polling (moved to assess_stack)
if grep -q 'method: "get_status"' "$SKILL_FILE"; then
    fail "Should not contain direct CI polling — moved to assess_stack"
fi

# Test 9: Does NOT contain direct review comment polling (moved to assess_stack)
if grep -q 'method: "get_review_comments"' "$SKILL_FILE"; then
    fail "Should not contain direct review comment polling — moved to assess_stack"
fi

# Test 10: Has 5-step structure (Step 0 through Step 4)
if ! grep -q 'Step 0' "$SKILL_FILE"; then
    fail "Missing Step 0 (Surface Quality Signals)"
fi
if ! grep -q 'Step 1' "$SKILL_FILE"; then
    fail "Missing Step 1 (Assess)"
fi
if ! grep -q 'Step 2' "$SKILL_FILE"; then
    fail "Missing Step 2 (Fix)"
fi
if ! grep -q 'Step 3' "$SKILL_FILE"; then
    fail "Missing Step 3 (Resubmit)"
fi
if ! grep -q 'Step 4' "$SKILL_FILE"; then
    fail "Missing Step 4 (Request Approval)"
fi

# Test 11: References escalation-criteria.md
if ! grep -q 'escalation-criteria' "$SKILL_FILE"; then
    fail "Must reference escalation-criteria.md"
fi

# Test 12: References fix-strategies.md
if ! grep -q 'fix-strategies' "$SKILL_FILE"; then
    fail "Must reference fix-strategies.md"
fi

# Test 13: escalation-criteria.md exists
if [[ ! -f "$ESCALATION_REF" ]]; then
    fail "references/escalation-criteria.md does not exist"
fi

# Test 14: fix-strategies.md contains remediation event emission section
if ! grep -q 'Remediation Event Emission' "$FIXES_REF"; then
    fail "fix-strategies.md must contain Remediation Event Emission section"
fi

# Test 15: fix-strategies.md references remediation.attempted
if ! grep -q 'remediation\.attempted' "$FIXES_REF"; then
    fail "fix-strategies.md must reference remediation.attempted"
fi

# Test 16: fix-strategies.md references remediation.succeeded
if ! grep -q 'remediation\.succeeded' "$FIXES_REF"; then
    fail "fix-strategies.md must reference remediation.succeeded"
fi

# Test 17: gate-event-emission.md exists
if [[ ! -f "$GATE_REF" ]]; then
    fail "references/gate-event-emission.md does not exist"
fi

# Test 18: Uses exarchos_orchestrate for assess_stack (not exarchos_workflow)
if ! grep -q 'exarchos_orchestrate' "$SKILL_FILE"; then
    fail "Must reference exarchos_orchestrate tool"
elif ! grep -q 'action: "assess_stack"' "$SKILL_FILE"; then
    fail "Must use action: assess_stack with exarchos_orchestrate"
fi

if (( FAIL )); then
    exit 1
fi

echo "PASS: All shepherd skill tests passed ($WORD_COUNT words)"
