# Implementation Plan: v2.9 Install Rewrite

- **Design:** `docs/designs/2026-04-21-install-rewrite.md`
- **Feature ID:** `v29-install-rewrite`
- **Total PRs:** 3 (strict sequence)

## Branching Model

- **Integration branch:** `feature/v29-install-rewrite`
- **PR branches** (stacked off integration):
  - `feature/v29-install-rewrite/pr1-binary-target`
  - `feature/v29-install-rewrite/pr2-install-rewrite`
  - `feature/v29-install-rewrite/pr3-cleanup`

Each PR merges into `main` in order (no stacking-into-integration — this mirrors the user's GitHub-native workflow).

---

## PR1 — Binary Target Works (Internal)

**Goal:** Produce a `bun compile` binary functionally equivalent to today's `node dist/exarchos.js`. No user-facing change.

### Task 1.1: Swap `better-sqlite3` → `bun:sqlite` imports
**Phase:** RED → GREEN → REFACTOR

1. [RED] Delete `import Database from 'better-sqlite3'` in `servers/exarchos-mcp/src/storage/sqlite-backend.ts`. Run `cd servers/exarchos-mcp && npm run test:run` — existing suite fails (no SQLite provider).
   - Expected failure: import resolution error across `backend-contract.test.ts`, `crash-recovery.test.ts`, `e2e-persistence.test.ts`, `hydration-pbt.test.ts`, `lifecycle-sqlite.test.ts`, `schema-migration.test.ts`, `wal-concurrency.test.ts`

2. [GREEN] Replace import with `import { Database } from 'bun:sqlite'`. Replace `Database.Statement` / `Database.Database` types with `bun:sqlite` equivalents. Tests pass.
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.ts`

3. [REFACTOR] Convert `db.pragma('journal_mode = WAL')` calls → `db.exec('PRAGMA journal_mode = WAL')`. Same for `synchronous`, `mmap_size`. Keep `db.pragma('integrity_check')` call shape if bun:sqlite supports it; otherwise swap to `db.query('PRAGMA integrity_check').all()`. Verify tests stay green.

**Dependencies:** None (first task)
**Parallelizable:** No (lead task)

### Task 1.2: Delete `better-sqlite3` from package manifests
**Phase:** RED → GREEN

1. [RED] Add assertion in `servers/exarchos-mcp/src/storage/__tests__/no-legacy-deps.test.ts` that `package.json` does not list `better-sqlite3` in dependencies.
   - File: new — `servers/exarchos-mcp/src/storage/__tests__/no-legacy-deps.test.ts`
   - Expected failure: dependency still present

2. [GREEN] Remove `better-sqlite3` and `@types/better-sqlite3` from `servers/exarchos-mcp/package.json` + root `package.json` if present. Run `npm install` in both. Test passes.

**Dependencies:** 1.1
**Parallelizable:** No

### Task 1.3: Delete platform-variant `.node` download logic
**Phase:** RED → GREEN

1. [RED] Add assertion in `scripts/build-bundle.test.ts` (new) that `scripts/build-bundle.ts` does not reference `better-sqlite3` or `node_modules/better-sqlite3/build`.
   - Expected failure: references present

2. [GREEN] Delete the `downloadPlatformBinaries` / variant-matrix code from `scripts/build-bundle.ts`. Simplify to plain bundle emission. Test passes.

**Dependencies:** 1.2
**Parallelizable:** No

### Task 1.4: Add `bun build --compile` script producing host binary
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write `scripts/build-binary.test.ts`:
   - `BuildBinary_HostTarget_ProducesExecutable` — invokes `scripts/build-binary.ts` for current host, asserts `dist/bin/exarchos-<os>-<arch>` exists and is executable.
   - `BuildBinary_CompiledBinary_RespondsToVersionFlag` — spawns the binary with `--version`, asserts stdout contains the version from `package.json`.
   - Expected failure: `scripts/build-binary.ts` does not exist

2. [GREEN] Create `scripts/build-binary.ts`:
   - Reads current-host OS/arch
   - Invokes `bun build servers/exarchos-mcp/src/index.ts --compile --target=bun-<os>-<arch> --outfile dist/bin/exarchos-<os>-<arch>` — this is the **same entry** used by `scripts/build-bundle.ts` today; `index.ts` already implements unified MCP/hook/CLI dispatch (`isMcpServerInvocation`, `isHookCommand`, delegation to `adapters/cli.ts`) and carries the 250ms cold-start budget tuning. Reusing it avoids splitting the process-entry responsibility and preserves existing backend-cleanup/self-healing logic.
   - Adds `.exe` suffix on Windows
   - Exits non-zero on failure

3. [REFACTOR] Extract `TARGETS` matrix constant. Add `--all` flag to build every target sequentially. Keep test assertions passing.

**Dependencies:** 1.1 (needs bun:sqlite swap to compile)
**Parallelizable:** Yes (can run parallel with 1.2 and 1.3 in separate worktrees)

### Task 1.5: Add `npm run build:binary` script + CI matrix
**Phase:** RED → GREEN

1. [RED] Write `scripts/ci-binary-matrix.test.ts` asserting `.github/workflows/ci.yml` has a `binary-matrix` job that produces all 5 target artifacts.
   - Expected failure: job does not exist

2. [GREEN] Add `"build:binary": "bun run scripts/build-binary.ts --all"` to root `package.json`. Extend `.github/workflows/ci.yml` with a `binary-matrix` job running on `ubuntu-latest` (cross-compiles all 5 targets via `bun build --target=...`). Upload artifacts for manual inspection.

**Dependencies:** 1.4
**Parallelizable:** No

### Task 1.6: Integration test — compiled binary passes MCP server test suite
**Phase:** RED → GREEN

1. [RED] Write `servers/exarchos-mcp/test/process/compiled-binary-mcp.test.ts`:
   - `CompiledBinary_McpSubcommand_HandshakesSuccessfully` — spawns `dist/bin/exarchos-<host>` with `mcp` subcommand via `StdioClientTransport`, completes `initialize`.
   - `CompiledBinary_McpWorkflowInit_ReturnsExpectedShape` — calls `exarchos_workflow` init, asserts response matches zod schema.
   - Expected failure: binary spawns but response shape doesn't match (or crashes on bun:sqlite init)

2. [GREEN] Fix any bun:sqlite-vs-better-sqlite3 divergence uncovered by the spawn test. Most likely culprits: pragma response shape, prepared statement lifecycle on close.

**Dependencies:** 1.1, 1.4
**Parallelizable:** No (final PR1 gate)

---

## PR2 — Install Rewrite (User-Facing)

**Goal:** Plugin surface switches to PATH-resolved `exarchos`; bootstrap scripts ship; GitHub Releases carries binary assets.

### Task 2.1: Plugin manifest — `plugin.json` uses bare `exarchos`
**Phase:** RED → GREEN

1. [RED] Write `src/plugin-validation.test.ts` assertion (new `case`):
   - `PluginJson_McpServerCommand_IsExarchosNotNode` — parses `.claude-plugin/plugin.json`, asserts `mcpServers.exarchos.command === "exarchos"` and no occurrence of `"node"` anywhere in the file.
   - Expected failure: current value is `"node"`

2. [GREEN] Rewrite `.claude-plugin/plugin.json` `mcpServers.exarchos` block:
   ```json
   {
     "command": "exarchos",
     "args": ["mcp"],
     "env": {
       "WORKFLOW_STATE_DIR": "~/.claude/workflow-state",
       "EXARCHOS_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
     }
   }
   ```
   Additionally, sweep the entire `.claude-plugin/plugin.json` for any residual `EXARCHOS_PLUGIN_ROOT` fallback paths that reference the bundled JS entry (design §7 last bullet). Add assertion: `PluginJson_HasNoBundledJsFallbacks` — no occurrences of `dist/exarchos.js`, `dist/cli.js`, or `node` anywhere in the file.

**Dependencies:** PR1 merged (binary must exist on PATH for this to be testable end-to-end)
**Parallelizable:** Yes (with 2.2, 2.3, 2.4)

### Task 2.2: Hooks — `hooks/hooks.json` uses bare `exarchos` for all 8 hooks
**Phase:** RED → GREEN

1. [RED] Write `src/hooks-validation.test.ts`:
   - `HooksJson_AllCommands_UseExarchosPathResolved` — parses `hooks/hooks.json`, asserts every `command` field starts with `"exarchos "` (no `node`, no `${CLAUDE_PLUGIN_ROOT}` in the executable position — only as arg).
   - Expected failure: current commands invoke `node`

2. [GREEN] Rewrite all 8 hook `command` fields:
   - `PreCompact` → `exarchos pre-compact`
   - `SessionStart` → `exarchos session-start --plugin-root "${CLAUDE_PLUGIN_ROOT}"`
   - `PreToolUse` → `exarchos guard`
   - `TaskCompleted` → `exarchos task-gate`
   - `TeammateIdle` → `exarchos teammate-gate`
   - `SubagentStart` → `exarchos subagent-context`
   - `SubagentStop` → `exarchos subagent-stop`
   - `SessionEnd` → `exarchos session-end`

**Dependencies:** None (independent of 2.1 structurally)
**Parallelizable:** Yes

### Task 2.3: Version compatibility check — library + `exarchos version --check-plugin-root` subcommand
**Phase:** RED → GREEN → REFACTOR

**Rationale:** One library function with two call sites — standalone subcommand (user-invokable diagnostic, CI preflight) and embedded invocation in `handleSessionStart` (automatic per-session check). Keeping both in a single process preserves the 250ms cold-start budget — no second hook entry in `hooks.json`.

1. [RED] Write `servers/exarchos-mcp/src/cli-commands/version.test.ts`:
   - `VersionCheck_PluginRootCompatible_ExitsZero` — fixture plugin.json with `metadata.compat.minBinaryVersion: "2.8.0"` + binary version `2.9.0` → exit 0.
   - `VersionCheck_PluginRootIncompatible_ExitsNonZeroWithMessage` — min `3.0.0` + binary `2.9.0` → exit 1, stderr mentions required version.
   - `VersionCheck_PluginRootMissingMetadata_ExitsZeroWithWarning` — no compat metadata → exit 0 with stderr warning.
   - Expected failure: subcommand does not exist

   Also extend `cli-commands/session-start.test.ts`:
   - `SessionStart_PluginRootIncompatible_EmitsStderrWarning` — fixture with drift; asserts stderr warning from session-start invocation (non-blocking, exit 0).
   - `SessionStart_PluginRootCompatible_Silent` — no stderr version-related output.
   - Expected failure: session-start handler does not invoke the check.

2. [GREEN] Create `servers/exarchos-mcp/src/lib/plugin-compat.ts` exporting `checkPluginRootCompatibility(pluginRoot: string, binaryVersion: string): CompatResult`. Add `version` subcommand handler in `servers/exarchos-mcp/src/cli-commands/version.ts` as a thin adapter around the library. Wire the same library into `handleSessionStart` to emit stderr warning on drift (non-blocking).

3. [REFACTOR] Extract semver compare helper; add unit tests for edge cases (prerelease tags, invalid ranges). Confirm both call sites share the same library path (no duplicated logic).

**Dependencies:** PR1 merged
**Parallelizable:** Yes (with 2.1, 2.2, 2.4)

### Task 2.4: SessionStart drift-check — plugin.json declares `minBinaryVersion`
**Phase:** RED → GREEN

1. [RED] Write assertion in `src/plugin-validation.test.ts`:
   - `PluginJson_Metadata_DeclaresMinBinaryVersion` — asserts `metadata.compat.minBinaryVersion` matches the binary's current version.
   - Expected failure: field absent

2. [GREEN] Add `metadata.compat.minBinaryVersion` to `.claude-plugin/plugin.json`. Wire version-sync script (`scripts/sync-versions.sh`) to keep it aligned with `package.json` on release.

**Dependencies:** 2.3
**Parallelizable:** No

### Task 2.5: `get-exarchos.sh` — Unix bootstrap
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write `scripts/get-exarchos.test.sh`:
   - `GetExarchos_DryRun_PrintsInstallPlan` — `bash scripts/get-exarchos.sh --dry-run` prints platform, URL, destination, checksum URL; exit 0; no filesystem changes.
   - `GetExarchos_PlatformDetection_Linux_x64` — mocks `uname` to return Linux x86_64; asserts selected asset name.
   - `GetExarchos_PlatformDetection_Darwin_arm64` — ditto for macOS Apple Silicon.
   - `GetExarchos_ChecksumMismatch_RefusesInstall` — downloads to tmp with tampered sha512 sidecar; exit non-zero; no binary installed.
   - `GetExarchos_PathAppend_Bashrc` — stub `$HOME` with empty `.bashrc`; after install, `.bashrc` contains PATH export for install dir.
   - `GetExarchos_VersionFlag_PinsRelease` — `--version v2.9.0-rc1` downloads from the exact tag URL.
   - `GetExarchos_GithubActionsMode_WritesGithubPath` — `--github-actions` with stub `$GITHUB_PATH` appends install dir.
   - Expected failure: script does not exist

2. [GREEN] Create `scripts/get-exarchos.sh`:
   - Platform detection (`uname -s` / `uname -m`), musl detection
   - Quality tiers (`--tier release|staging|dev`)
   - Download via `curl` with retry + fail-on-error
   - SHA-512 verification via `shasum -a 512` / `sha512sum`
   - Install dir: `${EXARCHOS_INSTALL_DIR:-$HOME/.local/bin}`
   - PATH append to `.bashrc`, `.zshrc`, `.config/fish/config.fish` (idempotent via marker comment)
   - Dry-run mode
   - Version pinning via `--version`
   - GitHub Actions mode via `--github-actions`

3. [REFACTOR] Extract platform-map function; add helpful error messages; ensure POSIX `sh` compatibility (not bash-specific) where feasible.

**Dependencies:** PR1 merged
**Parallelizable:** Yes (with 2.1, 2.2, 2.3, 2.6)

### Task 2.6: `get-exarchos.ps1` — Windows bootstrap
**Phase:** RED → GREEN

1. [RED] Write `scripts/get-exarchos.ps1.test.ps1` (Pester) with equivalent coverage to Task 2.5:
   - Dry-run, platform detection (Windows x64, Windows arm64), checksum validation, registry PATH append, version pinning.
   - Expected failure: script does not exist

2. [GREEN] Create `scripts/get-exarchos.ps1` mirroring `.sh` behavior using PowerShell primitives (`Invoke-WebRequest`, `Get-FileHash -Algorithm SHA512`, `[Environment]::SetEnvironmentVariable`).

**Dependencies:** PR1 merged; ideally same-branch as 2.5 so they co-evolve
**Parallelizable:** Yes (with 2.1, 2.2, 2.3, 2.5)

### Task 2.7: GitHub Releases binary asset pipeline
**Phase:** RED → GREEN

1. [RED] Write `.github/workflows/release.test.sh`:
   - `ReleaseWorkflow_HasBinaryMatrixJob` — asserts job exists with 5 matrix entries.
   - `ReleaseWorkflow_UploadsBinariesAndChecksums` — asserts 10 asset uploads (5 binaries + 5 `.sha512`).
   - `ReleaseWorkflow_RunsAfterTag` — asserts trigger on `push: tags: ['v*.*.*']`.
   - Expected failure: release workflow does not include binary-matrix job

2. [GREEN] Extend `.github/workflows/release.yml` (or create if absent):
   - `binary-matrix` job: matrix of 5 targets, each runs `bun build --compile --target=bun-<os>-<arch>`, produces binary + sha512
   - `publish-release` job: uploads all 10 assets to the GitHub Release via `softprops/action-gh-release`
   - Release body template lists bootstrap URLs

**Dependencies:** 1.4, 1.5
**Parallelizable:** Yes (with 2.1–2.6)

### Task 2.8: Missing-binary SessionStart nudge
**Phase:** RED → GREEN

1. [RED] Write `hooks/session-start-nudge.test.sh`:
   - `SessionStartNudge_BinaryMissing_EmitsInstallHint` — runs the shell fallback with `PATH` stripped of exarchos; asserts stderr contains install URL.
   - `SessionStartNudge_BinaryPresent_Silent` — runs with exarchos on PATH; no stderr output.
   - Expected failure: fallback script does not exist

2. [GREEN] Create a 20-line POSIX shell preamble in `hooks/hooks.json`'s `SessionStart.command` (or as a standalone `hooks/session-start.sh`) that:
   - Checks `command -v exarchos` succeeds
   - On miss: prints one-line install hint to stderr and exits 0 (non-blocking)
   - On hit: `exec exarchos session-start --plugin-root "${CLAUDE_PLUGIN_ROOT}"`

**Dependencies:** 2.2
**Parallelizable:** No (modifies the same hook entry as 2.2)

### Task 2.9: End-to-end smoke — fresh-environment bootstrap
**Phase:** RED → GREEN

1. [RED] Write `test/e2e/fresh-install-bootstrap.test.ts`:
   - `FreshInstall_BootstrapScript_ProducesWorkingBinary` — runs the bootstrap script inside a minimal docker image (`alpine` for musl + `ubuntu:latest` for glibc), verifies `exarchos --version` succeeds and `exarchos mcp` responds to JSON-RPC handshake.
   - Expected failure: test infrastructure doesn't exist

2. [GREEN] Add a `fresh-install-smoke` CI job (gated on `workflow_dispatch` + weekly schedule to avoid slowing PR gate) that exercises the full bootstrap path.

**Dependencies:** 2.5, 2.7
**Parallelizable:** No (final PR2 gate)

---

## PR3 — Dead Code Removal

**Goal:** Delete obsoleted install surface, strip bundled-MCP references, add the HTTPS fallback note. No functional change.

### Task 3.1: Delete `src/install.ts` + `src/install.test.ts`
**Phase:** RED → GREEN

1. [RED] Write `scripts/validate-no-legacy.test.sh`:
   - `NoLegacy_InstallTsAbsent` — asserts `src/install.ts` does not exist.
   - `NoLegacy_InstallTestAbsent` — same for `src/install.test.ts`.
   - Expected failure: files still exist

2. [GREEN] `rm src/install.ts src/install.test.ts`. Remove `"exarchos": "./dist/exarchos.js"` entry from root `package.json` `bin` if unused. Verify test suite still passes.

**Dependencies:** PR2 merged (plugin no longer invokes the JS bundle)
**Parallelizable:** Yes (with 3.2, 3.3, 3.5)

### Task 3.2: Delete `packages/create-exarchos/` entirely
**Phase:** RED → GREEN

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_CreateExarchosPackageAbsent` — asserts `packages/create-exarchos/` does not exist.
   - Expected failure: directory still exists

2. [GREEN] `rm -rf packages/create-exarchos/`. Remove any root-`package.json` workspace reference. Audit `scripts/sync-versions.sh` for create-exarchos version syncing and remove.

**Dependencies:** None
**Parallelizable:** Yes

### Task 3.3: Archive deprecation artifacts
**Phase:** RED → GREEN

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_CreateExarchosDesignArchived` — asserts `docs/designs/archive/2026-03-14-create-exarchos.md` exists and `docs/designs/2026-03-14-create-exarchos.md` does not.
   - `NoLegacy_ExarchosDevDeprecationDocRemoved` — asserts `docs/deprecation/exarchos-dev.md` does not exist.
   - Expected failure: docs in original locations

2. [GREEN] `mkdir -p docs/designs/archive && git mv docs/designs/2026-03-14-create-exarchos.md docs/designs/archive/`. `rm docs/deprecation/exarchos-dev.md`. If `docs/deprecation/` becomes empty, remove it.

**Dependencies:** None
**Parallelizable:** Yes

### Task 3.4: Strip bundled-MCP references from distribution surface
**Phase:** RED → GREEN

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_ReadmeHasNoBundledMcp` — `README.md` contains no mentions of graphite/serena/context7/microsoft-learn as bundled/companion products.
   - `NoLegacy_AgentsMdHasNoBundledMcp` — same for `AGENTS.md`.
   - `NoLegacy_ChangelogHasNoCompanionClaims` — `CHANGELOG.md` doesn't describe companion installation.
   - Expected failure: references present

2. [GREEN] Edit `README.md`, `AGENTS.md`, installer-adjacent sections of `CHANGELOG.md` to remove bundled-MCP claims. Legitimate external-tool mentions inside skill `references/` docs (e.g., "use `gt` to submit PRs" — already stale per project memory) are left for a separate polish pass.

**Dependencies:** None
**Parallelizable:** Yes

### Task 3.5: README HTTPS fallback note (#1173)
**Phase:** RED → GREEN

1. [RED] Write `src/readme-validation.test.ts`:
   - `Readme_InstallSection_MentionsHttpsFallback` — asserts README's Install section mentions `https://github.com/lvlup-sw/.github.git` as the HTTPS fallback for users without SSH keys.
   - Expected failure: note absent

2. [GREEN] Add a one-line note below the `/plugin marketplace add lvlup-sw/.github` quickstart, per #1173's acceptance criteria.

**Dependencies:** None
**Parallelizable:** Yes

### Task 3.6: Remove `dist/exarchos.js` JS bundle emission
**Phase:** RED → GREEN

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_BuildProducesOnlyBinary` — `npm run build` output contains `dist/bin/exarchos-*` but no `dist/exarchos.js`.
   - Expected failure: JS bundle still produced

2. [GREEN] Simplify `scripts/build-bundle.ts` (or delete entirely if unused) and update `"build"` npm script to `tsc && npm run build:binary && npm run build:skills`. Adjust `package.json` `files` array to ship only `dist/bin/`, not `dist/exarchos.js`.

**Dependencies:** PR2 merged + 3.1
**Parallelizable:** No

### Task 3.7: Audit + remove `scripts/sync-marketplace.sh`
**Phase:** RED → GREEN

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_SyncMarketplaceAbsentOrUpdated` — asserts `scripts/sync-marketplace.sh` either does not exist, or contains no references to `create-exarchos` / dual-plugin model (grep-negative).
   - Expected failure: script still references the deleted package

2. [GREEN] Read `scripts/sync-marketplace.sh`. If tied to the dual-plugin model (create-exarchos ↔ marketplace sync), `rm` the script. If it performs other plugin-bundle syncing still relevant to single-plugin ship, strip the create-exarchos branches only. Update any CI workflow callers accordingly.

**Dependencies:** 3.2
**Parallelizable:** Yes (with 3.1, 3.3, 3.4, 3.5)

### Task 3.8: Delete dead `servers/exarchos-mcp/src/cli.ts` + `cli.test.ts` + audit orphaned handlers
**Phase:** RED → GREEN

**Context:** Confirmed dead during planning — zero non-test imports of `./cli` in `servers/exarchos-mcp/src/**/*.ts`; hooks.json and plugin.json invoke `dist/exarchos.js` (bundled from `index.ts`), never `dist/cli.js`; `scripts/build-bundle.ts` does not reference it. The file's comment claiming `All hook scripts call: node dist/cli.js <command>` is stale documentation of a never-used execution path. Take the cleanup opportunity to sweep transitively orphaned `cli-commands/` handlers.

1. [RED] Extend `validate-no-legacy.test.sh`:
   - `NoLegacy_DeadCliFileAbsent` — asserts `servers/exarchos-mcp/src/cli.ts` does not exist.
   - `NoLegacy_DeadCliTestAbsent` — asserts `servers/exarchos-mcp/src/cli.test.ts` does not exist.
   - Expected failure: files still present

2. [GREEN] `rm servers/exarchos-mcp/src/cli.ts servers/exarchos-mcp/src/cli.test.ts`. Re-run the full MCP server test suite (`cd servers/exarchos-mcp && npm run test:run`) to confirm no orphaned imports surface. Then audit `servers/exarchos-mcp/src/cli-commands/` — every handler exported there must still be consumed by `adapters/cli.ts` or `adapters/hooks.ts`. For each handler referenced *only* by the deleted `cli.ts`, delete the handler file and its test in the same PR (classic distill sweep — removing the dead entry exposes transitively dead handlers).

**Dependencies:** None (confirmed dead in planning)
**Parallelizable:** Yes (with 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.9)

### Task 3.9: `CONTRIBUTING.md` — document `npm run build:binary` workflow
**Phase:** RED → GREEN

1. [RED] Write `src/contributing-validation.test.ts`:
   - `Contributing_MentionsBuildBinary` — asserts `CONTRIBUTING.md` includes a section describing `npm run build:binary` for contributors debugging bootstrap behavior.
   - Expected failure: section absent

2. [GREEN] Add a short "Building the binary locally" section to `CONTRIBUTING.md` near existing build instructions. One paragraph is sufficient — links to `scripts/build-binary.ts` and mentions the `--all` cross-compile flag.

**Dependencies:** 1.4, 1.5
**Parallelizable:** Yes (with 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8)

### Task 3.10: Close #1043 with redirect comment
**Phase:** Manual (no test)

1. Post a comment on `lvlup-sw/exarchos#1043` linking to the new bootstrap installer (`scripts/get-exarchos.sh`) and the release assets. Close the issue. No in-repo artifact; tracked as a synthesis-time checklist item on PR3.

**Dependencies:** 3.2, 2.5, 2.7
**Parallelizable:** N/A (manual)

### Task 3.11: Create `scripts/validate-no-legacy.sh` + dead-code sweep + CI wiring
**Phase:** RED → GREEN → REFACTOR

1. [RED] The tests written in tasks 3.1–3.9 drive this. Additionally, add a dead-code sweep assertion:
   - `NoLegacy_DeadCodeSweep` — runs `npx knip` (or equivalent unreachable-export detector) against `servers/exarchos-mcp/src/` and `src/`, allowlist entry points (`index.ts`, `adapters/cli.ts`, `adapters/hooks.ts`, `adapters/mcp.ts`, `scripts/*.ts`). Expected-to-fail if any unreachable export remains after 3.1–3.8 cleanups.

2. [GREEN] Consolidate all `NoLegacy_*` checks into `scripts/validate-no-legacy.sh` (bash, grep-based). Wire into `.github/workflows/ci.yml` as a PR-gate job. Add the dead-code sweep to the same job (or a neighboring `dead-code` job if `knip` runtime is non-trivial).

3. [REFACTOR] Factor shared grep/find helpers; ensure fast exit on first failure with clear message. Document the entry-point allowlist as a comment in the script so future additions are intentional.

**Dependencies:** 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
**Parallelizable:** No (rollup task)

---

## Parallelization Summary

### Within PR1
- 1.1 is gating (sequential)
- After 1.1: 1.2, 1.4 can parallelize in separate worktrees
- 1.3 follows 1.2; 1.5 follows 1.4; 1.6 is the final integration gate

### Within PR2
- 2.1, 2.2, 2.3, 2.5, 2.6, 2.7 can parallelize (different files)
- 2.4 follows 2.3; 2.8 follows 2.2; 2.9 is the final integration gate

### Within PR3
- 3.1–3.5, 3.7, 3.8, 3.9 parallelize (independent files)
- 3.6 follows 3.1; 3.10 is manual (post-merge); 3.11 is the rollup gate
- Dependencies: 3.7 → 3.2; 3.9 → PR1 merged; 3.10 → 3.2, 2.5, 2.7

### Across PRs
- Strictly sequential: PR1 must merge before PR2 (binary must exist before plugin relies on it); PR2 must merge before PR3 (legacy install path still in use until PR2).

## Test Coverage Map (Design → Tasks)

| Design Section | Covered By |
|---|---|
| §1 SQLite runtime swap | 1.1, 1.2, 1.3, 1.6 |
| §2 Build pipeline — `bun build --compile` (entry = `servers/exarchos-mcp/src/index.ts`) | 1.4, 1.5, 1.6 |
| §3 Plugin surface refactor | 2.1, 2.2, 2.8 |
| §4 Bootstrap scripts | 2.5, 2.6, 2.9 |
| §5 GitHub Releases pipeline | 2.7 |
| §6 Version compatibility (library + subcommand + session-start wiring) | 2.3, 2.4 |
| §7 Deletions — install.ts, create-exarchos, docs, bundled-MCP refs, dist/exarchos.js | 3.1, 3.2, 3.3, 3.4, 3.6, 3.11 |
| §7 Deletions — scripts/sync-marketplace.sh | 3.7 |
| §7 Deletions — dead `servers/exarchos-mcp/src/cli.ts` | 3.8 |
| §7 Deletions — EXARCHOS_PLUGIN_ROOT bundled-JS fallback paths | 2.1 (sweep) |
| Open Question 3 (Windows line endings) | 2.6 (covered in `.ps1` tests) |
| Open Question 4 (`dist/exarchos.js` removal timing) | 3.6 |
| Open Question 5 (#1043 comment) | 3.10 |
| Open Question 6 (CONTRIBUTING.md note) | 3.9 |
| #1173 HTTPS fallback | 3.5 |

## Deferred / Out of Scope (tracked but not in these PRs)

- **Open Q1** (get.exarchos.dev vanity hosting) — use raw GitHub URL in PR2; vanity redirect is polish
- **Open Q2** (binary size measurement) — measured in PR1's CI output; documented, not gated
- **Open Q5** (`create-exarchos` search-engine redirect) — left as 404; PR3 closes #1043 with comment
- **Open Q7** (install telemetry) — decision: none, no action
