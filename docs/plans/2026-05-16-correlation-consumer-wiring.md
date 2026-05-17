# Implementation Plan — Correlation Consumer Wiring (#1448)

**Design:** [`docs/designs/2026-05-16-correlation-consumer-wiring.md`](../designs/2026-05-16-correlation-consumer-wiring.md)
**Feature ID:** `refactor-correlation-consumer-wiring`
**Issue:** [#1448](https://github.com/lvlup-sw/exarchos/issues/1448) (items 2-5; item 1 = #1446 separately tracked)
**Stacked on:** PR #1447 (`feature/correlation-indexed-columns`)
**Branch:** `feature/correlation-consumer-wiring`
**Date:** 2026-05-16
**Total tasks:** 9, organized into 4 waves

## Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
>
> Every task that modifies production behavior begins with a RED test (assert the new behavior; assert it fails for the right reason). GREEN is the minimum production change to flip RED green. REFACTOR is optional — only if duplication or cohesion suffers.

## Wave overview

| Wave | Theme | Tasks | Parallel? | Depends on |
|---|---|---|---|---|
| 1 | Item 5 counters + Item 3 investigation | 1-3 | Yes (all 3 parallel — no shared files) | — |
| 2 | Item 2 — AsyncLocalStorage default | 4-5 | Sequential chain (helper → handler refactor) | — (parallel with Wave 1) |
| 3 | Item 4 — CLI flags + runbook + README | 6-8 | Two parallel groups (flag wiring vs docs) | Wave 2 (helper exists for CLI to reuse) |
| 4 | Item 3 — T17 rewrite | 9 | — | Wave 1 Task 3 outcome |

Branch strategy: subagent worktrees branch from `feature/correlation-consumer-wiring` (per `feedback_subagent_nested_worktrees`). Each task lands on the integration branch before the next dependent wave begins.

**Critical:** Waves 1 + 2 + 3 must not race for `views/tools.ts`. Wave 1 Task 1 touches `views/tools.ts` (the `materializeFiltered` call site). Wave 2 Tasks 4-5 also touch `views/tools.ts` (the 6 inline spread blocks). **Serialize:** Wave 1 Task 1 → Wave 2 Tasks 4-5. Wave 1 Tasks 2-3 can run parallel with anything.

---

## Wave 1 — Item 5 counters + Item 3 investigation

### Task 1: `cacheBypasses` counter in `ViewMaterializer`

**Phase:** RED → GREEN

1. **[RED]** Write test in `servers/exarchos-mcp/src/views/materializer.test.ts`:
   - `Materializer_recordBypass_IncrementsCacheBypassesCounter`
   - Construct a materializer, call `materializer.recordBypass()` 3 times, assert `materializer.getStats().bypasses === 3`. Also assert `hits` and `misses` are untouched.
   - Expected: RED — `recordBypass` method does not exist; `bypasses` is not in stats.

2. **[GREEN]** In `servers/exarchos-mcp/src/views/materializer.ts`:
   - Add `private cacheBypasses = 0;` next to `cacheHits` / `cacheMisses` (L75-76).
   - Add `recordBypass(): void { this.cacheBypasses++; }` method.
   - Extend `getStats()` (L269-274) to return `bypasses: this.cacheBypasses` and include it in the total denominator for `bypassRate`.

3. **[REFACTOR]** Wire the call site: in `servers/exarchos-mcp/src/views/tools.ts`, `materializeFiltered` (L221-235), call `materializer.recordBypass()` after `getProjection` succeeds, before the fold loop. **Coordination:** this is the only `views/tools.ts` touch in Wave 1; Wave 2 must serialize after this lands.

4. **[GREEN]** Update the test to assert end-to-end: call `materializeFiltered(materializer, viewName, [])` and verify `getStats().bypasses === 1`.

**Files:** `views/materializer.ts`, `views/materializer.test.ts`, `views/tools.ts` (`materializeFiltered` call only)
**Dependencies:** None
**Parallelizable:** With Tasks 2-3 (different files except for the small `views/tools.ts` touch). Wave 2 Tasks 4-5 must wait on this.

---

### Task 2: `correlationFilteredQueries` counter in `SqliteBackend`

**Phase:** RED → GREEN

1. **[RED]** Write test in `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`:
   - `Sqlite_queryEvents_WithCorrelationFilter_IncrementsIndexedPathCounter`
   - Initialize a `SqliteBackend`, insert a few events, call `backend.queryEvents(streamId, { correlationId: 'x' })` 3 times and `backend.queryEvents(streamId, {})` once (no filter). Assert `backend.getStats().correlationFilteredQueries === 3`.
   - Also: `Sqlite_queryEventsByType_WithCorrelationFilter_IncrementsIndexedPathCounter` mirrors the same pattern via `queryEventsByType`.
   - Expected: RED — counter does not exist.

2. **[GREEN]** In `servers/exarchos-mcp/src/storage/sqlite-backend.ts`:
   - Add `private correlationFilteredQueries = 0;` to the `SqliteBackend` class fields.
   - In `queryEvents` (L1258-1268 filter-clause block) and `queryEventsByType` (L1353-1363 filter-clause block), increment when any of the three correlation filter fields is supplied. **Important:** increment once per query, not per clause appended (otherwise a query with all three filters would triple-count).
   - Extend `getStats()` (or add one if it doesn't exist — check the class API) to return `correlationFilteredQueries`.

3. **[REFACTOR]** Inspect: does `SqliteBackend` already expose a stats getter? If not, add one that returns at least `{ correlationFilteredQueries }`. Match the shape of the existing `ViewMaterializer.getStats()` for consistency.

**Files:** `storage/sqlite-backend.ts`, `storage/sqlite-backend.test.ts`
**Dependencies:** None
**Parallelizable:** Yes (no overlap with Tasks 1, 3, or Wave 2/3/4).

---

### Task 3: Investigation — does a production `next_actions` auto-dispatch handler exist?

**Phase:** Investigation (no production code change in this task; outcome feeds Task 9).

1. **[INVESTIGATE]** Trace from a `ToolResult` carrying `next_actions: [...]` to wherever the dispatcher *executes* one of those actions in production (NOT in a test driver). Candidates to inspect:
   - `servers/exarchos-mcp/src/next-actions-from-result.ts` (already known: computes only).
   - `servers/exarchos-mcp/src/views/composite.ts` (envelope wrap).
   - `servers/exarchos-mcp/src/adapters/cli.ts` (CLI driver).
   - `servers/exarchos-mcp/src/cli-commands/checkpoint.ts` (orchestrator loop?).
   - Grep `next_actions` callsites that are NOT field assignments — i.e., reads that feed a dispatcher call.

2. **[DECISION]** Two outcomes:
   - **(A) Production handler exists** — record file path + entry function in the task result. Task 9 then drives T17 through it.
   - **(B) No production handler; auto-dispatch is caller-driven** (orchestrator harness or CLI loop reads `next_actions` and dispatches one-shot). Record evidence (the grep results, the orchestrator file paths, the abstraction boundary). Task 9 then becomes a documentation-only update to T17's inline TODO with a permanent justification + reference to where production auto-dispatch *would* live if added.

3. **[OUTPUT]** Write the investigation result as the task's `evidence` field. Subsequent task (Task 9) reads this to choose its approach.

**Files:** read-only investigation
**Dependencies:** None
**Parallelizable:** Yes (read-only).

---

## Wave 2 — Item 2: AsyncLocalStorage default for `current_correlation`

### Task 4: `deriveCorrelationFilters` helper

**Phase:** RED → GREEN

1. **[RED]** Write test in `servers/exarchos-mcp/src/views/tools.test.ts` (or a new `deriveCorrelationFilters.test.ts` colocated with the helper):
   - `DeriveCorrelationFilters_ExplicitArgs_PassesThroughUnchanged` — supply `{ correlationId: 'cor-x' }`, no dispatch context active, assert returned `{ correlationId: 'cor-x' }`.
   - `DeriveCorrelationFilters_NoArgsNoContext_ReturnsEmpty` — supply `{}`, no dispatch context active, assert `{}`.
   - `DeriveCorrelationFilters_NoArgsWithContext_DefaultsCorrelationId` — supply `{}` inside `runWithDispatchContext({ operationId, correlationId: 'ctx-cor', causationId }, ...)`, assert returned `{ correlationId: 'ctx-cor' }`.
   - `DeriveCorrelationFilters_AnyExplicitArg_DoesNotDefault` — supply `{ operationId: 'op-x' }` inside `runWithDispatchContext(...)`, assert returned `{ operationId: 'op-x' }` — NO `correlationId` injection.
   - `DeriveCorrelationFilters_NoArgsWithContext_LogsCtxDefault` — verify debug log line emitted with `{ source: 'ctx-default' }` (spy on `logger.debug`).

2. **[GREEN]** Add to `servers/exarchos-mcp/src/views/tools.ts` (next to `ViewQueryFilters` interface, L167-184):
   ```typescript
   export function deriveCorrelationFilters(args: {
     operationId?: string;
     correlationId?: string;
     causationId?: string;
   }): ViewQueryFilters {
     const explicit: ViewQueryFilters = {
       ...(args.operationId !== undefined ? { operationId: args.operationId } : {}),
       ...(args.correlationId !== undefined ? { correlationId: args.correlationId } : {}),
       ...(args.causationId !== undefined ? { causationId: args.causationId } : {}),
     };
     if (Object.keys(explicit).length > 0) {
       return explicit;
     }
     const ctx = getDispatchContext();
     if (ctx) {
       logger.debug({ source: 'ctx-default', correlationId: ctx.correlationId }, 'deriveCorrelationFilters: defaulted to active dispatch context');
       return { correlationId: ctx.correlationId };
     }
     return {};
   }
   ```
   - Import `getDispatchContext` from `'../dispatch/dispatch-context.js'`.

**Files:** `views/tools.ts`, `views/tools.test.ts` (or new test file)
**Dependencies:** None (parallel with Wave 1)
**Parallelizable:** Can run parallel with Wave 1, but Task 5 (handler refactor) MUST serialize after Wave 1 Task 1 to avoid `views/tools.ts` conflicts.

---

### Task 5: Refactor the 6 handlers + telemetry handler to use `deriveCorrelationFilters`

**Phase:** GREEN-only (Task 4's helper already covers the behavior; this is mechanical substitution).

1. **[RED-OPTIONAL]** Add one integration test that exercises the end-to-end ctx-default path through a handler:
   - `HandleViewTelemetry_NoArgsInsideDispatch_DefaultsToCtxCorrelationId`
   - Set up an EventStore with events stamped under correlation `cor-X`. Wrap a call to `handleViewTelemetry({}, ...)` in `runWithDispatchContext({ correlationId: 'cor-X', ... }, ...)`. Assert the returned telemetry filters out events that don't match cor-X.
   - Mirror once for one other handler (e.g., `handleViewCodeQuality`) to pin the cross-handler invariance.

2. **[GREEN]** Replace the inline filter-spread blocks at 6 sites with `const correlationFilters = deriveCorrelationFilters(args);`:
   - `views/tools.ts:596-600` (`handleViewDelegationTimeline`)
   - `views/tools.ts:648-652` (`handleViewCodeQuality`)
   - `views/tools.ts:749-752` (`handleViewEvalResults`)
   - `views/tools.ts:854-857` (`handleViewQualityCorrelation`)
   - `views/tools.ts:926-929` (`handleViewQualityAttribution`)
   - `telemetry/tools.ts:110-113` (`handleViewTelemetry`)
   - Each becomes a single line. The rest of each handler (the `hasCorrelationFilters(correlationFilters)` branch, `materializeFiltered` call, etc.) is unchanged.

3. **[GREEN]** Re-run full suite — no test should regress; the existing 6 handler tests pass identically (explicit-args-win means existing callers see no change).

**Files:** `views/tools.ts` (6 inline blocks), `telemetry/tools.ts` (1 inline block), one integration test file
**Dependencies:** Task 4 (helper exists). Serialize with Wave 1 Task 1.
**Parallelizable:** No (single-author refactor).

---

## Wave 3 — Item 4: CLI flags + runbook + README

### Task 6: Wire `--operation-id` / `--correlation-id` / `--causation-id` CLI flags

**Phase:** RED → GREEN

1. **[INVESTIGATE]** In `servers/exarchos-mcp/src/adapters/cli.ts` (1148 lines), locate the subcommand wiring for the 6 telemetry view actions. Identify the flag-definition surface (likely a Commander or yargs invocation; or a manual `process.argv` parse). Record the pattern in the task's working notes.

2. **[RED]** Add CLI flag-parsing tests (file likely exists — search for `cli.test.ts` or similar):
   - `Cli_ViewTelemetry_CorrelationIdFlag_ProducesArg` — invoke the CLI with `view telemetry --correlation-id cor-x`, assert the parsed args object contains `correlationId: 'cor-x'`.
   - Mirror for `--operation-id` and `--causation-id`.
   - Mirror for one other telemetry action (e.g., `delegation_timeline`) to pin the flag is wired symmetrically.

3. **[GREEN]** Add the three flag definitions to each of the 6 telemetry view subcommands. Use kebab-case flag names → camelCase arg keys.

4. **[GREEN]** Run an end-to-end smoke: spin up an in-process EventStore with a stamped event, invoke the CLI's `view telemetry --correlation-id cor-x`, assert the output is filtered. This exercises both the flag parser AND the `deriveCorrelationFilters` helper from Task 4 (explicit-args-win path).

**Files:** `adapters/cli.ts`, `adapters/cli.test.ts` (or equivalent)
**Dependencies:** Task 4 (helper) — Task 6's smoke test confirms the integration. Strictly speaking, CLI flag parsing doesn't need the helper; but the end-to-end smoke does.
**Parallelizable:** With Tasks 7-8 (different files).

---

### Task 7: Runbook — `docs/runbooks/correlation-filters.md`

**Phase:** Documentation (no production code).

1. Create `docs/runbooks/correlation-filters.md` covering:
   - **What:** definitions of the three IDs (operation = dispatch boundary, correlation = chain anchor, causation = one-hop upstream).
   - **When:** filter selection rule (workflow scoping with `correlationId`; cross-workflow rollup = no filter; one-hop tracing = `causationId`).
   - **How (MCP):** example call `exarchos_view telemetry { correlationId: 'cor-x' }` with sample response shape.
   - **How (CLI):** example `exarchos view telemetry --correlation-id cor-x` with sample output.
   - **AsyncLocalStorage default:** brief note that inside an active dispatch, omitting all three filters auto-defaults `correlationId` to the active dispatch's correlationId. Link to `dispatch-context.ts` for the primitive.

2. **Verification:** All command examples must be copy-pasteable and produce a valid response shape against the current API. Author runs each example manually before committing.

**Files:** `docs/runbooks/correlation-filters.md` (new)
**Dependencies:** None for content. Reference to AsyncLocalStorage section is accurate once Task 4-5 land.
**Parallelizable:** With Task 6, 8.

---

### Task 8: README — add observability section link to runbook

**Phase:** Documentation.

1. In `README.md`, find the "Observability" or equivalent section. Add a brief paragraph (2-3 sentences) explaining that telemetry view actions support correlation filters and link to `docs/runbooks/correlation-filters.md`.

2. If no observability section exists, place under the closest relevant section (likely the MCP server feature list or telemetry mention).

**Files:** `README.md`
**Dependencies:** Task 7 (runbook must exist at the linked path).
**Parallelizable:** With Task 6 (different files).

---

## Wave 4 — Item 3: T17 rewrite

### Task 9: Convert T17 based on Task 3 outcome

**Phase:** Depends on Task 3 evidence.

**Branch A (production auto-dispatch handler exists):**

1. **[RED]** Update `T17_CausationChain_AutoDispatch_FromNextActionsHint_CarriesCausationIdReferencingUpstreamEvent` in `correlation-acceptance.test.ts`:
   - Remove the `mintDispatchContext` synthesis of the second boundary.
   - Construct a `ToolResult` that the production handler treats as the trigger (carrying `next_actions` hint with the parent eventId as causation).
   - Invoke the production handler.
   - Assert the resulting child dispatch's events carry `causationId === parentEventId` and `correlationId === parentCorrelationId`.

2. **[GREEN-IF-RED]** If the test goes RED, the production handler is the genuine causation-threading bug. Fix the handler to thread `causationId` from the upstream event id into the child `mintDispatchContext` call.

**Branch B (no production auto-dispatch handler):**

1. Replace the T17 inline TODO at the test's describe block with a permanent justification:
   - State that auto-dispatch is caller-driven in the current architecture (orchestrator harness, CLI loop, or test driver) and therefore the test's `mintDispatchContext` synthesis IS the integration surface.
   - Reference the investigation evidence from Task 3 by file path.
   - Link to a (new, optional) issue for "production-side `next_actions` auto-dispatch handler" if one is justified architecturally.

2. Add a smaller test that DOES cover what we can: simulate the caller path (the orchestrator's `next_actions` consumption code, if present at all) and assert `causationId` threading there.

**Files:** `__tests__/correlation-acceptance.test.ts`; possibly the auto-dispatch handler source file under Branch A.
**Dependencies:** Task 3 evidence.
**Parallelizable:** No (depends on Wave 1 Task 3).

---

## Validation gates (post-task)

After each task lands on the integration branch, the orchestrator runs:

- `check_tdd_compliance` — verifies the RED commit landed before the GREEN commit (Tasks 1, 2, 4, 5, 6, 9 branch A).
- `check_static_analysis` — typecheck + lint clean.
- Co-located test suite passes for the touched files.

Before final synthesis (PR creation):

- `cd servers/exarchos-mcp && npm run test:run` — full project sweep.
- `npm run typecheck` — root typecheck.
- Verify `feature/correlation-consumer-wiring` rebases cleanly on `feature/correlation-indexed-columns` (no drift from PR #1447).

## PR shape

Single squash merge of `feature/correlation-consumer-wiring` → `feature/correlation-indexed-columns`. When PR #1447 merges to `main`, GitHub auto-retargets this PR to `main`.

Title: `feat(correlation): wire consumer side of correlation tuple filters (#1448)`

Closes #1448 (items 2-5).
