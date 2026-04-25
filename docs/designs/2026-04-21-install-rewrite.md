# Design: v2.9 Install Rewrite — `bun compile` binary + PATH-resolved plugin

- **Milestone:** v2.9.0 — Cross-platform & Install
- **Feature ID:** `v29-install-rewrite`
- **Primary issues:** #1115 (universal bootstrap), #1175 (replace `better-sqlite3`)
- **Subsumes:** #1043 (delete `create-exarchos` entirely, don't publish), #1173 (docs HTTPS fallback)
- **Not in scope for this design:** #1170, #1168, #1167 (cross-platform test guardrails), #1174, #1165 (runtime-polish track) — tracked under the same milestone but ideated separately

## Problem Statement

Exarchos today installs via `npx @lvlup-sw/exarchos` or marketplace plugin installation. Both paths require a working Node.js + npm toolchain on the user's machine, and the runtime plugin surface (`plugin.json`, `hooks/hooks.json`) invokes `node "${CLAUDE_PLUGIN_ROOT}/dist/exarchos.js"` for every hook and MCP server launch — making Node a hard dependency for *using* exarchos, not just installing it. The current build also bundles a native `better-sqlite3` addon that downloads 12 platform×ABI variants at build time — a pattern that survives `npm install -g` but is incompatible with a single-file compiled binary.

The goal for v2.9 is **zero-dependency installation** — `curl -fsSL https://get.exarchos.dev | bash` drops a self-contained binary on PATH, and the Claude Code plugin becomes content-only (commands, skills, rules, hooks config) that invokes the on-PATH binary. Node, npm, Bun, and native addons disappear from the user-facing surface. The reference implementation is Aspire's `eng/scripts/get-aspire-cli.sh`.

## Chosen Approach

A three-part change, split across three PRs that can land on `main` over days to weeks without a release cut:

1. **Binary target works** — swap `better-sqlite3` → `bun:sqlite`; add `bun build --compile` producing per-platform binaries. The binary runs `exarchos mcp`, `exarchos session-start`, etc., entirely without Node.
2. **Install rewrite** — `plugin.json` and `hooks.json` call bare `exarchos <cmd>` (PATH-resolved, Graphite-style). `get-exarchos.sh` / `get-exarchos.ps1` fetch the binary from GitHub Releases. Plugin and bootstrap are complementary channels.
3. **Dead code removal** — delete `src/install.ts`, `packages/create-exarchos/`, bundled-MCP references (graphite/serena/context7/microsoft-learn from installer surface), related docs; add marketplace HTTPS fallback note.

## Technical Design

### 1. SQLite runtime swap (`better-sqlite3` → `bun:sqlite`)

Surface area is bounded to `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (557 lines) and its tests. The `StorageBackend` interface stays fully synchronous — `bun:sqlite`'s API shape is near-identical to `better-sqlite3`:

| better-sqlite3 | bun:sqlite | Notes |
|---|---|---|
| `import Database from 'better-sqlite3'` | `import { Database } from 'bun:sqlite'` | Import style change |
| `new Database(path)` | `new Database(path)` | Same |
| `db.prepare(sql)` → `Statement` | `db.prepare(sql)` → `Statement` | Same |
| `stmt.run(...args)` / `.get(...)` / `.all(...)` | Same | Same |
| `db.pragma('journal_mode = WAL')` | `db.exec('PRAGMA journal_mode = WAL')` | Minor — bun:sqlite exposes pragma via `exec` |
| `db.transaction(fn)` | `db.transaction(fn)` | Same |

Internal callers of `StorageBackend` (event-store, materializer, outbox, hydration, lifecycle, migration) remain unchanged — their synchronous contract is preserved. The `runIntegrityPragma(signal)` async wrapper stays as-is. Zero caller-side changes.

Platform-variant download logic in `scripts/build-bundle.ts` is deleted — `bun compile` embeds SQLite directly into the binary.

### 2. Build pipeline — `bun build --compile` target

New `scripts/build-binary.ts` produces per-platform binaries:

```bash
# Output matrix
dist/bin/exarchos-linux-x64
dist/bin/exarchos-linux-arm64
dist/bin/exarchos-darwin-x64
dist/bin/exarchos-darwin-arm64
dist/bin/exarchos-windows-x64.exe
```

Internally: `bun build src/cli-entry.ts --compile --target=bun-${os}-${arch} --outfile dist/bin/exarchos-${os}-${arch}`. The existing `src/cli-entry.ts` (or equivalent — bundled today as `dist/exarchos.js`) becomes the compile entry point. The CLI entry dispatches on `argv[2]` to the subcommands already used by hooks (`mcp`, `session-start`, `guard`, `task-gate`, `teammate-gate`, `subagent-context`, `subagent-stop`, `session-end`, `pre-compact`).

Cross-platform compilation runs in CI on a single Linux runner — Bun's `--target` flag cross-compiles to all supported OS/arch combos without requiring per-OS runners.

SHA-512 checksums are produced per binary and published alongside the release.

### 3. Plugin surface refactor — PATH-resolved `exarchos`

Before:
```json
"mcpServers": {
  "exarchos": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/exarchos.js", "mcp"]
  }
}
```
After:
```json
"mcpServers": {
  "exarchos": {
    "command": "exarchos",
    "args": ["mcp"],
    "env": {
      "EXARCHOS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
    }
  }
}
```

Same transform for all 8 hooks in `hooks/hooks.json`. `${CLAUDE_PLUGIN_ROOT}` still flows through as an arg/env (data, not code) so the binary can locate plugin-relative assets (skills references, playbooks) — identical to today's `session-start --plugin-root "${CLAUDE_PLUGIN_ROOT}"` pattern.

Precedent already in the repo: Graphite's removed-but-formerly-declared MCP config used `"command": "gt"` with no bundled runtime. This design applies the same shape to exarchos itself.

**Graceful degradation:** if `exarchos` is not on PATH, Claude Code reports the MCP server unavailable and hooks exit non-zero silently. A `SessionStart` hook script embedded in the plugin (pure shell, no Node) can optionally emit a user-visible nudge: *"exarchos binary not found on PATH — run `curl -fsSL https://get.exarchos.dev | bash` to install."*

