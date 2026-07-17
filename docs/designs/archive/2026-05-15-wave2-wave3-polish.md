# v2.10.0-preview.4 — Wave 2 + Wave 3 Polish Bundle

**Feature ID:** `v2-10-0-preview-4-wave2-wave3-polish`
**Epic:** [#1354](https://github.com/lvlup-sw/exarchos/issues/1354) — v2.10.0-preview.3/.4 dogfood remediation
**Milestone:** v2.10.0 — Agent Output Contract
**Scope:** #1359, #1360, #1363, #1364 (defers #1362 Windows preflight, #1365 eval-suite elevation)
**Date:** 2026-05-15

## Problem

The 2026-05-13 Windows dogfood session surfaced eight verified findings against the live MCP surface. Wave 1 (#1388, merged 2026-05-15) closed the data-safety findings (#1355, #1356, #1357, #1358) and landed the INV-6 audit (#1361). Four operator-trust + diagnostics findings remain open inside the v2.10.0 milestone:

- **#1359 — projection drift.** `rehydrate.taskProgress` and `view pipeline.completedCount/taskCount` diverge from canonical `tasks[].status`. One observed session reported 53 vs 67 `taskCount`, 20 vs 56 `completedCount`. An agent that trusts `rehydrate` as ground truth re-dispatches completed work. A `RED-by-design` outcome test (`tests/outcome/rehydrate-projection-drift.test.ts`) is parked under `it.fails` waiting for an atomic flip in the fix commit.
- **#1360 — RESERVED_FIELD discoverability.** `exarchos_workflow update` rejects writes to reserved keys with `RESERVED_FIELD: Cannot update reserved field: <key>`; the reserved set is undocumented in `describe`, in the skill, and in the error envelope. Callers trial-and-error the boundary.
- **#1363 — merge-pending runbook.** `exarchos_orchestrate({action: 'runbook', phase: 'merge-pending'})` returns `data: []`. The other three phases return populated runbooks; only the heaviest skill (`merge-orchestrator`, ~12KB) has no structured runbook.
- **#1364 — telemetry undercounts action-level errors.** `view telemetry.errors` reports `0` even when handlers returned the standard MCP-envelope structured failure (`{success: false, error: {...}}`). Only JS `throw` reaches the error counter, so all `MERGE_ROLLED_BACK`, `PREFLIGHT_FAILED`, `RESERVED_FIELD` outcomes are invisible.

All four are dogfood-surfaced — every recommendation in the source issues names file paths and line numbers. The bundle is operator trust + diagnostics polish, intentionally separated from #1362 (needs Windows host repro) and #1365 (multi-step substrate feature).

## Verified root causes

### #1359 — two compounding bugs

**Bug A (pipeline view does not fold plan state):** `views/pipeline-view.ts:74-90` increments `taskCount` only on `task.assigned` and `completedCount`/`failedCount` only on `task.completed`/`task.failed`. The view never folds `state.patched` events, so `workflow.update({tasks: [...]})` mutations — which emit `state.patched`, not `task.*` — are invisible to all three counters.

**Bug B (rehydrate reducer normalizes status vocabulary):** `projections/rehydration/reducer.ts:241-249` maps `rawStatus === 'complete' || rawStatus === 'completed' → 'completed'`. Canonical `tasks[].status` (per workflow `TaskSchema`) is `'complete'`. The projection's output vocabulary therefore diverges by a label rename from the canonical state. The parked RED test asserts `byId.get('T001') === 'complete'` and sees `'completed'`. The rehydrate fold otherwise works: `state.patched` IS folded into `taskProgress` via `applyStatePatched → foldPlanTasks` (post #1179 fix), with monotonic status promotion.

The rehydrate fold has the right *mechanism* with the wrong *vocabulary*. The pipeline view has neither.

### #1360 — silent rule, three layers

`workflow/schemas.ts:515-528` defines `isReservedField` as top-level `phase|workflowType|featureId|createdAt|version` PLUS any dot-path containing an underscore-prefixed segment. `state-store.ts:553-557` throws `StateStoreError(RESERVED_FIELD, "Cannot update reserved field: ${dotPath}")` with no structured payload. Neither the rule nor the error surfaces in `describe`, in the `workflow-state` skill, or in any structured carrier. The error envelope ships only the string message.

### #1363 — registry omission

`servers/exarchos-mcp/src/runbooks/definitions.ts` registers `TASK_COMPLETION`, `QUALITY_EVALUATION`, `AGENT_TEAMS_SAGA`, `SYNTHESIS_FLOW`. No `MERGE_ORCHESTRATION` entry exists; `exarchos_orchestrate runbook` returns empty for `phase: 'merge-pending'`.

### #1364 — middleware emits wrong event on structured failure

`telemetry/middleware.ts:140-145` (success branch) emits `tool.completed` on *any* return — including `{success: false, ...}`. `telemetry/middleware.ts:224-234` (catch branch) emits `tool.errored` only on JS `throw`. The `view telemetry` projection counts only `tool.errored`. Structured action-level failures pass through as completions.

## Design overview

Four orthogonal fixes share one cross-cutting axis: **three of them extend a registered `outputSchema`** because Wave 0 (#1369) just landed the carrier swap. Every envelope-shape change in this bundle must register against its action's `outputSchema` or the carrier validation will reject it.

The outputSchema surface area:

| Issue | Surface | Schema delta |
|---|---|---|
| #1359 | `exarchos_workflow.rehydrate`, `exarchos_view.pipeline` | `projectionAsOf: ISO string`; `_meta.projectionLag?: number` |
| #1360 | `exarchos_workflow.update` (error branch) | `error.data: { rejectedPath, rule, alternateWritePath }` |
| #1364 | `exarchos_view.telemetry` | `actionErrors: number`; `actionErrorBreakdown: Record<string, number>` |
| #1363 | n/a (registry-only) | — |

The bundle does not introduce new actions, verbs, tools, or platforms; it adds structured information to existing carriers and closes one omitted runbook.

### #1359 — projection drift (two-bug fix)

**Pipeline view (Bug A).** Introduce `tasksById: Map<id, status>` into `PipelineViewState` (or equivalent record — Map serializes via the materializer). Fold `state.patched` events: `extractPlanTasks(event.data)` returns `[{id, status}]`; merge each id with monotonic precedence matching the rehydrate reducer (`pending(0) < assigned(1) < complete(2) ≈ failed(2)`). Derive counters from the map: `taskCount = map.size`, `completedCount = count(status === 'complete')`, `failedCount = count(status === 'failed')`. Continue to handle `task.assigned`/`task.completed`/`task.failed` for events-only paths (executor flows that never round-trip through `workflow.update`).

**Rehydrate reducer (Bug B).** Drop the `'complete' → 'completed'` normalization at `reducer.ts:243-247`. Surface the canonical `tasks[].status` vocabulary (`pending | in_progress | complete | failed`) directly. Update `RehydrationDocumentSchema` and the `TaskProgressStatus` union accordingly. The schema rev bumps `v` (currently `v: 3`) because the status label set widens — handle via existing `upgrade.ts` projection-version mechanism: old documents with `'completed'` upgrade to `'complete'` on read.

**Freshness exposure (INV-5b output contract).** Both projections emit `projectionAsOf: ISO timestamp` from the latest event folded. Both emit `_meta.projectionLag: ms` when the gap between `Date.now()` and `projectionAsOf` exceeds 5s. The 5s threshold mirrors the existing `_perf` window heuristic; document the threshold inline.

**Reconcile gate.** Add a `projection-drift` check to `reconcile_state`. The check compares `view pipeline.completedCount` to `count(state.patched.patch.tasks[].status === 'complete')` derived from event-fold of the same stream. Disagreement → reconcile reports the drift with the two counts; today it returns `PASS 5/5` in the presence of this drift.

**Atomic RED→GREEN flip.** `tests/outcome/rehydrate-projection-drift.test.ts:40` parks the contract under `it.fails`. The fix commit removes the `it.fails` annotation in the same commit as the projection change; the outcome-test tier runs in CI and locks the contract.

### #1360 — describe, structured error, skill

**describe enumeration.** Extend the `describe(actions: ['update'])` response to include a `reservedFields` block:

```jsonc
{
  "reservedFields": {
    "rule": "Top-level keys 'phase', 'workflowType', 'featureId', 'createdAt', 'version' are immutable; any dot-path containing an underscore-prefixed segment is server-managed.",
    "topLevelImmutable": ["phase", "workflowType", "featureId", "createdAt", "version"],
    "underscorePrefixed": "any path matching /(^_|\\._)/",
    "examples": ["_version", "_checkpoint.summary", "_eventHints"],
    "alternateWritePaths": {
      "phase": "exarchos_workflow({action: 'transition', target: '<phase>'})",
      "_checkpoint": "managed by prune_stale_workflows / checkpoint cadence",
      "_version|_esVersion|_perf|_meta|_eventHints": "server-managed; no write path"
    }
  }
}
```

The block lives in the `describe` outputSchema branch; the alternate write paths read from a single source-of-truth table that the workflow handlers also consume so doc and behavior cannot drift.

**Structured error.** Extend `StateStoreError` to carry typed `data`. `RESERVED_FIELD` instances populate `data: { rejectedPath, rule, alternateWritePath }`. The MCP envelope's error branch already has an open `data` slot in the carrier; this fix registers the typed shape in `exarchos_workflow.update`'s error branch outputSchema.

**Skill section.** Add "Reserved fields" subsection to `skills-src/workflow-state/SKILL.md` listing the rule, examples, write paths. Cross-link from `skills-src/merge-orchestrator/SKILL.md` (because `mergeOrchestrator` is one of the writeable nested objects and merge-orchestrator authors hit this boundary). Run `npm run build:skills`; commit regenerated `skills/`.

### #1363 — merge-pending runbook

Add `MERGE_ORCHESTRATION` to `runbooks/definitions.ts` per the issue spec:

```ts
export const MERGE_ORCHESTRATION: RunbookDefinition = {
  id: 'merge-orchestration',
  phase: 'merge-pending',
  description: 'Land a subagent worktree branch onto integration with preflight + recorded rollback.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      params: { dryRun: true }, onFail: 'stop',
      note: 'Preflight: ancestry, target-worktree-availability (post-#1356), current-branch, drift.' },
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      onFail: 'continue',
      note: 'Real merge. preflight-fail → aborted (no executor). merge-fail → rolled-back (post-#1356: structured target-worktree-busy categorization).' },
    { tool: 'exarchos_workflow', action: 'transition',
      params: { target: 'delegate' }, onFail: 'continue',
      note: 'HSM exits merge-pending back to delegate regardless of merge outcome.' },
  ],
  templateVars: ['featureId', 'taskId', 'sourceBranch', 'targetBranch', 'strategy', 'repoRoot'],
  autoEmits: ['merge.preflight', 'merge.executed', 'merge.rollback', 'workflow.transition'],
};
```

Wire into the runbook registry. Extend `decision-runbooks.test.ts` with two cases: `runbook(phase: 'merge-pending')` returns populated array; the `templateVars` placeholders resolve when the workflow state supplies them.

### #1364 — split transport vs action-level errors

**Middleware.** In `telemetry/middleware.ts` success branch, detect `result.success === false` after the handler returns. Emit `tool.action_errored` alongside `tool.completed` with the same `durationMs`, `responseBytes`, `tokenEstimate`, plus `errorCode: result.error?.code ?? 'UNKNOWN'`. Catch branch unchanged: `throw` still produces `tool.errored`. The distinction: `tool.errored` = transport/protocol-level (the wire was bad), `tool.action_errored` = handler returned structured failure (the operator got an envelope error).

**Telemetry projection.** Extend `telemetry-projection.ts` to fold `tool.action_errored`. Per-tool aggregations gain `actionErrors: number` and `actionErrorBreakdown: Record<errorCode, number>`. `errors` continues to count only `tool.errored` — semantics preserved.

**view.telemetry outputSchema.** Register the two new fields in `exarchos_view.telemetry`'s outputSchema. Schema delta is additive (no removals) so no client-side breaking change.

## Architectural choices considered

### Pipeline-view fold strategy

| Option | Approach | Verdict |
|---|---|---|
| A — recommended | `tasksById: Map<id, status>` in view state; derive counters as map operations | Mirrors the rehydrate reducer's mechanism; one source of truth per task; no double-count risk |
| B | Keep incremental counters; also increment on `state.patched` when status crosses boundary | Requires diffing the previous status of every task; cannot reconstruct from cold start without remembering last status anyway — collapses into A |
| C | Compute counters by re-folding canonical `tasks[]` snapshot every time | Violates ViewProjection's incremental-fold contract; quadratic in events |

Choosing A keeps the pipeline view and the rehydrate reducer mechanically identical on the relevant axis (both keyed by `id`, both monotonic in status precedence).

### #1359 vocabulary normalization

| Option | Approach | Verdict |
|---|---|---|
| A — recommended | Surface canonical `'complete'` (drop normalization); bump projection version | Aligns projection with canonical schema; one-time upgrade path is straightforward |
| B | Document `'completed'` as the projection's canonical vocabulary; update canonical `TaskSchema` to match | Wider blast radius; touches every task surface; breaks consumers |
| C | Surface both `status` and `canonicalStatus` | Doubles the contract surface; only useful as a migration intermediate |

A minimizes blast radius and aligns with the issue's explicit acceptance criterion (`rehydrate.taskProgress[i].status` matches `tasks[i].status`).

### #1364 emit strategy

| Option | Approach | Verdict |
|---|---|---|
| A — recommended | Emit both `tool.completed` and `tool.action_errored` on structured failure | Preserves existing `tool.completed` semantics for non-error consumers; additive |
| B | Replace `tool.completed` with `tool.action_errored` on failure | Breaks any consumer that counts completions per tool; collapses `invocations` |
| C | Single `tool.observation` event with success flag | Larger refactor; deferred to a v3.0 telemetry rev if ever |

A is least surprising and preserves the issue's stated split between `errors` (transport) and `actionErrors` (handler).

### PR shape

| Option | Approach | Verdict |
|---|---|---|
| A — recommended | 4-PR stack, bottom-up merge, one PR per issue | Each fix bisectable; matches recent project pattern (Wave 1 PR 1388/1389) |
| B | Two consolidated PRs (Wave 2 / Wave 3) | Faster, but mixes scopes; if one fix regresses, the rebase blast radius doubles |
| C | Single squashed PR | Faster review iteration; harder to bisect; defers acceptance signal |

The 4-PR stack costs ~30 minutes of stack management against substantially cleaner bisection if any of the four turns out to need a follow-up.

## Sequencing

Recommended bottom-up stack order — lowest risk and least surface contact first:

1. **PR 1 — #1363 runbook addition** (registry-only, ~50 LOC + test). Lands first. No interaction with other PRs.
2. **PR 2 — #1360 reserved-fields discoverability** (workflow describe + error envelope + skill docs). Isolated to workflow surface; no telemetry or projection touch.
3. **PR 3 — #1364 telemetry split** (middleware + projection + view outputSchema). Touches shared middleware that every action handler routes through, so any test fallout surfaces here, before PR 4's projection schema bump.
4. **PR 4 — #1359 projection drift** (atomic RED→GREEN flip; pipeline + rehydrate + reconcile + outputSchema; projection version bump). Lands last because its projection schema rev has the widest downstream surface.

Each PR targets the previous PR's branch; merging PR 1 auto-retargets PR 2 to `main`, etc.

## Conformance — Design Invariants

| Invariant | Check | Result |
|---|---|---|
| **INV-1 event-sourcing** | All projection derivations remain event-folded; `state.patched` is the canonical event behind `workflow.update` and is folded by both views | PASS |
| **INV-2 facade equivalence** | All changes in MCP handlers; CLI wrappers inherit via shared dispatch core | PASS |
| **INV-3 basileus-forward** | No basileus surface touch | N/A |
| **INV-4 platform-agnosticity** | Runbook content is structural, not platform-specific; telemetry middleware unaffected by OS | PASS |
| **INV-5a input ergonomics** | #1360 directly improves `describe` discoverability — strong positive | PASS (+) |
| **INV-5b output contract** | Three outputSchema extensions registered with their actions; all envelope changes go through Wave 0 carrier; `next_actions` semantics unchanged | PASS |
| **INV-5c Aspire verbs** | No new verbs; existing actions extended | PASS |
| **INV-5d action discriminator** | No new actions; extensions only | PASS |
| **INV-6 workflow-agnosticism** | #1363 runbook is workflow-typed by design — lives under `runbooks/definitions.ts`, not under skills. #1360 skill edits stay inside `workflow-state` and `merge-orchestrator`, both of which already declare `metadata.workflow-type:` | PASS |

Notable INV-5b consequence: the three outputSchema extensions (#1359, #1360, #1364) realize the "Carrier-Wave / dogfood-wave interaction checklist" from the epic body. Wave 0 (#1369) made these registrations possible; this bundle exercises that surface.

## Conformance — Axiom Dimensions

| Dimension | Concern | Verdict |
|---|---|---|
| **DIM-1 topology** | Pipeline view gains a `Map` field; telemetry middleware gains one conditional emission; no new coupling created | PASS |
| **DIM-2 observability** | #1364 is a direct DIM-2 win (operators can now see structured failures); #1359's `projectionAsOf` is a DIM-2 win | PASS (+) |
| **DIM-3 contracts** | Three outputSchema extensions are registered and tested; projection version bump uses existing upgrade machinery | PASS |
| **DIM-4 test fidelity** | #1359 atomic flip of outcome-tier test; #1363 decision-runbooks coverage; #1364 middleware unit test; #1360 describe + error-data tests | PASS |
| **DIM-5 dead code** | Vocabulary fix removes the `'completed'` normalization branch; audit for `'completed'` literal references during implementation | WATCH |
| **DIM-6 coupling** | Reconcile gate adds one check using existing reconcile facility; no new modules | PASS |
| **DIM-7 error handling** | #1360 turns string error into structured data — DIM-7 win; #1364 makes silent action failures observable | PASS (+) |
| **DIM-8 prose** | Skill docs run through `npm run build:skills` lint; humanize pass on the new "Reserved fields" subsection before commit | PASS |

DIM-5 carries a `WATCH` flag for the implementation: every callsite that branches on `status === 'completed'` against rehydrate output needs to be reviewed; some may legitimately handle both terms during the upgrade window.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Projection version bump invalidates fingerprints / cached projections | Existing `upgrade.ts` mechanism handles old→new doc shape; outcome test covers the upgrade path |
| `'completed' → 'complete'` rename breaks consumers reading `taskProgress[].status` | Bump projection version; document the rename in the PR body; surface the change in `next_actions` migration hints if any |
| Pipeline-view `Map` materializer serialization fragility | Materializer already serializes Map state for the agent-team views (`teamPerformanceView`); use the same pattern |
| Stack-conflict thrash if Wave 1 follow-up PRs land mid-stack | Rebase the stack on `main` between PR merges; project-memory `stale_worktree_after_external_push` documented |
| Telemetry middleware emits a noisy synthetic event per structured failure | `tool.action_errored` carries the same `responseBytes`/`tokenEstimate` as the paired `tool.completed`; aggregation counts both for invocation totals but only `tool.action_errored` for `actionErrors` |

## Acceptance criteria

Composed from the four issue acceptance lists:

- [ ] **#1359**: `tests/outcome/rehydrate-projection-drift.test.ts` GREEN; `it.fails` removed in same commit as fix.
- [ ] **#1359**: `view pipeline.completedCount` equals `count(tasks[].status === 'complete')` from canonical state.
- [ ] **#1359**: `rehydrate.taskProgress[i].status` matches `tasks[i].status` immediately after canonical mutations.
- [ ] **#1359**: `projectionAsOf` + `_meta.projectionLag` present on both `rehydrate` and `view.pipeline` outputSchemas.
- [ ] **#1359**: `reconcile_state` includes `projection-drift` check; drift cases report both counts.
- [ ] **#1360**: `describe('update').reservedFields` present and includes rule + alternate write paths.
- [ ] **#1360**: `RESERVED_FIELD` error carries structured `data: { rejectedPath, rule, alternateWritePath }`.
- [ ] **#1360**: `workflow-state` SKILL has "Reserved fields" section; `merge-orchestrator` cross-links it; `npm run build:skills` regenerates per-runtime variants.
- [ ] **#1363**: `exarchos_orchestrate({action: 'runbook', phase: 'merge-pending'})` returns populated entries with all three steps.
- [ ] **#1363**: `decision-runbooks.test.ts` covers the new runbook.
- [ ] **#1364**: Handler returning `{success: false, error: {code: 'X'}}` appends `tool.action_errored` with `errorCode: 'X'`.
- [ ] **#1364**: `view telemetry` returns `actionErrors` and `actionErrorBreakdown` fields; values are correct against an outcome-tier scenario that exercises a structured failure.
- [ ] **All four PRs**: `npm run typecheck && npm run test:run` clean; `npm run skills:guard` clean; outcome-test tier clean.

## Out of scope (deferred)

- **#1362 Windows preflight phase 1 instrumentation** — needs Windows-host repro to validate the `EXARCHOS_PREFLIGHT_DEBUG=1` payload; ships in a separate bundle once a Windows runner is available or a dogfood session re-produces F2.
- **#1365 eval-suite elevation** — multi-step substrate feature; design surface large enough to warrant its own ideation pass.
- **Full INV-6 audit** of remaining skills (delegation, synthesis, oneshot-workflow, workflow-state) — tracked under #1361 follow-up; not blocking on this bundle.
- **Telemetry dashboard updates** for `actionErrors` — visualization surface follows after the data lands.

## References

- Epic: [#1354](https://github.com/lvlup-sw/exarchos/issues/1354) — v2.10.0-preview.3 epic body + 2026-05-15 Wave 1 comment
- Source remediation report: `docs/research/2026-05-13-windows-dogfood-remediation.md` §4, §5, §7, §8
- Source dogfood findings: `docs/references/2026-05-13-exarchos-dogfood-findings.md` F3, F4, F6
- Wave 0 carrier: PR #1369 (squash `8a732811`, 2026-05-15)
- Wave 1 fixes: PR #1388 (squash `224027b5`, 2026-05-15) — landed parked RED outcome test
- Prior projection bugs (closed, same surface): #1179, #1180
- Design invariants skill: `.claude/skills/design-invariants/SKILL.md`
- Backend quality dimensions: `axiom:backend-quality`
