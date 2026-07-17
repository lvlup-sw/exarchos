---
title: v2.10.0-preview.1 — Substrate Stabilization (Implementation Plan)
date: 2026-05-09
design: docs/designs/2026-05-09-v2-10-0-preview-1-substrate-stabilization.md
release-tag: 2.10.0-preview.1
anchor-issue: 1303
pr-split:
  alpha: [1303, 1325]      # event-emission seam
  beta:  [1333, 1334, 1335, 1336, 1324]  # post-cut cleanup
total-tasks: 31
parallelization-summary:
  wave-alpha-parallel-groups: 2  # #1303 chain || #1325 chain
  wave-beta-parallel-groups: 5   # all 5 issues independent
---

# Implementation Plan — v2.10.0-preview.1 Substrate Stabilization

This plan lands as **two PRs** (Wave α, Wave β). Wave α is the substrate-stabilization core (event-emission consistency). Wave β is post-cut cleanup that bundles five issues with no inter-dependencies.

**Iron law:** every production change preceded by a failing test. RED tasks must produce a failing assertion that names the missing behavior; GREEN tasks add the minimum code to flip it green.

## Conventions

- Test names follow `Method_Scenario_Outcome` (e.g. `MergeExecutedAppend_CrashAfterAppendBeforeStateWrite_NoDuplicateEvent`)
- `[RED]` tasks fail when run; `[GREEN]` tasks make the prior `[RED]` test pass; `[REFACTOR]` tasks preserve all green tests
- Tasks reference `servers/exarchos-mcp/src/...` paths unless otherwise noted
- Worktree-isolated dispatch is assumed; each task runs in its own worktree branch off `feature/v2-10-0-preview-1-{alpha|beta}`

---

## Wave α — Event-Emission Consistency (PR α)

**Issues:** #1303, #1325. **Branch:** `feature/v2-10-0-preview-1-alpha`. **Parallelizable groups:** 2 (the #1303 chain and the #1325 chain are independent and can dispatch in parallel; tasks within each chain are mostly sequential).

### Task α-01: Integration test — crash-replay produces no duplicate `merge.executed`

**Phase:** RED

1. Write test: `MergeOrchestrate_CrashAfterMergeExecutedAppendThenResume_AppendsExactlyOneMergeExecutedEvent`
   - File: `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.integration.test.ts` (new file)
   - Setup: spin up SQLite-backed `EventStore`; seed a `merge-pending` workflow state; invoke `merge_orchestrate` with `resume: true`; mock `eventStore.append` to throw *after* writing `merge.executed` but *before* state-file write; invoke again with `resume: true`; assert `eventStore.query(featureId)` returns exactly one event of type `merge.executed`
   - Expected failure: handler at `orchestrate/merge-orchestrate.ts:410` calls `eventStore.append(...)` without `idempotencyKey`, so the second invocation appends a duplicate. The assertion `events.filter(e => e.type === 'merge.executed').length === 1` fails with `2`.

**Dependencies:** None. **Parallelizable:** with α-04 RED.

### Task α-02: Wire `idempotencyKey` + `expectedSequence` into `merge.executed` append

**Phase:** GREEN

1. Modify `orchestrate/merge-orchestrate.ts:410` to:
   - Compute `expectedSequence = await ctx.eventStore.getStreamTailSequence(args.featureId)` before append
   - Compute `idempotencyKey = ${args.featureId}:merge_orchestrate:${args.taskId}:merge.executed`
   - Use `buildValidatedEvent(args.featureId, expectedSequence, { type: 'merge.executed', data: {...} })` and `appendValidated` with the key
2. Reuse the prefix-building idiom from `next-actions-computer.ts:118` — extract a shared helper if duplicating across α-02/α-04/α-05

**Dependencies:** α-01. **Parallelizable:** No.

### Task α-03: Race test extension — concurrent invocations on same stream

**Phase:** RED

