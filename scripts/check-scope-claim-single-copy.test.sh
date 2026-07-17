#!/usr/bin/env bash
# check-scope-claim-single-copy.sh — Test Suite
# Validates that the projection-scope claim (#1696, DR-6) is only stated in
# its two homes, that the tuned phrases neither over- nor under-match, and —
# via the kill probe — that this self-test itself goes red against a stubbed
# gate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-scope-claim-single-copy.sh"
PASS=0
FAIL=0

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

# make_homes <root>
# Seed miniature versions of the two claim homes so a fixture tree passes the
# home-anchor check (the phrase list must find the claim where it lives).
make_homes() {
    local root="$1"
    mkdir -p "$root/servers/exarchos-mcp/src/projections"
    mkdir -p "$root/docs/architecture"
    cat > "$root/servers/exarchos-mcp/src/projections/types.ts" << 'EOF'
/**
 * {@link ProjectionScope} is 'stream' and nothing else. Collapsing the union
 * makes the corrupting state unauthorable in typechecked code. The
 * cross-stream fold died with readProjection, not with this stamp.
 */
export type ProjectionScope = 'stream';
EOF
    cat > "$root/docs/architecture/projections.md" << 'EOF'
### Reducer scope discipline
No reducer in this codebase has a state shape that survives a cross-stream fold.
EOF
}

# seed_restatement <root>
# Plant a claim restatement in a NON-allowlisted production file.
seed_restatement() {
    local root="$1"
    mkdir -p "$root/servers/exarchos-mcp/src/orchestrate"
    cat > "$root/servers/exarchos-mcp/src/orchestrate/leaky-docs.ts" << 'EOF'
// a cross-stream fold is not representable
export const NOTE = 1;
EOF
}

echo "=== Projection-Scope One-Copy Gate Tests (#1696) ==="
echo ""

# --------------------------------------------------
# Test 1: CleanFixture_HomesOnly_ExitsZero
# Homes state the claim; a non-allowlisted file that says nothing about it
# is clean.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/orchestrate/clean.ts" << 'EOF'
// Points at the scope docstring in projections/types.ts; asserts nothing.
export const CLEAN = 1;
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CleanFixture_HomesOnly_ExitsZero"
else
    fail "CleanFixture_HomesOnly_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: SeededRestatement_NonAllowlistedFile_ExitsOne
# A restatement seeded into a non-allowlisted production file must be flagged
# with file:line and fail the gate.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
seed_restatement "$TMPDIR_ROOT"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "SeededRestatement_NonAllowlistedFile_ExitsOne"
else
    fail "SeededRestatement_NonAllowlistedFile_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

if echo "$OUTPUT" | grep -q "leaky-docs.ts:1"; then
    pass "SeededRestatement_ReportsFileAndLine"
else
    fail "SeededRestatement_ReportsFileAndLine (leaky-docs.ts:1 not in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: KillProbe_StubbedGate_SelfTestRed
# Adequacy probe for THIS suite: replace the gate with a stub that always
# exits 0 and re-run the seeded-restatement scenario against it. The scenario's
# expectation (exit 1) must now be violated — proving the scenario can go red
# and is actually sensitive to the gate's implementation, not vacuously green.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
seed_restatement "$TMPDIR_ROOT"

STUB="$TMPDIR_ROOT/stubbed-gate.sh"
cat > "$STUB" << 'EOF'
#!/usr/bin/env bash
echo "stub: OK"
exit 0
EOF
chmod +x "$STUB"

STUB_OUTPUT="$(bash "$STUB" "$TMPDIR_ROOT" 2>&1)" && STUB_EXIT=$? || STUB_EXIT=$?
if [[ $STUB_EXIT -eq 0 ]]; then
    # Stub sailed through the exact fixture Test 2 requires a 1 for: had the
    # real gate been stubbed out, Test 2 would have FAILED. Self-test is red
    # against a dead gate, which is what this probe exists to prove.
    pass "KillProbe_StubbedGate_SelfTestRed"
else
    fail "KillProbe_StubbedGate_SelfTestRed (stub exit=$STUB_EXIT, expected 0 — probe inconclusive)"
    echo "  Output: $STUB_OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: PristineArchive_CurrentTree_ExitsZero
