# Plan: E2E Tests for v2.9.0 — Revisited Process-Fidelity Series

**Workflow:** `e2e-v29-revisited`
**Date:** 2026-05-05 (revised after plan-review)
**Design:** `docs/designs/2026-05-05-e2e-v29-revisited.md`
**Iron Law:** No production code without a failing test first.

## Pre-revision verification (resolved at plan time)

Plan-review surfaced three implementation hazards. All resolved against current `main` before delegation:

| Hazard | Resolution | Source |
|--------|-----------|--------|
| CLI invocation shape for parity actions | **Two-word subcommand** auto-generated from MCP tool registry per `cli.ts:130-148` (`exarchos <tool-stripped-prefix> <action>`). Args are passed as flags via `addFlagsFromSchema` — `--feature-id <id>` rather than positional in most cases. | `servers/exarchos-mcp/src/adapters/cli.ts:130-148` |
| `exarchos_event` action name for emitting events | **`append`** (not `emit`). Confirmed in `playbooks.ts`, `runbooks/definitions.ts`, `describe/handler.ts:309`. | `servers/exarchos-mcp/src/runbooks/definitions.ts:35` et al. |
| CI workflow integration | `ci.yml` invokes `npm run test:run` twice (root + mcp); no `test:process` job exists. Plan now adds T1.8 to wire it as a non-blocking job in W1, and T3.7 flips it to gating. | `.github/workflows/ci.yml:71,123` |

Plan tasks updated to use confirmed names. The first-task-of-affected-wave verification overhead is eliminated.

## Mid-flight correction (post-D1-saga, 2026-05-05)

The original design + plan referenced three actions on `exarchos_view` that **do not exist** in the actual registry. Discovered when the D1-saga implementer (T2.1/T2.2/T2.3) had to map them to real surfaces. Corrected mapping:

| Plan reference (incorrect) | Actual location | Corrected CLI / MCP call |
|----------------------------|-----------------|--------------------------|
| `exarchos_view { action: 'describe' }` | `exarchos_workflow { action: 'describe' }` | `exarchos workflow describe --feature-id <id>` / `exarchos_workflow.describe` |
| `exarchos_view { action: 'event_log' }` | `exarchos_event { action: 'query', stream: <featureId> }` | `exarchos event query --stream <id>` / `exarchos_event.query`. Note `stream` (not `featureId`) is the schema key. |
| `exarchos_view { action: 'rehydrate' }` | `exarchos_workflow { action: 'rehydrate' }` | `exarchos workflow rehydrate --feature-id <id>` / `exarchos_workflow.rehydrate` |

`exarchos_view`'s **actual** actions are: `pipeline`, `tasks`, `workflow_status`, `stack_status`, `stack_place`, `telemetry`, `team_performance`, `delegation_timeline`, `code_quality`, `quality_hints`, `delegation_readiness`, `synthesis_readiness`, `shepherd_status`, `convergence` (per `servers/exarchos-mcp/src/registry.ts:1718-1726`). None match the parity-test design's needs; describe/event-log/rehydrate live on `_workflow` and `_event` instead.

**Tasks T3.1, T3.4–T3.6 use the corrected tool/action mappings.** PARITY_CONTRACT entries become `workflow.describe`, `event.query`, `workflow.rehydrate` (not `view.describe`, `view.event_log`, `view.rehydrate`).

Additional verified MCP shapes (for T2.4 / Wave E and parity tests):

```typescript
// event append:
{ name: 'exarchos_event', arguments: {
    action: 'append',
    stream: '<featureId>',                  // NOT featureId
    event: { type, data },                  // event body lives under `event` key
    idempotencyKey: '<optional>',
}}

// event query (returns data: WorkflowEvent[] post-normalize):
{ name: 'exarchos_event', arguments: {
    action: 'query',
    stream: '<featureId>',
}}
```

## v2.9 dogfood bugs surfaced + fixed during D1

D1's CLI smoke + install-skills tests surfaced **3 v2.9 bugs**, each fixed in a separate PR targeting `main` directly:

| Bug | PR | Status | v2.9 GA blocker? |
|-----|----|----|--------|
| #1216 — `version` subcommand prints hardcoded `2.8.3` | [#1219](https://github.com/lvlup-sw/exarchos/pull/1219) | Open | Yes (preflight cascade) |
| #1217 — `install-skills` non-interactive no-op | [#1222](https://github.com/lvlup-sw/exarchos/pull/1222) | Open | **YES — primary GA blocker** |
| #1218 — CLI/MCP schema asymmetry (intentional) | [#1221](https://github.com/lvlup-sw/exarchos/pull/1221) | Open | No (doc-only) |

