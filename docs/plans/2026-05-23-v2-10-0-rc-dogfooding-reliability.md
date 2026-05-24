# Implementation Plan: v2.10.0 RC — Dogfooding-Reliability Hardening

## Source Design
Link: `docs/designs/2026-05-23-v2-10-0-rc-dogfooding-reliability.md`

## Scope
**Target:** Partial — RC1 cluster (Option 2 from design): #1292, #1339, #1330, #1329, #1301.
**Excluded:** #1395 (RC2, investigation-gated); all v2.11-deferred features/test-expansion (#1321, #1169, #1232–#1234, #1170, #1337, #1299, #1296, #1353, #1352, #1088/#1342 trackers) — see design "Out of scope".

## Summary
- Total tasks: 9
- Parallel groups: 3
- Estimated test count: 12
- Design coverage: 6 of 6 scope rows (5 fixes + success-criteria parity guard)

## Spec Traceability

| Design row | Requirement | Task(s) |
|---|---|---|
| #1292 | Ratify SDK pin policy (premise stale: already exact `1.29.0`) | T-01 |
| #1339 | No `compoundStateId: undefined` event reaches the log via any append path | T-02, T-03 |
| #1330 | `check_static_analysis` runs against the agent's worktree, not the orchestrator's | T-04, T-05 |
| #1329 | Integration full-suite gate catches load-failure cascades between merges | T-06, T-07 |
| #1301 | `task-isolated` agent edits do not surface in the main worktree; merge-time backstop | T-08, T-09 |
| Success criteria | INV-2 parity preserved for the changed gate input | T-05 (parity assertion) |

All tasks run in `servers/exarchos-mcp`. Paths below are repo-relative.

## Task Breakdown

### Task T-01: Ratify and guard the MCP SDK pin policy (#1292)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** #1292

**TDD Steps:**
1. [RED] Write test: `McpSdkPin_PackageJson_IsExactNotCaretRange`
   - File: `servers/exarchos-mcp/src/__tests__/sdk-pin-policy.test.ts`
   - Reads `servers/exarchos-mcp/package.json`, asserts `@modelcontextprotocol/sdk` matches `/^\d+\.\d+\.(\d+|x)$/` (exact or minor-x), NOT a caret/tilde range.
   - Expected failure: no such test exists; guards against a future caret reintroduction.
   - Run: `npm run test:run` — MUST FAIL (file absent).
2. [GREEN] Make the assertion pass
   - File: `servers/exarchos-mcp/package.json` — confirm/keep exact pin (already `1.29.0`). No version bump unless review decides to move the floor.
   - File: `docs/architecture/runtime.md` (or `servers/exarchos-mcp/README.md`) — add a one-paragraph "SDK pin policy: exact pin, reviewed per minor; Tasks/SEP-1686 surface is `@experimental`" note.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] None.

**Verification:**
- [ ] Test fails before the guard exists
- [ ] Pin is exact; policy documented
- [ ] No functional code change

**Dependencies:** None
**Parallelizable:** Yes (Group A)
**Note:** Re-scope per design — this is policy ratification, not a `^1.0.0 → 1.26.x` swap. The issue's diff is against stale source.

---

### Task T-02: Make fix-cycle event schema-valid for non-compound children (#1339)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** #1339

