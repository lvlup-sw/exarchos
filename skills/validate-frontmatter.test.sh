#!/usr/bin/env bash
# validate-frontmatter.test.sh — Fixture-based tests for SKILL.md frontmatter validation
#
# Usage: bash skills/validate-frontmatter.test.sh
# Must be run from the repository root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${SCRIPT_DIR}/validate-frontmatter.sh"
FIXTURES="${SCRIPT_DIR}/test-fixtures"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0

# run_test <test_name> <expected_exit_code> <fixture_folder> [<folder_name_arg>]
# If folder_name_arg is omitted, defaults to the fixture folder basename.
run_test() {
  local test_name="$1"
  local expected_exit="$2"
  local fixture_folder="$3"
  local folder_name="${4:-$(basename "$fixture_folder")}"
  local skill_file="${fixture_folder}/SKILL.md"

  TOTAL=$((TOTAL + 1))

  local actual_exit=0
  local output
  output=$("$VALIDATOR" "$skill_file" "$folder_name" 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf "${GREEN}PASS${RESET} %s\n" "$test_name"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf "${RED}FAIL${RESET} %s (expected exit %d, got %d)\n" "$test_name" "$expected_exit" "$actual_exit"
    if [[ -n "$output" ]]; then
      printf "     Output: %s\n" "$output"
    fi
  fi
}

echo "=== Frontmatter Validation Tests ==="
echo ""

# 1. Valid frontmatter — all fields present — should pass
run_test "ValidFrontmatter_AllFieldsPresent_Passes" 0 "${FIXTURES}/valid-skill"

# 2. Missing frontmatter — no delimiters — should fail
run_test "MissingFrontmatter_NoDelimiters_Fails" 1 "${FIXTURES}/no-frontmatter"

# 3. Missing name field — should fail
run_test "MissingName_EmptyField_Fails" 1 "${FIXTURES}/missing-name"

# 4. Missing description field — should fail
run_test "MissingDescription_EmptyField_Fails" 1 "${FIXTURES}/missing-description"

# 5. Name mismatch — wrong kebab-case — should fail
run_test "NameMismatch_WrongKebabCase_Fails" 1 "${FIXTURES}/name-mismatch"

# 6. XML tags in description — angle brackets — should fail
run_test "XmlTags_AngleBrackets_Fails" 1 "${FIXTURES}/xml-tags"

# 7. Body too long — over word limit — should fail
run_test "BodyTooLong_OverWordLimit_Fails" 1 "${FIXTURES}/body-too-long"

# 8. Broken reference — missing file — should fail
run_test "ReferenceMissing_BrokenLink_Fails" 1 "${FIXTURES}/broken-reference"

echo ""
echo "=== Results: ${PASS_COUNT}/${TOTAL} passed, ${FAIL_COUNT} failed ==="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
