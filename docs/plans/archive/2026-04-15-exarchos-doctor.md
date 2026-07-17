# Implementation Plan: exarchos doctor

## Source Design

- Design: [`docs/designs/2026-04-15-exarchos-doctor.md`](../designs/2026-04-15-exarchos-doctor.md)
- Tracking issue: [lvlup-sw/exarchos#1089](https://github.com/lvlup-sw/exarchos/issues/1089) (v2.8.0 P3)

## Scope

**In scope:**
- `exarchos doctor` CLI command + `exarchos_orchestrate({action:"doctor"})` MCP action sharing one dispatch handler
- 10 diagnostic checks per design appendix
- `AgentEnvironmentDetector` primitive in `servers/exarchos-mcp/src/runtime/` (shared with future #1091 init)
- `diagnostic.executed` event type
- Parity test between CLI and MCP adapters
- Per-check timeouts and abort propagation

**Out of scope:**
- Enhanced `exarchos init` (#1091) — consumes the detector but lands later
- Real basileus remote-MCP connectivity (#1081) — stub check only
- Plugin-registered custom checks — rejected in ideate as premature (DIM-1 module-global risk)
- Auto-fix verb — reporting only

## Summary

- Total tasks: 22
- Parallel groups: 6 (A schema/events, B detector, C probes, D checks, E composer+wiring, F parity+acceptance)
- Estimated test count: ~28 new tests (2 schema, 4 detector, 10 per-check, 4 composer, 2 wiring, 2 parity, 4 error-path)
- Design coverage: all 9 acceptance criteria from #1089 traced below

## Spec Traceability

| #1089 Acceptance Criterion | Task(s) | Test layer |
|----------------------------|---------|------------|
| `exarchos doctor` command in dispatch core | 017, 018, 019 | integration |
| MCP `exarchos_orchestrate({action:"doctor"})` | 017, 018 | integration |
| ≥8 diagnostic checks | 008–013 | unit |
| Checks include category/name/message/status | 001 (schema) | unit |
| Warning/Fail checks include `fix` field | 001, per-check tasks | unit |
| `diagnostic.executed` event emitted | 002, 016 | integration |
| `--format json` + default table | 019 | integration |
| Exit codes (0/1/2) | 019, 020 | integration |
| Co-located per-check tests | 008–013 | unit |
| Shared detector consumed by #1091 later | 003–005 | unit |

## Risk Register

| Risk | Mitigation | Task |
|------|-----------|------|
| sqlite `integrity_check` hangs on corrupt DB | 2000ms per-check timeout enforced by composer | 014, 015 |
| Test-production divergence (DIM-4) | Parity test asserts byte-equal JSON across adapters | 021 |
| Detector duplication with `src/runtimes/detect.ts` (DIM-5) | JSDoc header calls out distinction; different package boundary | 003 |
| Module-global state creep (DIM-1) | All deps injected; detector is pure fn; no singleton registry | 003, 006 |
| Schema-type divergence (DIM-3) | Types derived via `z.infer`; output validated at composer exit | 001, 016 |

## Task Breakdown

### Group A — Schema + Event Foundation (sequential root)

#### Task 001: Define `CheckResult` and `DoctorOutput` Zod schemas

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** #1089 AC — checks shape + fix field

**TDD Steps:**
1. [RED] Write tests in `servers/exarchos-mcp/src/orchestrate/doctor/schema.test.ts`:
   - `CheckResultSchema_ValidPass_ParsesSuccessfully`
   - `CheckResultSchema_MissingCategory_ThrowsValidationError`
   - `CheckResultSchema_SkippedWithoutReason_ThrowsValidationError` (refinement: `status==='Skipped'` requires `reason`)
   - `CheckResultSchema_FailWithFix_ParsesSuccessfully`
   - `DoctorOutputSchema_SummaryMismatchesChecksLength_ThrowsValidationError` (refinement: `passed+warnings+failed+skipped === checks.length`)
   - Expected failure: module does not exist.
2. [GREEN] Create `schema.ts` with `CheckStatusSchema`, `CheckResultSchema` (with Skipped→reason refinement), `DoctorOutputSchema` (with summary-tally refinement). Export derived types via `z.infer`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Five witnessed failures; all pass after schema file is created.
**Dependencies:** None
**Parallelizable:** No (root)

#### Task 002: Add `diagnostic.executed` event to event store schemas

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** #1089 AC — event emission

**TDD Steps:**
1. [RED] Extend `servers/exarchos-mcp/src/event-store/schemas.test.ts`:
   - `EventSchema_DiagnosticExecuted_ParsesSuccessfully` (full valid payload with summary + failedCheckNames + durationMs + checkCount)
   - `EventSchema_DiagnosticExecuted_MissingSummary_ThrowsValidationError`
   - Expected failure: event type `diagnostic.executed` not in union.
2. [GREEN] Add `'diagnostic.executed'` to `EventTypes` array in `schemas.ts`. Add `DiagnosticExecutedDataSchema` referencing `DoctorOutputSchema.shape.summary`. Wire into the discriminated union.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Two witnessed failures; pass post-wire.
**Dependencies:** 001 (imports `DoctorOutputSchema.shape.summary`)
**Parallelizable:** No

### Group B — Agent Environment Detector (sequential within group; parallel with Group D post-006)

#### Task 003: `AgentEnvironment` type + empty-project baseline

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** shared primitive for #1089 + #1091

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/runtime/agent-environment-detector.test.ts`:
   - `DetectAgentEnvironments_EmptyProject_ReturnsAllRuntimesWithConfigAbsent` (inject fs probe that returns ENOENT for every path)
   - `DetectAgentEnvironments_AbortSignalSignaled_Rejects` (abort before call; expect AbortError)
   - Expected failure: module does not exist.
2. [GREEN] Create `agent-environment-detector.ts`:
   - Export `AgentEnvironment` interface (name, configPath, configPresent, configValid, mcpRegistered, skillsDir?)
   - Export `DetectorDeps` interface (fs, home, cwd — all optional with process.* defaults)
   - Export `detectAgentEnvironments(deps?, signal?)` — returns array of 5 runtimes (claude-code/codex/cursor/copilot/opencode), each with configPresent=false when fs throws ENOENT
   - JSDoc header explicitly differentiates from `src/runtimes/detect.ts` (DIM-5)
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Two witnessed failures; pass after module creation.
**Dependencies:** None
**Parallelizable:** No (root of Group B)

#### Task 004: Detect Claude Code config presence + MCP registration

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** shared primitive — claude-code branch

**TDD Steps:**
1. [RED] Extend detector test file:
   - `DetectAgentEnvironments_ClaudeJsonPresentWithExarchosMcp_ReturnsMcpRegisteredTrue`
   - `DetectAgentEnvironments_ClaudeJsonPresentWithoutExarchosMcp_ReturnsMcpRegisteredFalse`
   - `DetectAgentEnvironments_ClaudeJsonMalformed_ReturnsConfigValidFalse`
   - Expected failure: claude-code branch returns hardcoded `configPresent: false`.
2. [GREEN] Implement claude-code detection: read `~/.claude.json` via `deps.fs.readFile`, JSON.parse with try/catch, check `mcpServers.exarchos` presence. Skills dir at `~/.claude/skills`.
3. [REFACTOR] Extract `parseClaudeConfig(raw: string): {valid: boolean, mcpRegistered: boolean}` helper if branch exceeds 20 lines.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Three witnessed failures; pass.
**Dependencies:** 003
**Parallelizable:** No

#### Task 005: Detect codex/cursor/copilot/opencode configs

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** shared primitive — remaining branches

**TDD Steps:**
1. [RED] Extend detector test file with four more cases:
   - `DetectAgentEnvironments_CursorMcpJsonPresent_ReturnsCursorConfigPresent`
   - `DetectAgentEnvironments_CodexDirPresent_ReturnsCodexConfigPresent`
   - `DetectAgentEnvironments_CopilotInstructionsPresent_ReturnsCopilotConfigPresent`
   - `DetectAgentEnvironments_OpencodeDirPresent_ReturnsOpencodeConfigPresent`
   - Expected failure: branches return `configPresent: false`.
2. [GREEN] Implement each branch: cursor reads `.cursor/mcp.json`; codex probes `.codex/`; copilot probes `.vscode/copilot-instructions.md` and `.github/copilot-instructions.md`; opencode probes `.opencode/mcp.json`.
3. [REFACTOR] If branches have similar shape, extract `probeConfigFile(relPath, deps): {present, validJson, mcpRegistered}` helper.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Four witnessed failures; pass.
**Dependencies:** 004
**Parallelizable:** No

### Group C — Probes Bundle (parallel with Group D)

#### Task 006: `DoctorProbes` bundle type + `buildProbes` factory

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** probe injection for checks (DIM-4 test fidelity)

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/orchestrate/doctor/probes.test.ts`:
   - `BuildProbes_FromDispatchContext_ReturnsProbesWithDetectorBound`
   - `BuildProbes_FromDispatchContext_ReturnsProbesWithEventStoreBound`
   - Expected failure: module does not exist.
2. [GREEN] Create `probes.ts` exporting `DoctorProbes` interface (fs, env, git, sqlite, detector, eventStore) and `buildProbes(ctx: DispatchContext): DoctorProbes`. Defaults bind to `node:fs/promises`, `process.env`, `execFile` for git, `ctx.eventStore.sqlite()` handle, `detectAgentEnvironments`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Two witnessed failures; pass.
**Dependencies:** 003
**Parallelizable:** Yes (parallel with Group D once 003+006 are in)

### Group D — Per-Check Modules (parallel within group)

Each check task follows the same TDD pattern: RED writes a test file with Pass/Warning/Fail/Skipped cases using a hand-rolled stub probe; GREEN implements check under 50 lines per DIM-6/T-6.1b. All check files live in `servers/exarchos-mcp/src/orchestrate/doctor/checks/`.

#### Task 007: Check template skeleton + shared test helpers

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DRY across checks 008–013

**TDD Steps:**
1. [RED] Create `checks/__shared__/make-stub-probes.ts` (test-only helper building a partial `DoctorProbes` with sensible defaults; tests override fields).
2. [GREEN] Export `makeStubProbes(overrides?): DoctorProbes` returning stubs that throw if called without override. Include type export `CheckFn = (probes, signal) => Promise<CheckResult>`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Helper compiles and a smoke test imports it without error.
**Dependencies:** 006
**Parallelizable:** No (prereq for 008–013)

#### Task 008: Node version + state-dir + env-var checks

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** runtime+storage+env categories

**TDD Steps:**
1. [RED] Create three test files and RED cases (one per check):
   - `runtime-node-version.test.ts`: `Pass_NodeAtLeast20`, `Fail_NodeBelow20`
   - `storage-state-dir.test.ts`: `Pass_StateDirWritable`, `Fail_StateDirMissing`, `Warning_StateDirReadOnly`
   - `env-variables.test.ts`: `Pass_AllExarchosEnvValid`, `Warning_UnknownExarchosEnvVar`
2. [GREEN] Implement three check modules returning `CheckResult`. Each <50 lines, imports only from `probes.ts` and `schema.ts`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Seven witnessed failures; pass.
**Dependencies:** 007
**Parallelizable:** Yes (with 009–013)

#### Task 009: SQLite health check with bounded integrity_check

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DIM-7/T-7.2 bounded sqlite probe

**TDD Steps:**
1. [RED] `checks/storage-sqlite-health.test.ts`:
   - `Pass_IntegrityCheckOk`
   - `Warning_IntegrityCheckReportsCorruption` (fix: "Run exarchos export to bundle events, then investigate .exarchos/events.db")
   - `Skipped_SqliteBackendNotInUse` (jsonl-only install; reason recorded)
   - Expected failure: module absent.
2. [GREEN] `checks/storage-sqlite-health.ts`: open sqlite handle from probe, run `PRAGMA integrity_check` with abort-signal, map result to CheckResult.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Three witnessed failures; pass.
**Dependencies:** 007
**Parallelizable:** Yes

#### Task 010: Git + VCS availability check

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** vcs category

**TDD Steps:**
1. [RED] `checks/vcs-git-available.test.ts`:
   - `Pass_GitBinaryAndRepoDetected`
   - `Warning_GitBinaryMissing` (fix: "Install git from https://git-scm.com")
   - `Warning_NotInGitRepository` (fix: "Run git init in project root")
   - Expected failure: module absent.
2. [GREEN] Stub `probes.git.which()` + `probes.git.isRepo()`. Return CheckResult accordingly.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Three witnessed failures; pass.
**Dependencies:** 007
**Parallelizable:** Yes

#### Task 011: Agent-config-valid + agent-mcp-registered checks

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** agent category — consumes `AgentEnvironmentDetector`

**TDD Steps:**
1. [RED] `checks/agent-config-valid.test.ts` + `checks/agent-mcp-registered.test.ts`:
   - `Pass_AllDetectedEnvsConfigValid`
   - `Warning_ClaudeJsonMalformed` (fix: "Run exarchos init --runtime claude-code to regenerate")
   - `Skipped_NoAgentEnvironmentsDetected` (reason: "No agent runtime configs present")
   - `Pass_ExarchosMcpRegisteredInAllDetected`
   - `Warning_ExarchosMissingFromClaudeJsonMcpServers` (fix: "exarchos init")
   - Expected failure: modules absent.
2. [GREEN] Both checks read `probes.detector()` output, iterate, return aggregate CheckResult.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Five witnessed failures; pass.
**Dependencies:** 007, 005 (needs detector fully implemented)
**Parallelizable:** Yes with 008–010, 012, 013

#### Task 012: Skill hash sync + plugin version match

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** plugin category

**TDD Steps:**
1. [RED] `checks/plugin-skill-hash-sync.test.ts` + `checks/plugin-version-match.test.ts`:
   - `Pass_InstalledSkillsMatchSourceHashes`
   - `Warning_SkillHashDriftDetected` (fix: "Run npm run build:skills")
   - `Pass_InstalledPluginVersionMatchesPackageJson`
   - `Warning_PluginVersionMismatch` (fix: "Reinstall exarchos plugin")
   - Expected failure: modules absent.
2. [GREEN] Read package.json version from probe; read `~/.claude/plugins/.../package.json` for installed version. For hash sync, read source skill frontmatter hash vs installed.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Four witnessed failures; pass.
**Dependencies:** 007
**Parallelizable:** Yes

#### Task 013: Remote-MCP stub (always Skipped)

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** basileus-forward stub

**TDD Steps:**
1. [RED] `checks/remote-mcp-stub.test.ts`:
   - `RemoteMcpStub_NoConfigPresent_ReturnsSkippedWithPendingReason` (reason references #1081)
   - Expected failure: module absent.
2. [GREEN] Create `remote-mcp-stub.ts` returning `{status: 'Skipped', reason: 'Remote MCP not configured; basileus integration pending (#1081)'}`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** One witnessed failure; pass.
**Dependencies:** 007
**Parallelizable:** Yes

### Group E — Composer + Wiring (sequential)

#### Task 014: Composer — parallel execution with per-check timeout

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DIM-7 per-check bounds

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/orchestrate/doctor/index.test.ts`:
   - `HandleDoctor_AllChecksRunInParallel_TotalTimeLessThanSequentialSum` (use sleeps in stub checks; assert `duration < sum-of-individual`)
   - `HandleDoctor_CheckExceedsTimeout_ReturnsWarningWithTimeoutFix` (stub check sleeps longer than 2000ms; expect Warning + fix)
   - `HandleDoctor_AbortSignalFired_RejectsWithAbortError`
   - Expected failure: composer absent.
2. [GREEN] Create `index.ts` with `handleDoctor(args, ctx)`:
   - `const probes = buildProbes(ctx)`
   - `const controller = new AbortController()`
   - Wrap each check with `Promise.race([check(probes, signal), timeout(args.timeoutMs ?? 2000)])`
   - Run all in `Promise.all`
3. [REFACTOR] Extract `runCheckWithTimeout` helper.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** Three witnessed failures; pass.
**Dependencies:** 008–013
**Parallelizable:** No

#### Task 015: Composer — summary tally

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** summary math

**TDD Steps:**
1. [RED] Extend composer test:
   - `HandleDoctor_MixedResults_ReturnsCorrectSummaryTally` (2 pass, 1 warning, 1 fail, 1 skipped → {2,1,1,1})
   - `HandleDoctor_AllPass_SummaryEqualsChecksLength`
   - Expected failure: summary computed incorrectly or absent.
2. [GREEN] Tally function groups by status, returns `{passed, warnings, failed, skipped}`. Output validated via `DoctorOutputSchema.parse` before return (DIM-3).
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`
**Verification:** Two witnessed failures; pass.
**Dependencies:** 014
**Parallelizable:** No

#### Task 016: Composer — event emission

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** #1089 AC — diagnostic.executed event

**TDD Steps:**
1. [RED] Extend composer test with in-memory event-store double:
   - `HandleDoctor_OnCompletion_AppendsDiagnosticExecutedEventWithSummaryAndFailedNames`
   - `HandleDoctor_OnAbort_DoesNotAppendEvent` (no partial event on cancellation)
   - Expected failure: event not emitted.
2. [GREEN] After tally, call `ctx.eventStore.append({type:'diagnostic.executed', data:{summary, failedCheckNames, checkCount, durationMs}})`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** Two witnessed failures; pass.
**Dependencies:** 002, 015
**Parallelizable:** No

#### Task 017: Register `doctor` action in registry + orchestrate composite

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** MCP surface exposure

**TDD Steps:**
1. [RED] Add to existing `servers/exarchos-mcp/src/orchestrate/composite.test.ts` (or create if absent):
   - `OrchestrateComposite_DispatchDoctorAction_InvokesHandleDoctor`
   - `OrchestrateRegistry_ActionList_IncludesDoctor`
   - Expected failure: action not registered.
2. [GREEN] Add `doctor` action to `orchestrateActions` in `registry.ts` (args schema: `{timeoutMs?: number, format?: 'table'|'json'}`). Import and wire `handleDoctor` in `composite.ts` action map. Update `slimDescription` string.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** Two witnessed failures; pass.
**Dependencies:** 016
**Parallelizable:** No

#### Task 018: Wire composite handler loader in dispatch core

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** dispatch-core integration

**TDD Steps:**
1. [RED] Extend `servers/exarchos-mcp/src/core/dispatch.test.ts`:
   - `Dispatch_ExarchosOrchestrateDoctor_RoutesToOrchestrateComposite_ReturnsValidDoctorOutput`
   - Expected failure: existing composite loader covers this (no action needed IF orchestrate composite already wired); otherwise loader entry missing.
2. [GREEN] Confirm or add loader wiring for `exarchos_orchestrate` in `COMPOSITE_HANDLER_LOADERS` (likely already present — verification task). No new entry if orchestrate composite already loads.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** One witnessed behavior test; passes without new wiring if orchestrate already dispatched (expected case per codebase inspection).
**Dependencies:** 017
**Parallelizable:** No

#### Task 019: CLI top-level `exarchos doctor` surface

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** #1089 AC — CLI top-level + exit codes + format

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/adapters/cli-doctor.test.ts`:
   - `Cli_DoctorNoFailures_ExitsZeroWithTableOutput`
   - `Cli_DoctorAnyFail_ExitsTwo`
   - `Cli_DoctorWarningsOnly_ExitsZero`
   - `Cli_DoctorFormatJson_EmitsSingleLineJsonToStdout`
   - Expected failure: `doctor` sub-command not registered.
2. [GREEN] In `adapters/cli.ts`, add a top-level `doctor` sub-command with an alias that calls `dispatch('exarchos_orchestrate', {action:'doctor', ...})`. Leverage `schema-to-flags` for auto-generated flags. Exit code mapping follows existing `CLI_EXIT_CODES`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** Four witnessed failures; pass.
**Dependencies:** 018
**Parallelizable:** No

#### Task 020: CLI error-path wiring — uncaught exception → exit 3

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DIM-2 observable failure

**TDD Steps:**
1. [RED] Extend `cli-doctor.test.ts`:
   - `Cli_DoctorDispatchThrows_ExitsThreeWithNormalizedToolResult` (stub dispatch throws non-ToolResult)
   - Expected failure: uncaught path not hit (already handled by CLI adapter, but we assert doctor goes through the same path).
2. [GREEN] No new code — assert existing behavior. If test reveals a gap, add an explicit try/catch wrapping the doctor dispatch call that normalizes errors to `CLI_EXIT_CODES.UNCAUGHT_EXCEPTION`.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`
**Verification:** One witnessed behavior test.
**Dependencies:** 019
**Parallelizable:** No

### Group F — Parity + Acceptance

#### Task 021: CLI↔MCP parity test

**Phase:** RED → GREEN
**Test Layer:** acceptance
**Implements:** DIM-4 test fidelity — shared-handler proof

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/orchestrate/doctor.parity.test.ts` (mirrors `review-verdict.parity.test.ts`):
   - `Doctor_CliAndMcpAdaptersGivenSameProbes_ReturnByteEqualJsonOutput`
   - `Doctor_CliAndMcpAdaptersOnFailure_ReturnIdenticalErrorShape`
   - Use existing `parity-harness.ts` to invoke through both adapters.
   - Expected failure: test file doesn't exist; may reveal a real projection divergence.
2. [GREEN] Make byte-equal assertion pass. If divergence is discovered, fix in `adapters/cli-format.ts` or `adapters/mcp.ts` — do NOT diverge handler behavior.
3. [REFACTOR] None.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`
**Verification:** Two witnessed failures; pass. If adapter fix needed, document in PR body.
**Dependencies:** 019
**Parallelizable:** Yes (with 022)

#### Task 022: End-to-end acceptance test + axiom:humanize pass

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** acceptance
**Implements:** #1089 overall AC + DIM-8 prose quality

**TDD Steps:**
1. [RED] Create `servers/exarchos-mcp/src/__tests__/integration/doctor-workflow.test.ts`:
   - `Doctor_FreshProjectWithNoClaudeConfig_ReturnsExpectedShape` (full end-to-end: spawn CLI in temp dir, assert full DoctorOutput shape + presence of `init`-suggesting fix strings)
   - `Doctor_ProjectWithClaudeJsonAndExarchosMcp_ReturnsMostlyPass`
   - Expected failure: either wiring gap or prose issue.
2. [GREEN] Fix any wiring gaps surfaced.
3. [REFACTOR] Run `axiom:humanize` skill against all check message/fix strings; rewrite any flagged AI-writing patterns per DIM-8. Strings follow `<observed state>. <imperative fix>` convention.

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`
**Verification:** End-to-end spawn succeeds; humanize pass clean.
**Dependencies:** 019, 021
**Parallelizable:** Yes (with 021)

## Parallelization Strategy

```
Group A (001→002)              sequential root
         ↓
Group B (003→004→005)          sequential within; starts after 001
         ↓
Group C (006)                  starts after 003
         ↓
Group D (007→{008,009,010,012,013 parallel; 011 after 005})   starts after 006
         ↓
Group E (014→015→016→017→018→019→020)   sequential
         ↓
Group F ({021, 022} parallel)  after 019
```

**Worktree dispatch recommendation:**
- A single worktree for Groups A+B+C (sequential, small).
- Up to 6 parallel worktrees for Group D (checks 008–013 — each is independent once 007 is merged).
- Single worktree for Group E (sequential integration work).
- Two parallel worktrees for Group F (parity + acceptance).

Max concurrent worktrees: 6 (during Group D).

## Pre-Implementation Checklist (Cross-Cutting)

Before dispatching implementer agents, the delegate skill should:

1. Confirm `src/runtimes/detect.ts` is unchanged by the implementer (guard against accidental consolidation PR — that's a separate hygiene task).
2. Run `npm run typecheck` after each group.
3. Run `npm run skills:guard` at end of Group E (no skill changes expected; if drift detected, investigate).
4. All per-check test files must have ≤3 mocks per the DIM-4/T-4.2 threshold. Reviewer skill enforces this.

## Acceptance Gate

Plan is complete when:
- [ ] All 22 tasks have explicit RED failure mode documented
- [ ] All checks have ≤3 mocks in tests (DIM-4 enforcement)
- [ ] Parity test passes byte-equality (DIM-4 test fidelity)
- [ ] Event `diagnostic.executed` appears in `event-store/schemas.ts` EventTypes list (DIM-3)
- [ ] axiom:humanize scan clean on all check strings (DIM-8)
- [ ] No new module-global mutable state (grep confirms, DIM-1)
- [ ] Detector JSDoc explicitly differentiates from `src/runtimes/detect.ts` (DIM-5)
