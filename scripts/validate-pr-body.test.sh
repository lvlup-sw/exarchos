#!/usr/bin/env bash
# validate-pr-body.test.sh — Tests for validate-pr-body.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-pr-body.sh"
PASS=0
FAIL=0

# Colors
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
# TEST CASES
# ============================================================

echo "=== Validate PR Body Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ValidBody_AllSections_ExitsZero
# --------------------------------------------------
BODY=$(cat <<'EOF'
## Summary

This PR adds write-through backup for workflow state files.

## Changes

- **state-store** — Write .state.json alongside SQLite
- **migration** — Preserve files instead of deleting

## Test Plan

Added 3 unit tests covering write-through and failure paths.

---

**Results:** Tests 2701 ✓ · Build 0 errors
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidBody_AllSections_ExitsZero"
else
    fail "ValidBody_AllSections_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 2: MissingSummary_ExitsOne
# --------------------------------------------------
BODY=$(cat <<'EOF'
## Changes

- **state-store** — Write .state.json alongside SQLite

## Test Plan

Added tests.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingSummary_ExitsOne"
else
    fail "MissingSummary_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -qi "summary"; then
    pass "MissingSummary_OutputMentionsSection"
else
    fail "MissingSummary_OutputMentionsSection"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 3: MissingChanges_ExitsOne
# --------------------------------------------------
BODY=$(cat <<'EOF'
## Summary

This PR does things.

## Test Plan

Added tests.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingChanges_ExitsOne"
else
    fail "MissingChanges_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 4: MissingTestPlan_ExitsOne
# --------------------------------------------------
BODY=$(cat <<'EOF'
## Summary

This PR does things.

## Changes

- **Component** — Changed something
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MissingTestPlan_ExitsOne"
else
    fail "MissingTestPlan_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 5: EmptyBody_ExitsOne
# --------------------------------------------------
OUTPUT="$(echo "" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "EmptyBody_ExitsOne"
else
    fail "EmptyBody_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 6: CommitMessageOnly_ExitsOne
# --------------------------------------------------
BODY=$(cat <<'EOF'
fix: add write-through backup

Workflow state disappeared after restart because writeStateFile()
with SQLite backend skipped .state.json writes.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CommitMessageOnly_ExitsOne"
else
    fail "CommitMessageOnly_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 7: MergeQueue_Skipped_ExitsZero
# --------------------------------------------------
BODY=$(cat <<'EOF'
This draft PR was created by the merge queue.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" --head-ref "gh-readonly-queue/main/pr-123-abc123" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "MergeQueue_Skipped_ExitsZero"
else
    fail "MergeQueue_Skipped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 7b: MergeQueueText_NotSkipped_ExitsOne
# --------------------------------------------------
BODY=$(cat <<'EOF'
This PR discusses merge queue configuration.
No summary or changes sections here.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "MergeQueueText_NotSkipped_ExitsOne"
else
    fail "MergeQueueText_NotSkipped_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 8: RenovateBot_Skipped_ExitsZero
# --------------------------------------------------
BODY=$(cat <<'EOF'
This PR contains the following updates:

| Package | Type | Update | Change |
EOF
)
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --author "renovate[bot]" <<< "$BODY" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "RenovateBot_Skipped_ExitsZero"
else
    fail "RenovateBot_Skipped_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 9: CaseInsensitive_SummaryHeader_ExitsZero
# --------------------------------------------------
BODY=$(cat <<'EOF'
## summary

This PR does things.

## changes

- **Component** — Changed something

## test plan

Added tests.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CaseInsensitive_SummaryHeader_ExitsZero"
else
    fail "CaseInsensitive_SummaryHeader_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 10: AllMissing_ReportsAllSections
# --------------------------------------------------
BODY="Just some text without any sections"
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "AllMissing_ExitsOne"
else
    fail "AllMissing_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
MISSING_COUNT=$(echo "$OUTPUT" | grep -c "Missing:" || true)
if [[ $MISSING_COUNT -ge 3 ]]; then
    pass "AllMissing_ReportsAllThreeSections"
else
    fail "AllMissing_ReportsAllThreeSections (found $MISSING_COUNT, expected >= 3)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 11: CustomTemplate_OverridesDefault_ExitsZero
# --------------------------------------------------
TMPDIR_ROOT="$(mktemp -d)"
TEMPLATE_FILE="$TMPDIR_ROOT/pr-template.md"
cat > "$TEMPLATE_FILE" <<'EOF'
## Description
## Impact
EOF
BODY=$(cat <<'EOF'
## Description

This does things.

## Impact

No breaking changes.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" --template "$TEMPLATE_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "CustomTemplate_OverridesDefault_ExitsZero"
else
    fail "CustomTemplate_OverridesDefault_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
rm -rf "$TMPDIR_ROOT"

# --------------------------------------------------
# Test 12: CustomTemplate_MissingSection_ExitsOne
# --------------------------------------------------
TMPDIR_ROOT="$(mktemp -d)"
TEMPLATE_FILE="$TMPDIR_ROOT/pr-template.md"
cat > "$TEMPLATE_FILE" <<'EOF'
## Description
## Impact
EOF
BODY=$(cat <<'EOF'
## Description

This does things.
EOF
)
OUTPUT="$(echo "$BODY" | bash "$SCRIPT_UNDER_TEST" --template "$TEMPLATE_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "CustomTemplate_MissingSection_ExitsOne"
else
    fail "CustomTemplate_MissingSection_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
rm -rf "$TMPDIR_ROOT"

# --------------------------------------------------
# Test 13: MissingTemplateFile_ExitsTwo
# --------------------------------------------------
OUTPUT="$(echo "body" | bash "$SCRIPT_UNDER_TEST" --template "/nonexistent/template.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingTemplateFile_ExitsTwo"
else
    fail "MissingTemplateFile_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
if echo "$OUTPUT" | grep -q "not found"; then
    pass "MissingTemplateFile_OutputContainsNotFound"
else
    fail "MissingTemplateFile_OutputContainsNotFound"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 14: MissingFlagValue_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --pr 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingFlagValue_ExitsTwo"
else
    fail "MissingFlagValue_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 15: BodyFile_ValidBody_ExitsZero
# --------------------------------------------------
TMPDIR_ROOT="$(mktemp -d)"
BODY_FILE="$TMPDIR_ROOT/pr-body.md"
cat > "$BODY_FILE" <<'EOF'
## Summary

This PR adds a feature.

## Changes

- **Component** — Changed something

## Test Plan

Added tests.
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --body-file "$BODY_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "BodyFile_ValidBody_ExitsZero"
else
    fail "BodyFile_ValidBody_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
rm -rf "$TMPDIR_ROOT"

# --------------------------------------------------
# Test 16: BodyFile_MissingSections_ExitsOne
# --------------------------------------------------
TMPDIR_ROOT="$(mktemp -d)"
BODY_FILE="$TMPDIR_ROOT/pr-body.md"
cat > "$BODY_FILE" <<'EOF'
## Summary

This PR adds a feature.
EOF
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --body-file "$BODY_FILE" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "BodyFile_MissingSections_ExitsOne"
else
    fail "BodyFile_MissingSections_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
rm -rf "$TMPDIR_ROOT"

# --------------------------------------------------
# Test 17: BodyFile_NotFound_ExitsTwo
# --------------------------------------------------
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --body-file "/nonexistent/body.md" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "BodyFile_NotFound_ExitsTwo"
else
    fail "BodyFile_NotFound_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi

# --------------------------------------------------
# Test 18: PrNumberFlag_FetchesBody (mock)
# --------------------------------------------------
# This test verifies --pr flag parsing, not actual GH API
OUTPUT="$(bash "$SCRIPT_UNDER_TEST" --pr 999 --dry-run 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "PrNumberFlag_DryRun_ExitsZero"
else
    fail "PrNumberFlag_DryRun_ExitsZero (exit=$EXIT_CODE, expected 0)"
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
