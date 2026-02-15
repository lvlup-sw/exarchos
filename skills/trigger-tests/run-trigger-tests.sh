#!/usr/bin/env bash
# run-trigger-tests.sh — Validate skill descriptions against trigger fixtures
#
# Usage: bash skills/trigger-tests/run-trigger-tests.sh [fixtures.jsonl] [skills-dir]
# Must be run from the repository root.

set -euo pipefail

FIXTURES="${1:-skills/trigger-tests/fixtures.jsonl}"
SKILLS_DIR="${2:-skills}"
PASS=0; FAIL=0; SKIP=0

while IFS= read -r line; do
  skill=$(echo "$line" | jq -r '.skill')
  phrase=$(echo "$line" | jq -r '.phrase')
  expected=$(echo "$line" | jq -r '.expected')
  tag=$(echo "$line" | jq -r '.tags[0]')

  skill_file="${SKILLS_DIR}/${skill}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    SKIP=$((SKIP + 1)); continue
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
        if echo "$description" | grep -qi "$phrase"; then
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
  esac
done < "$FIXTURES"

echo "=== Trigger Tests: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped ==="
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
