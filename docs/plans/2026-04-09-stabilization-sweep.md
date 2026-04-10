# Implementation Plan: Stabilization Sweep

**Design:** `docs/designs/2026-04-09-stabilization-sweep.md`
**Issues:** #1061, #1062, #1063, #1064, #1065, #1066, #1067, #1068, #1069, #1070
**Branch:** `fix/stabilization-sweep`

## Task Overview

| Task | Issues | Area | Parallelizable |
|------|--------|------|----------------|
| task-001 | #1062 | Event store: sidecar sequence:0 | Yes (Group A) |
| task-002 | #1061 | Event store: team events not in `_events` | Yes (Group A) |
| task-003 | #1063 | Orchestrate: STATE_FILE_NOT_FOUND fallback | Yes (Group B) |
| task-004 | #1068 | Orchestrate: polyglot test detection | Yes (Group B) |
| task-005 | #1069, #1070 | Task-gate: workflow bypass + stderr | Yes (Group C) |
| task-006 | #1064, #1065, #1066, #1067 | Skills/docs alignment | Yes (Group D) |

## Parallelization

```
Group A:  task-001, task-002  (event-store/, views/, format.ts)
Group B:  task-003, task-004  (orchestrate/)
Group C:  task-005            (cli-commands/gates.ts)
Group D:  task-006            (skills-src/)
                              ↓
                         task-004 creates detectTestCommand() used by task-005
                         task-005 depends on task-004 for shared utility
```

**Adjusted parallelism:** Groups A, B, D fully parallel. Group C (task-005) waits for task-004 to land the shared `detectTestCommand` utility.

---

## Task Details

### task-001: Fix sidecar append returning sequence:0 (#1062)

**Phase:** RED → GREEN → REFACTOR

**Root cause:** `writeToSidecar()` in `servers/exarchos-mcp/src/event-store/store.ts:247-276` explicitly returns `sequence: 0` because sidecar events don't have assigned sequences until merged. The comment says "Returns a synthetic WorkflowEvent with sequence 0 (pending assignment)." However, `handleEventAppend()` calls `toEventAck(event)` on this return value, propagating `sequence: 0` to the caller.

**Fix:** The sidecar response should communicate that the sequence is pending, not return a misleading `0`. Return `sequence: -1` (or add a `pending: true` flag) and update `toEventAck()` to handle this. Alternatively, change the response to omit `sequence` for sidecar appends and return a distinct ack shape.

The simplest fix: when `appendValidated` returns from sidecar mode, `handleEventAppend` should detect `sequence <= 0` and return a response that says `sequencePending: true` instead of `sequence: 0`.

1. **[RED]** Write test: `HandleEventAppend_SidecarMode_ReturnsSequencePendingNotZero`
   - File: `servers/exarchos-mcp/src/event-store/tools.test.ts` (new file, co-located)
   - Setup: Create EventStore in sidecar mode, call `handleEventAppend()`
   - Assert: Response `data.sequence` is not 0. Either `data.sequencePending === true` or `data.sequence === -1`
   - Expected failure: Currently returns `sequence: 0`

2. **[RED]** Write test: `HandleEventAppend_NormalMode_ReturnsPositiveSequence`
   - File: `servers/exarchos-mcp/src/event-store/tools.test.ts`
   - Setup: Create EventStore in normal mode, append event
   - Assert: `data.sequence >= 1`
   - Expected failure: Should pass (existing behavior is correct)

3. **[GREEN]** Fix `handleEventAppend` in `servers/exarchos-mcp/src/event-store/tools.ts`
   - After calling `store.appendValidated()`, check if returned event has `sequence <= 0`
   - If so, modify the ack to include `sequencePending: true` and omit `sequence` (or set to `-1`)
   - Alternatively: update `toEventAck` in `servers/exarchos-mcp/src/format.ts` to handle this

4. **[REFACTOR]** Update `toEventAck` type signature to accommodate pending sequences

**Dependencies:** None
**Parallelizable:** Yes

