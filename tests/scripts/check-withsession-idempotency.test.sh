#!/usr/bin/env bash
# check-withsession-idempotency.test.sh — Test Suite
# Validates that the withSession idempotency CI gate correctly identifies
# call sites missing operationId or allowNonIdempotent: true.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tools/audit/gates" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-withsession-idempotency.sh"
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

# Fixture A: non-compliant — .withSession( with no operationId or allowNonIdempotent
create_fixture_a_noncompliant() {
    cat > "$TMPDIR_ROOT/fixture-a.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';

export async function processEvent(appender: AtomicAppender, streamId: string): Promise<void> {
  const result = await appender.withSession(
    streamId,
    'my-schema@v1',
    async session => {
      session.append({ type: 'task.assigned', data: { taskId: 'T-1' } });
    },
    { registry },
  );
}
EOF
}

# Fixture B: compliant — .withSession( with operationId
create_fixture_b_with_operation_id() {
    cat > "$TMPDIR_ROOT/fixture-b.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';

export async function processEvent(appender: AtomicAppender, streamId: string, opId: string): Promise<void> {
  const result = await appender.withSession(
    streamId,
    'my-schema@v1',
    async session => {
      session.append({ type: 'task.assigned', data: { taskId: 'T-1' } });
    },
    { registry, operationId: 'assign-task:feature-123' },
  );
}
EOF
}

# Fixture C: compliant — .withSession( with allowNonIdempotent: true
create_fixture_c_with_allow_non_idempotent() {
    cat > "$TMPDIR_ROOT/fixture-c.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';

export async function processEvent(appender: AtomicAppender, streamId: string): Promise<void> {
  const result = await appender.withSession(
    streamId,
    'my-schema@v1',
    async session => {
      session.append({ type: 'task.assigned', data: { taskId: 'T-1' } });
    },
    { registry, allowNonIdempotent: true },
  );
}
EOF
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== check-withsession-idempotency.sh Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ScriptExists_IsExecutable
# --------------------------------------------------
if [[ -f "$SCRIPT_UNDER_TEST" && -x "$SCRIPT_UNDER_TEST" ]]; then
    pass "ScriptExists_IsExecutable"
else
    fail "ScriptExists_IsExecutable (script not found or not executable: $SCRIPT_UNDER_TEST)"
fi

# --------------------------------------------------
# Test 2: FixtureA_NoMarkers_ExitsNonZero
# --------------------------------------------------
setup
create_fixture_a_noncompliant
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "FixtureA_NoMarkers_ExitsNonZero"
else
    fail "FixtureA_NoMarkers_ExitsNonZero (exit=$EXIT_CODE, expected non-zero)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: FixtureA_NoMarkers_ReportsOffendingFile
# --------------------------------------------------
setup
create_fixture_a_noncompliant
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -q "fixture-a.ts"; then
    pass "FixtureA_NoMarkers_ReportsOffendingFile"
else
    fail "FixtureA_NoMarkers_ReportsOffendingFile (fixture-a.ts not mentioned in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: FixtureB_WithOperationId_ExitsZero
# --------------------------------------------------
setup
create_fixture_b_with_operation_id
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "FixtureB_WithOperationId_ExitsZero"
else
    fail "FixtureB_WithOperationId_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: FixtureC_WithAllowNonIdempotent_ExitsZero
# --------------------------------------------------
setup
create_fixture_c_with_allow_non_idempotent
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "FixtureC_WithAllowNonIdempotent_ExitsZero"
else
    fail "FixtureC_WithAllowNonIdempotent_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: MixedDir_NonCompliantAndCompliant_ExitsNonZero
# --------------------------------------------------
setup
create_fixture_a_noncompliant
create_fixture_b_with_operation_id
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "MixedDir_NonCompliantAndCompliant_ExitsNonZero"
else
    fail "MixedDir_NonCompliantAndCompliant_ExitsNonZero (exit=$EXIT_CODE, expected non-zero)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: EmptyDir_NoWithSessionCalls_ExitsZero
# --------------------------------------------------
setup
# No files created — empty directory
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "EmptyDir_NoWithSessionCalls_ExitsZero"
else
    fail "EmptyDir_NoWithSessionCalls_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: TestFile_Excluded_ExitsZero
# --------------------------------------------------
# A .test.ts file with a non-compliant .withSession( call must be skipped
setup
cat > "$TMPDIR_ROOT/my-handler.test.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';
// Test files are exempt — they exercise the contract, not implement callers
const result = await appender.withSession(
  streamId,
  'my-schema@v1',
  async session => { session.append({ type: 'task.assigned' }); },
  { registry },
);
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "TestFile_Excluded_ExitsZero"
else
    fail "TestFile_Excluded_ExitsZero (exit=$EXIT_CODE, expected 0 — .test.ts must be exempt)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: UnderscoreTestsDir_Excluded_ExitsZero
# --------------------------------------------------
# A __tests__ file with a non-compliant call must be skipped
setup
mkdir -p "$TMPDIR_ROOT/__tests__"
cat > "$TMPDIR_ROOT/__tests__/my-handler.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';
const result = await appender.withSession(
  streamId,
  'my-schema@v1',
  async session => { session.append({ type: 'task.assigned' }); },
  { registry },
);
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "UnderscoreTestsDir_Excluded_ExitsZero"
else
    fail "UnderscoreTestsDir_Excluded_ExitsZero (exit=$EXIT_CODE, expected 0 — __tests__/ must be exempt)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: AtomicAppenderSubstrate_Excluded_ExitsZero
# --------------------------------------------------
# The substrate implementation file is exempt — it IS the implementation
setup
mkdir -p "$TMPDIR_ROOT/src/event-store"
cat > "$TMPDIR_ROOT/src/event-store/atomic-appender.ts" << 'EOF'
// Substrate implementation — exempt from idempotency marker requirement
export class AtomicAppender {
  async withSession(streamId, reducerId, fn, opts) {
    if (opts?.operationId === undefined && opts?.allowNonIdempotent !== true) {
      throw new InvalidSessionOptionsError();
    }
    // ... implementation ...
  }
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AtomicAppenderSubstrate_Excluded_ExitsZero"
else
    fail "AtomicAppenderSubstrate_Excluded_ExitsZero (exit=$EXIT_CODE, expected 0 — atomic-appender.ts must be exempt)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: CommentedWithSession_DoesNotTriggerFalsePositive
# --------------------------------------------------
# A non-compliant .withSession( commented out (line comment) or
# embedded in a multi-line comment must not trigger a violation.
# Previously the anchor regex matched any `.withSession(` substring,
# even inside `//` or `*` lines — every doc reference produced a
# spurious failure (Sentry finding #14039483).
setup
cat > "$TMPDIR_ROOT/commented-only.ts" << 'EOF'
import { AtomicAppender } from '../event-store/atomic-appender.js';
// Documentation: callers should invoke .withSession( with operationId or allowNonIdempotent.
/**
 * Example:
 *   appender.withSession(streamId, schemaId, fn, { operationId: 'op-1' })
 *   appender.withSession(streamId, schemaId, fn, { allowNonIdempotent: true })
 */
export function noop(): void {
  // intentionally empty — no real .withSession( calls in this file
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CommentedWithSession_DoesNotTriggerFalsePositive"
else
    fail "CommentedWithSession_DoesNotTriggerFalsePositive (exit=$EXIT_CODE, expected 0)"
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
