#!/usr/bin/env bash
set -euo pipefail

# Backfill GitHub releases for all version tags that don't have releases yet.
# Usage: bash scripts/backfill-releases.sh [--dry-run]

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== DRY RUN ==="
fi

# Get all version tags sorted
tags=$(git tag -l 'v*' | sort -V)

# Get existing releases
existing=$(gh release list --limit 100 --json tagName -q '.[].tagName' 2>/dev/null || true)

prev_tag=""
for tag in $tags; do
  if echo "$existing" | grep -qx "$tag"; then
    echo "SKIP $tag (release exists)"
    prev_tag="$tag"
    continue
  fi

  # Generate notes from commits between previous tag and this one
  if [[ -n "$prev_tag" ]]; then
    notes=$(git log --oneline "$prev_tag".."$tag" -- \
      | grep -v "chore: bump version\|chore: bump manifest" \
      | sed 's/^[a-f0-9]* /- /' \
      || true)
  else
    notes="Initial release"
  fi

  if [[ -z "$notes" ]]; then
    notes="Version bump and maintenance"
  fi

  echo ""
  echo "=== $tag ==="
  echo "$notes"

  if [[ "$DRY_RUN" == false ]]; then
    gh api repos/{owner}/{repo}/releases \
      -f tag_name="$tag" \
      -f name="$tag" \
      -f body="$notes" \
      -f make_latest="false" \
      --silent
    echo "Created release $tag"
  fi

  prev_tag="$tag"
done

# Mark the highest version as latest
latest_tag=$(echo "$tags" | tail -1)
if [[ "$DRY_RUN" == false ]]; then
  # Get the release ID for the latest tag and mark it as latest
  release_id=$(gh api "repos/{owner}/{repo}/releases/tags/$latest_tag" --jq '.id')
  gh api "repos/{owner}/{repo}/releases/$release_id" \
    -X PATCH \
    -f make_latest="true" \
    --silent
  echo ""
  echo "Marked $latest_tag as latest release"
fi

echo ""
echo "Done!"
