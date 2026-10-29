#!/usr/bin/env bash
# Tests for the withSession idempotency CI gate. The gate must find each call
# site that has neither `operationId` nor `allowNonIdempotent: true`.

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
    create_substrate_stub
}

# Every scan needs the exempt substrate, because the gate refuses to judge a
# tree that does not define the guarded API.
create_substrate_stub() {
    mkdir -p "$TMPDIR_ROOT/src/events"
    cat > "$TMPDIR_ROOT/src/events/atomic-appender.ts" << 'EOF'
export class AtomicAppender {
  async withSession<TState>(streamId: string, reducerId: string, fn: unknown, opts?: unknown) {
    return undefined;
  }
}
EOF
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
# Test 2: FixtureA_NoMarkers_ExitsOne
# --------------------------------------------------
setup
create_fixture_a_noncompliant
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "FixtureA_NoMarkers_ExitsOne"
else
    fail "FixtureA_NoMarkers_ExitsOne (exit=$EXIT_CODE, expected 1)"
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
# Test 6: MixedDir_NonCompliantAndCompliant_ExitsOne
# --------------------------------------------------
setup
create_fixture_a_noncompliant
create_fixture_b_with_operation_id
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MixedDir_NonCompliantAndCompliant_ExitsOne"
else
    fail "MixedDir_NonCompliantAndCompliant_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: NoCallSites_ExitsZeroAndReportsTheCount
# --------------------------------------------------
setup
# Only the substrate stub exists, so the scan finds no call site.
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]] && echo "$OUTPUT" | grep -q "0 .withSession( call site"; then
    pass "NoCallSites_ExitsZeroAndReportsTheCount"
else
    fail "NoCallSites_ExitsZeroAndReportsTheCount (exit=$EXIT_CODE, expected 0 and a zero count)"
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
cat > "$TMPDIR_ROOT/src/events/atomic-appender.ts" << 'EOF'
export class AtomicAppender {
  async withSession(streamId, reducerId, fn, opts) {
    if (opts?.operationId === undefined && opts?.allowNonIdempotent !== true) {
      throw new InvalidSessionOptionsError();
    }
  }
  async retry(streamId, reducerId, fn) {
    return this.withSession(
      streamId,
      reducerId,
      fn,
      { registry },
    );
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
# A non-compliant .withSession( in a line comment or in a multi-line comment
# must not be a violation. A documentation reference is not a call site.
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

# --------------------------------------------------
# Test 12: MissingSubstrate_ExitsTwo
# --------------------------------------------------
# A stale exemption path leaves the gate with no API to guard.
setup
rm -f "$TMPDIR_ROOT/src/events/atomic-appender.ts"
create_fixture_b_with_operation_id
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingSubstrate_ExitsTwo"
else
    fail "MissingSubstrate_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 13: SubstrateWithoutWithSession_ExitsTwo
# --------------------------------------------------
# A renamed API leaves every call-site scan vacuous.
setup
cat > "$TMPDIR_ROOT/src/events/atomic-appender.ts" << 'EOF'
export class AtomicAppender {
  async runSession(streamId: string) {
    return undefined;
  }
}
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "SubstrateWithoutWithSession_ExitsTwo"
else
    fail "SubstrateWithoutWithSession_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 14: MissingScanDir_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "/nonexistent-withsession-scan-dir" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingScanDir_ExitsTwo"
else
    fail "MissingScanDir_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

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
