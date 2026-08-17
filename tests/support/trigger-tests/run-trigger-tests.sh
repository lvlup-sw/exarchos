#!/usr/bin/env bash
# run-trigger-tests.sh — Validate skill descriptions against trigger fixtures
#
# Usage: bash tests/support/trigger-tests/run-trigger-tests.sh [fixtures.jsonl] [content-dir]
# Must be run from the repository root.
#
# Resolves against the AUTHORED sources, which are grouped by capability
# domain, so a skill is found by searching the domains rather than by joining
# a fixed path.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
FIXTURES="${1:-${SCRIPT_DIR}/fixtures.jsonl}"
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

while IFS= read -r line; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  skill=$(echo "$line" | jq -r '.skill')
  phrase=$(echo "$line" | jq -r '.phrase')
  expected=$(echo "$line" | jq -r '.expected')
  tag=$(echo "$line" | jq -r '.tags[0]')

  skill_file="$(resolve_skill "$skill")"
  if [[ ! -f "$skill_file" ]]; then
    if [[ "${SKIP_MISSING_SKILLS:-}" == "true" ]]; then
      SKIP=$((SKIP + 1)); continue
    fi
    FAIL=$((FAIL + 1))
    echo "FAIL: no SKILL.md for '${skill}' under any domain of ${SKILLS_DIR}"
    continue
  fi

  # Extract description from frontmatter (handles multiline YAML values)
  description=$(sed -n '/^---$/,/^---$/p' "$skill_file" | awk '
    /^description:/ { capture=1 }
    capture && /^[a-z_-]+:/ && !/^description:/ { capture=0 }
    capture { print }
  ')

  case "$expected" in
    trigger)
      if [[ "$tag" == "obvious" ]]; then
        if echo "$description" | grep -Fqi -- "$phrase"; then
          PASS=$((PASS + 1))
        else
          FAIL=$((FAIL + 1))
          echo "FAIL: ${skill} description missing obvious trigger: '${phrase}'"
        fi
      else
        PASS=$((PASS + 1))  # Advisory only in static mode
      fi
      ;;
    no-trigger)
      # Static check: verify skill has negative guidance (phrase-specific exclusion deferred to eval framework)
      if echo "$description" | grep -qi "Do NOT\|Not for"; then
        PASS=$((PASS + 1))
      else
        FAIL=$((FAIL + 1))
        echo "FAIL: ${skill} has no negative triggers (needed to exclude: '${phrase}')"
      fi
      ;;
    *)
      FAIL=$((FAIL + 1))
      echo "FAIL: ${skill} has unknown expected value: '${expected}'"
      ;;
  esac
done < "$FIXTURES"

echo "=== Trigger Tests: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
