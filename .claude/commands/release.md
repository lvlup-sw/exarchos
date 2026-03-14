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
git add package.json package-lock.json .claude-plugin/plugin.json manifest.json servers/exarchos-mcp/package.json
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

### 6. Update marketplace clone (CRITICAL)

**Claude Code resolves the plugin version from the marketplace clone, not just `installed_plugins.json`.** If this falls behind, Claude Code loads the old version.

```bash
cd ~/.claude/plugins/marketplaces/lvlup-sw && git fetch origin main && git reset --hard origin/main
```

**Verify the marketplace clone version matches:**

```bash
grep '"version"' ~/.claude/plugins/marketplaces/lvlup-sw/package.json
# Must show $VERSION
```

### 7. Report

Tell the user:
- The version that was released (e.g., `v2.5.0`)
- Git tag created and pushed
- Plugin cache and marketplace clone updated
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

## Companion

If the companion also needs updating:

```bash
cd companion && npm run build && npm publish --access public
cd /tmp && npx --yes @lvlup-sw/exarchos-dev@latest
```

For local dev (no publish needed):

```bash
node companion/dist/install.js
```
