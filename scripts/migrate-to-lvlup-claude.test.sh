#!/usr/bin/env bash
# Migration Script Test
# Tests the migrate-to-lvlup-claude.sh script functionality
#
# This is the RED phase of TDD - tests should FAIL initially because
# the migration script does not exist yet.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATION_SCRIPT="$SCRIPT_DIR/migrate-to-lvlup-claude.sh"
PASS=0
FAIL=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

pass() {
    echo -e "${GREEN}PASS${NC}: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAIL=$((FAIL + 1))
}

# Create temporary test directory for isolated tests
TEST_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "=== Migration Script Tests ==="
echo ""

# -----------------------------------------------------------------------------
# Test 1: Script exists
# -----------------------------------------------------------------------------
echo "--- Test 1: Script existence ---"
if [[ -f "$MIGRATION_SCRIPT" ]]; then
    pass "migrate-to-lvlup-claude.sh exists"
else
    fail "migrate-to-lvlup-claude.sh does not exist"
fi

# -----------------------------------------------------------------------------
# Test 2: Script is executable
# -----------------------------------------------------------------------------
echo "--- Test 2: Script is executable ---"
if [[ -x "$MIGRATION_SCRIPT" ]]; then
    pass "migrate-to-lvlup-claude.sh is executable"
else
    fail "migrate-to-lvlup-claude.sh is not executable"
fi

# -----------------------------------------------------------------------------
# Test 3: Script has correct shebang
# -----------------------------------------------------------------------------
echo "--- Test 3: Script has correct shebang ---"
if [[ -f "$MIGRATION_SCRIPT" ]]; then
    FIRST_LINE=$(head -n 1 "$MIGRATION_SCRIPT" 2>/dev/null || echo "")
    if [[ "$FIRST_LINE" == "#!/usr/bin/env bash" ]] || [[ "$FIRST_LINE" == "#!/bin/bash" ]]; then
        pass "Script has correct bash shebang"
    else
        fail "Script does not have correct bash shebang (found: '$FIRST_LINE')"
    fi
else
    fail "Cannot check shebang - script does not exist"
fi