### 4. Bootstrap scripts — `get-exarchos.sh` / `get-exarchos.ps1`

Modeled directly on `dotnet/aspire/eng/scripts/get-aspire-cli.sh`. Key behaviors:

- **Platform detection** — `uname -s` / `uname -m` on Unix, `$env:PROCESSOR_ARCHITECTURE` on PowerShell; musl detection via `ldd --version`
- **Quality tiers** — `release` (default, tagged GitHub Releases), `staging` (pre-release), `dev` (HEAD artifact)
- **Checksum validation** — SHA-512 verification against `.sha512` sidecar file
- **Install location** — default `$HOME/.local/bin` (Unix) / `$USERPROFILE\.exarchos\bin` (Windows); configurable via `EXARCHOS_INSTALL_DIR`
- **PATH configuration** — append to `.bashrc`/`.zshrc`/`.config/fish/config.fish` (Unix) or registry (Windows); GitHub Actions mode (`--github-actions`) writes to `$GITHUB_PATH`
- **Dry-run mode** — `--dry-run` prints the install plan without executing
- **Version pinning** — `--version v2.9.0` for reproducible installs; default is latest stable

Both scripts are under ~400 lines, copy-paste-friendly, self-contained (no jq/yq). Hosted at `https://get.exarchos.dev` via GitHub Pages redirect to the raw script in the repo (`scripts/get-exarchos.sh`).

### 5. GitHub Releases pipeline

Extend `.github/workflows/release.yml` (or equivalent) with a `binary-matrix` job that:

1. Checks out at the release tag
2. Runs `bun build --compile` for each target in parallel (5 matrix entries)
3. Generates `.sha512` per binary
4. Uploads to the GitHub Release as assets: `exarchos-{os}-{arch}{.exe?}` + `exarchos-{os}-{arch}{.exe?}.sha512`
5. Posts the bootstrap URLs to the release body

Bootstrap scripts download via `https://github.com/lvlup-sw/exarchos/releases/download/v${VERSION}/exarchos-${OS}-${ARCH}`.

### 6. Version compatibility (binary ↔ plugin)

Since binary and plugin are separate install channels, they can drift. Mitigation:

- `plugin.json.metadata.compat.minBinaryVersion` declares the minimum binary version the plugin requires
- `exarchos version --check-plugin-root "${CLAUDE_PLUGIN_ROOT}"` reads that metadata and exits non-zero on mismatch
- `SessionStart` hook performs the check on every session start; emits a user-visible warning on drift

Version-lockstep releases (bootstrap script downloads a binary pinned to the exact plugin release tag) keep drift rare in practice.

### 7. Deletions

- `packages/create-exarchos/` — entire package including tests, installers, companions config
- `docs/designs/2026-03-14-create-exarchos.md` — archived (move to `docs/designs/archive/`, not deleted outright, per project convention)
- `docs/deprecation/exarchos-dev.md` — obsolete
- `src/install.ts` + `src/install.test.ts` — replaced by bootstrap
- `scripts/build-bundle.ts` — platform-variant `better-sqlite3` download logic obsolete
- `scripts/sync-marketplace.sh` — audited; update or delete if tied to the dual-plugin model
- References to graphite/serena/context7/microsoft-learn as *bundled companions* in README, AGENTS.md, CHANGELOG — legitimate external-tool mentions in skill docs are left alone (polish work, not distribution)
- `.claude-plugin/plugin.json` — strip `EXARCHOS_PLUGIN_ROOT` fallback paths that referenced bundled JS

## Integration Points

- **Claude Code plugin system** — unchanged API surface; only `command`/`args` values differ
- **MCP stdio transport** — unchanged; binary speaks the same JSON-RPC protocol
- **Hooks** — unchanged protocol; binary receives the same env vars / stdin payloads as today's `node dist/exarchos.js`
- **GitHub Releases** — new binary assets alongside existing source archive
- **Marketplace** — plugin repo stays at `lvlup-sw/exarchos`; plugin listing is unchanged; users install plugin + binary independently