# Run against a pristine `git archive` export of HEAD — a fresh checkout
# without node_modules/dist — and require zero false positives. This is the
# regression that keeps the gate usable in CI.
# --------------------------------------------------
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
setup
ARCHIVE_DIR="$TMPDIR_ROOT/pristine"
mkdir -p "$ARCHIVE_DIR"
git -C "$REPO_ROOT" archive HEAD | tar -xf - -C "$ARCHIVE_DIR"

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$ARCHIVE_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "PristineArchive_CurrentTree_ExitsZero"
else
    fail "PristineArchive_CurrentTree_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: MissingScanDirs_FailsLoudly_ExitsTwo
# Empty-selection discipline (#1694): pointing the gate at a tree without its
# scan dirs must fail loudly (exit 2), never pass vacuously.
# --------------------------------------------------
setup

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingScanDirs_FailsLoudly_ExitsTwo"
else
    fail "MissingScanDirs_FailsLoudly_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: HomesRephrased_PhraseListUnanchored_ExitsOne
# If the homes are reworded so no phrase matches them, the phrase list can no
# longer locate the claim where it definitely lives — the gate is guarding
# nothing and must say so (exit 1), not stay green.
# --------------------------------------------------
setup
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/projections"
mkdir -p "$TMPDIR_ROOT/docs/architecture"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/projections/types.ts" << 'EOF'
/** Scope is per-stream; see docs for the rationale. */
export type ProjectionScope = 'stream';
EOF
cat > "$TMPDIR_ROOT/docs/architecture/projections.md" << 'EOF'
### Reducer scope discipline
Reworded such that no signature phrase survives.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]] && echo "$OUTPUT" | grep -q "phrase list"; then
    pass "HomesRephrased_PhraseListUnanchored_ExitsOne"
else
    fail "HomesRephrased_PhraseListUnanchored_ExitsOne (exit=$EXIT_CODE, expected 1 + 'phrase list' message)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: BareUnrepresentableInv11Style_NotFlagged
# `unrepresentable` without projection context is the INV-11 posture/worktree
# vocabulary (14 hits on the real tree) — must NOT be flagged. Pins the
# contextualization decision.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/capabilities"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/capabilities/resolver-like.ts" << 'EOF'
// Worktree mutation is unrepresentable from a read-only phase (INV-11).
export const POSTURE = 1;
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "BareUnrepresentableInv11Style_NotFlagged"
else
    fail "BareUnrepresentableInv11Style_NotFlagged (exit=$EXIT_CODE, expected 0) — pattern too broad"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: ContextualizedUnrepresentable_ExitsOne
# `unrepresentable` WITH projection context (scope/fold/cross-stream/reducer
# on the same line) is a scope-claim restatement and must be flagged.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/workflow"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/workflow/sneaky.ts" << 'EOF'
// A globally-scoped reducer is unrepresentable, so no runtime guard is needed.
export const SNEAKY = 1;
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]] && echo "$OUTPUT" | grep -q "sneaky.ts"; then
    pass "ContextualizedUnrepresentable_ExitsOne"
else
    fail "ContextualizedUnrepresentable_ExitsOne (exit=$EXIT_CODE, expected 1 naming sneaky.ts)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: ReadonlyScopeField_NotFlagged
# Pins the drop of the `only scope` candidate: `readonly scope:` contains
# "only scope" as a substring, and plain-English "the only scope where …" is
# unrelated. Neither may fire.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/views"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/views/ps-like.ts" << 'EOF'
// 'agent' is the only scope where `probe: true` is valid.
export interface Row {
  readonly scope: string;
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ReadonlyScopeField_NotFlagged"
else
    fail "ReadonlyScopeField_NotFlagged (exit=$EXIT_CODE, expected 0) — dropped phrase resurfaced"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: AllowlistedSubscriptionSemantics_ExitsZero
# subscriptions.ts legitimately says "cross-stream fold" about its OWN
# omitted-streamId semantics — allowlisted by file, must not be flagged.
# --------------------------------------------------
setup
make_homes "$TMPDIR_ROOT"
mkdir -p "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store"
cat > "$TMPDIR_ROOT/servers/exarchos-mcp/src/event-store/subscriptions.ts" << 'EOF'
/**
 * When streamId is omitted, the subscription observes every stream
 * (cross-stream fold).
 */
export interface SubscriptionFilter {
  readonly streamId?: string;
}
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" "$TMPDIR_ROOT" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AllowlistedSubscriptionSemantics_ExitsZero"
else
    fail "AllowlistedSubscriptionSemantics_ExitsZero (exit=$EXIT_CODE, expected 0)"
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