P4 will rebase onto `main` after these merge. T4.3's 3 install-skills tests already pass against #1222's fix (verified in F3's report).

Also surfaced separately: #1220 — subagent worktree isolation gap (non-implementer types). Not blocking; tracked.

## Wave structure

```
Wave 1 (P1)  ──▶  ┌── Wave 2 (P2) ──┐
Foundation        │                  │
rebase + retarget │                  │   Wave 5 (P3, after P2 + P4)
                  ├── Wave 3 (P4) ──┤    F3 parity narrowed
                  │                  │   (sequenced last; consumes
                  └─────────────────┘    normalizer extensions
                                         from W2/W3 if any)
```

W2 (P2 saga) and W3 (P4 broader CLI) are independent after W1 lands and run in parallel. W5 (P3 parity) sequences after W2+W3 to consume any normalizer extensions and to land the final v2.9.0 GA gate flip.

## Branch layout

| Wave | Integration branch | Per-task branch convention |
|------|-------------------|---------------------------|
| W1 | `feature/e2e-v29-p1-foundation` | `task/e2e-v29-T1-<n>-<slug>` |
| W2 | `feature/e2e-v29-p2-saga` | `task/e2e-v29-T2-<n>-<slug>` |
| W3 | `feature/e2e-v29-p4-cli-surface` | `task/e2e-v29-T4-<n>-<slug>` |
| W5 | `feature/e2e-v29-p3-parity` | `task/e2e-v29-T3-<n>-<slug>` |

Each integration branch becomes one PR (P1, P2, P4, P3). W4 reserved for any cross-wave hardening pass; expected empty.

---

## Wave 1 — P1: Foundation rebase + v2.9 retarget

**Source:** PR #1166 (open). Carries forward `test/fixtures/{hermetic,mcp-client,cli-runner,normalizers,process-tracker,index}.ts` + `test/setup/{global,preflight}.ts` + `vitest.config.ts` projects split. **Mostly mechanical**; deltas are below.

**Definition of done for W1:**
- Branch `feature/e2e-v29-p1-foundation` rebased onto current `main`.
- 49 fixture self-tests pass.
- Preflight asserts `exarchos` (not `exarchos-mcp`) on PATH and binary advertises `2.9.x`.
- `runCli` example call sites + JSDoc updated to v2.9 binary surface.
- `spawnMcpClient` default `command` is `'exarchos'` with `args: ['mcp']`.
- All 15 coderabbitai actionable comments triaged: structural addressed, style deferred to a single follow-up commit on the same PR.

### Task T1.1: Rebase #1166 onto main

**Phase:** mechanical (no TDD; no code change)

1. Check out `feature/process-fidelity-harness` (PR #1166's head branch).
2. Rename branch to `feature/e2e-v29-p1-foundation`.
3. `git rebase origin/main`.
4. Resolve conflicts in `package.json` scripts and `vitest.config.ts` (current main has evolved both).
5. Re-run `npm run test:run` and `npm run test:process` — both pass.

**Dependencies:** None.
**Parallelizable:** No (foundation for W1).
**Effort:** ~1 hour if conflicts mechanical, half-day if not.

### Task T1.2: Preflight asserts `exarchos` binary on PATH

1. **[RED]** Update `test/setup/preflight.test.ts`:
   - New test: `assertExarchosOnPath_missingBinary_throwsActionableError` — sets `PATH=''`, expects throw with message containing `npm link` or `install` instructions and the binary name `exarchos` (not `exarchos-mcp`).
   - Existing test for `exarchos-mcp` is renamed/updated.
   - Run: fail — current preflight checks for `exarchos-mcp`.

2. **[GREEN]** Update `test/setup/preflight.ts`:
   - Replace `'exarchos-mcp'` literal with `'exarchos'`.
   - Update error message to reference v2.9 install flow (`get-exarchos.sh` or `npm link`).

3. **[REFACTOR]** Single source of truth for binary name — extract to `BINARY_NAME` constant if not already.

**Files:** `test/setup/preflight.{ts,test.ts}`
**Dependencies:** T1.1
**Parallelizable:** No (T1.3 builds on this file)

### Task T1.3: Preflight asserts binary version is v2.9.x

1. **[RED]** Add test `assertExarchosOnPath_staleBinary_throwsVersionMismatch`:
   - Mock `runCli('exarchos', ['version'])` to return stdout `'2.8.3'`.
   - Expect throw with message naming both the expected major.minor (`2.9`) and the actual version found.
   - Run: fail — preflight does not check version.

2. **[GREEN]** In `test/setup/preflight.ts`, add a version-resolution step after PATH check:
   - `runCli` the binary with `['version']`, parse stdout, compare against `2.9.x` major.minor.
   - Throw with both expected and actual on mismatch.
   - Read expected major.minor from root `package.json` `version` field at preflight time (single source of truth).

3. **[REFACTOR]** None expected.

**Files:** `test/setup/preflight.{ts,test.ts}`
**Dependencies:** T1.2
**Parallelizable:** No

### Task T1.4: `runCli` defaults + JSDoc retargeted to v2.9 binary

1. **[RED]** Add test in `test/fixtures/cli-runner.test.ts`:
   - `runCli_defaultCommand_resolvesToExarchos` — calling `runCli({ args: ['version'] })` (no `command`) should resolve to the `exarchos` binary on PATH.
   - Run: fail — `RunCliOpts.command` is currently required (no default).

2. **[GREEN]** Update `test/fixtures/cli-runner.ts`:
   - Make `command` optional in `RunCliOpts`; default to `'exarchos'`.
   - Update JSDoc on `runCli` to document the v2.9 binary surface and link to the design doc.
   - Update example in module JSDoc from `'exarchos-install'` to `'exarchos'` + `['install-skills']`.

3. **[REFACTOR]** None.

**Files:** `test/fixtures/cli-runner.{ts,test.ts}`
**Dependencies:** T1.1
**Parallelizable:** Yes (with T1.5)

### Task T1.5: `spawnMcpClient` default `command + args` for v2.9 mode dispatch

1. **[RED]** Add test in `test/fixtures/mcp-client.test.ts`:
   - `spawnMcpClient_defaultCommand_spawnsExarchosMcpSubcommand` — calling `spawnMcpClient()` (no `command`) spawns the `exarchos` binary with `args: ['mcp']`.
   - Assert by inspecting the captured `ChildProcess.spawnargs` or by intercepting the `StdioClientTransport` constructor.
   - Run: fail — current default is `'exarchos-mcp'` with no args.

2. **[GREEN]** Update `test/fixtures/mcp-client.ts`:
   - Default `command` to `'exarchos'`.
   - Default `args` to `['mcp']` (merged before any caller-provided args).
   - Update JSDoc.

3. **[REFACTOR]** None.

**Files:** `test/fixtures/mcp-client.{ts,test.ts}`
**Dependencies:** T1.1
**Parallelizable:** Yes (with T1.4)

### Task T1.6: Address coderabbit structural comments

**Phase:** Review-driven; no new TDD cycle (each comment may suggest a small TDD increment).

1. Triage all 15 actionable comments into: `structural` | `style` | `out-of-scope`.
2. For each `structural` comment, follow the standard RED→GREEN cycle in the affected file.
3. Bundle all `style` comments into a single follow-up commit with title `chore(test/fixtures): apply coderabbit style suggestions`.
4. For each `out-of-scope`, reply to the comment on the PR with the deferral reason and (if appropriate) link to a follow-up issue.

**Files:** Various under `test/fixtures/`, `test/setup/`, `vitest.config.ts`.
**Dependencies:** T1.1
**Parallelizable:** Per-comment yes; recommended sequential to avoid conflicts.
**Effort:** 1–2 days (depends on triage outcome).

### Task T1.7: W1 acceptance verification

**Phase:** verification (no code change)

1. `npm run typecheck` clean.
2. `npm run test:run` (unit + integration) clean.
3. `npm run test:process` exits 0 (empty test set; setupFiles skipped on zero-discovery is the original design intent).
4. `npm run test` (all projects) clean.
5. Push `feature/e2e-v29-p1-foundation`; open PR (or update #1166 if preserving history per design open question 10.1).
6. Confirm CI green.

**Dependencies:** T1.1–T1.6
**Parallelizable:** No
**Effort:** 30 min.

### Task T1.8: CI workflow — `test:process` as non-blocking job

1. **[RED]** None — CI config change has no co-located test pattern. Verify by failing-fast assertion: add the job, intentionally break it once locally, confirm GitHub Actions surfaces the failure.

2. **[GREEN]** Edit `.github/workflows/ci.yml`:
   - After the existing `npm run test:run` step (line 71 area, post-mcp-server tests), add a new job `e2e-process` (or step within an existing job, depending on dependency on the bun-built binary):
     - Build the binary (`npm run build:binary` or rely on existing build step).
     - `npm link` so the binary is on PATH (preflight assertion needs this).
     - Run `npm run test:process`.
   - Mark with `continue-on-error: true` initially (non-blocking through W2/W3). Comment explaining T3.7 will remove this flag.
   - Run on Linux only (`ubuntu-latest`) — Windows matrix is v2.10 P5.

3. **[REFACTOR]** None.

**Files:** `.github/workflows/ci.yml`
**Dependencies:** T1.7 (run after foundation lands so the job has tests to discover, even if empty initially)
**Parallelizable:** No (W1 closeout)
**Effort:** ~1 hour.

---

## Wave 2 — P2: F6 saga harness + #1208 regression

**Goal:** ship the saga primitives and the test that would have caught #1208.

**Definition of done for W2:**
- `test/fixtures/event-replay.ts` exports `snapshotEventStream` and `replayInto` with self-tests.
- `test/fixtures/saga-driver.ts` exports `driveSaga` with self-tests.
- `test/process/saga-merge-detour.test.ts` exists and passes after the #1208 fix lands in the same PR.
- `test/process/saga-merge-detour.test.ts` fails on `main` without the #1208 fix (proven via a precondition commit on the integration branch).

### Task T2.1: `snapshotEventStream` primitive

1. **[RED]** Create `test/fixtures/event-replay.test.ts`:
   - `snapshotEventStream_freshFeature_returnsEmptySnapshot`
   - `snapshotEventStream_afterEvents_includesAllEventsInOrder`
   - `snapshotEventStream_appliesNormalize_replacesTimestamps`
   - All three: import `snapshotEventStream` — fails (module does not exist).

2. **[GREEN]** Create `test/fixtures/event-replay.ts`:
   - Export `snapshotEventStream(client, featureId): Promise<EventSnapshot>` — calls `client.callTool({ name: 'exarchos_event', arguments: { action: 'query', stream: featureId } })` (per mid-flight correction §0; `stream` is the schema key, not `featureId`), parses the result, applies `normalize`, returns `{ featureId, events: NormalizedEvent[] }`.
   - Define `EventSnapshot` and `NormalizedEvent` types.

3. **[REFACTOR]** None expected.

**Files:** `test/fixtures/event-replay.{ts,test.ts}`
**Dependencies:** T1.7
**Parallelizable:** With T2.2 (different fixture functions, same file → sequential within file)

### Task T2.2: `replayInto` primitive

1. **[RED]** Add to `test/fixtures/event-replay.test.ts`:
   - `replayInto_emptyTarget_appliesAllEvents` — snapshot a saga from server A, replay into fresh server B, assert B's `rehydrate` projection structurally equals A's.
   - `replayInto_idempotent_secondCallNoOp` — replaying the same snapshot twice does not double-apply.
   - Run: fail — `replayInto` does not exist.

2. **[GREEN]** Add to `test/fixtures/event-replay.ts`:
   - `replayInto(client, snapshot): Promise<void>` — for each event in snapshot, call `client.callTool({ name: 'exarchos_event', arguments: { action: 'append', ...event } })`. Action name `'append'` confirmed against `servers/exarchos-mcp/src/runbooks/definitions.ts:35` (see plan §"Pre-revision verification").
   - After all events appended, poll `exarchos_workflow({ action: 'rehydrate' })` (per mid-flight correction §0; `rehydrate` lives on `_workflow`, not `_view`) until projection's `_eventSequence` matches snapshot's last event sequence (timeout 5s).

3. **[REFACTOR]** Extract poll logic to `awaitProjectionCatchUp` helper if used twice.

**Files:** `test/fixtures/event-replay.{ts,test.ts}`
**Dependencies:** T2.1
**Parallelizable:** No (same file)

### Task T2.3: `driveSaga` primitive

1. **[RED]** Create `test/fixtures/saga-driver.test.ts`:
   - `driveSaga_emptyCallList_returnsEmptyTranscript`
   - `driveSaga_singleCall_returnsSingleTranscriptEntry`
   - `driveSaga_multipleCalls_executesInOrder`
   - `driveSaga_callThrows_haltsAndIncludesErrorInTranscript`
   - All: import `driveSaga` — fails.

2. **[GREEN]** Create `test/fixtures/saga-driver.ts`:
   - `driveSaga(client, calls: SagaCall[]): Promise<SagaTranscript>` where `SagaCall = { tool: string, arguments: Record<string, unknown> }` and `SagaTranscript = { steps: { call: SagaCall, result: unknown, error?: Error }[] }`.
   - Sequential `await client.callTool(...)` per call; halt on first throw, recording the error.

3. **[REFACTOR]** None.

**Files:** `test/fixtures/saga-driver.{ts,test.ts}`
**Dependencies:** T1.7
**Parallelizable:** Yes (with T2.1, T2.2 — different files)

### Task T2.4: #1208 regression test

1. **[RED]** Create `test/process/saga-merge-detour.test.ts`:
   - `taskCompletedWithWorktreePath_surfacesMergeOrchestrateInNextActions` — uses `driveSaga` to: `workflow init` → `prepare_delegation` (1 task) → `event emit task.assigned` → `orchestrate task_complete` with `result.worktreePath`. Then calls `exarchos_view({ action: 'rehydrate' })`. Asserts `next_actions` contains an entry with `verb: 'merge_orchestrate'`.
   - Run on current `main`: **fails** (this is exactly #1208). Capture the failure output to confirm we have a true regression test.

2. **[GREEN]** Fix #1208 in HSM detour code:
   - Locate the HSM transition handler in `servers/exarchos-mcp/src/orchestrate/` that processes `task.completed` events.
   - Add the missing branch: when `event.data.worktreePath` (or `event.data.worktree`) is present, transition phase to `merge-pending` and emit a `merge_orchestrate` verb in `next_actions`.
   - Re-run the test: pass.

3. **[REFACTOR]** Extract worktree-detection predicate to a named helper `eventCarriesWorktreeAssociation(event)` for reuse.

**Files:** `test/process/saga-merge-detour.test.ts` + handler in `servers/exarchos-mcp/src/orchestrate/*.ts` (exact file TBD by implementer per plan-level "code archeology" step) + matching `.test.ts` for the handler.
**Dependencies:** T2.2, T2.3
**Parallelizable:** No (final test of W2)
**Effort:** ~1 day, mostly handler triage.

### Task T2.5: W2 acceptance verification

1. `npm run test:process` runs and includes 1 new test, all pass.
2. `npm run test:run` clean.
3. Push `feature/e2e-v29-p2-saga`; open PR. PR description cites #1208 close.
4. CI green.

**Dependencies:** T2.1–T2.4
**Parallelizable:** No
**Effort:** 30 min.

---

## Wave 3 — P4: Broader CLI surface (P4b scope)

**Goal:** Linux end-to-end coverage of the v2.9 published subcommand surface.

**Runs in parallel with W2** after W1 lands. Test files are per-subcommand and independent — each task is one file.

**Definition of done for W3:**
- `test/process/cli/` directory exists with 7 test files.
- Each test passes against the bun-compiled `exarchos` binary on PATH.
- Each test uses `withHermeticEnv` and asserts no leaked processes.

### Task T4.1: `version.test.ts`

1. **[RED]** Create `test/process/cli/version.test.ts`:
   - `version_default_matchesPackageJsonVersion` — `runCli({ args: ['version'] })` exits 0 and stdout contains the version from root `package.json`.
   - `version_unknownFlag_exitsNonZero` — `runCli({ args: ['version', '--bogus'] })` exits non-zero.
   - Run: presumably passes (binary already implements). If it fails, that is the bug to fix in [GREEN].

2. **[GREEN]** Only if RED passed: confirm; if not, fix the binary's version subcommand.

3. **[REFACTOR]** None.

**Files:** `test/process/cli/version.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes (independent of all other T4.x)
**Effort:** ~30 min.

### Task T4.2: `doctor.test.ts`

1. **[RED]** Create `test/process/cli/doctor.test.ts`:
   - `doctor_cleanTmpHome_exitsZero` — `withHermeticEnv` then `runCli({ args: ['doctor'] })` exits 0.
   - `doctor_jsonFlag_outputsValidJsonWithExpectedChecks` — `runCli({ args: ['doctor', '--json'] })` stdout parses as JSON with at least the documented check keys (consult current doctor implementation for keys).
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

**Files:** `test/process/cli/doctor.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~45 min.

### Task T4.3: `install-skills.test.ts`

1. **[RED]** Create `test/process/cli/install-skills.test.ts`:
   - `installSkills_agentClaude_writesExpectedFiles` — hermetic env, `runCli({ args: ['install-skills', '--agent', 'claude'] })`, exit 0, then assert `~/.claude/skills/<one-known-skill>/SKILL.md` exists and is non-empty under `tmp/$HOME`.
   - `installSkills_agentClaude_registersMcpServerInClaudeJson` — after install, `~/.claude.json` exists, parses as JSON, contains an `mcpServers.exarchos` entry.
   - `installSkills_idempotent_secondRunNoChanges` — run twice; second run produces no fs changes (capture mtimes).
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

3. **[REFACTOR]** Extract path assertions to fixture helper if reused in W3.

**Files:** `test/process/cli/install-skills.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~1 day (largest test file in W3).

### Task T4.4: `schema.test.ts`

1. **[RED]** Create `test/process/cli/schema.test.ts`:
   - `schema_default_outputsValidJson` — `runCli({ args: ['schema'] })`, exit 0, stdout parses JSON.
   - `schema_actionsCoverMcpToolsList_complete` — capture the action set from `schema` output and from a `spawnMcpClient` + `client.listTools()` call; assert equality.
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

**Files:** `test/process/cli/schema.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~45 min.

### Task T4.5: `topology.test.ts`

1. **[RED]** Create `test/process/cli/topology.test.ts`:
   - `topology_default_outputsValidJson` — `runCli({ args: ['topology'] })` exit 0, JSON parses.
   - `topology_workflowType_returnsTypeSpecificGraph` — `runCli({ args: ['topology', 'feature'] })` returns a graph node count > 0.
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

**Files:** `test/process/cli/topology.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~30 min.

### Task T4.6: `emissions.test.ts`

1. **[RED]** Create `test/process/cli/emissions.test.ts`:
   - `emissions_default_outputsNonEmptyCatalog` — `runCli({ args: ['emissions'] })` exit 0, JSON parses, catalog length > 0.
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

**Files:** `test/process/cli/emissions.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~30 min.

### Task T4.7: `mcp-start-stop.test.ts`

1. **[RED]** Create `test/process/cli/mcp-start-stop.test.ts`:
   - `mcp_start_acceptsInitializeOverStdio` — spawn the binary with `args: ['mcp']`, send a JSON-RPC `initialize` over stdin, read response over stdout, assert valid `initialize` response.
   - `mcp_sigterm_exitsCleanlyWithinThreeSeconds` — after start, send SIGTERM, assert exit code 0 (or platform-conventional) within 3000ms.
   - Note: prefer `spawnMcpClient` which already wraps this — these tests then assert the convenience surface works as documented.
   - Run.

2. **[GREEN]** Only if RED reveals a bug.

**Files:** `test/process/cli/mcp-start-stop.test.ts`
**Dependencies:** T1.7
**Parallelizable:** Yes
**Effort:** ~1 hour.

### Task T4.8: W3 acceptance verification

1. `npm run test:process` includes all 7 new files; all pass.
2. `npm run typecheck` clean.
3. Push `feature/e2e-v29-p4-cli-surface`; open PR.
4. CI green.

**Dependencies:** T4.1–T4.7
**Parallelizable:** No
**Effort:** 30 min.

---

## Wave 5 — P3: F3 narrowed parity + F6.1 reconstructability

**Goal:** operationally close #1109 invariants #1 and #2.

**Sequenced after W2 + W3** to consume any normalizer extensions added by those waves. Final PR before v2.9.0 GA.

**Definition of done for W5:**
- `test/fixtures/parity-contract.ts` exports `PARITY_CONTRACT` and `assertParity`.
- `test/fixtures/normalizers.ts` extended with envelope key-ordering canonicalization and transport-id stripping.
- `test/process/parity-view-{describe,event-log,rehydrate}.test.ts` all pass.
- The rehydrate parity test also asserts F6.1 reconstructability via `replayInto(snapshotEventStream(...))`.

### Task T3.1: `parity-contract.ts` schema + `workflow.describe` entry

1. **[RED]** Create `test/fixtures/parity-contract.test.ts`:
   - `paritySpec_describeAction_listsRequiredFields` — assert `PARITY_CONTRACT` includes an entry for `workflow.describe` and that its `fieldsRequiringEquality` contains at least `phase`, `featureId`, `tasks`.
   - `paritySpec_actionUniqueness_eachActionHasOneEntry` — no duplicate `action` strings.
   - Run: fail (module does not exist).

2. **[GREEN]** Create `test/fixtures/parity-contract.ts`:
   - `ParitySpec` type per design §4.3.
   - `PARITY_CONTRACT` array with one entry: `{ action: 'workflow.describe', fieldsRequiringEquality: ['phase', 'featureId', 'tasks'], fieldsAllowedToDiffer: ['_transport.requestId'] }` (per mid-flight correction §0; `describe` lives on `_workflow`, not `_view`).

3. **[REFACTOR]** None.

**Files:** `test/fixtures/parity-contract.{ts,test.ts}`
**Dependencies:** T2.5, T4.8
**Parallelizable:** No (foundation for W5)

### Task T3.2: `assertParity` helper

1. **[RED]** Add to `test/fixtures/parity-contract.test.ts`:
   - `assertParity_equalEnvelopes_passes`
   - `assertParity_diffInRequiredField_throws`
   - `assertParity_diffInAllowedField_passes`
   - `assertParity_missingRequiredField_throws`
   - All: import `assertParity` — fails.

2. **[GREEN]** Add `assertParity(cliResult, mcpResult, spec)` to `test/fixtures/parity-contract.ts`:
   - For each `fieldsRequiringEquality` dot-path, extract from both envelopes, deep-equal, throw on mismatch with structured diff in error message.
   - Ignore `fieldsAllowedToDiffer` paths.
   - Use `expect`-compatible error format so vitest renders nicely.

3. **[REFACTOR]** Extract dot-path resolver to a small named helper.

**Files:** `test/fixtures/parity-contract.{ts,test.ts}`
**Dependencies:** T3.1
**Parallelizable:** No

### Task T3.3: Normalizer extensions for envelope parity

1. **[RED]** Add to `test/fixtures/normalizers.test.ts`:
   - `normalize_jsonKeyOrdering_canonicalizesAlphabetical` — input with `{b: 1, a: 2}` and `{a: 2, b: 1}` produces structurally equal output.
   - `normalize_transportRequestId_replacedWithPlaceholder` — `{_transport: {requestId: 'abc-123'}}` becomes `{_transport: {requestId: '<REQ_ID>'}}`.
   - `normalize_idempotent_doubleNormalizeIsNoOp` (already in baseline; assert still holds).
   - Run.

2. **[GREEN]** Extend `test/fixtures/normalizers.ts`:
   - Add envelope key-ordering canonicalizer (recursive object key sort).
   - Extend the placeholder rule set with `_transport.requestId → '<REQ_ID>'`.

3. **[REFACTOR]** Keep the per-rule list flat — no class abstraction.

**Files:** `test/fixtures/normalizers.{ts,test.ts}`
**Dependencies:** T1.7
**Parallelizable:** Yes (with T3.1/T3.2 — different files)

### Task T3.4: `parity-workflow-describe.test.ts`

(Renamed from `parity-view-describe` per the mid-flight correction — describe lives on `_workflow`.)

1. **[RED]** Create `test/process/parity-workflow-describe.test.ts`:
   - `workflowDescribe_cliVsMcp_envelopesMatchAfterNormalize` — run a 3-step saga via `driveSaga`, then:
     - **CLI side:** `runCli({ args: ['workflow', 'describe', '--feature-id', featureId, '--json'] })` and parse stdout. (Two-word subcommand pattern auto-generated. Confirm exact flag name via `exarchos workflow describe --help` at task start; commander kebab-cases.)
     - **MCP side:** `client.callTool({ name: 'exarchos_workflow', arguments: { action: 'describe', featureId } })`.
     - Apply `normalize` to both, then `assertParity(cli, mcp, PARITY_CONTRACT.find(s => s.action === 'workflow.describe'))`.
   - Run: may fail if there is real divergence; that is a real bug to fix in [GREEN].

2. **[GREEN]** If divergence found, fix in CLI adapter or MCP handler depending on which side is wrong (treat MCP envelope as the canonical source, per design §3 Basileus-forward).

3. **[REFACTOR]** None.

**Files:** `test/process/parity-view-describe.test.ts` (+ possible fix in `servers/exarchos-mcp/src/adapters/cli.ts`)
**Dependencies:** T3.1, T3.2, T3.3, T2.3 (driveSaga)
**Parallelizable:** No (sequential parity tests)

### Task T3.5: `parity-event-query.test.ts`

(Renamed from `parity-view-event-log` per the mid-flight correction — event log lives on `_event` as the `query` action.)

1. **[RED]** Add `event.query` entry to `PARITY_CONTRACT` (if not added in T3.1).
2. **[RED]** Create `test/process/parity-event-query.test.ts`:
   - `eventQuery_cliVsMcp_envelopesMatchAfterNormalize` — same shape as T3.4 with action `query` on `_event`.
   - **CLI invocation:** `runCli({ args: ['event', 'query', '--stream', featureId, '--json'] })` — note `--stream` flag (the schema discriminator), NOT `--feature-id`.
   - **MCP invocation:** `client.callTool({ name: 'exarchos_event', arguments: { action: 'query', stream: featureId } })`.
   - Run.

3. **[GREEN]** If divergence, fix.

**Files:** `test/process/parity-view-event-log.test.ts` + `test/fixtures/parity-contract.ts`
**Dependencies:** T3.4
**Parallelizable:** No

### Task T3.6: `parity-workflow-rehydrate.test.ts` + F6.1 reconstructability

(Renamed from `parity-view-rehydrate` per the mid-flight correction — rehydrate lives on `_workflow`.)

1. **[RED]** Add `workflow.rehydrate` entry to `PARITY_CONTRACT`.
2. **[RED]** Create `test/process/parity-workflow-rehydrate.test.ts` with two tests:
   - `workflowRehydrate_cliVsMcp_envelopesMatchAfterNormalize` — parity check, same shape as T3.4/T3.5.
     - **CLI invocation:** `runCli({ args: ['workflow', 'rehydrate', '--feature-id', featureId, '--json'] })`.
     - **MCP invocation:** `client.callTool({ name: 'exarchos_workflow', arguments: { action: 'rehydrate', featureId } })`.
   - `workflowRehydrate_replayedEvents_reconstructEqualProjection` — drive saga in server A, `snapshotEventStream`, spawn fresh server B, `replayInto`, assert B's `rehydrate` equals A's `rehydrate` (modulo normalize). **This is the F6.1 invariant test.**
   - Run.

3. **[GREEN]** If either fails, fix the projection or the event-replay primitive depending on root cause.

**Files:** `test/process/parity-view-rehydrate.test.ts`
**Dependencies:** T3.5, T2.2 (replayInto), T2.1 (snapshotEventStream)
**Parallelizable:** No

### Task T3.7: W5 acceptance verification + PR-gate flip

1. `npm run test:process` includes all parity tests; all pass.
2. `npm run typecheck` clean.
3. **Flip PR gate:** in `.github/workflows/ci.yml`, remove `continue-on-error: true` from the `e2e-process` job added in T1.8. The job is now blocking.
4. Push `feature/e2e-v29-p3-parity`; open PR. PR description cites #1109 invariants #1 and #2 closure.
5. CI green.

**Dependencies:** T3.1–T3.6
**Parallelizable:** No
**Effort:** ~1 hour for steps 1–3.

---

## Parallelization summary

| Wave | Sequential within | Parallel with |
|------|-------------------|---------------|
| W1 | T1.1 → T1.2 → T1.3 → (T1.4 ∥ T1.5) → T1.6 → T1.7 → T1.8 | (none — foundation) |
| W2 | T2.1 → T2.2 → (T2.3 ∥ above) → T2.4 → T2.5 | W3 |
| W3 | T4.1–T4.7 all parallel → T4.8 | W2 |
| W5 | T3.1 → T3.2 → (T3.3 ∥ above) → T3.4 → T3.5 → T3.6 → T3.7 | (none — sequenced after W2+W3) |

Subagent dispatch waves:
- **Dispatch wave A:** T1.1 (single sequential).
- **Dispatch wave B:** T1.2, T1.3, T1.4, T1.5 (after T1.1; T1.2/T1.3 sequential together, T1.4/T1.5 parallel).
- **Dispatch wave C:** T1.6, T1.7, T1.8 (sequential).
- **Dispatch wave D (parallel):** {T2.1→T2.2, T2.3} ∥ {T4.1, T4.2, T4.3, T4.4, T4.5, T4.6, T4.7}. ~10 subagents.
- **Dispatch wave E:** T2.4 → T2.5 (P2 closeout) and T4.8 (P4 closeout).
- **Dispatch wave F:** T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6 → T3.7. Sequential.

## Schedule projection

| Wave | Calendar effort | Wall time (1 dev / parallelism) |
|------|-----------------|--------------------------------|
| W1 | ~1 week | 1 week |
| W2 | ~1 week | 1 week (parallel with W3) |
| W3 | ~4 days | 1–2 days with parallel dispatch (7 independent tasks) |
| W5 | ~1 week | 1 week |
| **Total v2.9.0 GA** | **~3.5 weeks** | **~3 weeks with parallel dispatch** |

P5 + P6 (v2.10) are out of this plan.

## Open questions deferred from design

These appear in design §10 and are unresolved at plan time. Plan-review or first-task-of-affected-PR resolves them:

- **10.1** Preserve PR #1166 history (interactive rebase + force-push) vs. new squashed PR. **Plan recommendation:** new branch `feature/e2e-v29-p1-foundation`, single squashed PR, body cites #1166.
- **10.2** `driveSaga` exposes per-step events vs. final state only. **Plan recommendation:** transcript exposes per-step `result`; per-step events come from `snapshotEventStream` after the fact (composability).
- **10.3** HATEOAS `_links` parity treatment. **Plan recommendation:** per-action choice in `ParitySpec`, default to "set semantics" (order-insensitive).
- **10.4** Action-surface CI guard ships in P3 or v2.10. **Plan recommendation:** P3 if it is <50 lines, defer otherwise. Re-evaluate after T3.4 lands.
- **10.5** P5/P6 sequencing in v2.10. **Out of plan scope; v2.10 ideate.**

## References

- Design: `docs/designs/2026-05-05-e2e-v29-revisited.md`
- Original design: `docs/designs/2026-04-19-process-fidelity-harness.md`
- Strategy: `docs/research/2026-04-19-e2e-testing-strategy.md`
- PR #1166 (P1 carry-forward source)
- Issues regression-tested: #1208 (W2), #1206/#1180 (W5 via reconstructability)
- Cross-cutting tracker: #1109
