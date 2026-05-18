# Implementation Plan — v2.10.0-preview.4 substrate hygiene bundle

> **Design:** `docs/designs/2026-05-17-preview-4-substrate-hygiene.md`
> **Date:** 2026-05-17
> **Integration branch:** `feature/preview-4-substrate-hygiene`
> **Closes:** #1446 (residue), #1434, #1448 (hygiene), #1438 F-4..F-8
> **Iron Law:** No production code without a failing test first.

---

## Wave map

| Wave | Tasks | Parallelizable | Notes |
|---|---|---|---|
| **V** (views layer) | T1, T2, T3 | T1 ∥ T2 (different files); T3 last | Wave V is parallel-safe with Wave T |
| **T** (task-store) | T4, T5, T6, T7, T8 | T4 ∥ T5 ∥ T6 ∥ T7; T8 depends on T7 | Five tasks, only T8→T7 has a hard edge |

Branch convention: each task lands on `task/<feature>-<id>` and merges into `feature/preview-4-substrate-hygiene`. Final integration → one PR to `main`.

---

## Wave V — Views layer

### Task T1: Register 3 unregistered view actions in `TOOL_REGISTRY`

**Closes:** #1446 residue
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write three tests pinning the full DR-5 acceptance:
   - Test A — `TOOL_REGISTRY_viewActions_IncludesSessionProvenanceProvenanceAndIdeateReadiness`
     - File: `servers/exarchos-mcp/src/registry.test.ts` (extend existing suite)
     - Asserts: `TOOL_REGISTRY.exarchos_view.actions.find(a => a.name === 'session_provenance')` is defined, schema is `z.object`, and `provenance` + `ideate_readiness` likewise. For each, where the underlying handler queries the event store, asserts `CORRELATION_TUPLE_FILTER_SHAPE` keys (`operationId`, `correlationId`, `causationId`) are present in the action's schema shape.
   - Test B — `ExarchosViewDescribe_ListsAllSeventeenDispatchedActions`
     - File: `servers/exarchos-mcp/src/views/composite.envelope.test.ts` (extend) or new `describe.coverage.test.ts`
     - Asserts: invoking `exarchos_view {action: 'describe'}` returns an action list whose `name` set is a superset of all 17 dispatched action names (collected from `composite.ts` switch cases excluding `describe`). Pins the registry-vs-dispatch parity contract.
   - Test C — `ExarchosViewDispatch_OnInvalidArgsForNewlyRegisteredAction_ReturnsZodValidationError`
     - File: `servers/exarchos-mcp/src/core/dispatch.test.ts` (extend) or co-located
     - Asserts: dispatching `session_provenance` (and `provenance`, `ideate_readiness`) with a Zod-invalid arg shape returns a structured validation error envelope — same path that fired for Wave 5 actions post-#1437.
   - Expected failure: today all three actions are absent from `viewActions`, so describe under-lists them and dispatch's per-action Zod validation at `core/dispatch.ts:801` silently skips.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/registry.ts`
   - Add 3 entries to `viewActions: readonly ToolAction[]`, mirroring the Wave 5 pattern from `eval_results` / `quality_correlation` / `quality_attribution`. Each entry: `name`, `description`, `schema` (derived from composite handler signature in `views/composite.ts`), `phases`, `roles`, `outputSchema: EnvelopeSchema(z.unknown())`, `annotations: READ_ONLY_LOCAL`. Include `CORRELATION_TUPLE_FILTER_SHAPE` where the underlying view queries the event store.

3. **[REFACTOR]** None expected; the existing pattern is the target shape.

**Dependencies:** None
**Parallelizable:** Yes (with T2..T7)

---

### Task T2: Skip `__`-prefixed sentinel streams in `ViewMaterializer`

**Closes:** #1434
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ViewMaterializer_IteratesStreams_SkipsDunderPrefixedSentinels`
   - File: `servers/exarchos-mcp/src/views/materializer.test.ts` (extend) or new `materializer.sentinel-skip.test.ts`
   - Setup: event store seeded with two streams — `my-feature` (user-facing) and `__migration__` (sentinel). Call the materializer's stream iteration path (whichever method drives `pipeline` view aggregation).
   - Asserts: `my-feature` is materialized; `__migration__` is NOT passed to `SnapshotStore.getSnapshotPath`; no `Invalid streamId` error thrown.
   - Companion integration test: `ExarchosView_Pipeline_DoesNotCrashOnMigrationStream` — drives through `exarchos_view {action: 'pipeline'}` end-to-end with a `__migration__` stream present; asserts envelope success.
   - Expected failure: today the validator throws; today's pipeline view crashes.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/views/materializer.ts`
   - At the stream-iteration site, add a `if (streamId.startsWith('__')) continue;` (or equivalent filter). Add a `logger.debug({ streamId }, 'ViewMaterializer: skipping sentinel stream')` so operators can see it.

