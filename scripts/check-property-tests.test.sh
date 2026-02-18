#!/usr/bin/env bash
# check-property-tests.sh — Test Suite
# Validates that tasks requiring property-based tests actually have PBT patterns.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-property-tests.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# ============================================================
# TEST FIXTURES
# ============================================================

TMPDIR_ROOT=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# ============================================================
# T5: Arg parsing and usage tests
# ============================================================

echo "=== check-property-tests.sh Tests ==="
echo ""

# --------------------------------------------------
# Test 1: exits_2_on_no_args
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "exits_2_on_no_args"
else
    fail "exits_2_on_no_args (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 2: exits_2_on_missing_plan_file
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --worktree-dir /tmp 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "exits_2_on_missing_plan_file"
else
    fail "exits_2_on_missing_plan_file (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 3: exits_2_on_missing_worktree_dir
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file /tmp/plan.json 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "exits_2_on_missing_worktree_dir"
else
    fail "exits_2_on_missing_worktree_dir (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# ============================================================
# T6: Plan JSON extraction tests
# ============================================================

# --------------------------------------------------
# Test 4: exits_0_when_no_tasks_require_pbt
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.json" <<'PLAN'
{
  "tasks": [
    {
      "id": "task-001",
      "title": "Add logging",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": false,
        "benchmarks": false
      }
    },
    {
      "id": "task-002",
      "title": "Update config",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": false,
        "benchmarks": false
      }
    }
  ]
}
PLAN
mkdir -p "$TMPDIR_ROOT/worktree/src"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$TMPDIR_ROOT/plan.json" --worktree-dir "$TMPDIR_ROOT/worktree" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "exits_0_when_no_tasks_require_pbt"
else
    fail "exits_0_when_no_tasks_require_pbt (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: exits_0_when_required_tasks_have_pbt_files
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.json" <<'PLAN'
{
  "tasks": [
    {
      "id": "task-001",
      "title": "Implement parser",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": true,
        "benchmarks": false,
        "properties": ["roundtrip"]
      }
    }
  ]
}
PLAN
mkdir -p "$TMPDIR_ROOT/worktree/src"
# Create a test file with fast-check patterns
cat > "$TMPDIR_ROOT/worktree/src/parser.test.ts" <<'TEST'
import fc from 'fast-check';
import { describe, it } from 'vitest';

describe('parser', () => {
  it.prop([fc.anything()], (input) => {
    fc.assert(fc.property(fc.string(), (s) => {
      return decode(encode(s)) === s;
    }));
  });
});
TEST
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$TMPDIR_ROOT/plan.json" --worktree-dir "$TMPDIR_ROOT/worktree" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "exits_0_when_required_tasks_have_pbt_files"
else
    fail "exits_0_when_required_tasks_have_pbt_files (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# ============================================================
# T7: PBT pattern detection tests
# ============================================================

# --------------------------------------------------
# Test 6: detects_typescript_fast_check_patterns
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.json" <<'PLAN'
{
  "tasks": [
    {
      "id": "task-001",
      "title": "TS parser",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": true,
        "benchmarks": false
      }
    }
  ]
}
PLAN
mkdir -p "$TMPDIR_ROOT/worktree/src"
cat > "$TMPDIR_ROOT/worktree/src/parser.test.ts" <<'TEST'
import { fc } from '@fast-check/vitest';
fc.assert(fc.property(fc.string(), (s) => s.length >= 0));
TEST
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$TMPDIR_ROOT/plan.json" --worktree-dir "$TMPDIR_ROOT/worktree" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "detects_typescript_fast_check_patterns"
else
    fail "detects_typescript_fast_check_patterns (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: detects_dotnet_fscheck_patterns
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.json" <<'PLAN'
{
  "tasks": [
    {
      "id": "task-001",
      "title": ".NET validator",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": true,
        "benchmarks": false
      }
    }
  ]
}
PLAN
mkdir -p "$TMPDIR_ROOT/worktree/src"
cat > "$TMPDIR_ROOT/worktree/src/Validator.Tests.cs" <<'TEST'
using FsCheck;
using FsCheck.Xunit;

[Property]
public void Roundtrip_EncodeDecode(string input)
{
    Prop.ForAll<string>(s => Decode(Encode(s)) == s).QuickCheck();
}
TEST
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$TMPDIR_ROOT/plan.json" --worktree-dir "$TMPDIR_ROOT/worktree" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "detects_dotnet_fscheck_patterns"
else
    fail "detects_dotnet_fscheck_patterns (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# ============================================================
# T8: Cross-reference and failure reporting tests
# ============================================================

# --------------------------------------------------
# Test 8: exits_1_when_required_task_lacks_pbt
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.json" <<'PLAN'
{
  "tasks": [
    {
      "id": "task-001",
      "title": "Implement parser",
      "testingStrategy": {
        "exampleTests": true,
        "propertyTests": true,
        "benchmarks": false
      }
    }
  ]
}
PLAN
mkdir -p "$TMPDIR_ROOT/worktree/src"
# Create a test file WITHOUT any PBT patterns
cat > "$TMPDIR_ROOT/worktree/src/parser.test.ts" <<'TEST'
import { describe, it, expect } from 'vitest';

describe('parser', () => {
  it('should parse input', () => {
    expect(parse('hello')).toBe('hello');
  });
});
TEST
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$TMPDIR_ROOT/plan.json" --worktree-dir "$TMPDIR_ROOT/worktree" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "exits_1_when_required_task_lacks_pbt"
else
    fail "exits_1_when_required_task_lacks_pbt (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions uncovered task IDs
if echo "$OUTPUT" | grep -q "task-001"; then
    pass "exits_1_reports_uncovered_task_id"
else
    fail "exits_1_reports_uncovered_task_id (no task-001 in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"

if [[ $FAIL -gt 0 ]]; then
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
else
    echo ""
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
