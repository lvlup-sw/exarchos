#!/usr/bin/env bash
# generate-traceability.sh — Test Suite
# Validates traceability matrix generation from design and plan documents.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/generate-traceability.sh"
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

create_valid_inputs() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Problem Statement

Build a widget system.

## Technical Design

### Widget Component

Renders the main UI.

### API Client

Handles data fetching.

## Testing Strategy

Unit tests for all.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Create Widget Component

Widget rendering layer.

### Task 002: Create API Client

API integration layer.

### Task 003: Add unit tests

Testing coverage.
EOF
    echo "$dir"
}

create_empty_design() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
EOF
    cat > "$dir/plan.md" << 'EOF'
# Plan
### Task 001: Something
EOF
    echo "$dir"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Generate Traceability Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ValidInputs_GeneratesMarkdownTable
# --------------------------------------------------
setup
DIR="$(create_valid_inputs "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidInputs_GeneratesMarkdownTable_ExitsZero"
else
    fail "ValidInputs_GeneratesMarkdownTable_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify markdown table structure (pipe-delimited rows)
if echo "$OUTPUT" | grep -qE "\|.*Design Section.*\|.*Task"; then
    pass "ValidInputs_GeneratesMarkdownTable_HasTableHeader"
else
    fail "ValidInputs_GeneratesMarkdownTable_HasTableHeader (no table header in output)"
    echo "  Output: $OUTPUT"
fi
# Verify design sections appear in output
if echo "$OUTPUT" | grep -q "Widget Component" && echo "$OUTPUT" | grep -q "API Client"; then
    pass "ValidInputs_GeneratesMarkdownTable_ContainsSections"
else
    fail "ValidInputs_GeneratesMarkdownTable_ContainsSections (missing design sections)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: OutputToFile_CreatesFile
# --------------------------------------------------
setup
DIR="$(create_valid_inputs "$TMPDIR_ROOT")"
OUTFILE="$TMPDIR_ROOT/traceability.md"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" --output "$OUTFILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "OutputToFile_CreatesFile_ExitsZero"
else
    fail "OutputToFile_CreatesFile_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if [[ -f "$OUTFILE" ]]; then
    pass "OutputToFile_CreatesFile_FileExists"
else
    fail "OutputToFile_CreatesFile_FileExists (file not created)"
fi
# Verify file contains table
if [[ -f "$OUTFILE" ]] && grep -qE "\|.*Design Section" "$OUTFILE"; then
    pass "OutputToFile_CreatesFile_HasContent"
else
    fail "OutputToFile_CreatesFile_HasContent (file missing table content)"
fi
teardown

# --------------------------------------------------
# Test 3: EmptyDesign_ParseError_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_empty_design "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EmptyDesign_ParseError_ExitsOne"
else
    fail "EmptyDesign_ParseError_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: UsageError_MissingArgs_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "UsageError_MissingArgs_ExitsTwo"
else
    fail "UsageError_MissingArgs_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: HelpFlag_ShowsUsage_ExitsZero
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "HelpFlag_ShowsUsage_ExitsZero"
else
    fail "HelpFlag_ShowsUsage_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "design-file"; then
    pass "HelpFlag_ShowsUsageText"
else
    fail "HelpFlag_ShowsUsageText (no usage text in output)"
fi
teardown

# --------------------------------------------------
# Test 6: MissingDesignFile_ExitsTwo
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Plan
### Task 001: Something
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "/nonexistent/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingDesignFile_ExitsTwo"
else
    fail "MissingDesignFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
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
