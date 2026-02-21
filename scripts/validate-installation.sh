#!/usr/bin/env bash
# validate-installation.sh — Post-install verification for skills
#
# Usage: validate-installation.sh [target-skills-dir]
# Default target: ~/.claude/skills
#
# Verifies:
#   1. Each skill subdirectory has a SKILL.md file
#   2. Each SKILL.md passes frontmatter validation
#   3. references/ directories have matching file counts vs repo source
#
# Exit 0 if all pass, exit 1 with error list otherwise.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VALIDATOR="${REPO_ROOT}/skills/validate-frontmatter.sh"
TARGET_DIR="${1:-${HOME}/.claude/skills}"

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "ERROR: Target directory not found: $TARGET_DIR"
  exit 2
fi

if [[ ! -x "$VALIDATOR" ]]; then
  echo "ERROR: Validator script not found or not executable: $VALIDATOR"
  exit 2
fi

ERRORS=()
PASS_COUNT=0
TOTAL=0

for skill_dir in "$TARGET_DIR"/*/; do
  [[ -d "$skill_dir" ]] || continue

  # Skip test-fixtures and trigger-tests directories
  local_name=$(basename "$skill_dir")
  if [[ "$local_name" == "test-fixtures" || "$local_name" == "trigger-tests" ]]; then
    continue
  fi

  TOTAL=$((TOTAL + 1))
  skill_file="${skill_dir}SKILL.md"

  # Check 1: SKILL.md exists
  if [[ ! -f "$skill_file" ]]; then
    ERRORS+=("${local_name}: Missing SKILL.md")
    continue
  fi

  # Check 2: Frontmatter validation
  result=""
  rc=0
  result=$("$VALIDATOR" "$skill_file" "$local_name" 2>&1) || rc=$?

  if [[ $rc -ne 0 ]]; then
    ERRORS+=("${local_name}: Frontmatter validation failed — ${result}")
    continue
  fi

  PASS_COUNT=$((PASS_COUNT + 1))

  # Check 3: references/ directory file count matches repo source (if applicable)
  repo_refs="${REPO_ROOT}/skills/${local_name}/references"
  target_refs="${skill_dir}references"

  if [[ -d "$repo_refs" ]]; then
    if [[ ! -d "$target_refs" ]]; then
      ERRORS+=("${local_name}: Missing references/ directory (repo has one)")
      PASS_COUNT=$((PASS_COUNT - 1))
    else
      repo_count=$(find "$repo_refs" -type f | wc -l | tr -d ' ')
      target_count=$(find "$target_refs" -type f | wc -l | tr -d ' ')

      if [[ "$repo_count" != "$target_count" ]]; then
        ERRORS+=("${local_name}: references/ file count mismatch (repo: ${repo_count}, installed: ${target_count})")
        PASS_COUNT=$((PASS_COUNT - 1))
      fi
    fi
  fi
done

if [[ $TOTAL -eq 0 ]]; then
  echo "ERROR: No skills found in $TARGET_DIR"
  exit 1
fi

echo "=== Installation Validation: ${PASS_COUNT}/${TOTAL} skills passed ==="

if [[ -n "${ERRORS+x}" ]] && [[ ${#ERRORS[@]} -gt 0 ]]; then
  echo ""
  echo "Errors:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi

exit 0