3. **[REFACTOR]** Extract to a named predicate if used in multiple sites: `const isInternalSentinelStream = (id: string) => id.startsWith('__')`.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T3: Hygiene close `#1448`

**Closes:** #1448 (issue closure only — no code)
**Phase:** No-code task; ordering only

1. **[VERIFY]** Confirm items 2–5 landed via PR #1449 by running `git log --oneline --all -- servers/exarchos-mcp/src/views/tools.ts | grep '#1448'`. Expect commits `5c3c1826`, `cc9343e3`, `c69ad5c0`, `1ccc41f1`, and `3288cf7d`.
2. **[ACT]** Post resolution comment on #1448: "Items 2–5 landed via PR #1449 (merged 2026-05-17). Item 1 (#1446) tracked separately; residue closed in this bundle." Close issue.
3. **[ACT]** Update epic #1441 checklist to reflect #1446 + #1434 + #1448 closure once the bundle PR merges.

**Dependencies:** Bundle PR merge (T3 fires post-merge, not in the PR itself)
**Parallelizable:** n/a (no code)

---

## Wave T — Task-store layer

### Task T4: Size-cap reap on `createTask`

**Closes:** #1438 F-4
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CreateTask_WhenMapExceeds1024Entries_TriggersExpiredReap`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: create 1024 tasks with TTLs that have already expired (mock clock or short TTL + advance). Then call `createTask` once more. Assert: `this.tasks.size` post-call ≤ 1024 (the new task plus survivors), expired entries gone.
   - Companion test: `CreateTask_WhenMapUnder1024_DoesNotReap` — assert no reap activity for sizes ≤ 1024 (asserts via a spy on the reap method).
   - Expected failure: today `createTask` never calls `reapExpired`; map grows unbounded.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - In `createTask`, after the `task.created` event append, add: `if (this.tasks.size > 1024) this.reapExpired();`
   - Optional: extract `1024` to a `SIZE_CAP_REAP_THRESHOLD` const at module top.

3. **[REFACTOR]** None expected.

**Dependencies:** None
**Parallelizable:** Yes (with T5, T6, T7)

---

### Task T5: Coerce-and-warn on `projectTask` malformed `request`

**Closes:** #1438 F-7
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ProjectTask_WhenRequestPayloadMalformed_LogsWarnWithStreamIdAndSequence`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: seed `task.created` event whose `request` field is `null` / missing / non-object. Replay via the projection.
   - Asserts: `logger.warn` called once with payload containing `streamId` and event `sequence`; projection still returns a coerced Task (tolerate-and-flag).
   - Expected failure: today the coerce is silent.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - At `projectTask:455` (the `createdData['request'] ?? {}`): branch on whether `createdData['request']` is missing or non-object; if so, call `logger.warn({ streamId, sequence: event.sequence, requestType: typeof createdData['request'] }, 'projectTask: coerced malformed request payload')`. Behavior unchanged on the happy path.

3. **[REFACTOR]** If similar coerce sites exist for other fields, file a follow-up but do not expand scope here.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T6: Persist `requestId` on `task.created` event payload

