---
description: Version bump, sync, validate, tag, and trigger the Release workflow
---

# Release

Bump the version, propagate it to every derived call site, validate locally, then tag and push to trigger `.github/workflows/release.yml`. The workflow publishes to npm AND uploads cross-compiled binaries (5 targets × 2 files each = 10 assets) to a new GitHub Release.

**Argument:** `patch` | `minor` | `major` | an explicit semver like `2.9.0-rc.1` (default: `patch`)

A pre-release identifier like `2.9.0-rc.1` is allowed and triggers the same workflow path — the semver guard `contains(github.ref_name, '.')` matches both stable and pre-release tags.

---

## Process

### 1. Pre-flight: clean working tree on `main`

```bash
git checkout main
git pull origin main
git status                                  # must be clean
```

If the tree isn't clean, stop and resolve before continuing — `version:sync` mutates seven files and you don't want to commingle those edits with unrelated work.

### 2. Bump `package.json`

Pass an explicit semver for pre-releases; use `patch`/`minor`/`major` for stable bumps.

```bash
# Stable bump:
npm version patch --no-git-tag-version

# Pre-release (e.g. release candidate):
npm version 2.9.0-rc.1 --no-git-tag-version
```

Capture the new version:

```bash
VERSION=$(node -p "require('./package.json').version")
```

### 3. Propagate the version everywhere

`scripts/sync-versions.sh` (driven by `npm run version:sync`) is the single source-of-truth bumper. It patches all seven derived call sites:

| Sink | Field |
|------|-------|
| `.claude-plugin/plugin.json` | `.version`, `.metadata.compat.minBinaryVersion` |
| `manifest.json` | `.version` |
| `servers/exarchos-mcp/package.json` | `.version` |
| `servers/exarchos-mcp/src/index.ts` | `export const SERVER_VERSION` |
| `servers/exarchos-mcp/src/adapters/mcp.ts` | `const SERVER_VERSION` |
| `servers/exarchos-mcp/src/adapters/cli.ts` | `.version('…')` (commander) + `binaryVersion: '…'` |
| `servers/exarchos-mcp/src/cli-commands/session-start.ts` | `const SESSION_START_BINARY_VERSION` |

```bash
npm run version:sync
npm run version:check                       # confirms zero drift across the 7 sinks
```

`--check` exits 1 with a `MISMATCH:` line per drifted site if anything is out of sync — never short-circuits, so one run reports every problem. Add a sink by extending the `ts_sites` registry in `scripts/sync-versions.sh` (single registration point — see DIM-1 in `axiom:backend-quality`).

### 4. Validate locally

```bash
npm run typecheck
npm run test:run
(cd servers/exarchos-mcp && npm run test:run)
npm run build                               # produces 5 binaries in dist/bin/
ls -lh dist/bin/                            # exarchos-{linux,darwin,windows}-{x64,arm64}*
bash scripts/sync-versions.test.sh          # 11 tests on the bumper itself
```

Fail fast if any of these break. Don't tag a release that doesn't typecheck.

### 5. Commit + tag + push

`scripts/sync-versions.sh` already wrote the seven derived files; `npm version` handled `package.json` + `package-lock.json`. Stage, commit, tag, push.

```bash
git add package.json package-lock.json manifest.json .claude-plugin/plugin.json \
        servers/exarchos-mcp/package.json servers/exarchos-mcp/package-lock.json \
        servers/exarchos-mcp/src/index.ts \
        servers/exarchos-mcp/src/adapters/mcp.ts \
        servers/exarchos-mcp/src/adapters/cli.ts \
        servers/exarchos-mcp/src/cli-commands/session-start.ts

git commit -m "chore: bump version to ${VERSION}"
git push origin main

git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin "v${VERSION}"
```

### 6. Watch the Release workflow

The tag push fires `.github/workflows/release.yml`, which runs three jobs in parallel:

