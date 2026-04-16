---
description: Version bump, git tag, build, and sync plugin to local installation
---

# Release

Bump the version, tag the release, build, and sync to the local plugin installation.

**Argument:** `patch` | `minor` | `major` (default: `patch`)

## Process

### 1. Version bump

Bump the version in `package.json` using the specified level:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

Then sync all manifest files and build:

```bash
npm run version:sync && npm run build
```

### 2. Read the new version

```bash
node -e "console.log(require('./package.json').version)"
```

Store this as `$VERSION`.

### 3. Commit and tag

```bash
git add package.json package-lock.json .claude-plugin/plugin.json manifest.json servers/exarchos-mcp/package.json packages/create-exarchos/package.json
git commit -m "chore: bump version to $VERSION"
git tag -a v$VERSION -m "v$VERSION"
git push origin main && git push origin v$VERSION
```

### 4. Sync to plugin cache

Copy the full package contents to the cache directory:

```bash
mkdir -p ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION

rsync -a --delete \
  --include='.claude-plugin/***' \
  --include='commands/***' \
  --include='skills/***' \
  --include='rules/***' \
  --include='hooks/***' \
  --include='scripts/***' \
  --include='dist/***' \
  --include='agents/***' \
  --include='settings.json' \
  --include='package.json' \
  --include='AGENTS.md' \
  --include='CLAUDE.md.template' \
  --include='LICENSE' \
  --include='README.md' \
  --exclude='*' \
  ./ ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION/
```

### 5. Update installed_plugins.json

Read `~/.claude/plugins/installed_plugins.json` and update the `exarchos@lvlup-sw` entry:
- Set `installPath` to the absolute cache path
- Set `version` to `$VERSION`
- Set `lastUpdated` to the current ISO timestamp

### 6. Sync marketplace and prune stale cache (CRITICAL)

**This step prevents version drift across Claude Code sessions.** The marketplace clone determines which version Claude Code loads — if it falls behind, all other sessions load the old version.

```bash
bash scripts/sync-marketplace.sh
```

This script:
1. Updates `marketplace.json` in the lvlup-sw marketplace clone with the new version
2. Commits and pushes the change to the remote repository
3. Prunes old cache entries (keeps only the current version)
4. Verifies `installed_plugins.json` is consistent

**If the push fails** (e.g., branch protection), manually push the marketplace repo:

```bash
cd ~/.claude/plugins/marketplaces/lvlup-sw
git push origin main
```

### 7. Validate (run every time)

```bash
bash scripts/sync-marketplace.sh --check
```

This verifies:
- Marketplace version matches `package.json`
- `installed_plugins.json` points to the correct cache path
- Cache path exists on disk
- No stale cache entries remain

**Do not skip this step.** The validation catches drift that causes the bug where other sessions load stale plugin versions.

### 8. Report

Tell the user:
- The version that was released (e.g., `v2.5.0`)
- Git tag created and pushed
- Plugin cache, marketplace, and installed_plugins.json all updated
- Remind them to restart Claude Code to pick up the changes

## Why not `claude plugin update`?

The plugin installer resolves versions through npm CDN which has aggressive caching — it often fetches stale tarballs even after `npm publish`. This command bypasses that by copying the local build directly.

## Publishing to npm

When publishing to the npm registry (after the release):

```bash
npm login                    # if token expired
npm publish --access public
```

### Verifying the published tarball

```bash
npm pack @lvlup-sw/exarchos@$VERSION --dry-run 2>&1 | grep better_sqlite3.node
# Should show the ~2MB native binary
```

**Do NOT use `claude plugin update`** — the npm CDN aggressively caches old tarballs.

## Companion (deprecated)

The `@lvlup-sw/exarchos-dev` companion package has been deprecated. Use `npx create-exarchos` instead. See `docs/deprecation/exarchos-dev.md` for migration details.