1. Write test: `MergeOrchestrate_TwoConcurrentInvocationsSameStream_NoDuplicateSequences`
   - File: extend `servers/exarchos-mcp/src/event-store/store.race.test.ts`
   - Setup: launch two `merge_orchestrate` invocations in parallel against the same `featureId` + `taskId`; wait for both to settle; assert `eventStore.query(featureId)` has no duplicate `(stream_id, sequence)` rows AND exactly one `merge.executed`
   - Expected failure: without `expectedSequence` enforcement, both invocations race past the read-tail step and both append at the same sequence, hitting the SQLite `PRIMARY KEY (stream_id, sequence)` constraint. The test asserts the failure is *handled* (one wins, one re-tries or surfaces a typed conflict error) — bare conflict throw fails the assertion.

**Dependencies:** α-02 (test needs the wired path to expose the conflict). **Parallelizable:** No.

### Task α-04: Wire `idempotencyKey` + `expectedSequence` into `execute-merge.ts:306`

**Phase:** GREEN

1. Modify `orchestrate/execute-merge.ts:306` (the `merge.preflight` append) using the same shape as α-02
2. Use `idempotencyKey = ${args.featureId}:merge_orchestrate:${args.taskId}:merge.preflight`

**Dependencies:** α-03. **Parallelizable:** with α-05.

### Task α-05: Wire `idempotencyKey` + `expectedSequence` into `execute-merge.ts:321`

**Phase:** GREEN

1. Modify `orchestrate/execute-merge.ts:321` (the `merge.recovered` append) using the same shape
2. `idempotencyKey = ${args.featureId}:merge_orchestrate:${args.taskId}:merge.recovered`

**Dependencies:** α-03. **Parallelizable:** with α-04.

### Task α-06: Refactor — extract shared idempotency-key builder

**Phase:** REFACTOR

1. If α-02/α-04/α-05 duplicated the `${streamId}:merge_orchestrate:${taskId}:${eventType}` template more than twice, extract `buildMergeOrchestrateIdempotencyKey(streamId, taskId, eventType)` into `orchestrate/merge-keys.ts` (new file)
2. Reuse the prefix builder logic from `next-actions-computer.ts:118` — confirm it's the same shape; consolidate
3. All α-01..α-05 tests remain green

**Dependencies:** α-04, α-05. **Parallelizable:** No.

---

### Task α-07: Property test — every event in `workflow/cancel.ts` uses canonical envelope

**Phase:** RED

1. Write test: `WorkflowCancel_AllEmittedEvents_HaveCanonicalEnvelope`
   - File: `servers/exarchos-mcp/src/workflow/cancel.envelope.test.ts` (new file)
   - For each of the 6 emission paths in `cancel.ts` (lines 131, 151, 190, 202, 225, 236), exercise the path and assert each emitted event has non-empty `correlationId`, registered `source`, and matches the per-event-type data schema
   - Expected failure: 6 sites today bypass `buildValidatedEvent`; events emitted lack `correlationId` / `source` fields — assertion fails

**Dependencies:** None. **Parallelizable:** with α-01.

### Task α-08: Migrate 6 sites in `workflow/cancel.ts` to canonical helper

**Phase:** GREEN

1. For each of lines 131, 151, 190, 202, 225, 236, replace `eventStore.append(featureId, {type, data})` with:
   ```ts
   const event = buildValidatedEvent(featureId, currentSequence, { type, data });
   await eventStore.appendValidated(featureId, event);
   ```
2. Thread `correlationId` from the surrounding handler context where available; if a site has no clear correlation source, file as a sub-issue and keep the site on the raw path (do **not** invent a correlation ID)

**Dependencies:** α-07. **Parallelizable:** with α-10 / α-12 / α-14.

### Task α-09: Property test — `workflow/hsm-transition-guard.ts`

**Phase:** RED

1. Write test: `HsmTransitionGuard_AllEmittedEvents_HaveCanonicalEnvelope`
   - File: `servers/exarchos-mcp/src/workflow/hsm-transition-guard.envelope.test.ts` (new file)
   - Exercise each of the 3 paths at lines 293, 357, 429
   - Expected failure: same shape as α-07