## Migration Path — 3 PRs

### PR1 — Binary target works (internal-only)
- Swap `better-sqlite3` → `bun:sqlite` in `sqlite-backend.ts` (+ update tests)
- Add `scripts/build-binary.ts` and `npm run build:binary`
- Produce per-platform binaries in CI; verify they run `exarchos mcp` against the full MCP server test suite
- Delete platform-variant download logic from `build-bundle.ts` (but keep `dist/exarchos.js` JS bundle — plugin still invokes it)
- **Merge criterion:** binary is produced and functionally equivalent to the JS bundle; no user-facing change yet

### PR2 — Install rewrite (user-facing)
- Rewrite `plugin.json` + `hooks/hooks.json` to use bare `exarchos <cmd>` with PATH lookup
- Add `scripts/get-exarchos.sh` + `scripts/get-exarchos.ps1`
- Extend release workflow to publish binary assets + checksums to GitHub Releases
- Add `exarchos version --check-plugin-root` + SessionStart compatibility check
- Add SessionStart missing-binary nudge (POSIX shell fallback)
- **Merge criterion:** fresh install via bootstrap + plugin works end-to-end on Linux + macOS; Windows deferred to the test-guardrails track (#1170)

### PR3 — Dead code removal
- Delete `src/install.ts`, `packages/create-exarchos/`, `docs/deprecation/exarchos-dev.md`
- Archive `docs/designs/2026-03-14-create-exarchos.md`
- Strip bundled-MCP references from README, AGENTS.md, installer-adjacent docs
- Add HTTPS-fallback note to README (#1173)
- Remove `dist/exarchos.js` JS bundle emission from build (binary is the only artifact)
- **Merge criterion:** `npm run build` produces only the binary + content; no leftover Node-based install paths

## Testing Strategy

### Unit (PR1)
- `sqlite-backend.test.ts` runs unchanged against `bun:sqlite` — proves API-shape equivalence
- New `build-binary.test.ts` shells out `bun build --compile` for the current host and asserts the produced binary responds to `exarchos --version`

### Integration (PR1)
- Existing MCP server vitest suite runs against the compiled binary (not just the JS bundle) — proves `exarchos mcp` is functionally equivalent
- Event-store replay tests run against `bun:sqlite`-backed storage — proves migration-from-v1 paths still work

### Process-fidelity (PR2)
- `get-exarchos.sh --dry-run` prints expected install plan; verified via snapshot test in CI
- Fresh-environment smoke: docker container with no Node/Bun → run bootstrap → verify `exarchos --version` works
- Plugin-root integration: `exarchos mcp` spawned with `EXARCHOS_PLUGIN_ROOT` env var correctly resolves playbooks and skills

### Cross-platform (PR2)
- CI matrix for bootstrap scripts: `ubuntu-latest`, `macos-latest` (binary runtime); Windows bootstrap deferred to coordinate with #1170

### Cleanup (PR3)
- `grep -rE "better-sqlite3|create-exarchos|dist/exarchos\.js" src/ servers/ .github/` returns empty — asserted in a `scripts/validate-no-legacy.sh` check

## Open Questions

1. **`get.exarchos.dev` hosting** — GitHub Pages redirect vs Cloudflare Worker vs just `raw.githubusercontent.com/lvlup-sw/exarchos/main/scripts/get-exarchos.sh` with a README link? Cheapest option is the raw link; a short vanity URL is a polish item that can follow.

2. **Binary size** — `bun compile` output for a project of this size is typically 40–80 MB (embeds the Bun runtime). Acceptable for a CLI install, but worth measuring in PR1 and documenting. If it balloons past ~100 MB, investigate `bun build --compile --minify` and tree-shaking the MCP server's unused imports.

3. **Windows line endings in `hooks/hooks.json`** — PATH-resolved `exarchos` on Windows needs `.exe` resolution. Claude Code's plugin loader may or may not append `.exe` automatically on Win32. Verify in PR2; fall back to two matcher entries or a `.cmd` shim if needed.

4. **`dist/exarchos.js` JS bundle** — PR1 keeps it (plugin still invokes node + JS bundle). PR2 removes those invocations but can we delete the bundle build in PR2, or must it stay for the `.github/workflows/*` scripts that might invoke it? Audit in PR2.

5. **`create-exarchos` archive** — user confirmed full deletion (subsumes #1043). Worth adding a one-line redirect in the deleted README pointing at `get-exarchos.sh` for any stray search-engine traffic? Or close #1043 with a comment and let the dead link 404? Lean toward the redirect.

6. **Node-based contributors** — dev workflow continues running `npm test` / `bun test` against source. Binary is release-time only. No contributor-facing change, but CONTRIBUTING.md should note the new `npm run build:binary` step for anyone debugging bootstrap behavior locally.

7. **Telemetry** — bootstrap script fires no telemetry today; Aspire's doesn't either. Decision: keep it that way. Anyone wanting install counts reads GitHub Release download stats.
