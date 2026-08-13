#!/usr/bin/env bash
# run-pressure-tests.sh — Validate pressure test fixtures for discipline skills
#
# Verifies that each pressure test fixture entry references a valid skill
# and contains the required fields for adversarial pressure testing.
#
# Usage: bash tests/support/trigger-tests/run-pressure-tests.sh [fixtures.jsonl] [content-dir]
# Must be run from the repository root.
#
# Resolves against the AUTHORED sources, which are grouped by capability
# domain, so a skill is found by searching the domains rather than by joining
# a fixed path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
FIXTURES="${1:-${SCRIPT_DIR}/fixtures/pressure-tests.jsonl}"
SKILLS_DIR="${2:-${REPO_ROOT}/content}"
PASS=0; FAIL=0; SKIP=0

# Echo the SKILL.md for a skill name, wherever its domain puts it.
# Reports "not found" as empty output, never as a non-zero status: the caller
# runs under `set -e` and reports the miss itself.
resolve_skill() {
  local found
  found=$(echo "${SKILLS_DIR}"/*/skills/"$1"/SKILL.md)
  [[ -f "$found" ]] && echo "$found"
  return 0
}

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
  skill_file="$(resolve_skill "$expected_skill")"
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
