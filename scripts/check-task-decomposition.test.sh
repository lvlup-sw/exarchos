#!/usr/bin/env bash
# check-task-decomposition.sh — Test Suite
# Validates task decomposition quality gate for plan structure, dependency DAG, and parallel safety.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-task-decomposition.sh"
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

# Factory: Well-decomposed plan with all required fields
create_well_decomposed_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- `src/components/widget.ts`
- `src/components/widget.test.ts`

**Tests:**
- [RED] `Widget_Render_DisplaysContent` — verify widget renders content
- [RED] `Widget_EmptyData_ShowsPlaceholder` — verify empty state

**Dependencies:** None
**Parallelizable:** No

### Task T-02: Create the API client module for backend communication

**Description:** Implement the HTTP client wrapper that handles authentication headers, retry logic, and response parsing for all backend API calls in the application.

**Files:**
- `src/api/client.ts`
- `src/api/client.test.ts`

**Tests:**
- [RED] `ApiClient_Fetch_ReturnsData` — verify data fetching
- [RED] `ApiClient_Error_ThrowsHttpError` — verify error handling
- [RED] `ApiClient_Retry_AttemptsThreeTimes` — verify retry logic

**Dependencies:** None
**Parallelizable:** Yes

### Task T-03: Create the state manager for application state

**Description:** Build the centralized state management module that handles all application state transitions, subscriptions, and persistence using an event-sourced architecture pattern.

**Files:**
- `src/state/manager.ts`
- `src/state/manager.test.ts`

**Tests:**
- [RED] `StateManager_Set_UpdatesState` — verify state update
- [RED] `StateManager_Subscribe_NotifiesListeners` — verify subscriptions

**Dependencies:** T-01, T-02
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Plan with a task missing description (only title, <10 words body)
create_missing_description_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Widget component

**Description:** Build it.

**Files:**
- `src/components/widget.ts`

**Tests:**
- [RED] `Widget_Render_DisplaysContent`

**Dependencies:** None
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Plan with task missing test expectations
create_missing_tests_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- `src/components/widget.ts`

**Dependencies:** None
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Plan with task missing file targets
create_missing_files_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Tests:**
- [RED] `Widget_Render_DisplaysContent` — verify widget renders content

**Dependencies:** None
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Plan with cyclic dependencies (T-01 -> T-02 -> T-01)
create_cyclic_dependencies_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Create the widget component with full rendering support

**Description:** Build the widget rendering component that handles all display logic including template compilation and DOM updates for the main dashboard view.

**Files:**
- `src/components/widget.ts`
- `src/components/widget.test.ts`

**Tests:**
- [RED] `Widget_Render_DisplaysContent` — verify widget renders

**Dependencies:** T-02
**Parallelizable:** No

### Task T-02: Create the API client for backend communication

**Description:** Implement the HTTP client wrapper that handles authentication headers, retry logic, and response parsing for all backend API calls in the application.

**Files:**
- `src/api/client.ts`
- `src/api/client.test.ts`

**Tests:**
- [RED] `ApiClient_Fetch_ReturnsData` — verify data fetching

**Dependencies:** T-01
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Plan with parallel conflict (both T-01 and T-02 modify same file)
create_parallel_conflict_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Add validation to the shared utilities module

**Description:** Build the validation helpers for the shared utilities module that handles input sanitization and constraint checking across the entire application.

**Files:**
- `src/shared/utils.ts`
- `src/shared/utils.test.ts`

**Tests:**
- [RED] `Validate_Input_ReturnsTrue` — verify input validation

**Dependencies:** None
**Parallelizable:** Yes

### Task T-02: Add formatting helpers to the shared utilities module

**Description:** Build the formatting helpers for the shared utilities module that handles date formatting, number formatting, and string manipulation across the application.

**Files:**
- `src/shared/utils.ts`
- `src/shared/format.test.ts`

**Tests:**
- [RED] `Format_Date_ReturnsISO` — verify date formatting

**Dependencies:** None
**Parallelizable:** Yes
EOF
    echo "$dir"
}

# Factory: Plan with valid linear dependency chain (T-01 -> T-02 -> T-03)
create_valid_dag_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Tasks

### Task T-01: Create the foundation types and interfaces

**Description:** Define all TypeScript interfaces and type definitions that form the foundation layer of the application including domain models and value objects.

