#!/usr/bin/env bash
set -euo pipefail

# Resolve the prompt relative to this script so the test is robust to cwd and
# to runtime-namespaced render paths (skills/<runtime>/delegation/...). Falls
# back to the legacy flat path when run from inside a single rendered runtime.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/fixer-prompt.md" ]]; then
    PROMPT_FILE="$SCRIPT_DIR/fixer-prompt.md"
else
    PROMPT_FILE="skills/delegation/references/fixer-prompt.md"
fi

# Test 1: File exists
if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "FAIL: $PROMPT_FILE does not exist"
    exit 1
fi

# Test 2: Contains Issue to Fix section
if ! grep -q "Issue to Fix\|Issues* to Fix" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Issue to Fix' section"
    exit 1
fi

# Test 3: Contains Working Directory section
if ! grep -q "Working Directory" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Working Directory' section"
    exit 1
fi

# Test 4: Contains Verification section
if ! grep -q "Verification" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Verification' section"
    exit 1
fi

# Test 5: Contains worktree reference
if ! grep -q "worktree\|\.worktrees" "$PROMPT_FILE"; then
    echo "FAIL: Missing worktree reference"
    exit 1
fi

# Test 6: Contains TDD guidance
if ! grep -q "TDD\|test" "$PROMPT_FILE"; then
    echo "FAIL: Missing TDD/test guidance"
    exit 1
fi

# Test 7: Contains Success Criteria
if ! grep -q "Success Criteria" "$PROMPT_FILE"; then
    echo "FAIL: Missing 'Success Criteria' section"
    exit 1
fi

# Test 8 (#1470): test-running guidance must be toolchain-neutral. The
# hardcoded `npm --prefix` anchored invocation is forbidden, and the bare
# "Run tests: `npm run test:run`" instruction is gone. npm may still appear,
# but only as one example in a documented fallback list.
if grep -q "npm --prefix" "$PROMPT_FILE"; then
    echo "FAIL: prompt hardcodes 'npm --prefix' (must be toolchain-neutral)"
    exit 1
fi
if grep -q 'Run tests: `npm run test:run`' "$PROMPT_FILE"; then
    echo "FAIL: prompt uses bare 'Run tests: npm run test:run' (must be toolchain-neutral)"
    exit 1
fi
if ! grep -qi "project test command" "$PROMPT_FILE"; then
    echo "FAIL: prompt must describe running the project test command"
    exit 1
fi

echo "PASS: All tests passed"
