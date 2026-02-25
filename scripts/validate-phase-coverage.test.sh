#!/usr/bin/env bash
# Validate Phase Coverage — Test Suite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-phase-coverage.sh"
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL + 1)); }

TMPDIR_ROOT=""
setup() { TMPDIR_ROOT="$(mktemp -d)"; }
teardown() { [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]] && rm -rf "$TMPDIR_ROOT"; }

echo "=== Validate Phase Coverage Tests ==="
echo ""

# Test 1: Complete coverage exits 0
setup
mkdir -p "$TMPDIR_ROOT/scripts"
touch "$TMPDIR_ROOT/scripts/post-delegation-check.sh"
touch "$TMPDIR_ROOT/scripts/pre-synthesis-check.sh"
cat > "$TMPDIR_ROOT/playbooks.json" << 'EOF'
{
  "feature:ideate": { "phase": "ideate", "workflowType": "feature", "validationScripts": [] },
  "feature:plan": { "phase": "plan", "workflowType": "feature", "validationScripts": [] },
  "feature:plan-review": { "phase": "plan-review", "workflowType": "feature", "validationScripts": [] },
  "feature:delegate": { "phase": "delegate", "workflowType": "feature", "validationScripts": ["scripts/post-delegation-check.sh"] },
  "feature:review": { "phase": "review", "workflowType": "feature", "validationScripts": [] },
  "feature:synthesize": { "phase": "synthesize", "workflowType": "feature", "validationScripts": ["scripts/pre-synthesis-check.sh"] },
  "feature:completed": { "phase": "completed", "workflowType": "feature", "validationScripts": [] },
  "feature:cancelled": { "phase": "cancelled", "workflowType": "feature", "validationScripts": [] },
  "feature:blocked": { "phase": "blocked", "workflowType": "feature", "validationScripts": [] }
}
EOF
cat > "$TMPDIR_ROOT/phases.json" << 'EOF'
{
  "feature": ["ideate", "plan", "plan-review", "delegate", "review", "synthesize", "completed", "cancelled", "blocked"]
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --playbook-json "$TMPDIR_ROOT/playbooks.json" --phases-json "$TMPDIR_ROOT/phases.json" --scripts-dir "$TMPDIR_ROOT/scripts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then pass "CompleteCoverage_ExitsZero"; else fail "CompleteCoverage_ExitsZero (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

# Test 2: Missing phase exits 1
setup
mkdir -p "$TMPDIR_ROOT/scripts"
cat > "$TMPDIR_ROOT/playbooks.json" << 'EOF'
{
  "feature:ideate": { "phase": "ideate", "workflowType": "feature", "validationScripts": [] },
  "feature:plan": { "phase": "plan", "workflowType": "feature", "validationScripts": [] }
}
EOF
cat > "$TMPDIR_ROOT/phases.json" << 'EOF'
{
  "feature": ["ideate", "plan", "plan-review", "delegate", "review", "synthesize", "completed", "cancelled", "blocked"]
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --playbook-json "$TMPDIR_ROOT/playbooks.json" --phases-json "$TMPDIR_ROOT/phases.json" --scripts-dir "$TMPDIR_ROOT/scripts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then pass "MissingPhase_ExitsOne"; else fail "MissingPhase_ExitsOne (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
if echo "$OUTPUT" | grep -qi "plan-review\|missing"; then pass "MissingPhase_MentionedInOutput"; else fail "MissingPhase_MentionedInOutput"; fi
teardown

# Test 3: Orphaned script exits 1
setup
mkdir -p "$TMPDIR_ROOT/scripts"
touch "$TMPDIR_ROOT/scripts/orphaned-script.sh"
cat > "$TMPDIR_ROOT/playbooks.json" << 'EOF'
{
  "feature:ideate": { "phase": "ideate", "workflowType": "feature", "validationScripts": [] }
}
EOF
cat > "$TMPDIR_ROOT/phases.json" << 'EOF'
{
  "feature": ["ideate"]
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --playbook-json "$TMPDIR_ROOT/playbooks.json" --phases-json "$TMPDIR_ROOT/phases.json" --scripts-dir "$TMPDIR_ROOT/scripts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then pass "OrphanedScript_ExitsOne"; else fail "OrphanedScript_ExitsOne (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
if echo "$OUTPUT" | grep -qi "orphan\|unreferenced\|not referenced"; then pass "OrphanedScript_MentionedInOutput"; else fail "OrphanedScript_MentionedInOutput"; echo "  Output: $OUTPUT"; fi
teardown

# Test 4: Usage error exits 2
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then pass "UsageError_ExitsTwo"; else fail "UsageError_ExitsTwo (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

# Test 5: Missing script reference exits 1
setup
mkdir -p "$TMPDIR_ROOT/scripts"
cat > "$TMPDIR_ROOT/playbooks.json" << 'EOF'
{
  "feature:ideate": { "phase": "ideate", "workflowType": "feature", "validationScripts": ["scripts/nonexistent.sh"] }
}
EOF
cat > "$TMPDIR_ROOT/phases.json" << 'EOF'
{
  "feature": ["ideate"]
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --playbook-json "$TMPDIR_ROOT/playbooks.json" --phases-json "$TMPDIR_ROOT/phases.json" --scripts-dir "$TMPDIR_ROOT/scripts" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then pass "MissingScriptRef_ExitsOne"; else fail "MissingScriptRef_ExitsOne (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