**Files:**
- `src/types/index.ts`
- `src/types/index.test.ts`

**Tests:**
- [RED] `Types_Validate_AcceptsValidInput` — verify type guards

**Dependencies:** None
**Parallelizable:** No

### Task T-02: Create the core service layer implementation

**Description:** Build the core service implementations that depend on the foundation types including business logic handlers and domain event processors.

**Files:**
- `src/services/core.ts`
- `src/services/core.test.ts`

**Tests:**
- [RED] `CoreService_Process_ReturnsResult` — verify processing

**Dependencies:** T-01
**Parallelizable:** No

### Task T-03: Create the integration glue code and API layer

**Description:** Wire up the integration layer connecting core services to the API endpoints including request routing, middleware, and response serialization.

**Files:**
- `src/api/routes.ts`
- `src/api/routes.test.ts`

**Tests:**
- [RED] `Routes_Get_ReturnsData` — verify route handler

**Dependencies:** T-02
**Parallelizable:** No
EOF
    echo "$dir"
}

# Factory: Empty plan (no task headers)
create_empty_plan() {
    local dir="$1"
    cat > "$dir/plan.md" << 'EOF'
# Implementation Plan

## Overview

This is just an overview with no actual tasks defined.

## Schedule

Week 1: Design review
Week 2: Implementation
EOF
    echo "$dir"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Check Task Decomposition Tests ==="
echo ""

# --------------------------------------------------
# Test 1: WellDecomposed_AllFieldsPresent_ExitsZero
# --------------------------------------------------
setup
DIR="$(create_well_decomposed_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "WellDecomposed_AllFieldsPresent_ExitsZero"
else
    fail "WellDecomposed_AllFieldsPresent_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: MissingDescription_EmptyTaskBody_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_missing_description_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingDescription_EmptyTaskBody_ExitsOne"
else
    fail "MissingDescription_EmptyTaskBody_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingTestExpectations_NoTestSection_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_missing_tests_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingTestExpectations_NoTestSection_ExitsOne"
else
    fail "MissingTestExpectations_NoTestSection_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: MissingFiles_NoFileTargets_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_missing_files_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingFiles_NoFileTargets_ExitsOne"
else
    fail "MissingFiles_NoFileTargets_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: CyclicDependencies_CircularBlockedBy_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_cyclic_dependencies_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CyclicDependencies_CircularBlockedBy_ExitsOne"
else
    fail "CyclicDependencies_CircularBlockedBy_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify cycle is mentioned in output
if echo "$OUTPUT" | grep -qi "CYCLE"; then
    pass "CyclicDependencies_ReportsMentionsCycle"
else
    fail "CyclicDependencies_ReportsMentionsCycle (expected 'CYCLE' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: ParallelConflict_SameFileInParallelTasks_ExitsOne
# --------------------------------------------------
setup
DIR="$(create_parallel_conflict_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "ParallelConflict_SameFileInParallelTasks_ExitsOne"
else
    fail "ParallelConflict_SameFileInParallelTasks_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify conflict is mentioned in output
if echo "$OUTPUT" | grep -qi "CONFLICT"; then
    pass "ParallelConflict_ReportsMentionsConflict"
else
    fail "ParallelConflict_ReportsMentionsConflict (expected 'CONFLICT' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 7: ValidDependencyDAG_LinearChain_ExitsZero
# --------------------------------------------------
setup
DIR="$(create_valid_dag_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidDependencyDAG_LinearChain_ExitsZero"
else
    fail "ValidDependencyDAG_LinearChain_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
# Verify DAG is valid
if echo "$OUTPUT" | grep -qi "valid DAG"; then
    pass "ValidDependencyDAG_ReportsValidDAG"
else
    fail "ValidDependencyDAG_ReportsValidDAG (expected 'valid DAG' in output)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: EmptyPlan_NoTasks_ExitsTwo
# --------------------------------------------------
setup
DIR="$(create_empty_plan "$TMPDIR_ROOT")"
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "$DIR/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "EmptyPlan_NoTasks_ExitsTwo"
else
    fail "EmptyPlan_NoTasks_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: MissingPlanFile_BadPath_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --plan-file "/nonexistent/plan.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingPlanFile_BadPath_ExitsTwo"
else
    fail "MissingPlanFile_BadPath_ExitsTwo (exit=$EXIT_CODE, expected 2)"
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
