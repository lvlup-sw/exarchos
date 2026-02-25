#!/usr/bin/env bash
# Validates PR body against required section headers.
# Exit 0 = valid, Exit 1 = missing sections, Exit 2 = usage error
#
# Usage:
#   echo "$PR_BODY" | validate-pr-body.sh
#   validate-pr-body.sh --pr 906 [--repo owner/repo]
#   validate-pr-body.sh --template path/to/template.md < body.md
#   validate-pr-body.sh --dry-run --pr 906
#
# Default required sections: ## Summary, ## Changes, ## Test Plan
# Custom templates: any line matching `^## <section>` defines a required section.
# Skip conditions: Graphite merge queue PRs, bot authors (renovate, dependabot).

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────────────────

DEFAULT_SECTIONS=("Summary" "Changes" "Test Plan")
SKIP_AUTHORS=("renovate[bot]" "dependabot[bot]")

PR_NUMBER=""
REPO=""
AUTHOR=""
TEMPLATE=""
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
if [[ -n "$PR_NUMBER" ]]; then
  # Fetch from GitHub API
  REPO_FLAG=""
  if [[ -n "$REPO" ]]; then
    REPO_FLAG="--repo $REPO"
  fi
  # shellcheck disable=SC2086
  PR_DATA=$(gh pr view "$PR_NUMBER" $REPO_FLAG --json body,author --jq '{body: .body, author: .author.login}')
  BODY=$(echo "$PR_DATA" | jq -r '.body // ""')
  if [[ -z "$AUTHOR" ]]; then
    AUTHOR=$(echo "$PR_DATA" | jq -r '.author // ""')
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

# Skip Graphite merge queue PRs (defense-in-depth; CI also skips via job condition)
if echo "$BODY" | grep -qi "graphite merge queue"; then
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
  escaped_section=$(printf '%s' "$section" | sed 's/[.*+?^${}()|[\]/\\&/g')
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