**Closes:** #1438 F-8
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CreateTask_AppendsTaskCreatedEvent_IncludesRequestIdInPayload`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: call `createTask({ ..., requestId: 'req-abc' })`. Inspect the appended `task.created` event payload.
   - Asserts: `event.data.requestId === 'req-abc'`. Companion test: `ProjectTask_ReplaysTaskCreated_WithoutRequestIdField_FallsBackToSyntheticReplayedPrefix` — replay an old-shape event lacking `requestId`; assert projection returns `requestId: 'replayed:${taskId}'`.
   - Expected failure: today `requestId` is not written to event payload.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - At the `task.created` emission site in `createTask`, add `requestId` to the event `data` object. Update the typed payload schema (if `task.created` has a Zod schema in `events/` or similar — verify location during implementation).
   - In `projectTask`, read `createdData['requestId']` first; fall back to `replayed:${taskId}` if missing.

3. **[REFACTOR]** None expected.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T7: Stable cursor — sort `listTasks` by `(createdAt ASC, taskId ASC)`

**Closes:** #1438 F-5 (cursor half of the cursor + hydration co-design)
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `ListTasks_AcrossSimulatedRestart_PaginatesStablyWithCursor`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: seed N=20 `task.created` events with deterministic but **unsorted** insertion order (e.g., createdAt timestamps interleaved). Create instance A, page through with `limit=5`, capture cursors per page. Destroy instance A. Create instance B against the same event store. Page through with the same cursors.
   - Asserts: instance B returns the same task order as instance A. Tasks across all pages are unique and totalled to N.
   - Companion test: `ListTasks_TieBreakOnIdenticalCreatedAt_OrdersByTaskIdAsc` — two `task.created` events with identical timestamps; assert `taskId` ASC ordering.
   - Expected failure: today sort is Map insertion order → instance B sees a different sequence.

2. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - In `listTasks`, after hydration: `Array.from(this.tasks.values()).sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)`.
   - Cursor encoding: `base64url(JSON.stringify({ createdAt, taskId }))` for the last task in the page.
   - Cursor decode + offset: skip past tasks `<=` the cursor (lexicographic on `(createdAt, taskId)` tuple).

3. **[REFACTOR]** Extract cursor encode/decode helpers if useful; document the cursor shape in a top-of-file comment.

**Dependencies:** None
**Parallelizable:** Yes (with T1..T6); T8 depends on T7

---

### Task T8: Cursor-anchored incremental hydration

**Closes:** #1438 F-6 (hydration half of the cursor + hydration co-design)
**Phase:** PRECHECK → RED → GREEN → REFACTOR

1. **[PRECHECK]** Verify `EventStore.queryEvents` supports `(streamPrefix, eventType, createdAtFrom, limit)` filter triple.
   - File: read `servers/exarchos-mcp/src/event-store/store.ts` + `storage/sqlite-backend.ts` `queryEvents` signature.
   - On match: proceed.
   - On miss: file a 1-line issue for the minimal extension; T8 falls back to "query all + post-filter" for cold-start only (degrades to today's behavior on the slow path). Document chosen path in the PR.

2. **[RED]** Write test: `ListTasks_OnColdStartWithLimit10_QueriesOnePageOfStreams`
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.test.ts`
   - Setup: seed 100 `task.created` events. Wrap `EventStore.queryEvents` with a counter. Cold-start instance and call `listTasks({ limit: 10 })`.
   - Asserts: counter ≤ `limit + lookahead` (i.e., ≤ 18 with lookahead=8); not 100.
   - Companion test: `ListTasks_OnWarmCallAfterColdHydration_DoesNotReQueryAlreadyHydratedTasks` — call `listTasks` twice; second call queries only for newly-created tasks since the first.
   - Expected failure: today `hydrateFromEventStore` enumerates all streams.

3. **[GREEN]** Implement
   - File: `servers/exarchos-mcp/src/task-store/event-sourced-task-store.ts`
   - Replace `hydrateFromEventStore`'s full enumeration with: query `task.created` events with `(streamPrefix='task-store/', eventType='task.created', createdAtFrom=cursor.createdAt OR undefined, limit=limit+lookahead)`. For each event in result, hydrate the per-task projection if `this.tasks` doesn't already have it. Skip cached.
   - Set `lookahead = 8` as a module-level const.

4. **[REFACTOR]** Document the lookahead choice + tie-break interaction in a top-of-file comment.

**Dependencies:** T7 (cursor sort + encoding)
**Parallelizable:** No (sequential after T7)

---

## Pre-PR gates

Before opening the integration PR:

- [ ] `cd servers/exarchos-mcp && npm run test:run` — full suite passes
- [ ] `npm run typecheck` — clean (root + servers/exarchos-mcp)
- [ ] `npm run build` — clean
- [ ] Manual smoke: `exarchos_view {action: 'pipeline'}` on a repo with `__migration__` stream
- [ ] Manual smoke: `exarchos_view {action: 'session_provenance'}` invokes Zod-validated dispatch
- [ ] Benchmark: `listTasks` cold-start query count for 100 seeded tasks (counter assertion, see T8)

## Out of scope

- T17 `next_actions` real-handler integration (closed via #1449)
- Cross-tier correlation propagation (basileus / remote MCP — INV-3, v3+)
- Filter-aware materializer cache keying (rejected in #1447 design)
- Reopening F-1/F-2/F-3 (#1443/#1444/#1445)
- #1395 auto-emit audit; #1370 + #1439 invariant audit — separate bundles

## Risks (carried from design)

- F-7 coerce-warn noise — mitigation: streamId in log payload
- F-6 lookahead under-shoot — mitigation: lookahead configurable; test asserts 8 sufficient
- T2 sentinel hides legit `__`-prefixed stream — mitigation: debug log on skip
- T8 queryEvents surface — mitigation: PRECHECK + fallback path

## References

- Design: `docs/designs/2026-05-17-preview-4-substrate-hygiene.md`
- Epic: #1441
- TaskStore audit: `docs/research/2026-05-16-event-sourced-task-store-audit.md`