**TDD Steps:**
1. [RED] Write test: `ExecuteTransition_FixCycleOnNonCompoundChild_EmitsSchemaValidEvent`
   - File: `servers/exarchos-mcp/src/workflow/state-machine.test.ts`
   - Drive a fix-cycle transition where `getParentCompound` returns `undefined`; assert the emitted `fix-cycle` event's `metadata`/`data` parses against `EVENT_DATA_SCHEMAS['workflow.fix-cycle']` (`WorkflowFixCycleData`).
   - Expected failure: today `metadata: { compoundStateId: parent?.id }` yields `compoundStateId: undefined`, which fails `z.string()`.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Two coordinated edits
   - File: `servers/exarchos-mcp/src/workflow/state-machine.ts:792` — omit `compoundStateId` from metadata when `parent` is undefined (spread-conditional), don't emit the key as `undefined`.
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts:636` — make `WorkflowFixCycleData.compoundStateId` `.optional()` (the field is only meaningful inside a compound; absence is valid for a top-level child). Leave `WorkflowCompoundExitData`/`CompoundEntryData` `z.string()` (those sites always have a defined id).
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] None.

**Verification:**
- [ ] Witnessed schema-validation failure pre-fix
- [ ] Event validates post-fix; no `undefined` key present
- [ ] Compound-entry/exit schemas unchanged (their sites are always defined)

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task T-03: Route HSM-internal event emission through validation (#1339 defense-in-depth)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1339

**TDD Steps:**
1. [RED] Write test: `LegacyAppendPath_SchemaInvalidWorkflowEvent_IsRejected`
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.test.ts` (or `state-machine.test.ts`)
   - Construct a `fix-cycle` event with `data.compoundStateId === undefined` and assert the HSM emission boundary (post-T-02 path) cannot launder it — emission goes through `buildValidatedEvent` so `EVENT_DATA_SCHEMAS` runs, returning a validation error rather than appending.
   - Expected failure: the legacy `EventStore.append` path validates only `WorkflowEventBase` (envelope), skipping `EVENT_DATA_SCHEMAS`; a malformed `data` slips through.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Route the HSM transition emission through `buildValidatedEvent`
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.ts` (or the state-machine append site)
   - Use `buildValidatedEvent` for `fix-cycle`/`compound-entry`/`compound-exit` so `data` is schema-checked at the boundary, consistent with the #1325 migration this issue followed from.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] Ensure no double-validation regressions on the already-migrated transition event.

**Verification:**
- [ ] Pre-fix: malformed data reaches the log via legacy path
- [ ] Post-fix: emission boundary rejects schema-invalid data
- [ ] No regression in valid-transition append throughput tests

**Dependencies:** T-02 (schema + emission shape settled first)
**Parallelizable:** No (sequential after T-02)

---

### Task T-04: `check_static_analysis` accepts and resolves an agent-worktree `repoRoot` (#1330)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1330

**TDD Steps:**
1. [RED] Write test: `CheckStaticAnalysis_DiffOnlyInWorktree_RunsTscAgainstWorktree`
   - File: `servers/exarchos-mcp/src/orchestrate/static-analysis.test.ts`
   - Stub `RunCommandFn`; assert that when `repoRoot` points at an agent worktree path (distinct from `process.cwd()`), the runner is invoked with `cwd === <worktreePath>`. Add a case where `repoRoot: 'auto'` resolves to the calling delegation's recorded worktree.
   - Expected failure: `'auto'` is not a recognized value; current code only does `args.repoRoot || process.cwd()`.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Resolve worktree-aware `repoRoot`
   - File: `servers/exarchos-mcp/src/orchestrate/static-analysis.ts` — accept `repoRoot: 'auto'`; resolve it to the agent worktree path read from delegation state (via a passed `worktreePath` arg or a resolver reading the latest `worktree.created` event for the taskId). Keep literal paths and `process.cwd()` fallback behavior intact.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] Extract worktree-path resolution into `gate-utils.ts` if reused by T-06.

**Verification:**
- [ ] Pre-fix: gate runs against cwd regardless of worktree
- [ ] Post-fix: gate runs `tsc` in the agent worktree when directed
- [ ] Default/`process.cwd()` behavior unchanged for non-delegation callers

**Dependencies:** None
**Parallelizable:** Yes (Group B head)

---

### Task T-05: Thread `worktreePath` into the `task-completion` runbook + parity guard (#1330)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1330 (+ INV-2 parity)

**TDD Steps:**
1. [RED] Write test: `TaskCompletionRunbook_StaticAnalysisStep_ReceivesWorktreePath`
   - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts`
   - Assert `TASK_COMPLETION.templateVars` includes `worktreePath`, and the `check_static_analysis` step resolves `repoRoot` from it (not literal `'.'`).
   - Expected failure: `templateVars` is `['taskId','featureId','streamId','branch']`; no worktree path.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Wire the template var
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts` — add `worktreePath` to `TASK_COMPLETION.templateVars`; set the `check_static_analysis` step `params.repoRoot` to the worktree path (or `'auto'`).
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] Add/extend a parity assertion: `StaticAnalysis_CliVsMcp_IdenticalResultForSameRepoRoot`
   - File: `servers/exarchos-mcp/src/orchestrate/static-analysis.parity.test.ts` (create if absent, else extend the nearest `*.parity.test.ts`)
   - INV-2: CLI and MCP facades produce identical `ToolResult` for the same `repoRoot`. MUST STAY GREEN.

**Verification:**
- [ ] Pre-fix: runbook has no worktree path
- [ ] Post-fix: task-completion gate is worktree-aware end-to-end
- [ ] Parity test green (INV-2)

**Dependencies:** T-04
**Parallelizable:** No (sequential after T-04)

---

### Task T-06: New `check_integration_suite` gate counts load-failures as failures (#1329)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1329

**TDD Steps:**
1. [RED] Write test: `CheckIntegrationSuite_FileFailsToLoad_ReturnsFailedAndCountsIt`
   - File: `servers/exarchos-mcp/src/orchestrate/check-integration-suite.test.ts`
   - Stub the test-runner invocation to emit a vitest result where one file fails at import (0 "failed tests", 1 "failed file"). Assert the handler returns `passed: false` and a `loadFailures` count ≥ 1 — the silent-load-failure trap from the issue.
   - Expected failure: handler/action does not exist.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Implement the handler
   - File: `servers/exarchos-mcp/src/orchestrate/check-integration-suite.ts` — run the full suite against the integration tip (`repoRoot` worktree-aware via the T-04 resolver), parse vitest JSON for `numFailedTestSuites`/unhandled-load errors, fold load-failures into `failCount`. Emit `gate.executed` (reuse `emitGateEvent`). Register in the orchestrate composite + `registry.ts`.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] Share worktree-path resolution with T-04 (`gate-utils.ts`).

**Verification:**
- [ ] Pre-fix: no integration full-suite gate exists
- [ ] Post-fix: a load-failure is reported as a failure, not silently 0
- [ ] `gate.executed` event emitted with distinct gate name

**Dependencies:** T-04 (worktree resolver)
**Parallelizable:** No (sequential after T-04; parallel with T-05)

---

### Task T-07: Wire `check_integration_suite` as a post-merge gate in the delegate runbook (#1329)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1329

**TDD Steps:**
1. [RED] Write test: `DelegateRunbook_AfterTaskMerge_RunsIntegrationSuiteGate`
   - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts`
   - Assert the post-merge runbook step sequence includes `check_integration_suite` with `onFail: 'stop'` after `task_complete`/merge, so a broken integration tip blocks the next dispatch.
   - Expected failure: no such step today.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Add the step
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts` — insert `check_integration_suite` into the post-merge/`task-completion` (or merge-orchestrate follow-up) runbook with `onFail: 'stop'`.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] None.

**Verification:**
- [ ] Pre-fix: cumulative regression invisible to gate cycle
- [ ] Post-fix: integration tip is gated between merges
- [ ] `onFail: 'stop'` halts dispatch on cascade

**Dependencies:** T-06
**Parallelizable:** No (sequential after T-06)

---

### Task T-08: Merge-time backstop — detect leaked agent edits in the main worktree (#1301)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** #1301

**TDD Steps:**
1. [RED] Write test: `VerifyWorktreeBaseline_LeakedEditByteIdenticalToCommittedAgentChange_IsDetected`
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree-baseline.test.ts`
   - Simulate the #1301 scenario: a working-tree modification in the main worktree that is byte-identical to a change already committed on the agent branch. Assert the baseline check flags it as a recoverable leak (distinct code/flag) rather than an unrelated dirty tree.
   - Expected failure: current baseline check does not distinguish a leaked-but-committed change from arbitrary dirt.
   - Run: `npm run test:run` — MUST FAIL.