**Dependencies:** None. **Parallelizable:** with α-07.

### Task α-10: Migrate 3 sites in `workflow/hsm-transition-guard.ts`

**Phase:** GREEN

1. Same migration shape as α-08, applied to lines 293, 357, 429

**Dependencies:** α-09. **Parallelizable:** with α-08 / α-12 / α-14.

### Task α-11: Property test — `workflow/rehydrate.ts`

**Phase:** RED

1. Write test: `WorkflowRehydrate_AllEmittedEvents_HaveCanonicalEnvelope`
   - File: `servers/exarchos-mcp/src/workflow/rehydrate.envelope.test.ts` (new file)
   - Exercise each of the 2 paths at lines 231, 577

**Dependencies:** None. **Parallelizable:** with α-07.

### Task α-12: Migrate 2 sites in `workflow/rehydrate.ts`

**Phase:** GREEN

1. Same migration shape, applied to lines 231, 577

**Dependencies:** α-11. **Parallelizable:** with α-08 / α-10 / α-14.

### Task α-13: Property test — `workflow/tools.ts`

**Phase:** RED

1. Write test: `WorkflowTools_AllEmittedEvents_HaveCanonicalEnvelope`
   - File: `servers/exarchos-mcp/src/workflow/tools.envelope.test.ts` (new file)
   - Exercise each of the 7 paths at lines 159, 474, 489, 720, 787, 1191, 1321

**Dependencies:** None. **Parallelizable:** with α-07.

### Task α-14: Migrate 7 sites in `workflow/tools.ts`

**Phase:** GREEN

1. Same migration shape, applied to lines 159, 474, 489, 720, 787, 1191, 1321

**Dependencies:** α-13. **Parallelizable:** with α-08 / α-10 / α-12.

### Task α-15: Refactor — consolidate envelope-property-test fixture

**Phase:** REFACTOR

1. If α-07 / α-09 / α-11 / α-13 duplicate the assertion shape, extract `assertCanonicalEnvelope(events)` into `workflow/test-helpers/canonical-envelope.ts`
2. All α-07..α-14 tests remain green

**Dependencies:** α-08, α-10, α-12, α-14. **Parallelizable:** No.

---

## Wave β — Post-Cut Cleanup (PR β)

**Issues:** #1333, #1334, #1335, #1336, #1324. **Branch:** `feature/v2-10-0-preview-1-beta`. **Parallelizable groups:** 5 (every issue is independent of every other).

### Task β-01: Posture-mapping coverage test for IMPLEMENTER agent

**Phase:** RED

1. Write test: `ResolveCapabilities_ImplementerSpec_ProducesSameSetAsLegacyArray`
   - File: extend `servers/exarchos-mcp/src/capabilities/posture-mapping.test.ts`
   - For each agent literal in `agents/definitions.ts` (IMPLEMENTER at line 141, FIXER at 217, REVIEWER at 303, SCAFFOLDER at 360), assert `resolveCapabilities(literal.posture, literal.id)` returns a Set deeply equal to `new Set(literal.capabilities)`
   - Expected failure: posture-mapping.ts today doesn't cover the long-tail (`mcp:exarchos`, `session:resume`, `tool:Read`, `tool:Write`, etc.) — set difference is non-empty

**Dependencies:** None. **Parallelizable:** with β-04 / β-07 / β-09 / β-12.

### Task β-02: Extend posture-mapping to cover long-tail capabilities

**Phase:** GREEN

1. Update `capabilities/posture-mapping.ts` so the mapping covers every capability declared in any of the 4+ agent literals
2. If a capability surfaces that no posture cleanly implies, **abort to Option 2 path** (per design): file follow-up issue, downscope the offending agent (skip the legacy-array removal for that one agent), and document in the PR body. Do **not** invent a synthetic posture.

**Dependencies:** β-01. **Parallelizable:** No.

