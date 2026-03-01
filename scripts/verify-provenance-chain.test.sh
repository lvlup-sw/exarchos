#!/usr/bin/env bash
# verify-provenance-chain.sh — Test Suite
# Validates cross-referencing of design DR-N identifiers to plan task Implements: fields.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/verify-provenance-chain.sh"
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
# FIXTURE CREATORS
# ============================================================

create_full_coverage_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Problem Statement

We need a widget system.

## Technical Design

### Widget Component

DR-1: Renders the main UI widget.

### API Client

DR-2: Handles data fetching from the backend.

### State Manager

DR-3: Manages application state lifecycle.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Widget Component

**Implements:** DR-1

Build the core widget rendering component.

### Task 2: Create API Client

**Implements:** DR-2

Set up the API client with fetch wrappers.

### Task 3: Implement State Manager

**Implements:** DR-3

Create the state management layer.
EOF
}

create_partial_coverage_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Auth Module

DR-1: Authentication flow.

### Session Manager

DR-2: Session lifecycle management.

### Audit Logger

DR-3: Audit log capture.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Auth Module

**Implements:** DR-1

Implement the auth flow.

### Task 2: Create Session Manager

**Implements:** DR-2

Build session handling.
EOF
}

create_orphan_reference_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Component A

DR-1: First requirement.

### Component B

DR-2: Second requirement.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Component A

**Implements:** DR-1

Build component A.

### Task 2: Build Component B

**Implements:** DR-2, DR-99

Build component B with a reference to a non-existent requirement.
EOF
}

create_no_dr_design() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Widget Component

A component that renders widgets.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Widget

Build it.
EOF
}

create_multi_implement_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Core Engine

DR-1: Engine core.
DR-2: Engine extensions.
DR-3: Engine configuration.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Engine Core

**Implements:** DR-1, DR-2, DR-3

A single task that covers all three requirements.
EOF
}

create_no_implements_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Module A

DR-1: First thing.

### Module B

DR-2: Second thing.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Module A

Build module A without an Implements field.

### Task 2: Build Module B

Build module B without an Implements field.
EOF
}

create_lowercase_implements_files() {
    local dir="$1"
    cat > "$dir/design.md" << 'EOF'
# Feature Design

## Technical Design

### Parser

DR-1: Parse input.

### Formatter

DR-2: Format output.
EOF

    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task 1: Build Parser

implements: DR-1

Build the parser.

### Task 2: Build Formatter

**implements:** DR-2

Build the formatter.
EOF
}

# ============================================================
# TESTS
# ============================================================

# --- Usage errors ---

test_missing_args() {
    setup
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
        pass "Missing args returns exit 2"
    else
        fail "Missing args: expected exit 2, got $exit_code"
    fi
    teardown
}

test_missing_design_file() {
    setup
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/nonexistent.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
        pass "Missing design file returns exit 2"
    else
        fail "Missing design file: expected exit 2, got $exit_code"
    fi
    teardown
}

test_missing_plan_file() {
    setup
    echo "DR-1: test" > "$TMPDIR_ROOT/design.md"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/nonexistent.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
        pass "Missing plan file returns exit 2"
    else
        fail "Missing plan file: expected exit 2, got $exit_code"
    fi
    teardown
}

test_no_dr_identifiers() {
    setup
    create_no_dr_design "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
        pass "No DR-N identifiers returns exit 2"
    else
        fail "No DR-N identifiers: expected exit 2, got $exit_code"
    fi
    teardown
}

test_unknown_argument() {
    setup
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --unknown-flag 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 2 ]]; then
        pass "Unknown argument returns exit 2"
    else
        fail "Unknown argument: expected exit 2, got $exit_code"
    fi
    teardown
}

# --- Success cases ---

test_full_coverage() {
    setup
    create_full_coverage_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        pass "Full coverage returns exit 0"
    else
        fail "Full coverage: expected exit 0, got $exit_code. Output: $output"
    fi
    teardown
}