---

### task-002: Project team events into workflow state `_events` (#1061)

**Phase:** RED → GREEN → REFACTOR

**Root cause analysis:** The `_events` field is populated two ways:
1. `hydrateEventsFromStore()` in `servers/exarchos-mcp/src/workflow/state-store.ts:717-728` — queries event store, maps events via `mapExternalToInternalType()`, spreads `data` fields at top level. Called during `handleSet` (line 494) and `reconcileFromEvents` (line 846).
2. The workflow-state-projection in `views/workflow-state-projection.ts` — used by the materializer for the workflow-state VIEW (separate from state files).

The guards in `servers/exarchos-mcp/src/workflow/guards.ts` check `state._events` for `team.spawned` and `team.disbanded`. The hydration via `hydrateEventsFromStore` should work (test at `reconcile-state.test.ts:126-171` confirms this).

**The actual bug:** In `handleSet` (tools.ts:492), hydration only runs when `input.phase && eventStore` are both truthy. If `eventStore` is not threaded through the dispatch context (e.g., in some orchestrate code paths), `_events` won't be hydrated and guards fail.

Also: the workflow-state-projection returns state unchanged for team events (line 264-275), which means the MATERIALIZER VIEW (used by `exarchos_view`) never shows these events. This is a separate concern but confusing for debugging.

**Fix (two parts):**
1. Add team event projection to `workflow-state-projection.ts` so the materializer view includes a `_teamEvents` (or append to an `_events` array on the view) for observability
2. Ensure `handleSet` logs a warning when `eventStore` is unavailable during phase transitions, so the failure isn't silent

1. **[RED]** Write test: `Apply_TeamSpawned_AppendsToViewEvents`
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.test.ts`
   - Apply `team.spawned` event to initial state
   - Assert: `view._events` (or a new field) contains the team.spawned entry
   - Expected failure: Currently returns state unchanged

2. **[RED]** Write test: `Apply_TeamDisbanded_AppendsToViewEvents`
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.test.ts`
   - Apply `team.spawned` then `team.disbanded` events
   - Assert: Both appear in view's events list
   - Expected failure: Currently returns state unchanged

3. **[GREEN]** Update `workflow-state-projection.ts`
   - Add `_events: Array<{type: string; timestamp: string; data?: unknown}>` to `WorkflowStateView`
   - Initialize to `[]` in `init()`
   - For `team.spawned` and `team.disbanded` cases, append `{type, timestamp, data}` to `view._events`
   - Other team.* events can remain no-op (observability-only)

4. **[GREEN]** Add warning log in `handleSet` when eventStore unavailable
   - File: `servers/exarchos-mcp/src/workflow/tools.ts:492`
   - If `input.phase && !eventStore`, log a warning: "eventStore unavailable — _events will not be hydrated, guards may fail"

5. **[REFACTOR]** Clean up: ensure the test for reconcile hydration (reconcile-state.test.ts:126) still passes

**Dependencies:** None
**Parallelizable:** Yes

---

### task-003: Orchestrate state resolution fallback (#1063)

**Phase:** RED → GREEN → REFACTOR

**Root cause:** `parseStateFile()` in `post-delegation-check.ts:62` and `handleReconcileState()` in `reconcile-state.ts:190` require a `stateFile` filesystem path. MCP-managed workflows store state in-memory via the event store, not on disk. When `stateFile` is `undefined`, `existsSync(undefined)` is falsy, producing `STATE_FILE_NOT_FOUND`.

**Fix:** Make `stateFile` optional in both handlers. When omitted but `featureId` is provided, resolve state from the MCP event store via the workflow materializer. Extract a `resolveWorkflowState(stateFile?, featureId?, eventStore?)` helper that tries file first, then event store.

1. **[RED]** Write test: `HandlePostDelegationCheck_NoStateFile_WithFeatureId_ResolvesFromEventStore`
   - File: `servers/exarchos-mcp/src/orchestrate/post-delegation-check.test.ts` (new file)
   - Setup: Create EventStore with workflow events, call handler with `stateFile: undefined, featureId: 'test'`
   - Assert: Returns success (not STATE_FILE_NOT_FOUND)
   - Expected failure: Currently fails with STATE_FILE_NOT_FOUND