### Task β-03: Drop `capabilities` field from `AgentSpec` interface

**Phase:** GREEN

1. Modify `servers/exarchos-mcp/src/agents/types.ts:42` — remove `readonly capabilities: readonly Capability[]`
2. Remove the `capabilities: [...]` literal arrays from `agents/definitions.ts` for every agent that β-02 covered
3. Update each adapter (`adapters/{codex,cursor,opencode,copilot,claude}.ts`) to call `resolveCapabilities(spec.posture, spec.id)` instead of reading `spec.capabilities`

**Dependencies:** β-02. **Parallelizable:** No.

### Task β-04: Adapter consumes resolver — test

**Phase:** RED

1. Write test: `Adapter_RendersAgentSpec_CallsResolveCapabilitiesNotSpecField`
   - File: extend `servers/exarchos-mcp/src/agents/adapters/codex.test.ts` (and parallel `cursor.test.ts`, etc.)
   - Spy on `resolveCapabilities`; render the IMPLEMENTER spec; assert spy called with `(spec.posture, spec.id)`
   - Expected failure: adapter today reads `spec.capabilities` directly without invoking the resolver

**Dependencies:** None. **Parallelizable:** with β-01.

### Task β-05: Refactor — adapter cleanup

**Phase:** REFACTOR

1. After β-03, walk the 5 adapters; ensure each renders capabilities through the resolver consistently
2. Delete any `Capability` import sites in `definitions.ts` that are now unused (DIM-5 hygiene)
3. β-01 + β-04 tests remain green

**Dependencies:** β-03, β-04. **Parallelizable:** No.

---

### Task β-06: Topology-threading test for `selectPruneCandidates`

**Phase:** RED

1. Write test: `SelectPruneCandidates_WithTopologyArgument_ReturnsCandidatesScoredByPhaseContract`
   - File: extend `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.test.ts`
   - Construct a `Topology` fixture with one phase declaring a `staleness` block; pass to `selectPruneCandidates`; assert candidate selection matches `scoreEntryThroughTopology` output, not the legacy `phaseStale && (lastActivityStale || branchInactive)` heuristic
   - Expected failure: `selectPruneCandidates` doesn't accept a topology arg today — TS compile error or runtime arity mismatch

**Dependencies:** None. **Parallelizable:** with β-01 / β-04 / β-09 / β-12.

### Task β-07: Thread `Topology` through `selectPruneCandidates`

**Phase:** GREEN

1. Modify `orchestrate/prune-stale-workflows.ts` — update `selectPruneCandidates` signature to accept `topology: Topology`; replace the heuristic block at lines 222–249 with a call to `scoreEntryThroughTopology(entry, topology, now)` from `pruner/score.ts`
2. Update the orchestrate handler to thread the topology from `DispatchContext`

**Dependencies:** β-06. **Parallelizable:** No.

### Task β-08: CLI fast-exit path — skip pruning with logged reason

**Phase:** RED → GREEN

1. [RED] Write test: `PruneStaleWorkflows_TopologyNotLoaded_SkipsPruningWithLoggedReason`
   - File: extend `prune-stale-workflows.test.ts`
   - Mock `getTopology()` to throw "load before"; invoke handler; assert response is structured `{ aborted: true, reason: 'topology_not_loaded' }` AND `orchestrateLogger.warn` was called with the same reason
2. [GREEN] In handler: catch the topology-not-loaded throw, return the skip envelope, emit the warn log
3. Confirm β-06 still passes (the topology-loaded path is unchanged)

**Dependencies:** β-07. **Parallelizable:** No.

### Task β-09: Refactor — delete vestigial heuristic block

**Phase:** REFACTOR

1. Confirm `prune-stale-workflows.ts:222–249` heuristic is fully unreferenced after β-07
2. Delete the dead block; ensure no comments-out-the-old-code residue (DIM-5 hygiene)
3. β-06, β-08 remain green

**Dependencies:** β-08. **Parallelizable:** with β-12 / β-14.

