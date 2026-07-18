#!/usr/bin/env bash
# sync-marketplace.sh — Update the lvlup-sw marketplace clone with the current version,
# commit, push, populate the local plugin cache, update installed_plugins.json,
# and prune stale cache entries.
#
# Called by the /release command after npm publish.
# Can also be run standalone to fix drift: `bash scripts/sync-marketplace.sh`
#
# Standalone-safety invariant (#1690): the new version's cache dir is populated
# (npm pack + extract) and installed_plugins.json is updated BEFORE any prune
# runs. Pruning never executes unless the target version dir exists, so the
# harness can never observe a dangling installPath and silently re-download the
# old version. Cache dirs carrying an `.in_use` marker are never pruned — the
# live session has them loaded.
#
# Flags:
#   --check    Verify marketplace is in sync without modifying anything (exit 1 on drift)
#   --no-push  Update locally but don't push to remote
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/lvlup-sw"
MARKETPLACE_JSON="${MARKETPLACE_DIR}/.claude-plugin/marketplace.json"
CACHE_DIR="${HOME}/.claude/plugins/cache/lvlup-sw/exarchos"
INSTALLED_JSON="${HOME}/.claude/plugins/installed_plugins.json"

CHECK_MODE=false
NO_PUSH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_MODE=true; shift ;;
    --no-push) NO_PUSH=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: sudo apt install jq" >&2
  exit 2
fi

VERSION=$(node -e "console.log(require('${REPO_ROOT}/package.json').version)")

if [[ ! -d "$MARKETPLACE_DIR" ]]; then
  echo "Error: marketplace clone not found at ${MARKETPLACE_DIR}" >&2
  exit 2
fi

if [[ ! -f "$MARKETPLACE_JSON" ]]; then
  echo "Error: marketplace.json not found at ${MARKETPLACE_JSON}" >&2
  exit 2
fi

CURRENT_MKT_VERSION=$(jq -r '.plugins[] | select(.name=="exarchos") | .version' "$MARKETPLACE_JSON")

if [[ "$CHECK_MODE" == "true" ]]; then
  ERRORS=0

  if [[ "$CURRENT_MKT_VERSION" != "$VERSION" ]]; then
    echo "DRIFT: marketplace declares exarchos ${CURRENT_MKT_VERSION}, repo is ${VERSION}" >&2
    ((ERRORS++)) || true
  fi

  # Check installed_plugins.json
  if [[ -f "$INSTALLED_JSON" ]]; then
    INSTALLED_VERSION=$(jq -r '.plugins["exarchos@lvlup-sw"][0].version' "$INSTALLED_JSON")
    if [[ "$INSTALLED_VERSION" != "$VERSION" ]]; then
      echo "DRIFT: installed_plugins.json points to ${INSTALLED_VERSION}, repo is ${VERSION}" >&2
      ((ERRORS++)) || true
    fi
    INSTALLED_PATH=$(jq -r '.plugins["exarchos@lvlup-sw"][0].installPath' "$INSTALLED_JSON")
    if [[ ! -d "$INSTALLED_PATH" ]]; then
      echo "BROKEN: installed_plugins.json points to missing path ${INSTALLED_PATH}" >&2
      ((ERRORS++)) || true
    fi
  fi

  # Check for stale cache entries
  if [[ -d "$CACHE_DIR" ]]; then
    STALE=$(find "$CACHE_DIR" -maxdepth 1 -mindepth 1 -type d -not -name "$VERSION" 2>/dev/null)
    if [[ -n "$STALE" ]]; then
      echo "STALE: found old cache entries (harmless but wasteful):" >&2
      echo "$STALE" | sed 's/^/  /' >&2
    fi
  fi

  if [[ $ERRORS -gt 0 ]]; then
    echo "Marketplace check FAILED (${ERRORS} issue(s))" >&2
    exit 1
  fi
  echo "Marketplace in sync: exarchos v${VERSION}"
  exit 0
fi

# --- Update mode ---

echo "Syncing marketplace to exarchos v${VERSION}..."

# 1. Update marketplace.json — only the exarchos entry
jq --arg v "$VERSION" '
  .plugins = [.plugins[] |
    if .name == "exarchos" then
      .version = $v | .source.version = $v
    else .
    end
  ]
' "$MARKETPLACE_JSON" > "${MARKETPLACE_JSON}.tmp"
mv "${MARKETPLACE_JSON}.tmp" "$MARKETPLACE_JSON"

echo "  Updated marketplace.json: exarchos → v${VERSION}"

