#!/usr/bin/env bash
# validate-all-skills.sh — Run frontmatter validation on all SKILL.md files
#
# Usage: bash skills/validate-all-skills.sh
# Must be run from the repository root, or provide SKILLS_DIR env var.
#
# Iterates over skills/*/SKILL.md (excluding test-fixtures and shared),
# extracts folder name, and calls validate-frontmatter.sh for each.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="${SCRIPT_DIR}/validate-frontmatter.sh"
SKILLS_DIR="${SCRIPT_DIR}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0

for skill_file in "${SKILLS_DIR}"/*/SKILL.md; do
  folder_path=$(dirname "$skill_file")
  folder_name=$(basename "$folder_path")

  # Skip test fixtures and shared
  if [[ "$folder_name" == "test-fixtures" || "$folder_name" == "shared" ]]; then
    continue
  fi

  TOTAL=$((TOTAL + 1))

  validation_output=""
  validation_output=$("$VALIDATOR" "$skill_file" "$folder_name" 2>&1) && validation_exit=0 || validation_exit=$?

  if [[ "$validation_exit" -eq 0 ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf "Validating %-30s ${GREEN}PASS${RESET}\n" "${folder_name}..."
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    # Extract the first error for the summary line
    first_error=$(echo "$validation_output" | head -n 1 | sed 's/^ERROR: //')
    printf "Validating %-30s ${RED}FAIL${RESET} (%s)\n" "${folder_name}..." "$first_error"
  fi
done

echo ""
echo "=== Results: ${PASS_COUNT}/${TOTAL} skills passed ==="

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