2. **[RED]** Write test: `HandleReconcileState_NoStateFile_WithFeatureId_ResolvesFromEventStore`
   - File: `servers/exarchos-mcp/src/orchestrate/reconcile-state.test.ts` (new file)
   - Similar setup
   - Expected failure: Currently fails with STATE_FILE_NOT_FOUND

3. **[RED]** Write test: `HandlePostDelegationCheck_NoStateFileNoFeatureId_ReturnsError`
   - Assert: Returns a clear error when neither stateFile nor featureId is provided

4. **[GREEN]** Create shared helper: `resolveWorkflowState()`
   - File: `servers/exarchos-mcp/src/orchestrate/resolve-state.ts` (new file)
   - Signature: `resolveWorkflowState(opts: { stateFile?: string; featureId?: string; eventStore?: EventStore }): WorkflowState | { error: ToolResult }`
   - Logic: Try `stateFile` (existsSync + readFileSync), fall back to materializing from event store

5. **[GREEN]** Refactor `post-delegation-check.ts` to use `resolveWorkflowState()`
   - Replace `parseStateFile(stateFile)` with `resolveWorkflowState({ stateFile, featureId, eventStore })`
   - Update `PostDelegationCheckArgs` to make `stateFile` optional, add `featureId?` and `eventStore?`

6. **[GREEN]** Refactor `reconcile-state.ts` to use `resolveWorkflowState()`
   - Same pattern

