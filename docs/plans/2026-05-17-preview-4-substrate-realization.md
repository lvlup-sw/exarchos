# Implementation Plan — Preview.4 Substrate Realization

> **Design:** `docs/designs/2026-05-17-preview-4-substrate-realization.md`
> **Closes:** #1436 + #1440 (Op 1 + Op 2 + Op 4)
> **Defers:** #1440 Op 3 (workflow verb wiring), Op 5 (SSE)
> **Iron law:** No production code without a failing test first.

## Task overview

12 tasks, organized into 2 waves with 4 parallel streams.

**Wave 0 — Prereqs (sequential, foundation).** Quick prerequisites that unblock parallel work. Two tasks: idempotency audit (T1) and `DispatchHints` interface (T2). T2 blocks T7, T9, T10.

**Wave 1 — Parallel streams.**
- Stream A — Elicitation E2E (#1436): T3, T4, T5, T6.
- Stream B — `--follow` expansion (#1440 Op 1): T7.
- Stream C — Op 2 describe + annotations (#1440 Op 2): T8, T9.
- Stream D — Op 4 hint (#1440 Op 4): T10, T11, T12.

**PR boundary.** Two PRs:
- **PR-A** — Stream A only (#1436). Smaller, focused, ships first.
- **PR-B** — Streams B + C + D (#1440 Op 1+2+4 bundle).

## Task list

### Task 1: Audit handler idempotency for new `--follow` view actions

**Phase:** [Audit only — no test or code change]

Verify that `view pipeline`, `view convergence`, `view delegation_timeline` handlers are **read-only on repeated polls** — no `*.polled` event emission, no state writes, no race-prone cache invalidation. Document findings in a short audit note appended to the PR-B description (or inline in a code comment on `cli.ts`'s `VIEW_FOLLOW_ACTIONS` set).

For each handler:

1. Read the handler entry point (`servers/exarchos-mcp/src/views/pipeline-view.ts`, `convergence-view.ts`, `delegation-timeline-view.ts` if exists, or wherever each routes).
2. Grep for `eventStore.append`, `emit`, `mutate`, `cache.set`, or any write surface.
3. If any handler emits a `*.polled` event, the FINDING-3 throttle pattern (already shipped for `task.polled`) must be retrofitted BEFORE landing follow support — file a follow-up issue and pull this handler out of the bundle.

**Deliverable:** audit note attached to PR-B describing each handler's idempotency status. If all three are clean, the predicate refactor (T7) proceeds. If any are dirty, T7 ships with the dirty handlers removed from the set.

**Dependencies:** None.
**Parallelizable:** Yes (Wave 0).
**Branch:** `feat/preview-4-realization-audit` (or merged inline with T7's branch).

---

### Task 2: Add `DispatchHints` interface to `ToolAction`

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Add test in `servers/exarchos-mcp/src/registry.test.ts`:
   - `ToolAction_DispatchHintsShape_OptionalTaskSuitableField` — assert an action descriptor with `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60000 }` satisfies the `ToolAction` type and is preserved on the registry export.
   - Expected failure: `dispatch` is not a known field on `ToolAction`; TypeScript compile error.

2. **[GREEN]** Add `DispatchHints` interface and `dispatch?: DispatchHints` field to `ToolAction` in `servers/exarchos-mcp/src/registry.ts`:
   - `DispatchHints` has `taskSuitable?: boolean` and `taskTtlSuggestionMs?: number`.
   - Place adjacent to `CliActionHints` for visual grouping.
   - Field is optional; no existing actions need annotation yet.

3. **[REFACTOR]** Add a JSDoc block citing the design's INV-2 rationale (why `dispatch.`, not `cli.`).

**Dependencies:** None.
**Parallelizable:** Yes (Wave 0). **Blocks:** T7 (predicate refactor doesn't use it but field convention should land first), T9 (annotations), T10 (hint reads `taskSuitable`).
**Branch:** `feat/preview-4-realization-dispatch-hints` (merged into PR-B base branch).

---

### Task 3: Elicitation E2E test harness — InMemoryTransport fixture

**Phase:** [GREEN — fixture setup]

Build the shared test infrastructure for #1436. Not a test itself — a helper that T4/T5/T6 consume.

1. **[GREEN]** Create `servers/exarchos-mcp/src/__tests__/integration/elicitation-roundtrip.fixture.ts`:
   - Export `createElicitationTestPair({ clientCapabilities, elicitInputHandler })` returning `{ client, server, eventStore, cleanup }`.
   - Wire `InMemoryTransport` (pattern from `cli-parity.test.ts`).
   - `clientCapabilities` controls whether `elicitation: {}` is declared.
   - `elicitInputHandler` is the test's mock — receives the form-mode params, returns `{ action: 'accept'|'reject'|'cancel', content?: Record<string,unknown> }`.
   - EventStore wiring: SQLite in-memory, fresh per test.

2. Quick sanity test in the same file (one test): `createElicitationTestPair_DefaultArgs_HandshakeSucceeds`.

**Dependencies:** None.
**Parallelizable:** Yes (Wave 1, Stream A entry point).
**Branch:** `feat/preview-4-realization-elicitation-e2e` (PR-A).

---

### Task 4: Elicitation E2E — accept path

**Phase:** RED → GREEN

1. **[RED]** Add test in `elicitation-roundtrip.test.ts` (new file at `src/__tests__/integration/`):
   - `ElicitationRoundtrip_AcceptPath_EnvelopeSuccessAndEventsLanded`.
   - Setup via fixture (T3). Client declares `elicitation: {}`. Mock `elicitInputHandler` returns `{ action: 'accept', content: { featureId: 'test-id' } }`.
   - Invoke `tools/call` for `exarchos_workflow init` with `featureId` omitted.
   - Assert: envelope is `success: true` (workflow created).
   - Assert: events on stream `elicitation/<operationId>`: both `elicitation.requested` AND `elicitation.fulfilled` present.
   - Assert: `result._meta.operationId` matches the elicitation stream's operation prefix (cross-stream correlation closed).
   - Expected outcome: PASS on first run if substrate is correct; FAIL if PR #1424 + CodeRabbit fix has any residual gap.

**Dependencies:** T3.
**Parallelizable:** Yes (Stream A, parallel with T5, T6).
**Branch:** Same as T3 (`feat/preview-4-realization-elicitation-e2e`).

---

### Task 5: Elicitation E2E — decline path

**Phase:** RED → GREEN

1. **[RED]** Add test in `elicitation-roundtrip.test.ts`:
   - `ElicitationRoundtrip_DeclinePath_InvalidInputEnvelopeAndDeclinedEventLanded`.
   - Mock `elicitInputHandler` returns `{ action: 'reject' }`.
   - Assert: envelope is `success: false` with `error.code: 'INVALID_INPUT'`.
   - Assert: event on stream `elicitation/<operationId>`: `elicitation.declined` present (typed event from `elicitation-dispatch.ts:122-126`).
   - Assert: NO retry attempted (the underlying action handler is called at most once).
   - Expected outcome: PASS on first run if substrate is correct.

**Dependencies:** T3.
**Parallelizable:** Yes (Stream A, parallel with T4, T6).
**Branch:** Same as T3.

---

### Task 6: Elicitation E2E — capability-absent path

**Phase:** RED → GREEN

1. **[RED]** Add test in `elicitation-roundtrip.test.ts`:
   - `ElicitationRoundtrip_CapabilityAbsent_LegacyInvalidInputAndNoElicitationEvents`.
   - Client does NOT declare `elicitation` capability.
   - Invoke `tools/call` for `exarchos_workflow init` with `featureId` omitted.
   - Assert: envelope is `success: false` with `error.code: 'INVALID_INPUT'` (legacy path).
   - Assert: NO events on ANY `elicitation/*` stream.
   - Assert: `elicitInputHandler` was never invoked.
   - Expected outcome: PASS on first run.

**Dependencies:** T3.
**Parallelizable:** Yes (Stream A, parallel with T4, T5).
**Branch:** Same as T3.

---

### Task 7: `--follow` expansion to 3 view actions

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Add tests in `servers/exarchos-mcp/src/cli/follow-loop.test.ts` (or new `cli-follow-expansion.test.ts` if existing file gets unwieldy):
   - `CliFollow_PipelineAction_EmitsNdjsonFrames`.
   - `CliFollow_ConvergenceAction_EmitsNdjsonFrames`.
   - `CliFollow_DelegationTimelineAction_EmitsNdjsonFrames`.
   - Each: invoke CLI with `view <action> --follow`; assert NDJSON frames stream; assert no `*.polled` events emitted (idempotency cross-check).
   - Expected failure: `isViewFollow` predicate rejects each new action; `--follow` flag not registered.

2. **[GREEN]** Refactor `adapters/cli.ts:236-238`:
   - Replace inline predicate with `VIEW_FOLLOW_ACTIONS` set containing `workflow_status`, `shepherd_status`, `pipeline`, `convergence`, `delegation_timeline`.
   - Update the action-name routing at `cli.ts:405` (currently a ternary) to route via the set as well.
   - Apply the audit results from T1: if any of the 3 new actions is non-idempotent, exclude from the set and file a follow-up.

3. **[REFACTOR]** Extract `VIEW_FOLLOW_ACTIONS` to a top-level module constant with a JSDoc comment citing INV-2 (CLI `--follow` and MCP `tasks/get` polling produce byte-equivalent transitions).

**Dependencies:** T1 (audit must complete before set expansion).
**Parallelizable:** Yes (Stream B, parallel with Streams C, D).
**Branch:** `feat/preview-4-realization-follow-expansion` (PR-B sub-branch).

---

### Task 8: Project `dispatch` field through `describe` handler

**Phase:** RED → GREEN

1. **[RED]** Add test in `servers/exarchos-mcp/src/describe/handler.test.ts` (or `views/describe.coverage.test.ts` — locate during implementation):
   - `DescribeHandler_ActionWithDispatchHints_ProjectsDispatchField`.
   - Setup: fixture action with `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60000 }`.
   - Invoke `describe({ actions: ['<fixture-action>'] })`.
   - Assert: result has `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60000 }`.
   - `DescribeHandler_ActionWithoutDispatchHints_OmitsDispatchField` — assert field is absent when annotation not set.
   - Expected failure: handler at `describe/handler.ts:113-149` does not project the field.

2. **[GREEN]** Extend `describe/handler.ts:113-149` action result construction:
   - Add `...(action.dispatch ? { dispatch: action.dispatch } : {})` alongside existing optional spreads (autoEmits, deprecated, outputSchema).

**Dependencies:** T2 (`DispatchHints` interface must exist).
**Parallelizable:** Yes (Stream C, parallel with B, D).
**Branch:** `feat/preview-4-realization-describe-dispatch` (PR-B sub-branch).

---

### Task 9: Annotate 4 target actions with `dispatch.taskSuitable`

**Phase:** RED → GREEN

1. **[RED]** Add test in `registry.test.ts`:
   - `Registry_TaskSuitableAnnotations_FourActionsMarked`.
   - Assert: `exarchos_orchestrate merge`, `exarchos_workflow synthesize`, `exarchos_workflow cleanup`, `exarchos_workflow rehydrate` each surface `dispatch.taskSuitable: true` AND `dispatch.taskTtlSuggestionMs: 60000`.
   - Expected failure: none of these actions has a `dispatch` annotation yet.

2. **[GREEN]** Add `dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 }` to each of the 4 action descriptors in `registry.ts`.

**Dependencies:** T2 (`DispatchHints` interface), T8 (projection — needed if test asserts via describe).
**Parallelizable:** Yes (Stream C, after T8).
**Branch:** Same as T8.

---

### Task 10: Add `retry_with_task` verb to next-actions discriminator schema

**Phase:** RED → GREEN

1. **[RED]** Add test in `servers/exarchos-mcp/src/next-actions-from-result.test.ts` (or wherever the discriminator validation lives):
   - `NextActionsDiscriminator_RetryWithTaskVerb_Validates`.
   - Assert: a next-action object of shape `{ verb: 'retry_with_task', reason: '...', ttl_suggestion_ms: 60000 }` passes the discriminator schema.
   - Expected failure: verb is not in the discriminator union.

2. **[GREEN]** Extend the discriminator schema at `next-actions-from-result.ts:122` (or wherever the union is defined — locate during implementation) to include `retry_with_task` with `ttl_suggestion_ms: number` as the additional payload field.

**Dependencies:** T2 (annotation must exist so the verb has somewhere to point).
**Parallelizable:** Yes (Stream D, parallel with B, C).
**Branch:** `feat/preview-4-realization-retry-with-task-hint` (PR-B sub-branch).

---

### Task 11: Emit `retry_with_task` hint from dispatch boundary

**Phase:** RED → GREEN

1. **[RED]** Add unit test in `next-actions-computer.test.ts` (or `core/dispatch.test.ts` — locate based on where hint composition lives):
   - `RetryWithTaskHint_TaskSuitableActionWithoutTaskTtlExceededThreshold_PrependsHint` (positive path).
   - Use `vi.useFakeTimers()` to simulate elapsed > threshold (default 10_000 ms).
   - Assert: `result._meta.next_actions[0].verb === 'retry_with_task'`.
   - Assert: `next_actions[0].ttl_suggestion_ms === 60_000` (from `dispatch.taskTtlSuggestionMs`).
   - Expected failure: no hint emission rule exists yet.

2. **[GREEN]** Add hint emission rule at the dispatch boundary in `core/dispatch.ts`, **after** the action handler returns but **before** `nextActionsFromResult` runs:
   - Compute `elapsedMs` from a start timestamp captured at dispatch entry.
   - Read `action.dispatch?.taskSuitable` from the registry.
   - Detect whether `task: { ttl }` was threaded (existing logic at `dispatch.ts:526`).
   - If (`taskSuitable === true`) AND (no `task: { ttl }`) AND (`elapsedMs > threshold`), construct the `retry_with_task` next-action object and prepend to `result._meta.next_actions`.
   - Threshold: read from `config.dispatch.retryWithTaskHintThresholdMs` if present, else `10_000`.

**Dependencies:** T9 (`merge`/`synthesize`/`cleanup`/`rehydrate` are annotated; test fixture uses one of them), T10 (discriminator accepts the verb).
**Parallelizable:** Sequential with T10 + T9.
**Branch:** Same as T10.

---

### Task 12: Negative-path coverage + integration test for `retry_with_task`

**Phase:** RED → GREEN

1. **[RED]** Add three negative tests in the same file as T11:
   - `RetryWithTaskHint_ElapsedBelowThreshold_HintNotEmitted` — fake timer to 9_999 ms.
   - `RetryWithTaskHint_ActionNotTaskSuitable_HintNotEmitted` — invoke a non-annotated action.
   - `RetryWithTaskHint_TaskTtlAlreadyThreaded_HintNotEmitted` — invoke with `task: { ttl: 60_000 }`.
   - Expected outcome: each must show the hint is NOT in `next_actions[0]`.

2. **[RED]** Add integration test in `core/dispatch.test.ts`:
   - `Dispatch_SlowTaskSuitableAction_EmitsRetryWithTaskHintInMeta`.
   - End-to-end: dispatch `merge_orchestrate` (or similar long-running annotated action) with a simulated handler that takes > 10s.
   - Assert: returned envelope's `_meta.next_actions` contains `retry_with_task` as the first entry.

3. **[GREEN]** Verify negative paths pass without code change (the emission rule from T11 should already short-circuit correctly). If not, tighten the rule.

**Dependencies:** T11.
**Parallelizable:** Sequential with T11.
**Branch:** Same as T10/T11.

---

## Wave + PR mapping

```
PR-A (#1436 only):                  PR-B (#1440 Op 1 + Op 2 + Op 4):
  T3 → T4, T5, T6 (parallel)          Wave 0:
                                        T1 (audit) — parallelizable
                                        T2 (DispatchHints type)
                                      Wave 1:
                                        Stream B: T7
                                        Stream C: T8 → T9
                                        Stream D: T10 → T11 → T12
                                      (Streams B, C, D parallel after Wave 0)
```

**Estimated PR sizes:**
- PR-A: 1 fixture file + 1 test file with 3 cases. Probably 250-400 LOC. Single review pass expected.
- PR-B: ~6 files touched (registry.ts, describe/handler.ts, adapters/cli.ts, core/dispatch.ts, next-actions-from-result.ts, plus tests). Probably 600-900 LOC. Reviewable but at the upper bound — consider stacking PR-B as 3 smaller PRs (per stream) if review feedback signals it.

## Risk register

| Risk | Mitigation |
|---|---|
| T1 audit finds a non-idempotent handler | Exclude that handler from the `VIEW_FOLLOW_ACTIONS` set; file follow-up issue; do NOT block the bundle. |
| T4/T5/T6 fail on first run (substrate gap) | This IS the test value. File a hot-fix sub-issue; do not paper over. |
| T11 hint emission has unexpected interaction with `nextActionsFromResult` ordering | Hint is prepended at dispatch boundary; integration test in T12 catches ordering regressions. |
| T9 annotations affect existing review/audit gates | None of the 4 actions currently has `dispatch` field; addition is additive and optional. Existing tests pass unchanged. |
| Stream B/C/D parallel work conflicts on `registry.ts` | T7, T8, T9, T10 touch different sections of `registry.ts` (or none of them — T7 touches `cli.ts`, T10 touches `next-actions-from-result.ts`). Only T2 + T9 touch the same file; T9 depends on T2 sequentially. Low conflict risk. |

## Out of scope (explicit, mirrors design §9)

- #1440 Op 3 (workflow verb wiring through Tasks-augmented dispatch).
- #1440 Op 5 (SSE/server-push).
- Any change to the binding `taskCapabilityGate` at `core/dispatch.ts:927-954`.
- Migration tooling for the `dispatch` annotation (purely additive).
