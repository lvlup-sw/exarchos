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

# --------------------------------------------------
# Test 12: DeferredSection_InTraceability_ExitsZero
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Component A

Build the A component.

### Component B

Build the B component.

## Testing Strategy

Tests needed.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Spec Traceability

### Traceability Matrix

| Design Section | Task ID(s) | Status |
|----------------|-----------|--------|
| Component A | T001 | Covered |
| Component B | Deferred | Operational process, not code. |

## Tasks

### Task 001: Build component A

Implement the A component.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "DeferredSection_InTraceability_ExitsZero"
else
    fail "DeferredSection_InTraceability_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 13: DeferredSection_ShownAsDeferredInMatrix
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Component A

Build the A component.

### Component B

Build the B component.

## Testing Strategy

Tests needed.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Spec Traceability

### Traceability Matrix

| Design Section | Task ID(s) | Status |
|----------------|-----------|--------|
| Component A | T001 | Covered |
| Component B | Deferred | Operational process. |

## Tasks

### Task 001: Build component A

Implement the A component.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qi "Component B.*Deferred"; then
    pass "DeferredSection_ShownAsDeferredInMatrix"
else
    fail "DeferredSection_ShownAsDeferredInMatrix (expected 'Component B' with 'Deferred' status)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 14: MixedDeferredAndCovered_ExitsZero
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Auth Module

Build auth.

### Cache Layer

Build cache.

### Monitoring

Add monitoring.

## Testing Strategy

Tests needed.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Spec Traceability

### Traceability Matrix

| Design Section | Task ID(s) | Status |
|----------------|-----------|--------|
| Auth Module | T001 | Covered |
| Cache Layer | T002 | Covered |
| Monitoring | Deferred | Will add in Phase 2. |

## Tasks

### Task 001: Implement auth module

Build authentication.

### Task 002: Implement cache layer

Build caching.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MixedDeferredAndCovered_ExitsZero"
else
    fail "MixedDeferredAndCovered_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 15: DeferredAndGap_ExitsOne
# --------------------------------------------------
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature Design

## Technical Design

### Auth Module

Build auth.

### Cache Layer

Build cache.

### Rate Limiting

Add rate limits.

## Testing Strategy

Tests needed.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Spec Traceability

### Traceability Matrix

| Design Section | Task ID(s) | Status |
|----------------|-----------|--------|
| Auth Module | T001 | Covered |
| Cache Layer | Deferred | Phase 2 work. |

## Tasks

### Task 001: Implement auth module

Build authentication.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DeferredAndGap_ExitsOne"
else
    fail "DeferredAndGap_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify Rate Limiting is identified as the gap (not Cache Layer)
if echo "$OUTPUT" | grep -qi "Rate Limiting"; then
    pass "DeferredAndGap_IdentifiesCorrectGap"
else
    fail "DeferredAndGap_IdentifiesCorrectGap (expected 'Rate Limiting' in gaps)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 16: DesignRequirements_DRHeaders_ExitsZero
# --------------------------------------------------
# Design doc uses "## Design Requirements" with "### DR-N" headers
# instead of "## Technical Design"
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Release Hardening

## Problem Statement

Preparing for public release.

## Design Requirements

### DR-1: Sensitive Document Removal

Remove internal docs.

### DR-2: Reference Scrub

Scrub internal references.

### DR-3: CI Hardening

Add required status checks.

## Out of Scope

Not doing semantic-release.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Sensitive document removal and gitignore hardening

Implements DR-1. Move sensitive documents to other repo and remove from this one.

### Task 2: Reference scrub across docs

Implements DR-2. Scrub and replace internal reference URLs.

### Task 3: CI hardening and branch protection

Implements DR-3. Add required CI status checks and branch protection rules.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "DesignRequirements_DRHeaders_ExitsZero"
else
    fail "DesignRequirements_DRHeaders_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 17: DesignRequirements_GapFound_ExitsOne
# --------------------------------------------------
# Design doc uses "## Design Requirements" but a DR-N section has no matching task
setup
cat > "$TMPDIR_ROOT/design.md" << 'EOF'
# Feature

## Design Requirements

### DR-1: Widget Component

Build widget.

### DR-2: Cache Layer

Build cache.

### DR-3: Monitoring Dashboard

Add monitoring.
EOF

cat > "$TMPDIR_ROOT/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build widget component

Widget implementation.

### Task 2: Build cache layer

Cache implementation.
EOF

OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "DesignRequirements_GapFound_ExitsOne"
else
    fail "DesignRequirements_GapFound_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "Monitoring"; then
    pass "DesignRequirements_IdentifiesGap"
else
    fail "DesignRequirements_IdentifiesGap (expected 'Monitoring' in output)"
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
