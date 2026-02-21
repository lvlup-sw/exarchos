#!/usr/bin/env bash
# validate-installation.test.sh — Tests for validate-installation.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="$SCRIPT_DIR/validate-installation.sh"
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
# TEST FIXTURES
# ============================================================

TMPDIR_ROOT=""

setup() {
    TMPDIR_ROOT="$(mktemp -d)"

    # Create a mock repo structure that the script expects
    # The script resolves REPO_ROOT from SCRIPT_DIR/..
    # We'll create a fake scripts/ dir with a symlink to the real script
    # and a mock validate-frontmatter.sh in skills/
    MOCK_REPO="$TMPDIR_ROOT/mock-repo"
    mkdir -p "$MOCK_REPO/scripts"
    mkdir -p "$MOCK_REPO/skills"

    # Copy the actual script to our mock repo's scripts/ dir
    cp "$SCRIPT_UNDER_TEST" "$MOCK_REPO/scripts/validate-installation.sh"
    chmod +x "$MOCK_REPO/scripts/validate-installation.sh"

    # Create a mock validate-frontmatter.sh that always passes
    cat > "$MOCK_REPO/skills/validate-frontmatter.sh" << 'MOCKEOF'
#!/usr/bin/env bash
# Mock validator — always passes
exit 0
MOCKEOF
    chmod +x "$MOCK_REPO/skills/validate-frontmatter.sh"

    # Create the target skills directory
    TARGET_DIR="$TMPDIR_ROOT/target-skills"
    mkdir -p "$TARGET_DIR"
}

teardown() {
    if [[ -n "$TMPDIR_ROOT" && -d "$TMPDIR_ROOT" ]]; then
        rm -rf "$TMPDIR_ROOT"
    fi
}

# Helper to create a valid skill in the target directory
create_valid_skill() {
    local skill_name="$1"
    local skill_dir="$TARGET_DIR/$skill_name"
    mkdir -p "$skill_dir"
    cat > "$skill_dir/SKILL.md" << EOF
---
name: $skill_name
description: A test skill. Do NOT use in production.
---

# $skill_name

This is a test skill.
EOF
    # Also create the matching repo source skill (for references check)
    mkdir -p "$MOCK_REPO/skills/$skill_name"
}

# ============================================================
# TEST CASES
# ============================================================

echo "=== Validate Installation Tests ==="
echo ""

# --------------------------------------------------
# Test 1: ValidInstallation_AllSkillsPresent_ExitsZero
# --------------------------------------------------
setup
create_valid_skill "my-skill"
create_valid_skill "another-skill"
OUTPUT="$(bash "$MOCK_REPO/scripts/validate-installation.sh" "$TARGET_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
    pass "ValidInstallation_AllSkillsPresent_ExitsZero"
else
    fail "ValidInstallation_AllSkillsPresent_ExitsZero (exit=$EXIT_CODE, expected 0)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 2: InvalidInstallation_MissingSkillMd_ExitsOne
# --------------------------------------------------
setup
# Create a skill directory WITHOUT SKILL.md
mkdir -p "$TARGET_DIR/broken-skill"
# Also create a valid one so TOTAL > 0
create_valid_skill "good-skill"
OUTPUT="$(bash "$MOCK_REPO/scripts/validate-installation.sh" "$TARGET_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "InvalidInstallation_MissingSkillMd_ExitsOne"
else
    fail "InvalidInstallation_MissingSkillMd_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions the error
if echo "$OUTPUT" | grep -q "Missing SKILL.md"; then
    pass "InvalidInstallation_MissingSkillMd_OutputMentionsError"
else
    fail "InvalidInstallation_MissingSkillMd_OutputMentionsError (output missing 'Missing SKILL.md')"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 3: MissingTargetDir_ExitsTwo
# --------------------------------------------------
setup
OUTPUT="$(bash "$MOCK_REPO/scripts/validate-installation.sh" "$TMPDIR_ROOT/nonexistent-dir" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 2 ]]; then
    pass "MissingTargetDir_ExitsTwo"
else
    fail "MissingTargetDir_ExitsTwo (exit=$EXIT_CODE, expected 2)"
    echo "  Output: $OUTPUT"
fi
teardown

# --------------------------------------------------
# Test 4: NoSkillsFound_ExitsOne
# --------------------------------------------------
setup
# TARGET_DIR exists but has no subdirectories (no skills)
OUTPUT="$(bash "$MOCK_REPO/scripts/validate-installation.sh" "$TARGET_DIR" 2>&1)" && EXIT_CODE=$? || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 1 ]]; then
    pass "NoSkillsFound_ExitsOne"
else
    fail "NoSkillsFound_ExitsOne (exit=$EXIT_CODE, expected 1)"
    echo "  Output: $OUTPUT"
fi
# Verify output mentions no skills found
if echo "$OUTPUT" | grep -q "No skills found"; then
    pass "NoSkillsFound_OutputMentionsNoSkills"
else
    fail "NoSkillsFound_OutputMentionsNoSkills (output missing 'No skills found')"
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