7. **[REFACTOR]** Remove duplicate `parseStateFile` from both files, consolidate in `resolve-state.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### task-004: Polyglot test command detection (#1068)

**Phase:** RED → GREEN → REFACTOR

**Root cause:** `checkTestsPass()` in `pre-synthesis-check.ts:399-421` hardcodes `npm run test:run` and `npm run typecheck`. No project-type detection.

**Fix:** Create `detectTestCommands(repoRoot: string, override?: string)` utility that returns test and typecheck commands based on project marker files. Also accept an optional `testCommand` parameter to override detection.

1. **[RED]** Write test: `DetectTestCommands_PackageJson_ReturnsNpmCommands`
   - File: `servers/exarchos-mcp/src/orchestrate/detect-test-commands.test.ts` (new file)
   - Setup: tmp dir with `package.json`
   - Assert: returns `{ test: 'npm run test:run', typecheck: 'npm run typecheck' }`

2. **[RED]** Write test: `DetectTestCommands_Csproj_ReturnsDotnetTest`
   - Setup: tmp dir with `Foo.csproj`
   - Assert: returns `{ test: 'dotnet test', typecheck: null }`

3. **[RED]** Write test: `DetectTestCommands_CargoToml_ReturnsCargoTest`
   - Setup: tmp dir with `Cargo.toml`
   - Assert: returns `{ test: 'cargo test', typecheck: null }`

4. **[RED]** Write test: `DetectTestCommands_PyprojectToml_ReturnsPytest`
   - Setup: tmp dir with `pyproject.toml`
   - Assert: returns `{ test: 'pytest', typecheck: null }`

5. **[RED]** Write test: `DetectTestCommands_NoMarkerFile_ReturnsNull`
   - Setup: empty tmp dir
   - Assert: returns `{ test: null, typecheck: null }`

6. **[RED]** Write test: `DetectTestCommands_Override_ReturnsOverride`
   - Setup: tmp dir with `package.json`, override `'dotnet test'`
   - Assert: returns `{ test: 'dotnet test', typecheck: null }`

7. **[GREEN]** Implement `detectTestCommands()`
   - File: `servers/exarchos-mcp/src/orchestrate/detect-test-commands.ts` (new file)
   - Check for marker files in order: `package.json`, `*.csproj`, `Cargo.toml`, `pyproject.toml`
   - Return `{ test: string | null; typecheck: string | null }`

8. **[GREEN]** Update `checkTestsPass()` in `pre-synthesis-check.ts`
   - Replace hardcoded `npm run test:run` with `detectTestCommands(repoRoot, args.testCommand)`
   - If `test` is null, call `checkSkip(ctx, 'Tests pass (no test command detected)')`
   - Add `testCommand?: string` to `PreSynthesisCheckArgs`

9. **[REFACTOR]** Clean up: remove dead `npm run test:run` reference, update handler args type

**Dependencies:** None
**Parallelizable:** Yes

---

### task-005: Task-gate workflow bypass + stderr feedback (#1069, #1070)

**Phase:** RED → GREEN → REFACTOR

**Root cause:** `handleTaskGate()` in `gates.ts:270-277` unconditionally runs `runQualityChecks()` which hardcodes `npm run typecheck` and `npm run test:run`. Inside exarchos workflows, this is redundant (quality is managed by review phases) and fails silently on non-Node projects. When the gate blocks, there's no stderr feedback (#1069).

**Fix:**
1. When an active exarchos workflow is detected, bypass quality checks with a message
2. Outside workflows, use `detectTestCommands()` from task-004 for polyglot support
3. On gate failure, write the error to stderr so the agent gets feedback

1. **[RED]** Write test: `HandleTaskGate_ActiveWorkflow_BypassesChecks`
   - File: `servers/exarchos-mcp/src/cli-commands/gates.test.ts`
   - Setup: Create state dir with active workflow state file, call `handleTaskGate({ cwd: '/path' })`
   - Assert: Returns `{ continue: true }` without running quality checks
   - Expected failure: Currently runs all checks

2. **[RED]** Write test: `HandleTaskGate_NoWorkflow_RunsChecks`
   - File: `servers/exarchos-mcp/src/cli-commands/gates.test.ts`
   - Setup: Empty state dir, mock execSync to succeed
   - Assert: Runs quality checks as usual

3. **[RED]** Write test: `RunQualityChecks_GateFails_ErrorMessageInResult`
   - Assert: On failure, `error.message` contains the check name and stderr output
   - (This likely already passes — confirming existing behavior)

4. **[GREEN]** Update `handleTaskGate()` in `gates.ts`
   - Before running checks, call `findActiveWorkflowState(resolveStateDir())`
   - If active workflow found, return `{ continue: true, message: 'task-gate: skipped (exarchos workflow manages quality gates)' }`
   - If no workflow, proceed with existing logic

5. **[GREEN]** Update `runQualityChecks()` to use `detectTestCommands()`
   - Import from `../orchestrate/detect-test-commands.js`
   - Replace hardcoded `QUALITY_CHECKS` with dynamically detected commands
   - Keep `clean-worktree` check (git status) unconditional

6. **[GREEN]** Ensure gate errors are written to stderr
   - In the CLI adapter (`adapters/hooks.ts`), when gate returns error, write to `process.stderr`
   - Verify the error includes the check name and failure detail

7. **[REFACTOR]** Remove hardcoded `QUALITY_CHECKS` constant (replaced by dynamic detection)

**Dependencies:** task-004 (for `detectTestCommands` utility)
**Parallelizable:** After task-004 completes

---

### task-006: Skills/docs alignment (#1064, #1065, #1066, #1067)

**Phase:** Edit → Build → Verify

No TDD needed — these are markdown-only changes. Verification is `npm run build:skills && npm run skills:guard`.

#### #1066 — Review skills stale keys

1. **Edit** `skills-src/spec-review/SKILL.md`
   - Line 249: Verify `reviews["spec-review"]` format is correct (it is — kebab-case, object with `status` field). Add explicit warning about flat string format being silently ignored, matching the pattern already in quality-review skill (line 369).

2. **Edit** `skills-src/quality-review/SKILL.md`
   - Verify existing documentation at lines 349-370 is accurate. Add explicit note about required key format: `reviews["quality-review"]` (kebab-case, not camelCase).

#### #1067 — Synthesize skill missing events

3. **Edit** `skills-src/synthesis/SKILL.md`
   - Add "Event Emissions (REQUIRED)" section after the PR creation step
   - Include `stack.submitted` event with `prUrls` and `mergeOrder` fields
   - Include `shepherd.iteration` event with `prNumber`, `ciStatus`, `reviewState` fields
   - Reference `PHASE_EXPECTED_EVENTS` in `check-event-emissions.ts:28` for expected types

#### #1064 — Delegation skill missing events

4. **Edit** `skills-src/delegation/SKILL.md`
   - Add "Event Emissions (REQUIRED)" section in the main SKILL.md body (not just in references)
   - Include summary table of required events: `team.spawned`, `team.task.planned`, `team.teammate.dispatched`, `team.disbanded`
   - Cross-reference `references/agent-teams-saga.md` for full examples
   - Note: `task.progressed` events are emitted by subagents, not the orchestrator

#### #1065 — Delegation skill worktree schema

5. **Edit** `skills-src/delegation/SKILL.md`
   - Add worktree entry schema documentation near the state management section
   - Document both `taskId` (single) and `tasks` (array) options
   - Show examples for single-task and multi-task worktrees
   - Include `status` enum: `active`, `merged`, `removed`

6. **Build** — Run `npm run build:skills` to regenerate all runtime variants

7. **Verify** — Run `npm run skills:guard` to ensure generated output matches source

**Dependencies:** None
**Parallelizable:** Yes

---

## Execution Order

```
Phase 1 (parallel):
  ├── task-001 (sidecar sequence fix)
  ├── task-002 (team event projection)
  ├── task-003 (state resolution fallback)
  ├── task-004 (polyglot test detection)  ←─ creates detectTestCommands()
  └── task-006 (skills/docs edits)

