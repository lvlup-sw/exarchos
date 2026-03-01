#!/usr/bin/env bash
# run-pressure-tests.sh — Validate pressure test fixtures for discipline skills
#
# Verifies that each pressure test fixture entry references a valid skill
# and contains the required fields for adversarial pressure testing.
#
# Usage: bash skills/trigger-tests/run-pressure-tests.sh [fixtures.jsonl] [skills-dir]
# Must be run from the repository root.

set -euo pipefail

FIXTURES="${1:-skills/trigger-tests/fixtures/pressure-tests.jsonl}"
SKILLS_DIR="${2:-skills}"
PASS=0; FAIL=0; SKIP=0

# Optional category filter
CATEGORY_FILTER="${CATEGORY:-pressure-test}"

while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue

  category=$(echo "$line" | jq -r '.category // empty')
  [[ "$category" != "$CATEGORY_FILTER" ]] && continue

  input=$(echo "$line" | jq -r '.input // empty')
  expected_skill=$(echo "$line" | jq -r '.expected_skill // empty')
  expected_behavior=$(echo "$line" | jq -r '.expected_behavior // empty')

  # Validate required fields
  if [[ -z "$input" || -z "$expected_skill" || -z "$expected_behavior" ]]; then
    FAIL=$((FAIL + 1))
    echo "FAIL: entry missing required field(s): input='${input:0:40}...'"
    continue
  fi

  # Verify referenced skill exists
  skill_file="${SKILLS_DIR}/${expected_skill}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    if [[ "${SKIP_MISSING_SKILLS:-}" == "true" ]]; then
      SKIP=$((SKIP + 1)); continue
    fi
    FAIL=$((FAIL + 1))
    echo "FAIL: skill not found for pressure test: ${expected_skill} (${skill_file})"
    continue
  fi

  # Verify the skill has discipline content (anti-patterns or rationalization sections)
  if grep -qi "Anti-Pattern\|Rationalization\|Iron Law\|adversarial\|Do NOT" "$skill_file"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: ${expected_skill} lacks discipline content to support pressure test: '${input:0:60}...'"
  fi

done < "$FIXTURES"

echo "=== Pressure Tests: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
