#!/usr/bin/env bash
# check-design-completeness.sh — Test Suite
# Validates that design completeness checks correctly identify
# numbered requirements, acceptance criteria, and error/edge case coverage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/check-design-completeness.sh"
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

# Create a complete design document with DR-N requirements, acceptance criteria, and error cases
create_complete_design() {
    cat > "$TMPDIR_ROOT/complete-design.md" << 'EOF'
# Design: Password Reset

## Problem Statement
Users cannot reset their password when they forget it.

## Requirements

### DR-1: Password reset via email

Users can reset their password by receiving a time-limited token via email.

**Acceptance criteria:**
- Valid token resets password and invalidates token
- Expired token returns 401
- Invalid token returns 404

### DR-2: Rate limiting on reset requests

Prevent abuse by limiting reset requests per email address.

**Acceptance criteria:**
- Max 3 requests per hour per email
- Exceeding limit returns 429
- Rate limit resets after the window

### DR-3: Error handling and edge cases

Handle invalid email addresses, network failures, and boundary conditions.

**Acceptance criteria:**
- Invalid email format returns 400 with validation message
- SMTP failure queues retry with exponential backoff
- Token at exact expiry boundary is treated as expired

## Chosen Approach
Token-based reset with signed JWT tokens.

## Technical Design
Implementation using JWT tokens with 1-hour expiry.

## Testing Strategy
Unit tests for token generation, integration tests for the full flow.

## Open Questions
None at this time.
EOF
}

# Design document missing numbered requirements entirely
create_no_requirements_design() {
    cat > "$TMPDIR_ROOT/no-reqs-design.md" << 'EOF'
# Design: Widget Feature

## Problem Statement
We need a widget.

## Chosen Approach
Build it with React.

## Technical Design
A React component that renders a widget.

## Testing Strategy
Write some tests.

## Open Questions
TBD.
EOF
}

# Design document with DR-N requirements but missing acceptance criteria on some
create_missing_criteria_design() {
    cat > "$TMPDIR_ROOT/missing-criteria-design.md" << 'EOF'
# Design: User Profile

## Requirements

### DR-1: Display user profile

Show the user's name, email, and avatar.

**Acceptance criteria:**
- Profile page loads in under 2 seconds
- All fields are displayed correctly

### DR-2: Edit user profile

Allow users to update their name and avatar.

This requirement has no acceptance criteria section, just a description.

### DR-3: Handle errors gracefully

Show user-friendly error messages when profile operations fail.

**Acceptance criteria:**
- Network errors show retry prompt
- Validation errors highlight invalid fields

## Chosen Approach
Standard form-based editing.

## Technical Design
React form with validation.

## Testing Strategy
Component tests and integration tests.

## Open Questions
None.
EOF
}

# Design document with requirements and criteria but no error/edge case coverage
create_happy_path_only_design() {
    cat > "$TMPDIR_ROOT/happy-path-design.md" << 'EOF'
# Design: Dashboard

## Requirements

### DR-1: Display metrics

Show key metrics on the dashboard.

**Acceptance criteria:**
- Metrics load within 3 seconds
- Charts render correctly

### DR-2: Filter by date range

Allow users to filter metrics by date range.

**Acceptance criteria:**
- Date picker allows range selection
- Metrics update when range changes

## Chosen Approach
Chart.js with React wrapper.

## Technical Design
React components with Chart.js.

## Testing Strategy
Snapshot tests for charts.

## Open Questions
None.
EOF
}

# Design document with alternative requirement ID formats (REQ-N)
create_alt_format_design() {
    cat > "$TMPDIR_ROOT/alt-format-design.md" << 'EOF'
# Design: Notification System

## Requirements

### REQ-1: Send email notifications

Send notifications via email on key events.

**Acceptance criteria:**
- Emails sent within 30 seconds of trigger
- Failed sends retry 3 times

### REQ-2: Handle delivery failures

Manage bounced emails and invalid addresses.

**Acceptance criteria:**
- Bounced addresses marked as invalid
- Error notifications sent to admin
- Edge case: partial delivery failure logged

## Chosen Approach
Queue-based email delivery.

## Technical Design
SQS queue with Lambda processor.

## Testing Strategy
Unit and integration tests.

## Open Questions
None.
EOF
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Design Completeness Check Tests ==="
echo ""

# --------------------------------------------------
# Test 1: CompleteDesign_AllChecksPass_ExitsZero
# --------------------------------------------------
setup
create_complete_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/complete-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CompleteDesign_AllChecksPass_ExitsZero"
else
    fail "CompleteDesign_AllChecksPass_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: NoRequirements_MissingStructuredIds_ExitsOne
# --------------------------------------------------
setup
create_no_requirements_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/no-reqs-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "NoRequirements_MissingStructuredIds_ExitsOne"
else
    fail "NoRequirements_MissingStructuredIds_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingAcceptanceCriteria_PartialCoverage_ExitsOne
# --------------------------------------------------
setup
create_missing_criteria_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/missing-criteria-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingAcceptanceCriteria_PartialCoverage_ExitsOne"
else
    fail "MissingAcceptanceCriteria_PartialCoverage_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify it identifies DR-2 as the one missing criteria
if echo "$OUTPUT" | grep -q "DR-2"; then
    pass "MissingAcceptanceCriteria_IdentifiesSpecificRequirement"
else
    fail "MissingAcceptanceCriteria_IdentifiesSpecificRequirement (DR-2 not mentioned)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: HappyPathOnly_MissingErrorCoverage_ExitsOne
# --------------------------------------------------
setup
create_happy_path_only_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/happy-path-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "HappyPathOnly_MissingErrorCoverage_ExitsOne"
else
    fail "HappyPathOnly_MissingErrorCoverage_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 5: AlternativeFormat_ReqN_AcceptsEquivalent
# --------------------------------------------------
setup
create_alt_format_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/alt-format-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "AlternativeFormat_ReqN_AcceptsEquivalent"
else
    fail "AlternativeFormat_ReqN_AcceptsEquivalent (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 6: UsageError_MissingArgs_ExitsTwo
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
# Test 7: HelpFlag_ShowsUsage_ExitsZero
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
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 8: NonexistentFile_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/nonexistent.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "NonexistentFile_ExitsTwo"
else
    fail "NonexistentFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 9: FindingsToStderr_ContainStructuredFindings
# --------------------------------------------------
setup
create_no_requirements_design
STDERR_OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/no-reqs-design.md" 2>&1 1>/dev/null)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$STDERR_OUTPUT" | grep -qi "finding\|MEDIUM\|requirement"; then
    pass "FindingsToStderr_ContainStructuredFindings"
else
    fail "FindingsToStderr_ContainStructuredFindings (no structured findings in stderr)"
    echo "  Stderr: $STDERR_OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 10: StructuredOutput_ContainsSummaryReport
# --------------------------------------------------
setup
create_complete_design
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --design-file "$TMPDIR_ROOT/complete-design.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if echo "$OUTPUT" | grep -qE "PASS|Design Completeness"; then
    pass "StructuredOutput_ContainsSummaryReport"
else
    fail "StructuredOutput_ContainsSummaryReport (no summary in output)"
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
