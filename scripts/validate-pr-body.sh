#!/usr/bin/env bash
# Validates PR body against required section headers.
# Exit 0 = valid, Exit 1 = missing sections, Exit 2 = usage error
#
# Usage:
#   echo "$PR_BODY" | validate-pr-body.sh
#   validate-pr-body.sh --pr 906 [--repo owner/repo]
#   validate-pr-body.sh --body-file /tmp/pr-body.md
#   validate-pr-body.sh --template path/to/template.md < body.md
#   validate-pr-body.sh --dry-run --pr 906
#
# Default required sections: ## Summary, ## Changes, ## Test Plan
# Custom templates: any line matching `^## <section>` defines a required section.
# Skip conditions: GitHub merge queue PRs, bot authors (renovate, dependabot).

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────

DEFAULT_SECTIONS=("Summary" "Changes" "Test Plan")
SKIP_AUTHORS=("renovate[bot]" "dependabot[bot]")

PR_NUMBER=""
REPO=""
AUTHOR=""
HEAD_REF=""
TEMPLATE=""
BODY_FILE=""
DRY_RUN=false

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      [[ $# -ge 2 ]] || { echo "Missing value for --pr" >&2; exit 2; }
      PR_NUMBER="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Missing value for --repo" >&2; exit 2; }
      REPO="$2"
      shift 2
      ;;
    --author)
      [[ $# -ge 2 ]] || { echo "Missing value for --author" >&2; exit 2; }
      AUTHOR="$2"
      shift 2
      ;;
    --head-ref)
      [[ $# -ge 2 ]] || { echo "Missing value for --head-ref" >&2; exit 2; }
      HEAD_REF="$2"
      shift 2
      ;;
    --body-file)
      [[ $# -ge 2 ]] || { echo "Missing value for --body-file" >&2; exit 2; }
      BODY_FILE="$2"
      shift 2
      ;;
    --template)
      [[ $# -ge 2 ]] || { echo "Missing value for --template" >&2; exit 2; }
      TEMPLATE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# ─── Dry Run ──────────────────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "true" ]]; then
  exit 0
fi

# ─── Fetch PR Body ───────────────────────────────────────────────────────────

BODY=""
if [[ -n "$BODY_FILE" ]]; then
  # Read from file (pre-creation validation)
  if [[ ! -f "$BODY_FILE" ]]; then
    echo "Body file not found: $BODY_FILE" >&2
    exit 2
  fi
  BODY=$(cat "$BODY_FILE")
elif [[ -n "$PR_NUMBER" ]]; then
  # Fetch from GitHub API
  REPO_FLAG=""
  if [[ -n "$REPO" ]]; then
    REPO_FLAG="--repo $REPO"
  fi
  # shellcheck disable=SC2086
  PR_DATA=$(gh pr view "$PR_NUMBER" $REPO_FLAG --json body,author,headRefName --jq '{body: .body, author: .author.login, headRef: .headRefName}')
  BODY=$(echo "$PR_DATA" | jq -r '.body // ""')
  if [[ -z "$AUTHOR" ]]; then
    AUTHOR=$(echo "$PR_DATA" | jq -r '.author // ""')
  fi
  if [[ -z "$HEAD_REF" ]]; then
    HEAD_REF=$(echo "$PR_DATA" | jq -r '.headRef // ""')
  fi
else
  # Read from stdin
  BODY=$(cat)
fi

# ─── Skip Conditions ─────────────────────────────────────────────────────────

# Skip bot authors
for skip_author in "${SKIP_AUTHORS[@]}"; do
  if [[ "$AUTHOR" == "$skip_author" ]]; then
    exit 0
  fi
done

# Skip GitHub merge queue PRs (defense-in-depth; CI also skips via job condition)
if [[ -n "$HEAD_REF" ]] && echo "$HEAD_REF" | grep -q "^gh-readonly-queue/"; then
  exit 0
fi

# ─── Determine Required Sections ──────────────────────────────────────────────

REQUIRED_SECTIONS=()
if [[ -n "$TEMPLATE" ]]; then
  if [[ ! -f "$TEMPLATE" ]]; then
    echo "Template file not found: $TEMPLATE" >&2
    exit 2
  fi
  # Extract section headers from custom template
  while IFS= read -r line; do
    if [[ "$line" =~ ^##[[:space:]]+(.+)$ ]]; then
      REQUIRED_SECTIONS+=("${BASH_REMATCH[1]}")
    fi
  done < "$TEMPLATE"
else
  REQUIRED_SECTIONS=("${DEFAULT_SECTIONS[@]}")
fi

if [[ ${#REQUIRED_SECTIONS[@]} -eq 0 ]]; then
  echo "No required sections found in template" >&2
  exit 2
fi

# ─── Validate ─────────────────────────────────────────────────────────────────

MISSING=()
for section in "${REQUIRED_SECTIONS[@]}"; do
  # Escape regex metacharacters in section name for safe ERE matching
  escaped_section=$(printf '%s' "$section" | sed 's/\\/\\\\/g; s/[].*+?^${}()|[]/\\&/g')
  # Case-insensitive match for ## Section Header
  if ! echo "$BODY" | grep -qiE "^##[[:space:]]+${escaped_section}[[:space:]]*$"; then
    MISSING+=("$section")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "PR body validation failed." >&2
  for section in "${MISSING[@]}"; do
    echo "  Missing: ## $section" >&2
  done
  echo "" >&2
  echo "Required sections: ${REQUIRED_SECTIONS[*]}" >&2
  echo "See skills/synthesis/references/pr-descriptions.md for template." >&2
  exit 1
fi

exit 0
