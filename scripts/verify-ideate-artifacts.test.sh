#!/usr/bin/env bash
# Verify Ideate Artifacts — Test Suite
# Validates all assertions for scripts/verify-ideate-artifacts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-ideate-artifacts.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Create a complete design document with all required sections and multiple options
create_complete_design() {
    local dir="$1"
    local docs_dir="$dir/docs/designs"
    mkdir -p "$docs_dir"
    cat > "$docs_dir/2026-02-15-test-feature.md" << 'EOF'
# Design: Test Feature

## Problem Statement

We need to solve a complex problem that requires careful design.

## Chosen Approach

We chose Option 2 because it balances flexibility and simplicity.

### Option 1: Simple Approach

**Approach:** A basic implementation with minimal complexity.

**Pros:**
- Easy to implement
- Low risk

**Cons:**
- Limited extensibility

### Option 2: Balanced Approach

**Approach:** A balanced implementation with moderate complexity.

**Pros:**
- Good extensibility
- Moderate risk

**Cons:**
- More code to maintain

### Option 3: Complex Approach

**Approach:** A full-featured implementation.

**Pros:**
- Maximum flexibility

**Cons:**
- High risk
- Longer to implement

## Technical Design

The implementation uses a strategy pattern with injectable handlers.

## Integration Points

Connects to the existing event store via the standard MCP protocol.

## Testing Strategy

Unit tests for each handler, integration tests for the full pipeline.

## Open Questions

- Should we support batch operations in v1?
EOF
    echo "$docs_dir/2026-02-15-test-feature.md"
}

# Create a design document missing the Technical Design section
create_design_missing_section() {
    local dir="$1"
    local docs_dir="$dir/docs/designs"
    mkdir -p "$docs_dir"
    cat > "$docs_dir/2026-02-15-incomplete.md" << 'EOF'
# Design: Incomplete Feature

## Problem Statement

We need to solve a problem.

## Chosen Approach

We chose Option 1.

### Option 1: Simple Approach

Basic implementation.

### Option 2: Complex Approach

Full implementation.

## Integration Points

Connects to existing systems.

## Testing Strategy

Unit tests for everything.

## Open Questions

None yet.
EOF
    echo "$docs_dir/2026-02-15-incomplete.md"
}

# Create a design document with only one option (should fail)
create_single_option_design() {
    local dir="$1"
    local docs_dir="$dir/docs/designs"
    mkdir -p "$docs_dir"
    cat > "$docs_dir/2026-02-15-single-option.md" << 'EOF'
# Design: Single Option Feature

## Problem Statement

We need to solve a problem.

## Chosen Approach

We chose the only approach.

### Option 1: The Only Way

This is the only way to do it.

## Technical Design

Simple implementation.

## Integration Points

Standard integration.

## Testing Strategy

Unit tests.

## Open Questions

None.
EOF
    echo "$docs_dir/2026-02-15-single-option.md"
}

# Create a state file with design path recorded
create_state_with_design() {
    local dir="$1"
    local design_path="$2"
    cat > "$dir/test.state.json" << EOF
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "plan",
  "artifacts": {
    "design": "$design_path"
  }
}
EOF
    echo "$dir/test.state.json"
}

# Create a state file without design path
create_state_without_design() {
    local dir="$1"
    cat > "$dir/test.state.json" << 'EOF'
{
  "version": "1.1",
  "featureId": "test-feature",
  "phase": "ideate",
  "artifacts": {}
}
EOF
    echo "$dir/test.state.json"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Ideate Artifacts Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CompleteDesign_AllSections_ExitsZero
# --------------------------------------------------
setup
DESIGN_FILE="$(create_complete_design "$TMPDIR_ROOT")"
STATE_FILE="$(create_state_with_design "$TMPDIR_ROOT" "$DESIGN_FILE")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --design-file "$DESIGN_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CompleteDesign_AllSections_ExitsZero"
else
    fail "CompleteDesign_AllSections_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: MissingSection_TechnicalDesign_ExitsOne
# --------------------------------------------------
setup
DESIGN_FILE="$(create_design_missing_section "$TMPDIR_ROOT")"
STATE_FILE="$(create_state_with_design "$TMPDIR_ROOT" "$DESIGN_FILE")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --design-file "$DESIGN_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingSection_TechnicalDesign_ExitsOne"
else
    fail "MissingSection_TechnicalDesign_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions missing section
if echo "$OUTPUT" | grep -qi "Technical Design"; then
    pass "MissingSection_TechnicalDesign_MentionedInOutput"
else
    fail "MissingSection_TechnicalDesign_MentionedInOutput (expected 'Technical Design' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: NoDesignDoc_ExitsOne
# --------------------------------------------------
setup
STATE_FILE="$(create_state_without_design "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --docs-dir "$TMPDIR_ROOT/docs/designs" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "NoDesignDoc_ExitsOne"
else
    fail "NoDesignDoc_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: StateFileHasDesignPath_ExitsZero
# --------------------------------------------------
setup
DESIGN_FILE="$(create_complete_design "$TMPDIR_ROOT")"
STATE_FILE="$(create_state_with_design "$TMPDIR_ROOT" "$DESIGN_FILE")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --docs-dir "$TMPDIR_ROOT/docs/designs" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "StateFileHasDesignPath_ExitsZero"
else
    fail "StateFileHasDesignPath_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify state design path check passes
if echo "$OUTPUT" | grep -qi "design path.*PASS\|PASS.*design path\|PASS.*State file"; then
    pass "StateFileHasDesignPath_PassReported"
else
    fail "StateFileHasDesignPath_PassReported (expected PASS for state design path in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: MultipleOptions_Detected_ExitsZero
# --------------------------------------------------
setup
DESIGN_FILE="$(create_complete_design "$TMPDIR_ROOT")"
STATE_FILE="$(create_state_with_design "$TMPDIR_ROOT" "$DESIGN_FILE")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --design-file "$DESIGN_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MultipleOptions_Detected_ExitsZero"
else
    fail "MultipleOptions_Detected_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify options were counted
if echo "$OUTPUT" | grep -qi "option"; then
    pass "MultipleOptions_Detected_MentionedInOutput"
else
    fail "MultipleOptions_Detected_MentionedInOutput (expected 'option' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: SingleOption_ExitsOne
# --------------------------------------------------
setup
DESIGN_FILE="$(create_single_option_design "$TMPDIR_ROOT")"
STATE_FILE="$(create_state_with_design "$TMPDIR_ROOT" "$DESIGN_FILE")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --state-file "$STATE_FILE" --design-file "$DESIGN_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "SingleOption_ExitsOne"
else
    fail "SingleOption_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: UsageError_NoArgs_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_NoArgs_ExitsTwo"
else
    fail "UsageError_NoArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
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
