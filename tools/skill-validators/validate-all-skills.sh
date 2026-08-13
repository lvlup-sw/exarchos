#!/usr/bin/env bash
# validate-all-skills.sh — Run frontmatter validation on all SKILL.md files
#
# Usage: bash tools/skill-validators/validate-all-skills.sh
# Must be run from the repository root, or provide SKILLS_DIR env var.
#
# Validates the AUTHORED sources, which is where frontmatter is written and
# where a bad `name`/`description` can still be corrected. The rendered tree is
# generator output and is covered by the render guard instead.
#
# The glob carries a domain segment because sources are grouped by capability:
# `content/<domain>/skills/<name>/SKILL.md`. Anchoring on the script's own
# directory is what silently emptied the previous glob when this file moved, so
# the root is resolved from the repository instead.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VALIDATOR="${SCRIPT_DIR}/validate-frontmatter.sh"
SKILLS_DIR="${SKILLS_DIR:-${REPO_ROOT}/content}"
shopt -s nullglob

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
TOTAL=0

for skill_file in "${SKILLS_DIR}"/*/skills/*/SKILL.md; do
  folder_path=$(dirname "$skill_file")
  folder_name=$(basename "$folder_path")

  TOTAL=$((TOTAL + 1))

  validation_output=""
  validation_output=$("$VALIDATOR" "$skill_file" "$folder_name" 2>&1) && validation_exit=0 || validation_exit=$?

  if [[ "$validation_exit" -eq 0 ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf "%b" "Validating $(printf '%-30s' "${folder_name}...") ${GREEN}PASS${RESET}\n"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    # Extract the first error for the summary line
    first_error=$(echo "$validation_output" | head -n 1 | sed 's/^ERROR: //')
    printf "%b" "Validating $(printf '%-30s' "${folder_name}...") ${RED}FAIL${RESET} (${first_error})\n"
  fi
done

echo ""
echo "=== Results: ${PASS_COUNT}/${TOTAL} skills passed ==="

# A validator that matched nothing is not a pass. This script spent its life
# reporting 0/0 after its glob was left pointing above the rendered tree, so
# an empty denominator is now the loudest failure it can raise.
if [[ "$TOTAL" -eq 0 ]]; then
  echo "ERROR: matched no SKILL.md under ${SKILLS_DIR}/*/skills/*/ — the glob is dead, not the tree." >&2
  exit 2
fi

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
