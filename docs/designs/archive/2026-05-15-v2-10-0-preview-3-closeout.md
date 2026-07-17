# v2.10.0-preview.3 — Final close-out bundle

**Feature ID:** `v2-10-0-preview-3-closeout`
**Epic:** [#1354](https://github.com/lvlup-sw/exarchos/issues/1354) — v2.10.0-preview.3 Windows dogfood remediation
**Milestone:** v2.10.0 — Agent Output Contract
**Scope:** #1374 (Wave 0 follow-up regression), #1362 (Windows preflight instrumentation), outcome-tier completeness backfill for #1360/#1363/#1364
**Date:** 2026-05-15 (reshaped 2026-05-15: PR3 #1365 pulled pending eval-suite redesign)
**Branch:** `feature/v2-10-0-preview-3-closeout`

## Problem

Preview.3's epic #1354 enumerated 8 dogfood findings + 3 systemic gates + 4 Agent Output Contract (AOC) carrier-track items. Waves 0–2 plus most of Wave 3 have landed (#1369 carrier swap; #1388 data-safety substrate; the 2026-05-15 polish bundle closing #1359/#1360/#1363/#1364). Three items remain in this bundle before the epic can partially close:

- **#1374 — saga-merge-detour regression.** `test/process/saga-merge-detour.test.ts` fails on the wave-0 head: `next_actions` is `[]` after a worktree-bearing `task.completed`, instead of surfacing `merge_orchestrate`. The skill contract at `skills-src/delegation/SKILL.md` §"Worktree-Bearing Tasks: Auto-Detour to merge-pending" mandates the verb. The auto-detour wire originally landed under #1208 is broken. Process-tier CI is blocking; the surface (next-action computer + rehydration projection) is the same one Wave 2 #1359 touched, so the regression likely shipped alongside the carrier swap or the projection vocabulary update.
- **#1362 — Windows preflight false-positive instrumentation.** `merge_orchestrate` preflight reports `ancestry.passed: false` on Windows even when `git merge-base --is-ancestor` succeeds manually. Phase-1 ships the debug payload behind `EXARCHOS_PREFLIGHT_DEBUG=1`; root-cause fix waits for one Windows-host event with the new payload.
- **Outcome-tier completeness.** The user's note on #1354: *"ensure we fully scaffolded all the planned outcome-tier tests."* The #1358 seed set (3 tests for #1355/#1356/#1359) is GREEN; the four open AOC carriers landed without paired outcome tests. Backfill #1360 / #1363 / #1364 with operator-visible behavior tests to complete the dogfood-finding coverage matrix.

All three belong in one bundle because they share the same carrier surface: every fix either consumes or extends an `outputSchema` registered during Wave 0 (#1287/#1289). Closing them together preserves the carrier-Wave / dogfood-Wave interaction discipline the epic established.

### #1365 deferred to eval-suite redesign

The original preview.3 close-out included #1365 (eval-suite elevation steps 1+2 — versioned dataset baselines + HTML dashboard). During plan review we recognized that #1365's design is built on top of an eval architecture we now intend to replace. Insight: our `{{TOKEN}}` placeholders encode harness mechanics (tool names, command verbs, hook surfaces) — they do NOT change the behavioral intent of the skill. Evaluating each rendered SKILL.md with a live LLM is triple-counting the same behavior under different vocabularies. The right architecture is a two-tier split: Tier A objective harness-surface tests against a versioned harness manifest; Tier B runtime-agnostic behavioral evals on the dotnet/skills pattern (live LLM + pairwise judging + overfitting detection). Shipping #1365 steps 1+2 against the current format would mean migrating both immediately after the redesign lands. Pulled from this bundle. Redesign tracked separately by the seed doc at `docs/research/2026-05-15-eval-suite-redesign-seed.md` and a forthcoming `/exarchos:ideate` pass.

## Verified surfaces

### #1374 — auto-detour wire location

The detour chain is three handlers:

1. **`servers/exarchos-mcp/src/projections/rehydration/reducer.ts:290-377`** — folds `task.completed` events. When `event.data.worktreePath` is present (line 299), the reducer projects the workflow into `phase: 'merge-pending'` and seeds `mergeOrchestrator: { taskId, phase: 'pending' }`. Re-entrant: a re-folded event keys off the existing `mergeOrchestrator.taskId` (lines 350-376) so idempotency holds.
2. **`servers/exarchos-mcp/src/next-actions-from-result.ts:74-93`** — extracts `phase`, `workflowType`, `featureId`, `mergeOrchestrator` from the rehydration document's `workflowState` segment (shape 2). The shape-2 fallback was the original #1208 fix.
3. **`servers/exarchos-mcp/src/next-actions-computer.ts:114-143`** — when `phase === 'merge-pending'` and `mergeOrchestrator.phase ∉ EXCLUDED_MERGE_PHASES`, appends `{verb: 'merge_orchestrate', idempotencyKey: '<streamId>:merge_orchestrate:<taskId>'}` to `next_actions`.

The failure mode is unknown without instrumentation but the three most likely fault lines are: (a) Wave 0's carrier swap moved the rehydrate payload from `result.data` to `result.structuredContent` and `nextActionsFromResult(result)` still reads `result.data`; (b) the `task_complete` orchestrate handler stopped converting `result.worktreePath` to the event's `data.worktreePath`; (c) the rehydration reducer's `extractWorktreePath` helper regressed during the #1359 vocabulary update. The implementer task starts with a single targeted run of the saga test against the current head plus a `console.log` at each of the three sites — the failure shape determines which fault line is real.

### #1362 — preflight surface

`servers/exarchos-mcp/src/orchestrate/dispatch-guard.ts:78` calls `gitExec(['merge-base', '--is-ancestor', upstream, integrationBranch])`. The pure helper `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts` composes `validateBranchAncestry` + `detectDrift` + `assertCurrentBranchNotProtected` + `assertMainWorktree` and emits `merge.preflight` events. The debug-block injection point is the `merge.preflight` event payload schema — add an optional `debug?: PreflightDebug` field gated on `process.env.EXARCHOS_PREFLIGHT_DEBUG === '1'` AND `ancestry.passed === false`. The `PreflightDebug` shape: `{ gitVersion, repoRoot, worktreeList, refsHeadsSource: {sha, packed}, refsHeadsTarget: {sha, packed}, mergeBaseCommand, mergeBaseExitCode, mergeBaseStdout, mergeBaseStderr }`. Per INV-1, the debug payload lives on the event (event-sourced), not a side channel.

### Outcome-tier helpers

`tests/outcome/_helpers/` ships `withTmpHome` (HOME isolation), `withTmpGit` (repo init), `addSiblingWorktree` (multi-worktree topology). The three existing tests cover CLI-binary invocation (#1355), handler-direct (#1356, #1359). No new helpers needed. The four new tests reuse existing patterns:

- `tests/outcome/reserved-fields-discoverability.test.ts` (#1360) — handler-direct: call `handleDescribe` + `handleUpdate` with a reserved field, assert structured error data + describe enumeration.
- `tests/outcome/runbook-merge-orchestration.test.ts` (#1363) — handler-direct: call `handleRunbook({phase: 'merge-pending'})`, assert non-empty payload with the expected event-shape entries.
- `tests/outcome/telemetry-action-errors.test.ts` (#1364) — saga-shape: drive a workflow into a structured-failure handler, assert `view telemetry` reports `actionErrors > 0` and `actionErrorBreakdown` carries the named error code.
- `tests/outcome/saga-merge-detour.test.ts` (#1374) — atomic RED→GREEN flip alongside the wire fix. Co-shipped in PR1; not separate.

## Design overview

Three PRs, stacked bottom-up on `feature/v2-10-0-preview-3-closeout`. Each PR is independently mergeable but bottom-up squash preserves the narrative.

| PR | Fix | Outcome test | Carrier? |
|---|---|---|---|
| PR1 | #1374 wire restoration | `tests/outcome/saga-merge-detour.test.ts` (atomic flip) | Reads existing `next_actions` |
| PR2 | #1362 preflight debug payload (env-gated) | `tests/outcome/preflight-debug.test.ts` (Linux: env-var gating + payload shape) | Extends `merge.preflight` event schema |
| PR3 | Outcome-tier completeness backfill | Three new tests (#1360 / #1363 / #1364) | n/a (read-only assertions) |

Bottom-up merge sequence partially closes #1354 on PR3 merge (#1365 stays open pending eval-suite redesign). PR2 is the only bundle PR that touches event-schema shape (the `merge.preflight` event's data schema gains an optional `debug` branch); PR1 and PR3 touch no schemas. Atomic RED→GREEN discipline preserved on PR1 (#1208 contract restoration) and elsewhere where the test pairs with a fix.

### Cross-cutting carrier interaction (clarified at plan-review)

**The `merge.preflight` event schema and the `merge_orchestrate` action's registered `outputSchema` are decoupled.** The Wave 0 carrier swap (#1287) mandates that any envelope-shape change for an action with a typed `outputSchema` (e.g., `WorkflowUpdateOutputSchema` for `exarchos_workflow.update`) must update the registration. `merge_orchestrate` does NOT have a typed outputSchema — it registers `EnvelopeSchema(z.unknown())` at the dispatch layer (verified at `servers/exarchos-mcp/src/registry.ts`). The event payload schema (`MergePreflightData` in `event-store/schemas.ts:1146`) is the source-of-truth for `merge.preflight` event shape; it gains the optional `debug` branch and is enforced at event-store append time, not at the action's envelope boundary.

**Authoritative integration point for PR2:** Extend `MergePreflightData` in `servers/exarchos-mcp/src/event-store/schemas.ts` with `debug: MergePreflightDebugData.optional()`. No `registeredOutputSchema` call in `merge-orchestrate.ts` needs updating. (A future PR that promotes `merge_orchestrate`'s action outputSchema from `EnvelopeSchema(z.unknown())` to a typed envelope WOULD need to thread the debug branch through that contract — but that's out of scope here.)

## Per-PR design

### PR1 — #1374 saga-merge-detour wire restoration

**Investigation step (mandatory before fix):** Run `npm run test:run -- test/process/saga-merge-detour.test.ts` against current main. Add `console.error` instrumentation at three sites — (a) the `task_complete` handler's event emission (does `data.worktreePath` actually carry?); (b) the rehydration reducer's worktreePath fold (does `phase` flip to `merge-pending`?); (c) `nextActionsFromResult`'s shape-2 read (does the post-Wave-0 envelope still expose `data` or has it migrated to `structuredContent`?). The failure point determines the fix surface — do not write a fix without first knowing where the chain breaks.

**Anticipated fix (subject to investigation):** If hypothesis (a) — patch `servers/exarchos-mcp/src/orchestrate/task-complete.ts` to thread `result.worktreePath` into the emitted `task.completed` event's `data.worktreePath`. If hypothesis (b) — patch `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`'s `extractWorktreePath` helper. If hypothesis (c) — patch `servers/exarchos-mcp/src/next-actions-from-result.ts` to also read `result.structuredContent.workflowState` when `result.data.workflowState` is empty.

**Outcome test:** No new test needed — the existing `test/process/saga-merge-detour.test.ts` is the contract and is currently failing. Optionally add a unit-level pin in `next-actions-computer.test.ts` covering the exact post-fix path so a future regression is caught at the unit tier before the saga tier.

**Acceptance:** `test/process/saga-merge-detour.test.ts` passes on the PR's head; no other process-tier test regresses; PR body links the diagnostic transcript showing which hypothesis was correct.

### PR2 — #1362 Windows preflight instrumentation

**Deltas:**

1. Extend `servers/exarchos-mcp/src/orchestrate/pure/merge-preflight.ts` with a `gatherPreflightDebug(gitExec, repoRoot, source, target): PreflightDebug` pure helper. Returns the debug block schema documented in §Verified surfaces. All git invocations through the injected `gitExec` — no direct shellouts.
2. Modify `mergePreflight` so when `process.env.EXARCHOS_PREFLIGHT_DEBUG === '1'` AND `ancestry.passed === false`, the returned `PreflightResult` carries a `debug` field populated by `gatherPreflightDebug`.
3. Extend the `merge.preflight` event payload schema (`servers/exarchos-mcp/src/event-schemas/merge.ts` or equivalent) with an optional `debug?: PreflightDebugSchema` branch. Register against the action's `outputSchema` so the carrier validates.
4. Document `EXARCHOS_PREFLIGHT_DEBUG=1` in `skills-src/merge-orchestrator/SKILL.md` under a new "Diagnostics" section.
5. Run `npm run build:skills` to regenerate per-runtime variants. CI `skills:guard` re-renders and fails on drift; this PR must include the regenerated `skills/` tree.

**Outcome test (`tests/outcome/preflight-debug.test.ts`):** Linux-only. Drives the preflight handler twice — once with `EXARCHOS_PREFLIGHT_DEBUG` unset (assert no `debug` field), once with it set AND a forced ancestry failure (assert `debug` field is present and shape-matches the schema). Does NOT attempt to reproduce the Windows-specific bug — that's phase 2.

**Acceptance:** Env-gated payload behaves as designed; no-op default; skill mentions the env var; carrier validation passes.

### PR3 — Outcome-tier completeness backfill

**Three new tests (each ~80-120 LOC, modeled on the existing seed tests):**

- **`tests/outcome/reserved-fields-discoverability.test.ts` (#1360)** — handler-direct invocation of `handleDescribe({tools: ['exarchos_workflow'], actions: ['update']})` asserting `reservedFields` block presence + schema. Second `it()` block: call `handleUpdate` with a reserved field, assert `success: false` + `error.code === 'RESERVED_FIELD'` + `error.data.rejectedPath` + `error.data.rule` + `error.data.alternateWritePath` all populated.
- **`tests/outcome/runbook-merge-orchestration.test.ts` (#1363)** — handler-direct invocation of `handleRunbook({phase: 'merge-pending'})`. Assert `success: true`, `data` is a non-empty array, the four-event canonical sequence (`merge.requested → merge.preflight → merge.executed → merge.completed`) is enumerated with correct event types.
- **`tests/outcome/telemetry-action-errors.test.ts` (#1364)** — saga-shape: drive a workflow into a structured-failure handler (e.g., `workflow.update` with a reserved field, forcing a `RESERVED_FIELD` envelope error). Then call `handleViewTelemetry` and assert `actionErrors >= 1` AND `actionErrorBreakdown['RESERVED_FIELD'] >= 1` AND transport-tier `errors` counter stays at 0 (the split that landed in #1393).

Each test is standard pass/fail (no `it.fails` — the production fixes already landed). The PR ships pure test code; no production changes.

**Acceptance:** All three tests pass against current main; `npm run test:outcome` aggregate stays green; coverage matrix updated in `tests/outcome/_helpers/README.md`.

## Axiom design constraints (DIM-1..DIM-8 applied)

- **DIM-1 (Topology):** No new state stores, no new tools. Bundle extends an existing event schema (#1362). Single source of truth preserved: `outputSchema` registered in dispatch-core; reserved-fields rule lives in `workflow/schemas.ts:isReservedField`. ✅
- **DIM-2 (Simplicity):** Each PR is a focused change. PR1 surgical fix, no refactoring; PR2 one new helper, one schema field; PR3 pure test code. No premature abstractions. ✅
- **DIM-3 (Verification):** Atomic RED→GREEN flip on PR1 (saga test currently RED → GREEN after fix). PR2 outcome test asserts env-var gating shape. PR3 backfills coverage where unit/integration was thin. ✅
- **DIM-4 (Hardening):** PR2's `gatherPreflightDebug` is fail-closed: if any git invocation fails, the helper returns a partial debug block with the failure recorded — does not crash the preflight. Env-var gating ensures the payload never ships in production by default. ✅
- **DIM-5 (Observability):** PR2 is itself observability work — the debug block IS the observability surface. PR3 makes telemetry observable from outcome-tier. ✅
- **DIM-6 (Coherence):** All three PRs share the carrier discipline established by Wave 0. Anywhere a new envelope field appears (PR2), it's registered against the `outputSchema`. The outcome-test pattern is consistent across PR1 and PR3. ✅
- **DIM-7 (Resilience):** PR2's debug block degrades gracefully on git failures (DIM-4 above). PR1's fix should be the minimum delta needed to restore the contract — no opportunistic refactoring of the surrounding next-action surface. ✅
- **DIM-8 (Sustainability):** Outcome-tier backfill creates durable contracts for the #1360/#1363/#1364 fixes so future refactors cannot silently regress them. ✅

## Design invariants (INV-1..INV-6 verified)

- **INV-1 (Event-sourcing integrity):** PR2's debug block lives on the `merge.preflight` event payload, not a side channel. No projection bypasses the event store. PR1's fix restores an event-sourced contract (`task.completed{worktreePath}` → reducer-folded merge-pending phase). ✅
- **INV-2 (Facade equivalence):** No new tools or actions; all changes flow through the shared dispatch core. CLI/MCP parity preserved automatically. ✅
- **INV-3 (Basileus-forward):** No `agent` verb usage; nothing in this bundle pre-empts Basileus reservations. ✅
- **INV-4 (Platform-agnosticity):** PR2 itself is Windows-targeted instrumentation but the implementation is platform-agnostic — env-var read, git-command shellout, payload assembly are all cross-platform. PR3's outcome tests are Linux-only (existing tier convention). ✅
- **INV-5a (Agent-first input):** PR2's `EXARCHOS_PREFLIGHT_DEBUG=1` is an env var (agent-friendly: set once, applies to all invocations) not a per-call flag. ✅
- **INV-5b (Spec-aligned output contract):** PR2's debug block is in the registered event schema; PR3's outcome tests assert envelope-shape contracts surfaced by #1359/#1360/#1364 fixes. ✅
- **INV-5c (Aspire-inspired verbs):** No new verbs introduced. `merge_orchestrate` (restored by PR1) was already in the verb catalog. ✅
- **INV-5d (Action discriminator):** No discriminator changes; PR1 restores the existing discriminator path. ✅
- **INV-6 (Workflow-agnosticism):** PR2's instrumentation is a behavior of the merge-orchestrator skill, not a workflow-specific feature. PR3's outcome tests target operator-visible behavior, not workflow types. ✅

## Sequencing notes

- **PR1 lands first.** The saga test is failing process-tier CI today; restoring the wire is the highest-priority unblock and has zero coupling to the other two PRs.
- **PR2 lands second.** New schema field; doesn't depend on PR1. Carrier registration is the most fragile work in the bundle — land it early so any registration-time issue surfaces with maximum review attention.
- **PR3 lands last.** Pure test code; landing it after PR1+PR2 means the outcome-tier sweep captures the final post-fix state. Partially closes #1354 on merge (#1365 stays open for the eval-suite redesign).

## Out of scope (deferred to eval-suite redesign / v2.10.0 GA / v2.11)

- **#1365 eval-suite elevation** — entire scope deferred to the eval-suite redesign. Context seed at `docs/research/2026-05-15-eval-suite-redesign-seed.md`. Will run a fresh `/exarchos:ideate` pass with the two-tier architecture (Tier A harness-surface tests + Tier B behavioral evals on the dotnet/skills pattern). The {{TOKEN}} placeholder system in `skills-src/` encodes harness mechanics, not behavior — building versioned-dataset/dashboard on top of the current eval format would burn the cost twice once the redesign lands.
- **#1362 phase 2** — Windows root-cause fix. Awaits one Windows-host event with the new debug payload. Phase-2 issue to be filed once data lands.
- **#1387, #1396, #1397** — eval follow-up issues. Commented to note the redesign; rescoped or superseded by the redesign as appropriate.
- **Outcome-tier coverage for #1362 instrumentation IN ACTION** (i.e., reproducing the false-positive). Linux-only outcome tier cannot reproduce the Windows-specific bug; we only test the env-gated payload shape.
- **Refactoring `next-actions-from-result.ts`** beyond what PR1's fix requires (e.g., #1238's Zod discriminated unions). Separate issue.

## Acceptance criteria (epic-level)

- [ ] PR1 — `test/process/saga-merge-detour.test.ts` passes.
- [ ] PR2 — `EXARCHOS_PREFLIGHT_DEBUG=1` produces the debug block on ancestry-failed preflights; default behavior unchanged; event schema validates.
- [ ] PR3 — Three new outcome tests pass against the post-fix state.
- [ ] Carrier-Wave / dogfood-Wave checklist for this bundle is updated (`MergePreflightDebugData` added to the `MergePreflightData` event schema).
- [ ] `#1354` epic body checkboxes flipped on each PR merge for #1374, #1362; epic partially closes on PR3 merge (#1365 stays open pending redesign).
- [ ] Follow-up issue filed for #1362 phase 2 (Windows root cause; awaits debug-payload data from a Windows host).
- [ ] Eval-suite redesign seed doc written (`docs/research/2026-05-15-eval-suite-redesign-seed.md`).

## Open questions for plan-review

1. Should PR2's `gatherPreflightDebug` also run when `ancestry.passed === true` for symmetry? Phase-1 issue scopes "only on failure" to keep the event store quiet; symmetry helps future Phase 2 root-cause analysis. (Recommendation locked at plan-review: failure-only, per DIM-8.)
2. PR1 hypothesis — should the implementer be authorized to add `console.error` instrumentation temporarily, or must they reason from logs only? (Authorized at plan-review with mandatory removal in T1.3.)
