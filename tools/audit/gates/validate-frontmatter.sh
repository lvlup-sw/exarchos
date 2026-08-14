#!/usr/bin/env bash
# validate-frontmatter.sh — Detect orphaned files in non-standard skill directories
#
# Checks:
#   For each file in skills/*/phases/ and skills/*/templates/, verifies that
#   at least one file in the parent skill's references/ or SKILL.md references
#   the filename. Orphaned files indicate dead content.
#
# Usage: validate-frontmatter.sh --repo-root <path>
#
# Exit codes:
#   0 = all files referenced (pass)
#   1 = orphaned files found (fail)
#   2 = usage error

set -euo pipefail

# ============================================================
# ARGUMENT PARSING
# ============================================================

REPO_ROOT="."

usage() {
  cat << 'USAGE'
Usage: validate-frontmatter.sh --repo-root <path>

Detects orphaned files in non-standard skill subdirectories (phases/, templates/).
For each file found, checks if any file in the parent skill's references/ or
SKILL.md references it by filename.

Options:
  --repo-root <path>   Path to the repository root (default: .)
  --help               Show this help message

Exit codes:
  0  All files referenced (pass)
  1  Orphaned files found (fail)
  2  Usage error
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --repo-root requires a path argument" >&2
        exit 2
      fi
      REPO_ROOT="$2"
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$REPO_ROOT" ]]; then
  echo "Error: Repository root not found: $REPO_ROOT" >&2
  exit 2
fi

# ============================================================
# ORPHAN DETECTION
# ============================================================

NONSTANDARD_DIRS=("phases" "templates")
ORPHANS=()
CHECKED=0

# is_file_referenced <skill_dir> <filename>
#   Returns 0 if filename is mentioned in SKILL.md or any references/ file.
is_file_referenced() {
  local skill_dir="$1"
  local filename="$2"

  # Check SKILL.md
  if [[ -f "$skill_dir/SKILL.md" ]] && grep -qF "$filename" "$skill_dir/SKILL.md"; then
    return 0
  fi

  # Check references/
  if [[ -d "$skill_dir/references" ]]; then
    for ref_file in "$skill_dir/references"/*; do
      [[ -f "$ref_file" ]] || continue
      if grep -qF "$filename" "$ref_file"; then
        return 0
      fi
    done
  fi

  return 1
}

# find_orphans_in_dir <skill_dir> <subdir_name>
#   Scans <skill_dir>/<subdir_name>/ for files, records orphans in ORPHANS array.
find_orphans_in_dir() {
  local skill_dir="$1"
  local subdir_name="$2"
  local subdir_path="$skill_dir/$subdir_name"

  [[ -d "$subdir_path" ]] || return 0

  for filepath in "$subdir_path"/*; do
    [[ -f "$filepath" ]] || continue

    local filename
    filename="$(basename "$filepath")"
    CHECKED=$((CHECKED + 1))

    if ! is_file_referenced "$skill_dir" "$filename"; then
      local relative_path="${filepath#"$REPO_ROOT"/}"
      ORPHANS+=("$relative_path")
    fi
  done
}

# scan_all_skills <repo_root>
#   Iterates over skill directories and scans non-standard subdirectories.
scan_all_skills() {
  local repo_root="$1"

  for skill_dir_raw in "$repo_root"/skills/*/; do
    [[ -d "$skill_dir_raw" ]] || continue

    # Strip trailing slash for clean path joining
    local skill_dir="${skill_dir_raw%/}"

    # Skip test-fixtures
    local dir_name
    dir_name="$(basename "$skill_dir")"
    [[ "$dir_name" == "test-fixtures" ]] && continue

    for subdir in "${NONSTANDARD_DIRS[@]}"; do
      find_orphans_in_dir "$skill_dir" "$subdir"
    done
  done
}

scan_all_skills "$REPO_ROOT"

# ============================================================
# STRUCTURED OUTPUT
# ============================================================

echo "## Frontmatter Validation Report"
echo ""

if [[ ${#ORPHANS[@]} -gt 0 ]]; then
  echo "Orphaned files in non-standard directories:"
  echo ""
  for orphan in "${ORPHANS[@]}"; do
    echo "- **FAIL**: $orphan — not referenced from SKILL.md or references/"
  done
  echo ""
  echo "---"
  echo ""
  echo "**Result: FAIL** (${#ORPHANS[@]} orphaned files found, $CHECKED files checked)"
  exit 1
elif [[ "$CHECKED" -eq 0 ]]; then
  echo "No non-standard directories (phases/, templates/) found."
  echo ""
  echo "---"
  echo ""
  echo "**Result: PASS** (0 files checked)"
  exit 0
else
  echo "All files in non-standard directories are referenced."
  echo ""
  echo "---"
  echo ""
  echo "**Result: PASS** ($CHECKED files checked)"
  exit 0
fi
