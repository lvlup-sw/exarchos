#!/usr/bin/env bash
# validate-frontmatter.sh — Validate YAML frontmatter in SKILL.md files
#
# Usage: validate-frontmatter.sh <path-to-SKILL.md> <expected-folder-name>
#
# Runs all checks, collects errors, exits 0 if clean or 1 if any errors found.
# Designed for macOS compatibility (no GNU-specific tools).

set -euo pipefail

SKILL_FILE="${1:-}"
EXPECTED_FOLDER="${2:-}"

if [[ -z "$SKILL_FILE" || -z "$EXPECTED_FOLDER" ]]; then
  echo "Usage: validate-frontmatter.sh <path-to-SKILL.md> <expected-folder-name>"
  exit 2
fi

if [[ ! -f "$SKILL_FILE" ]]; then
  echo "ERROR: File not found: $SKILL_FILE"
  exit 2
fi

ERRORS=()
FRONTMATTER=""
BODY=""

# ---------------------------------------------------------------------------
# check_frontmatter_exists
#   Verify file starts with --- and has a closing ---.
#   Extract frontmatter between delimiters and body after closing delimiter.
# ---------------------------------------------------------------------------
check_frontmatter_exists() {
  local first_line
  first_line=$(head -n 1 "$SKILL_FILE")

  if [[ "$first_line" != "---" ]]; then
    ERRORS+=("check_frontmatter_exists: Missing opening --- delimiter")
    return
  fi

  # Find the closing --- (second occurrence, so line number > 1)
  local closing_line=0
  local line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    if [[ "$line_num" -gt 1 && "$line" == "---" ]]; then
      closing_line=$line_num
      break
    fi
  done < "$SKILL_FILE"

  if [[ "$closing_line" -eq 0 ]]; then
    ERRORS+=("check_frontmatter_exists: Missing closing --- delimiter")
    return
  fi

  # Extract frontmatter (between line 2 and closing_line - 1)
  local fm_start=2
  local fm_end=$((closing_line - 1))
  FRONTMATTER=$(sed -n "${fm_start},${fm_end}p" "$SKILL_FILE")

  # Extract body (everything after closing delimiter)
  local body_start=$((closing_line + 1))
  local total_lines
  total_lines=$(wc -l < "$SKILL_FILE" | tr -d ' ')
  if [[ "$body_start" -le "$total_lines" ]]; then
    BODY=$(tail -n +"$body_start" "$SKILL_FILE")
  else
    BODY=""
  fi
}

# ---------------------------------------------------------------------------
# check_required_fields
#   Verify name: and description: are present in the frontmatter.
# ---------------------------------------------------------------------------
check_required_fields() {
  if [[ -z "$FRONTMATTER" ]]; then
    return
  fi

  if ! echo "$FRONTMATTER" | grep -q '^name:'; then
    ERRORS+=("check_required_fields: Missing required field 'name'")
  fi

  if ! echo "$FRONTMATTER" | grep -q '^description:'; then
    ERRORS+=("check_required_fields: Missing required field 'description'")
  fi
}

# ---------------------------------------------------------------------------
# check_name_matches_folder
#   Verify the name: value matches the expected folder name (kebab-case).
# ---------------------------------------------------------------------------
check_name_matches_folder() {
  if [[ -z "$FRONTMATTER" ]]; then
    return
  fi

  local name_value
  name_value=$(echo "$FRONTMATTER" | grep '^name:' | sed 's/^name:[[:space:]]*//' | tr -d '"' | tr -d "'" || true)

  if [[ -z "$name_value" ]]; then
    return  # Already caught by check_required_fields
  fi

  if [[ "$name_value" != "$EXPECTED_FOLDER" ]]; then
    ERRORS+=("check_name_matches_folder: Name '${name_value}' does not match folder '${EXPECTED_FOLDER}'")
  fi
}

# ---------------------------------------------------------------------------
# check_no_xml_tags
#   Verify the frontmatter section contains no < or > characters.
# ---------------------------------------------------------------------------
check_no_xml_tags() {
  if [[ -z "$FRONTMATTER" ]]; then
    return
  fi

  if echo "$FRONTMATTER" | grep -q '[<>]'; then
    ERRORS+=("check_no_xml_tags: Frontmatter contains '<' or '>' characters (breaks Claude Code parsing)")
  fi
}

# ---------------------------------------------------------------------------
# check_word_count
#   Count words in the body and verify <= 2000 words.
# ---------------------------------------------------------------------------
check_word_count() {
  if [[ -z "$BODY" ]]; then
    return
  fi

  local word_count
  word_count=$(echo "$BODY" | wc -w | tr -d ' ')

  if [[ "$word_count" -gt 2000 ]]; then
    ERRORS+=("check_word_count: Body has ${word_count} words (limit: 2000)")
  fi
}

# ---------------------------------------------------------------------------
# check_references_exist
#   Find all references/*.md patterns in the body and verify each file exists
#   relative to the SKILL.md's parent directory.
# ---------------------------------------------------------------------------
check_references_exist() {
  if [[ -z "$BODY" ]]; then
    return
  fi

  local skill_dir
  skill_dir=$(dirname "$SKILL_FILE")

  # Find all references/*.md patterns in the body
  local refs
  refs=$(echo "$BODY" | grep -oE 'references/[^)[:space:]"]+\.md' || true)

  if [[ -z "$refs" ]]; then
    return
  fi

  while IFS= read -r ref; do
    if [[ ! -f "${skill_dir}/${ref}" ]]; then
      ERRORS+=("check_references_exist: Referenced file '${ref}' not found relative to $(basename "$skill_dir")/")
    fi
  done <<< "$refs"
}

# ---------------------------------------------------------------------------
# Main — Run all checks, report errors, exit appropriately
# ---------------------------------------------------------------------------

check_frontmatter_exists
check_required_fields
check_name_matches_folder
check_no_xml_tags
check_word_count
check_references_exist

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  for err in "${ERRORS[@]}"; do
    echo "ERROR: $err"
  done
  exit 1
fi

exit 0