Phase 2 (after task-004):
  └── task-005 (task-gate bypass)  ←─ consumes detectTestCommands()

Phase 3 (integration):
  └── Build + full test suite: npm run build && npm run test:run
```

## Files Modified

| File | Tasks |
|------|-------|
| `servers/exarchos-mcp/src/event-store/tools.ts` | task-001 |
| `servers/exarchos-mcp/src/event-store/tools.test.ts` (new) | task-001 |
| `servers/exarchos-mcp/src/format.ts` | task-001 |
| `servers/exarchos-mcp/src/views/workflow-state-projection.ts` | task-002 |
| `servers/exarchos-mcp/src/views/workflow-state-projection.test.ts` | task-002 |
| `servers/exarchos-mcp/src/workflow/tools.ts` | task-002 |
| `servers/exarchos-mcp/src/orchestrate/resolve-state.ts` (new) | task-003 |
| `servers/exarchos-mcp/src/orchestrate/resolve-state.test.ts` (new) | task-003 |
| `servers/exarchos-mcp/src/orchestrate/post-delegation-check.ts` | task-003 |
| `servers/exarchos-mcp/src/orchestrate/reconcile-state.ts` | task-003 |
| `servers/exarchos-mcp/src/orchestrate/detect-test-commands.ts` (new) | task-004 |
| `servers/exarchos-mcp/src/orchestrate/detect-test-commands.test.ts` (new) | task-004 |
| `servers/exarchos-mcp/src/orchestrate/pre-synthesis-check.ts` | task-004 |
| `servers/exarchos-mcp/src/cli-commands/gates.ts` | task-005 |
| `servers/exarchos-mcp/src/cli-commands/gates.test.ts` | task-005 |
| `servers/exarchos-mcp/src/adapters/hooks.ts` | task-005 |
| `skills-src/spec-review/SKILL.md` | task-006 |
| `skills-src/quality-review/SKILL.md` | task-006 |
| `skills-src/synthesis/SKILL.md` | task-006 |
| `skills-src/delegation/SKILL.md` | task-006 |
| `skills/` (generated, all runtimes) | task-006 |
