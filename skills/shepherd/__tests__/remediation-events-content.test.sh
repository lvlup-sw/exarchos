#!/usr/bin/env bash
# Content validation tests for remediation event instructions in shepherd skill
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }

# Test 1: fix-strategies.md contains remediation.attempted event
if grep -q "remediation.attempted" "$SKILL_DIR/references/fix-strategies.md"; then
    pass "FixStrategies_ContainsRemediationAttempted"
else
    fail "FixStrategies_ContainsRemediationAttempted"
fi

# Test 2: fix-strategies.md contains remediation.succeeded event
if grep -q "remediation.succeeded" "$SKILL_DIR/references/fix-strategies.md"; then
    pass "FixStrategies_ContainsRemediationSucceeded"
else
    fail "FixStrategies_ContainsRemediationSucceeded"
fi

# Test 3: fix-strategies.md has Remediation Event Protocol section
if grep -qi "## Remediation Event Protocol" "$SKILL_DIR/references/fix-strategies.md"; then
    pass "FixStrategies_HasRemediationSection"
else
    fail "FixStrategies_HasRemediationSection"
fi

# Test 4: fix-strategies.md contains required fields for attempted (taskId, skill, gateName, attemptNumber, strategy)
MISSING_FIELDS=0
for field in taskId skill gateName attemptNumber strategy; do
    if ! grep -q "$field" "$SKILL_DIR/references/fix-strategies.md"; then
        MISSING_FIELDS=$((MISSING_FIELDS + 1))
    fi
done
if [[ $MISSING_FIELDS -eq 0 ]]; then
    pass "FixStrategies_RemediationAttempted_HasAllFields"
else
    fail "FixStrategies_RemediationAttempted_HasAllFields ($MISSING_FIELDS fields missing)"
fi

# Test 5: fix-strategies.md contains required fields for succeeded (totalAttempts, finalStrategy)
MISSING=0
for field in totalAttempts finalStrategy; do
    if ! grep -q "$field" "$SKILL_DIR/references/fix-strategies.md"; then
        MISSING=$((MISSING + 1))
    fi
done
if [[ $MISSING -eq 0 ]]; then
    pass "FixStrategies_RemediationSucceeded_HasAllFields"
else
    fail "FixStrategies_RemediationSucceeded_HasAllFields ($MISSING fields missing)"
fi

# Test 6: SKILL.md Step 3 references remediation events
if grep -qi "remediation" "$SKILL_DIR/SKILL.md" && grep -qi "fix-strategies" "$SKILL_DIR/SKILL.md"; then
    pass "SkillMd_Step3_ReferencesRemediation"
else
    fail "SkillMd_Step3_ReferencesRemediation"
fi

# Summary
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
    exit 1
else
    exit 0
fi
