#!/usr/bin/env bash
# Validate Phase Names — Test Suite
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-phase-names.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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

echo "=== Validate Phase Names Tests ==="
echo ""

# Test 1: Actual skill docs pass (post-fix)
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$REPO_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then pass "ActualSkillDocs_ExitsZero"; else fail "ActualSkillDocs_ExitsZero (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi

# Test 2: Bad phase-affinity value exits 1
setup
# Create minimal repo structure with skills/ and symlink to real dist/
mkdir -p "$TMPDIR_ROOT/skills/bad-skill"
mkdir -p "$TMPDIR_ROOT/servers"
ln -s "$REPO_ROOT/servers/exarchos-mcp" "$TMPDIR_ROOT/servers/exarchos-mcp"
cat > "$TMPDIR_ROOT/skills/bad-skill/SKILL.md" << 'EOF'
---
name: bad-skill
description: "Test skill with bad phase-affinity"
metadata:
  phase-affinity:
    - implement
    - validate
---

# Bad Skill
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then pass "BadPhaseAffinity_ExitsOne"; else fail "BadPhaseAffinity_ExitsOne (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
if echo "$OUTPUT" | grep -q "implement"; then pass "BadPhaseAffinity_ReportsPhase"; else fail "BadPhaseAffinity_ReportsPhase"; echo "  Output: $OUTPUT"; fi
teardown

# Test 3: Single-value phase-affinity with bad value exits 1
setup
mkdir -p "$TMPDIR_ROOT/skills/bad-single"
mkdir -p "$TMPDIR_ROOT/servers"
ln -s "$REPO_ROOT/servers/exarchos-mcp" "$TMPDIR_ROOT/servers/exarchos-mcp"
cat > "$TMPDIR_ROOT/skills/bad-single/SKILL.md" << 'EOF'
---
name: bad-single
description: "Test"
metadata:
  phase-affinity: cleanup
---

# Bad Single
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then pass "BadSingleAffinity_ExitsOne"; else fail "BadSingleAffinity_ExitsOne (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

# Test 4: Good phase-affinity values pass
setup
mkdir -p "$TMPDIR_ROOT/skills/good-skill"
mkdir -p "$TMPDIR_ROOT/servers"
ln -s "$REPO_ROOT/servers/exarchos-mcp" "$TMPDIR_ROOT/servers/exarchos-mcp"
cat > "$TMPDIR_ROOT/skills/good-skill/SKILL.md" << 'EOF'
---
name: good-skill
description: "Test"
metadata:
  phase-affinity:
    - triage
    - debug-implement
    - hotfix-validate
---

# Good Skill
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then pass "GoodPhaseAffinity_ExitsZero"; else fail "GoodPhaseAffinity_ExitsZero (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

# Test 5: Usage error exits 2
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then pass "UsageError_ExitsTwo"; else fail "UsageError_ExitsTwo (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi

# Test 6: Test fixtures are skipped
setup
mkdir -p "$TMPDIR_ROOT/skills/test-fixtures/bad-fixture"
mkdir -p "$TMPDIR_ROOT/servers"
ln -s "$REPO_ROOT/servers/exarchos-mcp" "$TMPDIR_ROOT/servers/exarchos-mcp"
cat > "$TMPDIR_ROOT/skills/test-fixtures/bad-fixture/SKILL.md" << 'EOF'
---
name: bad-fixture
description: "Test"
metadata:
  phase-affinity: testing
---

# Fixture
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --repo-root "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then pass "TestFixtures_Skipped"; else fail "TestFixtures_Skipped (exit=$EXIT_CODE)"; echo "  Output: $OUTPUT"; fi
teardown

echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
[[ $FAIL -gt 0 ]] && exit 1 || exit 0