1. **`release`** — npm publish (`@lvlup-sw/exarchos`).
2. **`binary-matrix`** (5 OS × ARCH targets) — `bun build --compile` + SHA-512 sidecars.
3. **`publish-release`** — collates the matrix outputs and creates the GitHub Release with **10 assets** (5 binaries + 5 `.sha512` checksums).

```bash
gh run watch                                # live tail of the most recent run
gh release view "v${VERSION}"               # confirm 10 assets attached
```

If `publish-release` ever attaches a different number of assets, the invariant is enforced by `scripts/release-workflow.test.ts` — fix the matrix or the test, never bypass.

### 7. Bump the marketplace pin (REQUIRED)

The `lvlup-sw/.github` marketplace `marketplace.json` declares the version that `/plugin install exarchos@lvlup-sw` will resolve. **End users installing through Claude Code's plugin path resolve through this file** — if it isn't bumped, the published npm version is unreachable via the plugin surface and `/plugin install` keeps serving the previous pin (or a stale npm-cache entry of it). The bootstrap installer (`curl … | bash`) is independent of this; the plugin path is not.

```bash
bash scripts/sync-marketplace.sh            # bumps marketplace.json + prunes stale cache + pushes
bash scripts/sync-marketplace.sh --check    # verify after
```

The script commits and pushes to `lvlup-sw/.github` automatically. If the push fails (branch protection or stale local clone), resolve it before moving on — do not skip this step:

```bash
cd ~/.claude/plugins/marketplaces/lvlup-sw
git pull --rebase origin main
git push origin main
```

Verify the remote actually advanced:

```bash
gh api repos/lvlup-sw/.github/contents/.claude-plugin/marketplace.json --jq '.content' \
  | base64 -d | jq -r '.plugins[] | select(.name=="exarchos") | .version'
# must print ${VERSION}
```

### 8. Smoke-test the install (REQUIRED for `-rc` tags)

The whole point of an rc tag is to dogfood the install path before stable. Run it.

```bash
# Real install — drops the binary at $HOME/.local/bin/exarchos:
bash scripts/get-exarchos.sh --version "v${VERSION}"

# Or via the public bootstrap entry-point once the release is live:
curl -fsSL "https://raw.githubusercontent.com/lvlup-sw/exarchos/v${VERSION}/scripts/get-exarchos.sh" \
  | bash -s -- --version "v${VERSION}"

exarchos --version                          # must print ${VERSION}
exarchos doctor                             # smoke-test
```

For dry-run preview (no download, no PATH mutation):

```bash
bash scripts/get-exarchos.sh --version "v${VERSION}" --dry-run
```

### 9. Report

Tell the user:
- The version that was released
- Tag created and pushed
- GitHub Release URL (`gh release view "v${VERSION}" --json url --jq .url`)
- Marketplace pin bumped (verified via the `gh api` check in step 7)
- For `-rc` tags: the exact `bash scripts/get-exarchos.sh --version v${VERSION}` command

---

## Why the manual edit list shrank to zero

Before `sync-versions.sh` covered the TypeScript constants, every release required hand-editing five `.ts` files in lockstep with `package.json`. Multiple missed bumps shipped with stale `SERVER_VERSION` strings (PR #1176 review-finding-2 caught one in v2.9). The bumper now owns the entire fan-out — `npm run version:sync` is sufficient.

If you find yourself editing a version literal by hand, that's a sign a new sink slipped into the codebase without being registered. Add it to the `ts_sites` registry (or to the JSON-sinks block) in `scripts/sync-versions.sh`, extend `scripts/sync-versions.test.sh`, and the next release picks it up automatically.

## Why not `claude plugin update`?

The plugin installer resolves versions through the npm CDN, which caches aggressively and frequently serves stale tarballs even after `npm publish` succeeds. Step 7 above (`sync-marketplace.sh`) bypasses the CDN entirely by pointing your local marketplace clone at the new version directly. Use that instead of `claude plugin update` whenever you need the new bits in your current session.