# 2. Commit and push if there are changes
cd "$MARKETPLACE_DIR"
if ! git diff --quiet .claude-plugin/marketplace.json 2>/dev/null; then
  git add .claude-plugin/marketplace.json
  git commit -m "chore: bump exarchos to ${VERSION} in marketplace"

  if [[ "$NO_PUSH" == "false" ]]; then
    git push origin main 2>&1 | tail -3
    echo "  Pushed marketplace update to remote"
  else
    echo "  Committed locally (--no-push)"
  fi
else
  echo "  marketplace.json already at v${VERSION}, no commit needed"
fi

# 3. Populate the new version's cache dir (BEFORE any prune — #1690).
#    Extracts the published npm tarball; the cache layout is just the package
#    contents (npm tarballs nest under `package/`, hence --strip-components=1).
populate_cache() {
  local target="${CACHE_DIR}/${VERSION}"
  if [[ -d "$target" ]]; then
    echo "  Cache already populated: ${target}"
    return 0
  fi
  local tmp tarball
  tmp=$(mktemp -d)
  if ! tarball=$(cd "$tmp" && npm pack "@lvlup-sw/exarchos@${VERSION}" 2>/dev/null | tail -1) \
     || [[ -z "$tarball" || ! -f "${tmp}/${tarball}" ]]; then
    rm -rf "$tmp"
    return 1
  fi
  local stage="${tmp}/extract"
  mkdir -p "$stage"
  if ! tar -xzf "${tmp}/${tarball}" -C "$stage" --strip-components=1; then
    rm -rf "$tmp"
    return 1
  fi
  mkdir -p "$(dirname "$target")"
  mv "$stage" "$target"
  rm -rf "$tmp"
  echo "  Populated cache from npm: ${target}"
}

# 4. Update installed_plugins.json to the new version + path (was warn-only).
update_installed_json() {
  if [[ ! -f "$INSTALLED_JSON" ]]; then
    return 0
  fi
  if ! jq -e '.plugins["exarchos@lvlup-sw"][0]' "$INSTALLED_JSON" >/dev/null 2>&1; then
    echo "  installed_plugins.json has no exarchos@lvlup-sw entry; leaving as-is"
    return 0
  fi
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S).000Z"
  jq --arg v "$VERSION" --arg p "${CACHE_DIR}/${VERSION}" --arg t "$now" '
    .plugins["exarchos@lvlup-sw"][0] |= (.version = $v | .installPath = $p | .lastUpdated = $t)
  ' "$INSTALLED_JSON" > "${INSTALLED_JSON}.tmp"
  mv "${INSTALLED_JSON}.tmp" "$INSTALLED_JSON"
  echo "  Updated installed_plugins.json → v${VERSION}"
}

# 5. Prune stale cache entries — only reachable after a successful populate,
#    and never a dir the live session has loaded (`.in_use` marker).
prune_stale_cache() {
  local PRUNED=0 entry entry_name
  for entry in "$CACHE_DIR"/*/; do
    [[ -d "$entry" ]] || continue
    entry_name=$(basename "$entry")
    if [[ "$entry_name" == "$VERSION" ]]; then
      continue
    fi
    if [[ -e "${entry}.in_use" ]]; then
      echo "  Skipped prune (in use): ${entry_name}"
      continue
    fi
    rm -rf "$entry"
    echo "  Pruned stale cache: ${entry_name}"
    ((PRUNED++)) || true
  done
  if [[ $PRUNED -eq 0 ]]; then
    echo "  No stale cache entries to prune"
  fi
}

HAS_LOCAL_INSTALL=false
if [[ -d "$CACHE_DIR" ]]; then
  HAS_LOCAL_INSTALL=true
elif [[ -f "$INSTALLED_JSON" ]] && jq -e '.plugins["exarchos@lvlup-sw"][0]' "$INSTALLED_JSON" >/dev/null 2>&1; then
  HAS_LOCAL_INSTALL=true
fi

if [[ "$HAS_LOCAL_INSTALL" == "true" ]]; then
  if populate_cache; then
    update_installed_json
    prune_stale_cache
  else
    echo "  WARNING: could not fetch @lvlup-sw/exarchos@${VERSION} from npm"
    echo "  Skipping installed_plugins.json update and cache prune (fail-safe: never prune without a populated target)"
    echo "  Local cache NOT synced; re-run once v${VERSION} is available on npm"
  fi
else
  echo "  No local exarchos plugin install detected; skipping cache sync"
fi

echo "Done."