---

### Task β-10: Comment-scrub test for `lifecycle.ts` + `subagent-context.ts`

**Phase:** RED

1. Write test: `StorageLifecycle_NoStaleJsonlReferences_GrepReturnsZeroMatches`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.no-jsonl-comments.test.ts` (new file)
   - Read both files via `readFile`; grep for `/jsonl|JSONL/i`; assert match count is 0
   - Expected failure: 6 stale "Pre-v2.11" doc-comment lines remain (verified during design recon)

**Dependencies:** None. **Parallelizable:** with β-01 / β-04 / β-06 / β-13.

### Task β-11: Scrub stale JSONL comments

**Phase:** GREEN

1. Delete the 6 stale "Pre-v2.11" prose lines in `storage/lifecycle.ts:67,178,190,191` and `cli-commands/subagent-context.ts:144,145`
2. If any line carries genuinely useful historical context, preserve as a `git log`-style breadcrumb in the design doc rather than inline (DIM-8)

**Dependencies:** β-10. **Parallelizable:** No.

### Task β-12: Refactor — confirm no live JSONL reader paths

**Phase:** REFACTOR

1. Run `rg -n 'readFile.*jsonl|fs.*jsonl|readJsonl' servers/exarchos-mcp/src` — assert zero matches
2. β-10 remains green

**Dependencies:** β-11. **Parallelizable:** with β-09 / β-14.

---

### Task β-13: Vestigial-`emit`-field test for `LoadTopologyOptions`

**Phase:** RED

1. Write test: `LoadTopologyOptions_NoEmitField_GrepReturnsZeroMatches`
   - File: `servers/exarchos-mcp/src/topology/loader.no-emit-option.test.ts` (new file)
   - Read `topology/loader.ts`; grep for `/emit\??:/`; assert match count is 0
   - Expected failure: vestigial `emit?:` field remains on `LoadTopologyOptions` (verified during design recon — JSDoc explicitly flags this as removable dead-code)

**Dependencies:** None. **Parallelizable:** with β-01 / β-04 / β-06 / β-10.

### Task β-14: Drop `emit` field from `LoadTopologyOptions`

**Phase:** GREEN

1. Remove the `emit?: …` field from the `LoadTopologyOptions` interface in `topology/loader.ts`
2. Remove the JSDoc paragraph that flags it as dead-code (lines ~17–22 of loader.ts)
3. Walk callers via `rg -n 'loadTopology' servers/exarchos-mcp/src` — none currently pass `emit`, but verify
4. β-13 passes; existing `loader.test.ts` + `loader.dr7-removal.test.ts` remain green

**Dependencies:** β-13. **Parallelizable:** with β-09 / β-12.

---

### Task β-15: In-process refactor of `cli-concurrency.test.ts`

**Phase:** REFACTOR-FIRST (test-only file; no production code change)

1. Refactor `event-store/cli-concurrency.test.ts:ConcurrentCliEventAppend_SameFeatureId_ProducesConsistentStore` to use an in-process `EventStore` (shared instance across "concurrent" appends modeled via `Promise.all` on direct `appendValidated` calls), eliminating the subprocess spawn
2. Remove the `it.skip` marker added in #1323
3. Test must continue to assert the *original property* (concurrent appends produce a consistent stream), not a weakened version. If the in-process model can't reproduce a coverage-relevant property of the subprocess version, **stop and file a follow-up** — don't ship a green-but-weakened test.

**Dependencies:** None. **Parallelizable:** with β-16.

### Task β-16: In-process refactor of doctor-workflow integration tests

**Phase:** REFACTOR-FIRST (test-only file)

1. Refactor `__tests__/integration/doctor-workflow.test.ts:Doctor_FreshProjectWithNoClaudeConfig_ReturnsExpectedShape` to invoke the doctor handler in-process
2. Same for `Doctor_ProjectWithClaudeJsonAndExarchosMcp_ReturnsMostlyPass`
3. Remove both `it.skip` markers
4. Assert original property preserved; if not, file follow-up rather than weakening

**Dependencies:** None. **Parallelizable:** with β-15.

---

## Cross-wave finalization

### Task FIN-01: Version bump to `2.10.0-preview.1`

**Phase:** GREEN (manifest edit only)

1. Update `package.json`, `servers/exarchos-mcp/package.json`, `.claude-plugin/plugin.json`, and any other manifest tracked by `scripts/sync-versions.sh`
2. Run `bash scripts/sync-versions.sh --check` — must report `All versions in sync: 2.10.0-preview.1`
3. Update CHANGELOG with the `[2.10.0-preview.1] - 2026-05-XX` entry (release-notes shape from design §"Release notes shape")

**Dependencies:** All Wave α + Wave β tasks merged to `feature/v2-10-0-preview-1` integration branch. **Parallelizable:** No.

### Task FIN-02: Preflight gate

**Phase:** Gate (no production change)

1. `npm run typecheck` — green
2. `cd servers/exarchos-mcp && npm run test:run` — green
3. `npm run skills:guard` — green
4. `bash scripts/sync-versions.sh --check` — green
5. Manual: confirm zero new `.skip` markers; confirm 3 `.skip`s from #1323 removed

**Dependencies:** FIN-01. **Parallelizable:** No.

---

## Parallelization Summary

**Wave α** (PR α — 15 tasks):

| Group | Tasks | Notes |
|---|---|---|
| α-1303 chain | α-01 → α-02 → α-03 → α-04 ‖ α-05 → α-06 | α-04 ‖ α-05 parallel |
| α-1325 chain | α-07 ‖ α-09 ‖ α-11 ‖ α-13 (RED, parallel) → α-08 ‖ α-10 ‖ α-12 ‖ α-14 (GREEN, parallel) → α-15 | All four file migrations parallel after their RED-tests |

Wave α dispatches as **2 top-level parallel groups** (1303 chain || 1325 chain). Within the 1325 chain, 4 file migrations dispatch as a parallel sub-wave.

**Wave β** (PR β — 16 tasks, 5 issues):

| Group | Tasks | Issue |
|---|---|---|
| β-1333 | β-01 → β-02 → β-03 ‖ β-04 → β-05 | #1333 |
| β-1334 | β-06 → β-07 → β-08 → β-09 | #1334 |
| β-1335 | β-10 → β-11 → β-12 | #1335 |
| β-1336 | β-13 → β-14 | #1336 |
| β-1324 | β-15 ‖ β-16 | #1324 |

Wave β dispatches as **5 top-level parallel groups** (one per issue). β-15 and β-16 within #1324 are also parallel.

**FIN tasks** are sequential and run only after both waves merge to the integration branch.

---

## Risk Anchors

| Risk (from design) | Surfaced by task | Mitigation in plan |
|---|---|---|
| α-01 crash-replay test depends on subprocess test infra | α-01 | Plan does **not** require subprocess; uses in-process mock-throw on `eventStore.append` to simulate crash. Independent of #1324. |
| β-02 posture mapping forces Option-2 escape hatch | β-02 | Abort condition documented in task body — file follow-up + downscope, do not invent posture. |
| β-08 CLI fast-exit path lacks loaded topology | β-08 | Plan picks "skip with logged reason" over fixture-everywhere. Reversible. |
| α-08/α-10/α-12/α-14 some sites lack correlation context | each migration task | Per-site abort: file sub-issue, keep raw path, document in PR. |
| β-15/β-16 in-process refactor weakens coverage | β-15, β-16 | "Stop and file follow-up" stated as the abort condition — do not ship a green-but-weakened test. |

---

## Definition of Done

- All 31 tasks GREEN
- FIN-02 preflight gate green
- Two PRs (α + β) opened against `main`, both with required `## Summary / ## Changes / ## Test Plan` sections
- CHANGELOG entry merged
- Tag `2.10.0-preview.1` pushed after both PRs merge

