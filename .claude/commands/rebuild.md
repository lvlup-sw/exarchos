---
description: Rebuild exarchos plugin and update marketplace installation
---

# Rebuild

Build the project and sync the build output into the local plugin installation.

**Why not `claude plugin update`?** The plugin installer resolves versions through npm CDN which has aggressive caching — it often fetches stale tarballs even after `npm publish`. This command bypasses that by copying the local build directly.

## Process

### 1. Build

Run from the exarchos repo root:

```bash
npm run build
```

### 2. Read the version from package.json

```bash
node -e "console.log(require('./package.json').version)"
```

Store this as `$VERSION`.

### 3. Sync to plugin cache

Copy the full package contents to the cache directory. The cache path is:
`~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION`

```bash
# Create the cache directory
mkdir -p ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION

# Sync all distributed files (mirrors what npm pack would include)
# Use rsync to overwrite existing files, --delete to remove stale files
rsync -a --delete \
  --include='.claude-plugin/***' \
  --include='commands/***' \
  --include='skills/***' \
  --include='rules/***' \
  --include='hooks/***' \
  --include='scripts/***' \
  --include='dist/***' \
  --include='settings.json' \
  --include='package.json' \
  --include='AGENTS.md' \
  --include='CLAUDE.md.template' \
  --include='LICENSE' \
  --include='README.md' \
  --exclude='*' \
  ./ ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION/
```

### 4. Update installed_plugins.json

Read `~/.claude/plugins/installed_plugins.json` and update the `exarchos@lvlup-sw` entry:
- Set `installPath` to `~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION` (use absolute path with expanded `~`)
- Set `version` to `$VERSION`
- Set `lastUpdated` to the current ISO timestamp

### 5. Update marketplace clone (CRITICAL)

**Claude Code resolves the plugin version from the marketplace clone, not just `installed_plugins.json`.** If you skip this step or it falls behind, Claude Code will load the old version regardless of what `installed_plugins.json` says.

The marketplace clone at `~/.claude/plugins/marketplaces/lvlup-sw/` is a git checkout of this repo. It must match the version you're installing.

```bash
cd ~/.claude/plugins/marketplaces/lvlup-sw && git fetch origin main && git reset --hard origin/main
```

Use `git reset --hard` instead of `git pull --ff-only` because the clone may have diverged or have local modifications.

**Verify the marketplace clone version matches:**

```bash
grep '"version"' ~/.claude/plugins/marketplaces/lvlup-sw/package.json
# Must show $VERSION
```

### 6. Report

Tell the user:
- The version that was synced
- Remind them to restart Claude Code to pick up the changes

## Publishing to npm

When publishing a new version to the npm registry:

### Version bump workflow

```bash
npm version patch --no-git-tag-version   # or minor/major
npm run version:sync                      # sync to plugin.json, marketplace.json, manifest.json
npm run build                             # rebuild with new version
git add package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json manifest.json
git commit -m "chore: bump version to $VERSION"
git push origin main
npm login                                 # if token expired
npm publish --access public
```

### Verifying the published tarball

After publishing, verify the tarball contains the expected files:

```bash
npm pack @lvlup-sw/exarchos@$VERSION --dry-run 2>&1 | grep better_sqlite3.node
# Should show the ~2MB native binary
```

### Installing from npm (like a new user)

To test the exact experience a new user would have:

```bash
# Clear the local cache for this version
rm -rf ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION

# Fetch the tarball directly from npm (bypasses CDN cache)
mkdir -p ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION
cd ~/.claude/plugins/cache/lvlup-sw/exarchos/$VERSION
npm pack @lvlup-sw/exarchos@$VERSION
tar xzf lvlup-sw-exarchos-$VERSION.tgz --strip-components=1
rm lvlup-sw-exarchos-$VERSION.tgz

# Then update installed_plugins.json and marketplace clone (steps 4-5 above)
```

**Do NOT use `claude plugin update`** — the npm CDN aggressively caches old tarballs and may fetch a stale version even minutes after publishing.

## Companion

If the companion also needs updating:

```bash
# Publish new version
cd companion && npm run build && npm publish --access public

# Install from npm (MUST run from outside the exarchos repo to avoid local resolution)
cd /tmp && npx --yes @lvlup-sw/exarchos-dev@latest
```

For local dev (no publish needed):

```bash
node companion/dist/install.js
```