test_full_coverage_output_format() {
    setup
    create_full_coverage_files "$TMPDIR_ROOT"
    local output
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)"
    if echo "$output" | grep -q "## Provenance Chain Report"; then
        pass "Output contains report header"
    else
        fail "Output missing report header"
    fi
    if echo "$output" | grep -q "Requirements: 3"; then
        pass "Output shows correct requirement count"
    else
        fail "Output missing correct requirement count. Output: $output"
    fi
    if echo "$output" | grep -q "Covered: 3"; then
        pass "Output shows correct covered count"
    else
        fail "Output missing correct covered count. Output: $output"
    fi
    if echo "$output" | grep -q "Gaps: 0"; then
        pass "Output shows zero gaps"
    else
        fail "Output missing zero gaps. Output: $output"
    fi
    if echo "$output" | grep -q "Result: PASS"; then
        pass "Output shows PASS result"
    else
        fail "Output missing PASS result"
    fi
    teardown
}

test_multi_implement_single_task() {
    setup
    create_multi_implement_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        pass "Multi-implement single task returns exit 0"
    else
        fail "Multi-implement: expected exit 0, got $exit_code. Output: $output"
    fi
    teardown
}

# --- Failure cases ---

test_partial_coverage() {
    setup
    create_partial_coverage_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 1 ]]; then
        pass "Partial coverage returns exit 1"
    else
        fail "Partial coverage: expected exit 1, got $exit_code. Output: $output"
    fi
    teardown
}

test_partial_coverage_shows_gap() {
    setup
    create_partial_coverage_files "$TMPDIR_ROOT"
    local output
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" || true
    if echo "$output" | grep -q "DR-3"; then
        pass "Partial coverage identifies DR-3 as gap"
    else
        fail "Partial coverage missing DR-3 gap. Output: $output"
    fi
    if echo "$output" | grep -q "Gaps: 1"; then
        pass "Partial coverage shows 1 gap"
    else
        fail "Partial coverage missing gap count. Output: $output"
    fi
    teardown
}

test_orphan_references() {
    setup
    create_orphan_reference_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 1 ]]; then
        pass "Orphan references returns exit 1"
    else
        fail "Orphan references: expected exit 1, got $exit_code. Output: $output"
    fi
    teardown
}

test_orphan_references_detected() {
    setup
    create_orphan_reference_files "$TMPDIR_ROOT"
    local output
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" || true
    if echo "$output" | grep -q "DR-99"; then
        pass "Orphan reference DR-99 detected"
    else
        fail "Orphan reference DR-99 not detected. Output: $output"
    fi
    if echo "$output" | grep -q "Orphan refs: 1"; then
        pass "Orphan count is 1"
    else
        fail "Orphan count incorrect. Output: $output"
    fi
    teardown
}

test_no_implements_fields() {
    setup
    create_no_implements_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 1 ]]; then
        pass "No Implements fields returns exit 1 (all gaps)"
    else
        fail "No Implements fields: expected exit 1, got $exit_code. Output: $output"
    fi
    teardown
}

test_lowercase_implements() {
    setup
    create_lowercase_implements_files "$TMPDIR_ROOT"
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/design.md" --plan-file "$TMPDIR_ROOT/plan.md" 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        pass "Lowercase implements: accepted"
    else
        fail "Lowercase implements: expected exit 0, got $exit_code. Output: $output"
    fi
    teardown
}

test_help_flag() {
    local output exit_code
    output="$(bash "$SCRIPT_UNDER_TEST" --help 2>&1)" && exit_code=0 || exit_code=$?
    if [[ $exit_code -eq 0 ]]; then
        pass "--help returns exit 0"
    else
        fail "--help: expected exit 0, got $exit_code"
    fi
    if echo "$output" | grep -q "Usage:"; then
        pass "--help shows usage"
    else
        fail "--help missing usage text"
    fi
}

# ============================================================
# RUN ALL TESTS
# ============================================================

echo "=== verify-provenance-chain.sh Test Suite ==="
echo ""

# Usage errors
test_missing_args
test_missing_design_file
test_missing_plan_file
test_no_dr_identifiers
test_unknown_argument
test_help_flag

# Success cases
test_full_coverage
test_full_coverage_output_format
test_multi_implement_single_task

# Failure cases
test_partial_coverage
test_partial_coverage_shows_gap
test_orphan_references
test_orphan_references_detected
test_no_implements_fields
test_lowercase_implements

# ============================================================
# SUMMARY
# ============================================================

echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: ${PASS}/${TOTAL} passed ==="

if [[ $FAIL -gt 0 ]]; then
    echo -e "${RED}${FAIL} test(s) failed${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed${NC}"
    exit 0
fi
