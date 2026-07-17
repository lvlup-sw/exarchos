# Plan: Consolidate Test-Runtime Resolution; Invert from Filesystem Detection to Declared Config

**Issue:** [#1199](https://github.com/lvlup-sw/exarchos/issues/1199)
**Workflow:** `refactor-1199-test-runtime-resolver`
**Branch base:** `main` @ `0ee9ecde`
**Track:** overhaul
**Stages:** 3 (S1 extract & unify → S2 declare → S3 invert default)
**Dependencies upstream:** none (no design doc — refactor-style brief in workflow state)
**Cross-cutting verification:** #1109 (event-sourcing, MCP parity, basileus-forward, capability resolution)

## Goals (from brief)

- **G1** Single resolver: one module owns test/typecheck/install command resolution.
- **G2** Declare-don't-detect: `.exarchos.yml` authoritative; detection runs once at init as seeding.
- **G3** Safe-by-default: no `npm install` against non-npm worktrees; null result triggers logged skip.
- **G4** Observable resolution: `command.resolved` events with `source` field.
- **G5** MCP parity: identical resolution from CLI hooks and orchestrate handlers.
- **G6** Close [#1174](https://github.com/lvlup-sw/exarchos/issues/1174) via graceful-skip behavior.

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

## Wave Structure

| Wave | Stage | Parallelism | Blocks on |
|------|-------|-------------|-----------|
| **W1 Characterization** | pre-S1 | parallel within wave (3 tasks) | nothing — entry point |
| **W2 Resolver core** | S1 | sequential within wave (T04→T05→T06) | W1 |
| **W3 Migrate consumers** | S1 | parallel within wave (4 tasks) | W2 |
| **W4 Declare** | S2 | sequential within wave (T11→T12→T13→T14) | W3 |
| **W5 Invert default** | S3 | sequential within wave (T15→T16→T17) | W4 |
| **W6 Docs phase** | n/a | parallel (2 tasks) | W5; runs in `overhaul-update-docs` phase |

Stage gating allows landing each stage as a separate PR if scope expands. Default plan: single PR.

---

## Wave 1 — Characterization (mandatory pre-step per refactor skill)

### Task T01: Characterization tests for `detect-test-commands.ts`

**Phase:** RED only — these tests document current behavior; they MUST stay green throughout the refactor.

1. **[RED]** Write characterization tests:
   - File: `servers/exarchos-mcp/src/orchestrate/detect-test-commands.characterization.test.ts`
   - Tests:
     - `detect_NodeProject_ReturnsNpmRunTestRun` (package.json → npm)
     - `detect_PythonProject_ReturnsPytest` (pyproject.toml → pytest)
     - `detect_RustProject_ReturnsCargoTest` (Cargo.toml → cargo)
     - `detect_DotNetProject_ReturnsDotnetTest` (*.csproj → dotnet)
     - `detect_NoMarkers_ReturnsNullCommands` (empty dir)
     - `detect_OverrideProvided_ReturnsOverride` (override path)
     - `detect_OverrideWithUnsafeChars_Throws` (security guard)
   - Expected: all PASS at HEAD; all PASS after refactor (invariant).

**Dependencies:** None.
**Parallelizable:** Yes (with T02, T03).
**Worktree:** `.worktrees/T01-characterization-detect-test-commands/`

### Task T02: Characterization tests for `verify-worktree-baseline.ts`

**Phase:** RED only.

1. **[RED]** Write characterization tests:
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree-baseline.characterization.test.ts`
   - Tests:
     - `detectProjectType_Node_ReturnsNpmRunTestRun`
     - `detectProjectType_DotNet_ReturnsDotnetTest`
     - `detectProjectType_Rust_ReturnsCargoTest`
     - `detectProjectType_Python_ReturnsUndefined` (current asymmetric behavior — DOCUMENTED gap; flips after T08)
     - `detectProjectType_NoMarkers_ReturnsUndefined`
   - Expected: all PASS at HEAD. After T08, the Python case flips to `pytest` (intentional behavior change documented in T08).

**Dependencies:** None.
**Parallelizable:** Yes (with T01, T03).
**Worktree:** `.worktrees/T02-characterization-verify-worktree-baseline/`

### Task T03: Characterization tests for `setup-worktree.ts`

**Phase:** RED only — captures BOTH current behavior AND the destructive failure mode that T09 will fix.

1. **[RED]** Write characterization tests:
   - File: `servers/exarchos-mcp/src/orchestrate/setup-worktree.characterization.test.ts`
   - Tests:
     - `runNpmInstall_NoPackageJson_SkipsWithReason`
     - `runNpmInstall_NpmProject_RunsNpmInstall`
     - `runNpmInstall_PnpmLockfilePresent_RunsNpmInstallAnyway` (DESTRUCTIVE — DOCUMENTED. Flips after T09.)
     - `runBaselineTests_NoPackageJson_SkipsWithReason`
     - `runBaselineTests_NpmProject_RunsNpmRunTestRun`
     - `runBaselineTests_SkipTestsFlag_Skips`
   - Expected: all PASS at HEAD. The pnpm case flips after T09 (intentional safety improvement; characterization assertion updated in T09).

**Dependencies:** None.
**Parallelizable:** Yes (with T01, T02).
**Worktree:** `.worktrees/T03-characterization-setup-worktree/`

---

## Wave 2 — Resolver Core (sequential)

### Task T04: New resolver module — interface + npm/.NET/Rust/Python

**Phase:** RED → GREEN

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/config/test-runtime-resolver.test.ts`
   - Tests:
     - `resolve_NodeProject_ReturnsNpmCommands` (test, typecheck, install, source: 'detection')
     - `resolve_PythonProject_ReturnsPytestCommands`
     - `resolve_RustProject_ReturnsCargoCommands`
     - `resolve_DotNetProject_ReturnsDotnetCommands`
     - `resolve_NoMarkers_ReturnsUnresolved` (source: 'unresolved')
     - `resolve_OverrideProvided_ReturnsOverride` (source: 'override')
   - Resolver shape: `resolve(repoRoot: string, override?: TestCommandOverride): ResolvedRuntime`
   - `ResolvedRuntime` = `{ test: string | null, typecheck: string | null, install: string | null, source: 'config' | 'detection' | 'override' | 'unresolved', remediation?: string }`

2. **[GREEN]** Minimum implementation:
   - File: `servers/exarchos-mcp/src/config/test-runtime-resolver.ts`
   - Inline detection for current matrix (npm/.NET/Rust/Python) using existing logic from `detect-test-commands.ts`.
   - Source field always `'detection'` for now (config support comes in W4).

**Dependencies:** W1 complete.
**Parallelizable:** No (T05, T06 build on this).
**Worktree:** `.worktrees/T04-resolver-core/`

### Task T05: Resolver — bun/pnpm/yarn lockfile detection

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Add tests:
   - File: same as T04.
   - Tests:
     - `resolve_BunProject_DetectsBunLockfile` (bun.lockb → `bun test`, `tsc --noEmit`, `bun install`)
     - `resolve_PnpmProject_DetectsPnpmLockfile` (pnpm-lock.yaml → `pnpm test`, `pnpm typecheck` if defined else `tsc --noEmit`, `pnpm install --frozen-lockfile`)
     - `resolve_YarnProject_DetectsYarnLockfile` (yarn.lock → `yarn test`, `tsc --noEmit`, `yarn install --immutable`)
     - `resolve_NpmProject_NoLockfileWins_ReturnsNpmCommands` (sanity check — package.json without alt lockfile still picks npm)
     - `resolve_PnpmAndPackageJson_PnpmWins` (lockfile precedence)

2. **[GREEN]** Extend resolver with lockfile detection. Order: bun.lockb > pnpm-lock.yaml > yarn.lock > package.json (npm).

3. **[REFACTOR]** Extract a `detectNodePackageManager(repoRoot): 'bun' | 'pnpm' | 'yarn' | 'npm' | null` helper.

**Dependencies:** T04.
**Parallelizable:** No.
**Worktree:** `.worktrees/T05-resolver-lockfile-detection/`

### Task T06: Resolver — script-existence check for npm projects

**Phase:** RED → GREEN

1. **[RED]** Add tests:
   - `resolve_NpmProjectMissingTestRunScript_ReturnsUnresolvedTestWithRemediation`
   - `resolve_NpmProjectMissingTypecheckScript_ReturnsNullTypecheckCommandWithoutFail`
   - Tests assert that an npm project whose `package.json.scripts` lacks `test:run` returns `{ test: null, source: 'unresolved', remediation: '<text pointing to .exarchos.yml>' }` for the test command. (Closes #1174.)

2. **[GREEN]** Read `package.json.scripts`; if `test:run` (or relevant per-pm script) is absent, set `test: null` and populate `remediation`.

**Dependencies:** T05.
**Parallelizable:** No.
**Worktree:** `.worktrees/T06-resolver-script-existence/`

---

## Wave 3 — Migrate Consumers (parallel)

### Task T07: Migrate `detect-test-commands.ts` to resolver

**Phase:** REFACTOR

1. Delete inline detection from `servers/exarchos-mcp/src/orchestrate/detect-test-commands.ts`.
2. Re-export `detectTestCommands(repoRoot, override?)` as a thin compatibility wrapper around the resolver, mapping `ResolvedRuntime` → existing `TestCommands` shape.
3. T01 characterization tests MUST still pass. Existing call sites unchanged.

**Dependencies:** T05 (resolver covers all current cases) + T06 (script-existence check).
**Parallelizable:** Yes (with T08, T09, T10).
**Worktree:** `.worktrees/T07-migrate-detect-test-commands/`

### Task T08: Migrate `verify-worktree-baseline.ts` to resolver

**Phase:** REFACTOR — closes asymmetric Python gap.

1. Delete inline `detectProjectType()` (lines 29-64).
2. Replace with a call to the shared resolver.
3. Update `formatReport()` to use `ResolvedRuntime.source` for the "Project type detected" line.
4. Update T02 characterization assertions: Python case now returns `{test: 'pytest', ...}` (intentional gap closure documented inline).

**Dependencies:** T05.
**Parallelizable:** Yes (with T07, T09, T10).
**Worktree:** `.worktrees/T08-migrate-verify-worktree-baseline/`

### Task T09: Fix destructive `setup-worktree.runNpmInstall`

**Phase:** REFACTOR — closes the destructive lockfile-rewrite path. **HIGH severity (DIM-7).**

1. **[RED]** Add tests:
   - `runInstall_PnpmLockfilePresent_DoesNotRunNpmInstall_SkipsWithReason`
   - `runInstall_YarnLockfilePresent_DoesNotRunNpmInstall_SkipsWithReason`
   - `runInstall_BunLockfilePresent_RunsBunInstall`

2. **[GREEN]** Rename `runNpmInstall` → `runInstallStep`. Call resolver; use `resolved.install`. If `resolved.install === null` (unresolved or not applicable), skip with reason logged.

3. Update T03 destructive-case assertion to `runInstall_PnpmLockfilePresent_DoesNotRunNpmInstall` (intentional flip from documented destructive behavior).

**Dependencies:** T05.
**Parallelizable:** Yes (with T07, T08, T10).
**Worktree:** `.worktrees/T09-setup-worktree-safe-install/`

### Task T10: Migrate `setup-worktree.runBaselineTests` to resolver

**Phase:** REFACTOR

1. Replace hardcoded `npm run test:run` invocation with `resolved.test` from the resolver.
2. If `resolved.test === null`, skip with reason from `resolved.remediation`.
3. T03 baseline characterization assertions preserved on npm-with-`test:run` happy path.

**Dependencies:** T05.
**Parallelizable:** Yes (with T07, T08, T09).
**Worktree:** `.worktrees/T10-setup-worktree-baseline-tests/`

---

## Wave 4 — Stage 2: Declare via `.exarchos.yml` (sequential)

### Task T11: Zod schema for `.exarchos.yml`

**Phase:** RED → GREEN

1. **[RED]** Tests:
   - File: `servers/exarchos-mcp/src/config/exarchos-config-schema.test.ts`
   - `schema_AllFieldsProvided_Validates`
   - `schema_PartialFields_Validates` (each field optional)
   - `schema_UnsafeShellChars_Rejected` (preserves `SAFE_COMMAND_PATTERN` from current detector)
   - `schema_EmptyObject_Validates` (no overrides)
   - `schema_UnknownFields_Rejected` (strict mode)

2. **[GREEN]** Implement:
   - File: `servers/exarchos-mcp/src/config/exarchos-config-schema.ts`
   - `ExarchosConfigSchema = z.object({ test: z.string()..., typecheck: z.string()..., install: z.string()... }).strict()` (all optional).

**Dependencies:** W3 complete.
**Parallelizable:** No (T12 depends on this).
**Worktree:** `.worktrees/T11-exarchos-config-schema/`

### Task T12: `loadExarchosConfig(worktreePath)` with fallback

**Phase:** RED → GREEN

1. **[RED]** Tests:
   - `loadConfig_PresentInWorktree_Loaded`
   - `loadConfig_AbsentInWorktreePresentInRepoRoot_LoadedFromRepoRoot`
   - `loadConfig_AbsentEverywhere_ReturnsNull`
   - `loadConfig_MalformedYaml_ThrowsWithPath`
   - `loadConfig_FailsSchema_ThrowsWithFieldErrors`

2. **[GREEN]** Implement:
   - File: `servers/exarchos-mcp/src/config/load-exarchos-config.ts`
   - Look in `worktreePath/.exarchos.yml`, fall back to repo root via `git rev-parse --show-toplevel`. Use existing `yaml-loader` patterns.

**Dependencies:** T11.
**Parallelizable:** No.
**Worktree:** `.worktrees/T12-load-exarchos-config/`

### Task T13: Resolver consults config first

**Phase:** RED → GREEN

1. **[RED]** Tests in `test-runtime-resolver.test.ts`:
   - `resolve_ConfigPresentWithTest_OverridesDetection` (source: 'config')
   - `resolve_ConfigPresentPartial_FallsBackToDetectionForMissing`
   - `resolve_ConfigAbsent_FallsBackToDetection` (preserves existing behavior)
   - `resolve_OverrideAndConfig_OverrideWins` (precedence: override > config > detection)

2. **[GREEN]** Resolver injects `loadExarchosConfig(repoRoot)`; merges `override > config > detection` per field.

**Dependencies:** T12.
**Parallelizable:** No.
**Worktree:** `.worktrees/T13-resolver-config-precedence/`

### Task T14: Workflow init seeds `.exarchos.yml` from detection

**Phase:** RED → GREEN

1. **[RED]** Tests:
   - File: `servers/exarchos-mcp/src/orchestrate/init/seed-exarchos-config.test.ts`
   - `seed_NoExistingConfig_WritesDetectedCommands`
   - `seed_ExistingConfig_DoesNotOverwrite` (idempotent; no surprise changes)
   - `seed_DetectionUnresolved_WritesEmptyConfigWithComments` (helps user discover the file)

2. **[GREEN]** Hook into `init` handler. Write `.exarchos.yml` with detection results + a header comment pointing at docs.

**Dependencies:** T13.
**Parallelizable:** No.
**Worktree:** `.worktrees/T14-init-seeds-config/`

---

## Wave 5 — Stage 3: Invert Default (sequential)

### Task T15: `command.resolved` event schema

**Phase:** RED → GREEN

1. **[RED]** Tests in `event-store/schemas.test.ts`:
   - `commandResolved_AllSourcesAccepted_Validates` (source ∈ {config, detection, override, unresolved})
   - `commandResolved_RemediationOptional_Validates`
   - `commandResolved_UnknownSource_Rejected`

2. **[GREEN]** Add `command.resolved` event schema to `event-store/schemas.ts`. Register in `EVENT_TYPES`. Ensure `getRegisteredEventTypes()` from rehydration reducer picks it up if it should be folded (likely no — informational only).

**Dependencies:** W4 complete.
**Parallelizable:** No.
**Worktree:** `.worktrees/T15-command-resolved-schema/`

### Task T16: Resolver emits `command.resolved` events

**Phase:** RED → GREEN

1. **[RED]** Tests in `test-runtime-resolver.test.ts`:
   - `resolve_OnSuccessfulDetection_EmitsCommandResolvedWithSourceDetection`
   - `resolve_OnConfigHit_EmitsCommandResolvedWithSourceConfig`
   - `resolve_OnOverride_EmitsCommandResolvedWithSourceOverride`
   - `resolve_OnUnresolved_EmitsCommandResolvedWithSourceUnresolvedAndRemediation`

2. **[GREEN]** Inject `EventStore` into resolver via constructor; emit `command.resolved` event on every call. Pattern follows the constructor-injection contract from PR #1185.

**Dependencies:** T15.
**Parallelizable:** No.
**Worktree:** `.worktrees/T16-resolver-emits-events/`

### Task T17: Unresolved → graceful skip with remediation; close #1174

**Phase:** RED → GREEN

1. **[RED]** Tests:
   - In `cli-commands/gates.test.ts`: `taskGate_NpmProjectMissingTestRunScript_SkipsGateWithRemediation` (closes #1174)
   - In `setup-worktree.test.ts`: `runBaselineTests_Unresolved_SkipsWithRemediation`
   - Existing GATE_FAILED behavior is replaced with GATE_SKIPPED + remediation.

2. **[GREEN]**: Update `cli-commands/gates.ts` and consumers in `setup-worktree.ts` and `verify-worktree-baseline.ts` to handle `source: 'unresolved'` as a skip (not a fail). Surface `resolved.remediation` in skip output.

**Dependencies:** T16.
**Parallelizable:** No.
**Worktree:** `.worktrees/T17-graceful-skip-1174/`

---

## Wave 6 — Documentation (`overhaul-update-docs` phase, parallel)

### Task T18: Update `tdd.md` skill reference

1. Update `skills-src/_shared/references/tdd.md`:
   - Document `.exarchos.yml` config approach.
   - Replace the `npm run test:run` / `dotnet test` table with a "see `.exarchos.yml`" reference.
2. Run `npm run build:skills && npm run skills:guard` to regenerate per-runtime variants.

**Dependencies:** W5 complete.
**Parallelizable:** Yes (with T19).
**Worktree:** main (docs phase, no isolation needed).

### Task T19: PR description template — #1109 invariants section

1. Author/update `.github/pull_request_template.md` (or similar) with the four-invariant verification block from #1109.
2. Apply the same template to this PR's description at synthesis time.

**Dependencies:** W5 complete.
**Parallelizable:** Yes (with T18).
**Worktree:** main.

---

## Cross-Cutting #1109 Invariant Coverage

| Invariant | Where verified |
|-----------|---------------|
| Event-sourcing | T15 (schema) + T16 (emission) + T17 (skip event) |
| MCP parity | T07 (CLI hook path via `detect-test-commands` wrapper) + T13 (resolver shared by orchestrate handlers) — both call same resolver |
| Basileus-forward | T11–T14 (`.exarchos.yml` consolidation per ADR §2.7) |
| Capability resolution | N/A (project config, not runtime capability) |

## Risks

- **R1 (M):** Bun `bun.lockb` is binary; detection by file presence only. Mitigation: existsSync is sufficient.
- **R2 (M):** `package.json.scripts` may be absent (declarations-only); T06 must handle `scripts === undefined` as missing-script.
- **R3 (L):** `loadExarchosConfig` worktree→repo-root fallback could cross repository boundaries in unusual setups. Mitigation: bound search to `git rev-parse --show-toplevel`.
- **R4 (M):** EventStore injection into resolver crosses a layering boundary (config module depending on event-store). Mitigation: optional injection with no-op default for environments without an EventStore (e.g., CLI tooling that runs before workflow init).

## Rollback Plan

Each wave is independently revertible:
- Revert W5 → no event emission, but resolver+config still work.
- Revert W4 → no `.exarchos.yml`, but resolver still consolidates detection (Stage 1 survives).
- Revert W3 → resolver exists but consumers still use old detectors.
- Revert W2 → only characterization tests added; no behavior change.
- Revert W1 → nothing applied.

Each task must be ≤300 LOC of net change to keep reviewability tractable.

## Task Summary

**Implementation tasks:** 17 (T01–T17)
**Documentation tasks:** 2 (T18–T19)
**Total:** 19

**Wave breakdown:**
- W1 (3 parallel) → W2 (3 sequential) → W3 (4 parallel) → W4 (4 sequential) → W5 (3 sequential) → W6 (2 parallel)

**Dispatch hint for `/exarchos:delegate`:**
- W1 dispatched as one parallel batch
- W2 dispatched serially after W1
- W3 dispatched as one parallel batch after W2
- W4–W5 dispatched serially after W3
- W6 dispatched as one parallel batch in `overhaul-update-docs` phase
