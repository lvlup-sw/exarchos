#!/usr/bin/env bash
# CodeRabbit Review Gate Workflow — Integration Tests
# Verifies the GitHub Actions workflow YAML file properties

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
WORKFLOW_FILE="$REPO_ROOT/.github/workflows/coderabbit-review-gate.yml"

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
# WORKFLOW FILE TESTS
# ============================================================
echo "=== Workflow File Tests ==="

# Test: Workflow_FileExists
if [[ -f "$WORKFLOW_FILE" ]]; then
    pass "Workflow_FileExists"
else
    fail "Workflow_FileExists — .github/workflows/coderabbit-review-gate.yml not found"
    echo ""
    echo "=== Test Summary ==="
    echo -e "Passed: ${GREEN}$PASS${NC}"
    echo -e "Failed: ${RED}$FAIL${NC}"
    echo ""
    echo -e "${RED}Tests failed! Workflow file missing — skipping remaining tests.${NC}"
    exit 1
fi

# Test: Workflow_ReferencesScript
if grep -q 'scripts/coderabbit-review-gate.sh' "$WORKFLOW_FILE"; then
    pass "Workflow_ReferencesScript"
else
    fail "Workflow_ReferencesScript — YAML does not reference scripts/coderabbit-review-gate.sh"
fi

# Test: Workflow_TriggersOnReview
if grep -q 'pull_request_review' "$WORKFLOW_FILE"; then
    pass "Workflow_TriggersOnReview"
else
    fail "Workflow_TriggersOnReview — YAML does not contain pull_request_review trigger"
fi

# Test: Workflow_HasCorrectPermissions
if grep -q 'pull-requests: write' "$WORKFLOW_FILE"; then
    pass "Workflow_HasCorrectPermissions"
else
    fail "Workflow_HasCorrectPermissions — YAML does not contain pull-requests: write permission"
fi

# Test: Workflow_FiltersCodeRabbit
if grep -q 'coderabbitai\[bot\]' "$WORKFLOW_FILE"; then
    pass "Workflow_FiltersCodeRabbit"
else
    fail "Workflow_FiltersCodeRabbit — YAML does not contain coderabbitai[bot] filter"
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