2. [GREEN] Implement detection
   - File: `servers/exarchos-mcp/src/orchestrate/verify-worktree-baseline.ts` — when the main worktree is dirty, compare each modified path's working-tree blob against the corresponding blob on the agent branch tip; if byte-identical, classify as `leaked-committed` and surface a safe-to-discard remediation (`git checkout -- <path>`), matching the documented manual workaround. Do NOT auto-discard silently without the classification.
   - Run: `npm run test:run` — MUST PASS.
3. [REFACTOR] Factor blob-comparison helper; keep INV-15 (no cross-process locking) — this is local git inspection only.

**Verification:**
- [ ] Pre-fix: leaked change indistinguishable from dirt; blocks FF-merge opaquely
- [ ] Post-fix: leak classified and remediation surfaced
- [ ] Unrelated dirty tree still reported as a genuine blocker

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task T-09: Root-cause diagnosis of the working-tree mirroring leak (#1301)

**Phase:** RED → GREEN (or escalate to RC2)
**Test Layer:** integration
**Implements:** #1301

**TDD Steps:**
1. [RED] Write characterization test: `ImplementerDispatch_WorktreeEdit_DoesNotAppearInMainWorktree`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.integration.test.ts` (extend)
   - Assert that the delegation/path-resolution surface owned by the MCP server never resolves an agent file-write to a main-worktree path (the issue's "file-tool path resolution leak" hypothesis #1). `characterizationRequired: true`.
   - Expected failure (or proof): if the leak is in MCP-owned path resolution, the test reproduces it; if it cannot be reproduced from the server side, the test documents that and the root fix is escalated to RC2 as a harness-layer issue.
   - Run: `npm run test:run`.
2. [GREEN] If reproduced: fix the path-resolution site so a `task-isolated` write cannot target outside the worktree (restores INV-11 by-construction). If not reproduced from the server side: record the finding in the issue, keep T-08 as the shipping mitigation, and move the root fix to RC2.
3. [REFACTOR] None.

**Verification:**
- [ ] Leak either reproduced+fixed (INV-11 restored) or proven out-of-server-scope and escalated, with T-08 backstop shipping regardless
- [ ] No regression to worktree provisioning

**Dependencies:** T-08 (backstop must ship even if root fix escalates)
**Parallelizable:** No (sequential after T-08)
**Note:** This is the design's "long pole." It is allowed to slip to RC2 *without* blocking T-01–T-08; the T-08 backstop is the RC1 guarantee.

## Parallelization Strategy

- **Group A (parallel worktrees):** T-01 (SDK pin), T-02 (schema/state-machine). Disjoint files.
- **Group B (sequential chain):** T-04 → T-05 (worktree-aware gate + runbook/parity); T-04 → T-06 → T-07 (integration-suite gate + wiring). T-05 and T-06 are parallel after T-04.
- **Group C (parallel with A/B):** T-08 → T-09 (#1301 backstop then root-cause). T-03 chains after T-02 within Group A.

Dispatch waves:
1. Wave 1: T-01, T-02, T-04, T-08 (all dependency-free).
2. Wave 2: T-03 (after T-02), T-05 + T-06 (after T-04), T-09 (after T-08).
3. Wave 3: T-07 (after T-06).

## Deferred Items

- **#1395** (RC2): event auto-emit migration — investigation-gated, not in this plan. Lands only if the inventory classifies events as cleanly auto-emittable.
- **T-09 root fix** may escalate to RC2 if the mirroring leak proves to be a harness-layer (not MCP-server) concern; T-08 backstop ships in RC1 regardless.
- All v2.11 deferrals per design "Out of scope".

## Completion Checklist
- [ ] All tests written before implementation (Iron Law)
- [ ] All tests pass
- [ ] `npm run typecheck` + full `npm run test:run` green against the integration tip (dogfoods T-06)
- [ ] All `*.parity.test.ts` green (INV-2)
- [ ] No new RC-resetting feature surface introduced
- [ ] Ready for review