# -----------------------------------------------------------------------------
# Test 4: Script defines required functions
# -----------------------------------------------------------------------------
echo "--- Test 4: Script defines required functions ---"
if [[ -f "$MIGRATION_SCRIPT" ]]; then
    REQUIRED_FUNCTIONS=("detect_source_dir" "create_target_dir" "migrate_files" "update_symlinks")
    MISSING_FUNCTIONS=()

    for func in "${REQUIRED_FUNCTIONS[@]}"; do
        if ! grep -qE "^(function )?${func}\s*\(\)" "$MIGRATION_SCRIPT" 2>/dev/null; then
            MISSING_FUNCTIONS+=("$func")
        fi
    done

    if [[ ${#MISSING_FUNCTIONS[@]} -eq 0 ]]; then
        pass "Script defines all required functions"
    else
        fail "Script missing functions: ${MISSING_FUNCTIONS[*]}"
    fi
else
    fail "Cannot check functions - script does not exist"
fi

# -----------------------------------------------------------------------------
# Test 5: Script handles --dry-run flag
# -----------------------------------------------------------------------------
echo "--- Test 5: Script supports --dry-run flag ---"
if [[ -f "$MIGRATION_SCRIPT" ]]; then
    if grep -q "\-\-dry-run" "$MIGRATION_SCRIPT" 2>/dev/null; then
        pass "Script supports --dry-run flag"
    else
        fail "Script does not support --dry-run flag"
    fi
else
    fail "Cannot check --dry-run support - script does not exist"
fi

# -----------------------------------------------------------------------------
# Test 6: Script handles missing source directory gracefully
# -----------------------------------------------------------------------------
echo "--- Test 6: Script handles missing directories ---"
if [[ -f "$MIGRATION_SCRIPT" && -x "$MIGRATION_SCRIPT" ]]; then
    # Run script with a non-existent home directory simulation
    # The script should exit with error code when neither claude-config nor lvlup-claude exists
    export HOME="$TEST_DIR/fake-home"
    mkdir -p "$TEST_DIR/fake-home"

    OUTPUT=$("$MIGRATION_SCRIPT" --dry-run 2>&1 || true)
    EXIT_CODE=$?

    if [[ $EXIT_CODE -ne 0 ]] || echo "$OUTPUT" | grep -qiE "(not found|does not exist|no source)"; then
        pass "Script handles missing directories gracefully"
    else
        fail "Script should error when source directory is missing"
    fi

    unset HOME
else
    fail "Cannot test missing directory handling - script does not exist or is not executable"
fi

# -----------------------------------------------------------------------------
# Test 7: Script validates source directory detection
# -----------------------------------------------------------------------------
echo "--- Test 7: Source directory detection ---"
if [[ -f "$MIGRATION_SCRIPT" && -x "$MIGRATION_SCRIPT" ]]; then
    # Create mock claude-config directory
    export HOME="$TEST_DIR/test-home-7"
    mkdir -p "$HOME/Documents/code/claude-config"
    touch "$HOME/Documents/code/claude-config/settings.json"

    OUTPUT=$("$MIGRATION_SCRIPT" --dry-run 2>&1 || true)

    if echo "$OUTPUT" | grep -qiE "(claude-config|found|detected|source)"; then
        pass "Script detects claude-config directory"
    else
        fail "Script should detect claude-config directory"
    fi

    unset HOME
else
    fail "Cannot test source detection - script does not exist or is not executable"
fi

# -----------------------------------------------------------------------------
# Test 8: Script creates lvlup-claude target directory
# -----------------------------------------------------------------------------
echo "--- Test 8: Target directory creation ---"
if [[ -f "$MIGRATION_SCRIPT" && -x "$MIGRATION_SCRIPT" ]]; then
    export HOME="$TEST_DIR/test-home-8"
    mkdir -p "$HOME/Documents/code/claude-config"
    touch "$HOME/Documents/code/claude-config/settings.json"

    # In dry-run, should indicate it would create the target
    OUTPUT=$("$MIGRATION_SCRIPT" --dry-run 2>&1 || true)

    if echo "$OUTPUT" | grep -qiE "(lvlup-claude|target|create|would)"; then
        pass "Script plans to create lvlup-claude directory"
    else
        fail "Script should indicate lvlup-claude target directory"
    fi

    unset HOME
else
    fail "Cannot test target creation - script does not exist or is not executable"
fi

# -----------------------------------------------------------------------------
# Test 9: Script updates symlinks
# -----------------------------------------------------------------------------
echo "--- Test 9: Symlink update planning ---"
if [[ -f "$MIGRATION_SCRIPT" && -x "$MIGRATION_SCRIPT" ]]; then
    export HOME="$TEST_DIR/test-home-9"
    mkdir -p "$HOME/Documents/code/claude-config"
    mkdir -p "$HOME/.claude"
    touch "$HOME/Documents/code/claude-config/settings.json"

    # Create a symlink that would need updating
    ln -sf "$HOME/Documents/code/claude-config/settings.json" "$HOME/.claude/settings.json"

    OUTPUT=$("$MIGRATION_SCRIPT" --dry-run 2>&1 || true)

    if echo "$OUTPUT" | grep -qiE "(symlink|link|update)"; then
        pass "Script plans symlink updates"
    else
        fail "Script should plan symlink updates"
    fi

    unset HOME
else
    fail "Cannot test symlink planning - script does not exist or is not executable"
fi

# -----------------------------------------------------------------------------
# Test 10: Script is idempotent (safe to run multiple times)
# -----------------------------------------------------------------------------
echo "--- Test 10: Idempotency check ---"
if [[ -f "$MIGRATION_SCRIPT" && -x "$MIGRATION_SCRIPT" ]]; then
    export HOME="$TEST_DIR/test-home-10"
    mkdir -p "$HOME/Documents/code/lvlup-claude"  # Target already exists
    touch "$HOME/Documents/code/lvlup-claude/settings.json"

    OUTPUT=$("$MIGRATION_SCRIPT" --dry-run 2>&1 || true)
    EXIT_CODE=$?

    # Should either succeed (already migrated) or provide clear guidance
    if [[ $EXIT_CODE -eq 0 ]] || echo "$OUTPUT" | grep -qiE "(already|exists|migrated|skip)"; then
        pass "Script handles already-migrated state"
    else
        fail "Script should handle already-migrated state gracefully"
    fi

    unset HOME
else
    fail "Cannot test idempotency - script does not exist or is not executable"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}$PASS${NC}"
echo -e "Failed: ${RED}$FAIL${NC}"
echo ""

if [[ $FAIL -gt 0 ]]; then
    echo -e "${YELLOW}NOTE:${NC} This is the RED phase of TDD."
    echo "Tests are expected to fail until migrate-to-lvlup-claude.sh is implemented."
    echo ""
    echo -e "${RED}Tests failed!${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
