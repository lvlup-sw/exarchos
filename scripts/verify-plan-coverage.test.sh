#!/usr/bin/env bash
# verify-plan-coverage.sh — Test Suite
# Validates cross-referencing of design sections to plan tasks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-plan-coverage.sh"
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

# Design with Technical Design subsections all mapped to tasks
create_full_coverage_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Problem Statement

We need to build a widget system.

## Chosen Approach

Use component-based architecture.

## Technical Design

### Widget Component

Renders the main UI.

### API Client

Handles data fetching.

### State Manager

Manages application state.

## Testing Strategy

Unit tests for all components.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Create Widget Component

Build the widget rendering layer.
Design section: Widget Component

### Task 002: Create API Client

Build the API integration.
Design section: API Client

### Task 003: Create State Manager

Build the state management module.
Design section: State Manager
EOF
    echo "$dir"
}

# Design with a section NOT mapped to any task
create_gap_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Problem Statement

We need a full system.

## Technical Design

### Widget Component

Renders the main UI.

### API Client

Handles data fetching.

### Cache Layer

Caching for performance.

## Testing Strategy

Unit tests needed.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Create Widget Component

Design section: Widget Component

### Task 002: Create API Client

Design section: API Client
EOF
    # Note: Cache Layer has no corresponding task
    echo "$dir"
}

# Empty design file
create_empty_design() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
EOF
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Something

Some task.
EOF
    echo "$dir"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Verify Plan Coverage Tests ==="
echo ""

# --------------------------------------------------
# Test 1: FullCoverage_AllSectionsMapped_ExitsZero
# --------------------------------------------------
setup
DIR="$(create_full_coverage_files "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "FullCoverage_AllSectionsMapped_ExitsZero"
else
    fail "FullCoverage_AllSectionsMapped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: GapFound_MissingSection_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_gap_files "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "GapFound_MissingSection_ExitsOne"
else
    fail "GapFound_MissingSection_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the gap identifies Cache Layer
if echo "$OUTPUT" | grep -qi "Cache Layer"; then
    pass "GapFound_IdentifiesMissingSection"
else
    fail "GapFound_IdentifiesMissingSection (expected 'Cache Layer' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: EmptyDesign_ExitsTwo
# --------------------------------------------------
setup
DIR="$(create_empty_design "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "EmptyDesign_ExitsTwo"
else
    fail "EmptyDesign_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: OutputContainsCoverageMatrix
# --------------------------------------------------
setup
DIR="$(create_full_coverage_files "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$DIR/design.md" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "Design Section.*Task"; then
    pass "OutputContainsCoverageMatrix"
else
    fail "OutputContainsCoverageMatrix (no coverage matrix in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: UsageError_MissingArgs_ExitsTwo
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
# Test 6: HelpFlag_ShowsUsage_ExitsZero
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
# Test 7: MissingDesignFile_ExitsTwo
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

# --------------------------------------------------
# Test 8: NoTasks_EmptyPlan_ExitsOne
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Problem Statement

We need a full system.

## Technical Design

### Widget Component

Renders the main UI.

### API Client

Handles data fetching.

## Testing Strategy

Unit tests needed.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Overview

This plan covers the widget system build-out.

## Schedule

Week 1: Design review
Week 2: Implementation
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "NoTasks_EmptyPlan_ExitsOne"
else
    fail "NoTasks_EmptyPlan_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify error message mentions no tasks found
if echo "$OUTPUT" | grep -qi "No.*Task.*headers"; then
    pass "NoTasks_ErrorMessageMentionsTasks"
else
    fail "NoTasks_ErrorMessageMentionsTasks (expected 'No Task headers' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: verify_plan_coverage_HierarchicalDesign_MatchesSubsectionsNotStreams
# --------------------------------------------------
# Bug: ### stream headers (e.g., "Stream 1: Storage E2E Validation") don't match
# granular task titles. The script should prefer #### subsections when they exist.
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Problem Statement

We need to validate the storage layer.

## Technical Design

### Stream 1: Storage E2E Validation

High-level stream description.

#### Parameterized Backend Contract Tests

Add a test harness that validates storage backends.

#### Concurrent Write Stress Tests

Test concurrent writes under load.

### Stream 2: Query Optimization

High-level query optimization stream.

#### Index Rebuild Logic

Redesign the index rebuild pipeline.

## Testing Strategy

Tests required.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Add parameterized backend contract test suite

Build the test harness for storage backend validation.

### Task 002: Add concurrent write stress tests

Implement stress tests for concurrent writes.

### Task 003: Redesign index rebuild logic

Improve the index rebuild pipeline.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
# With the fix, all #### subsections should match task titles via keyword matching
# Stream-level ### headers should NOT be the units being matched
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "verify_plan_coverage_HierarchicalDesign_MatchesSubsectionsNotStreams"
else
    fail "verify_plan_coverage_HierarchicalDesign_MatchesSubsectionsNotStreams (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify output references subsections, not stream headers
if echo "$OUTPUT" | grep -qi "Parameterized Backend Contract"; then
    pass "HierarchicalDesign_OutputReferencesSubsections"
else
    fail "HierarchicalDesign_OutputReferencesSubsections (expected subsection names in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: verify_plan_coverage_AllSubsectionsCovered_ExitsZero
# --------------------------------------------------
# When all #### subsections are covered, exit 0
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Stream 1: Auth Module

#### Token Validation

Validate JWT tokens.

#### Session Management

Handle user sessions.

## Testing Strategy

Tests.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Implement token validation

Build JWT token validation.

### Task 002: Implement session management

Build session handling.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "verify_plan_coverage_AllSubsectionsCovered_ExitsZero"
else
    fail "verify_plan_coverage_AllSubsectionsCovered_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 11: verify_plan_coverage_MissingSubsection_ExitsOne
# --------------------------------------------------
# When a #### subsection has no matching task, exit 1
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Stream 1: Auth Module

#### Token Validation

Validate JWT tokens.

#### Session Management

Handle user sessions.

#### Rate Limiting

Rate limit API calls.

## Testing Strategy

Tests.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 001: Implement token validation

Build JWT token validation.

### Task 002: Implement session management

Build session handling.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "verify_plan_coverage_MissingSubsection_ExitsOne"
else
    fail "verify_plan_coverage_MissingSubsection_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify the gap identifies Rate Limiting
if echo "$OUTPUT" | grep -qi "Rate Limiting"; then
    pass "MissingSubsection_IdentifiesGap"
else
    fail "MissingSubsection_IdentifiesGap (expected 'Rate Limiting' in output)"
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
