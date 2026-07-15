#!/usr/bin/env bash
# check-begin-immediate-substrate.sh — Test Suite
# Validates that BEGIN IMMEDIATE is only used inside the storage substrate
# directories, not in application code.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-begin-immediate-substrate.sh"
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
# TEST CASES
# ============================================================

echo "=== BEGIN IMMEDIATE Substrate Gate Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ViolationOutsideSubstrate_ExitsNonZero
# A .ts file in application code (not storage/ or event-store/) containing
# BEGIN IMMEDIATE must be flagged as a layering violation.
# --------------------------------------------------
setup

# Fixture A: application-level code leaking the substrate primitive
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/run-step.ts" << 'EOF'
// Application orchestration — should NOT use substrate primitives directly
export async function runStep(db: Database, fn: () => Promise<void>) {
  await db.run(`BEGIN IMMEDIATE`);
  await fn();
  await db.run("COMMIT");
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "ViolationOutsideSubstrate_ExitsNonZero"
else
    fail "ViolationOutsideSubstrate_ExitsNonZero (exit=$EXIT_CODE, expected non-zero)"
    echo "  Output: $OUTPUT"
fi

# Verify the output names the offending file
if echo "$OUTPUT" | grep -q "run-step.ts"; then
    pass "ViolationOutsideSubstrate_ReportsOffendingFile"
else
    fail "ViolationOutsideSubstrate_ReportsOffendingFile (offending file not named in output)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 2: AllowedInStorageSubstrate_ExitsZero
# A .ts file inside storage/ may legitimately use BEGIN IMMEDIATE.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/storage"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/storage/sqlite-substrate.ts" << 'EOF'
// Storage substrate — BEGIN IMMEDIATE is the WAL write-ownership primitive
export async function withWriteLock(db: Database, fn: () => Promise<void>) {
  await db.run("BEGIN IMMEDIATE");
  try {
    await fn();
    await db.run("COMMIT");
  } catch (e) {
    await db.run("ROLLBACK");
    throw e;
  }
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllowedInStorageSubstrate_ExitsZero"
else
    fail "AllowedInStorageSubstrate_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 3: AllowedInEventStoreSubstrate_ExitsZero
# A .ts file inside event-store/ may legitimately use BEGIN IMMEDIATE.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store/append.ts" << 'EOF'
// Event store append path — uses BEGIN IMMEDIATE for write serialization
export async function appendEvent(db: Database, event: Event) {
  await db.run(`BEGIN IMMEDIATE`);
  await db.run("INSERT INTO events ...");
  await db.run("COMMIT");
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllowedInEventStoreSubstrate_ExitsZero"
else
    fail "AllowedInEventStoreSubstrate_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 4: TestFilesExempted_ExitsZero
# Test files (*.test.ts) outside substrate dirs may reference BEGIN IMMEDIATE
# in assertions or fixtures without triggering a violation.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/run-step.test.ts" << 'EOF'
// Integration test — may reference BEGIN IMMEDIATE in assertion strings
import { expect, it } from 'vitest';
it('does not emit BEGIN IMMEDIATE from application layer', () => {
  // This test verifies the string "BEGIN IMMEDIATE" never appears in app code
  expect(appLayerSql).not.toContain('BEGIN IMMEDIATE');
});
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "TestFilesExempted_ExitsZero"
else
    fail "TestFilesExempted_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 5: MultipleViolations_ReportsAll_ExitsNonZero
# When multiple files outside substrate dirs contain BEGIN IMMEDIATE,
# all violations are reported.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/view"

cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/step-a.ts" << 'EOF'
export async function stepA(db: Database) {
  await db.run("BEGIN IMMEDIATE");
}
EOF

cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/view/materialize.ts" << 'EOF'
export async function materialize(db: Database) {
  await db.run(`BEGIN IMMEDIATE`);
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "MultipleViolations_ExitsNonZero"
else
    fail "MultipleViolations_ExitsNonZero (exit=$EXIT_CODE, expected non-zero)"
    echo "  Output: $OUTPUT"
fi

if echo "$OUTPUT" | grep -q "step-a.ts" && echo "$OUTPUT" | grep -q "materialize.ts"; then
    pass "MultipleViolations_ReportsBothFiles"
else
    fail "MultipleViolations_ReportsBothFiles (not all violations named in output)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 6: NoMatches_ExitsZero
# A clean directory with no BEGIN IMMEDIATE at all exits 0.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/clean.ts" << 'EOF'
// No substrate primitives here — uses the withSession abstraction
export async function runClean() {
  return "ok";
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "NoMatches_ExitsZero"
else
    fail "NoMatches_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 7: ImmediateCallOutsideSubstrate_ExitsNonZero
# `.immediate()` is the REAL primitive (bun:sqlite exposes
# `db.transaction(fn).immediate()` to open a BEGIN IMMEDIATE txn). Application
# code calling it directly is a layering violation, even though the literal
# string "BEGIN IMMEDIATE" never appears.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/leaky-step.ts" << 'EOF'
// Application orchestration — reaches for the substrate txn primitive directly.
// Note: the literal string "BEGIN IMMEDIATE" never appears here, so the
// legacy literal-only check could not catch this.
export function leakyStep(db: Database, fn: () => void) {
  const txn = db.transaction(fn);
  txn.immediate();
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -ne 0 ]]; then
    pass "ImmediateCallOutsideSubstrate_ExitsNonZero"
else
    fail "ImmediateCallOutsideSubstrate_ExitsNonZero (exit=$EXIT_CODE, expected non-zero)"
    echo "  Output: $OUTPUT"
fi

if echo "$OUTPUT" | grep -q "leaky-step.ts"; then
    pass "ImmediateCallOutsideSubstrate_ReportsOffendingFile"
else
    fail "ImmediateCallOutsideSubstrate_ReportsOffendingFile (offending file not named)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 8: ImmediateCallInStorageSubstrate_ExitsZero
# The substrate itself legitimately calls `.immediate()`. This mirrors the real
# call site at servers/exarchos-mcp/src/storage/sqlite-backend.ts:1852.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/storage"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/storage/sqlite-backend.ts" << 'EOF'
// Storage substrate — legitimate owner of the immediate-txn primitive.
export function allocateSequence(db: Database, fn: () => void) {
  const txn = db.transaction(fn);
  const txnUnknown = txn as unknown as { immediate: (...a: unknown[]) => void };
  const runOnce = (): void => {
    txnUnknown.immediate();
  };
  runOnce();
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ImmediateCallInStorageSubstrate_ExitsZero"
else
    fail "ImmediateCallInStorageSubstrate_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 9: ImmediateCallInEventStoreSubstrate_ExitsZero
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store/atomic-appender.ts" << 'EOF'
export function appendAtomic(db: Database, fn: () => void) {
  db.transaction(fn).immediate();
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ImmediateCallInEventStoreSubstrate_ExitsZero"
else
    fail "ImmediateCallInEventStoreSubstrate_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 10: ImmediateCallInComment_ExitsZero
# Documentation outside the substrate that *mentions* `.immediate()` is not a
# use of it — no false positive on comment lines.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/workflow"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/workflow/state-retry.ts" << 'EOF'
/**
 * Retry wrapper. The substrate opens its write txn via
 * `db.transaction(fn).immediate()`; this layer never does that itself.
 */
// See also: transaction(fn).immediate() in the storage backend.
export function withStateRetry(fn: () => void) {
  return fn();
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ImmediateCallInComment_ExitsZero"
else
    fail "ImmediateCallInComment_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 11: ImmediateCallExemptedInTestFiles_ExitsZero
# *.test.ts outside the substrate may drive `.immediate()` on a stub/mock.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/fake-driver.test.ts" << 'EOF'
import { it, vi } from 'vitest';
it('stubs the driver txn shape', () => {
  const txn = { immediate: vi.fn() };
  txn.immediate();
});
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ImmediateCallExemptedInTestFiles_ExitsZero"
else
    fail "ImmediateCallExemptedInTestFiles_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 12: SetImmediateNotMatched_ExitsZero
# `setImmediate(` / `.setImmediate(` must not be mistaken for the substrate
# primitive — guards against an over-broad pattern.
# --------------------------------------------------
setup

mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/scheduler.ts" << 'EOF'
import timers from 'node:timers';
export function schedule(fn: () => void) {
  setImmediate(fn);
  timers.setImmediate(fn);
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "SetImmediateNotMatched_ExitsZero"
else
    fail "SetImmediateNotMatched_ExitsZero (exit=$EXIT_CODE, expected 0) — pattern too broad"
    echo "  Output: $OUTPUT"
fi

teardown

# --------------------------------------------------
# Test 13: RealTree_ExitsZero_NoFalsePositives
# The gate must be clean against the actual repository as it stands, with no
# false positive on the legitimate in-substrate `.immediate()` call at
# servers/exarchos-mcp/src/storage/sqlite-backend.ts nor on any comment line.
# This is the regression that keeps the gate usable in CI.
# --------------------------------------------------
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$REPO_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "RealTree_ExitsZero_NoFalsePositives"
else
    fail "RealTree_ExitsZero_NoFalsePositives (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

if echo "$OUTPUT" | grep -q "sqlite-backend.ts"; then
    fail "RealTree_NoFalsePositiveOnSubstrateCallSite (sqlite-backend.ts flagged)"
    echo "  Output: $OUTPUT"
else
    pass "RealTree_NoFalsePositiveOnSubstrateCallSite"
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
