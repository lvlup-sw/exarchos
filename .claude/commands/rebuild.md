---
description: Rebuild exarchos plugin and update marketplace installation
---

# Rebuild

Build the project and sync the build output directly into the plugin cache.

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

### 5. Update marketplace clone

The marketplace clone at `~/.claude/plugins/marketplaces/lvlup-sw/` is a git checkout of this repo. Pull latest:

```bash
cd ~/.claude/plugins/marketplaces/lvlup-sw && git pull --ff-only origin main
```

### 6. Report

Tell the user:
- The version that was synced
- Remind them to restart Claude Code to pick up the changes

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
