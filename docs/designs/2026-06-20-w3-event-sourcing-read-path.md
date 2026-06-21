# Design: v2.11.0-preview.1 Wave 3 — event-sourcing read-path hardening (execution)

> **Type:** Feature design (execution slice of an approved umbrella)
> **Date:** 2026-06-20
> **Workflow:** `v2-11-w3-es-read-path` (feature)
> **Milestone:** v2.11.0 — Verification & Reliability
> **Issues:** #1556 (R4 upcasting) · #1504 (R1 delete `.state.json`) · #1554 (R2 one reducer)
> **Parent design:** [`docs/designs/2026-06-19-v2.11.0-preview.1.md`](2026-06-19-v2.11.0-preview.1.md) §6 — the *what* and the structural guards are settled there; this doc is the *how* (execution shape, grounded seams, the #1504 audit gate).
> **Source research:** [`docs/research/2026-06-18-event-sourcing-leverage-study.md`](../research/2026-06-18-event-sourcing-leverage-study.md) §R1, R2, R4.

---

## 1. Scope & framing

This is the **last open wave** of the v2.11.0-preview.1 cut. W1 (#1542, #1307) and W2 (#1525) are on `main`; the enabler **#1555** (bounded-fold primitive — `projectAt` / `diffStates` / `bisect`) shipped CLOSED (`main` `97a4a98a`). Its counterfactual / alt-reducer replay and cheap golden fixtures are therefore **available now** to de-risk this wave.

We do **not** re-design here — parent §6 owns the decisions. This doc pins the three execution facts §6 left to planning:

1. the **execution shape** (a single linear stack — §2),
2. the **#1504 field-coverage audit** as an explicit gated first task (§3.2), the one real risk in the wave, and
3. **grounded seams** (current line numbers, sibling gates to clone) so /plan can decompose without re-discovery.

**Precondition — satisfied.** #1504 sequences "after the `refactor-1486` gate-handler migration." That migration (#1499) merged in **PR #1506 on 2026-05-31**; the 7 gate handlers already resolve via `resolveWorkflowState`. #1504/#1554 are unblocked.

## 2. Execution shape — one linear stack

```
#1556 ──> #1504 ──> #1554 ──> main      (bottom-up merge)
 base      base       tip
```

A single bottom-up stack, each PR based on the one below via `--base` chaining (github-native; **never** Graphite). Merge order: #1556 → main, then rebase/merge #1504, then #1554.

**Why a stack and not parallel tracks.** §6's graph allows #1556 to run independently, but all three land in the **same preview tag** and all three add a CI gate plus golden-replay fixtures over the same event corpus. A linear stack gives one reviewable increment chain, one consistent fixture base, and no cross-track rebase churn when #1555's fixture helpers are extended in #1556 and reused by #1504/#1554. The cost — #1556 cannot merge until the stack is green — is acceptable: #1556 is the smallest, lowest-risk slice and merges first.

**Dispatch discipline** (per repo conventions): each slice is implemented on its own branch from the correct base tip, **never from `main`** mid-stack; merges run only from the main worktree; insert a checkpoint at each PR boundary. The #1504→#1554 ordering is load-bearing — #1504 deletes fold #3 (`applyEventToState`), and #1554's consolidation is incoherent while that fold still exists.

## 3. Per-slice execution

### 3.1 #1556 (R4) — wire upcasting at the query choke point *(stack base)*

**Seam.** `store.ts:495` `query()` returns `this.getReadBackend().queryEvents(streamId, filters)` verbatim. Map every returned row through `migrateEvent` (event-migration.ts:40) here — the single seam every reader passes (rehydrate, reconcile, views, `resolveWorkflowState`). Also upcast the two cache-hit branches that pass `schemaVersion` through verbatim (issue cites `store.ts:373,481`). Identity no-op today (`eventMigrations:[]`, `EVENT_SCHEMA_VERSION:'1.0'`), load-bearing the instant a migration registers.

**Structural guards (the point of the issue):**
- **(a) No-bypass CI gate** — forbid constructing a `WorkflowEvent` from a raw backend row anywhere except the `query` choke point. Clone the existing `scripts/check-event-store-composition-root.mjs` (the `Database`-import gate) + its `.test.ts`; red/green fixtures.
- **(b) Version-coverage build-time test** — assert every `schemaVersion < EVENT_SCHEMA_VERSION` has a migration path to current; bumping `EVENT_SCHEMA_VERSION` *or* changing an event's Zod shape without a matching migration **fails the build**.
- **(c) Golden-log replay corpus** — pinned historical-version rows that must keep replaying green across a version bump. Cheap now that #1555 landed (alt-reducer replay).

Snapshots already invalidate on `schemaVersion` mismatch (`views/snapshot-store.ts:130`) — a bump forces a clean cold rebuild *through* the upcaster; no stale snapshot survives. Unblocks #1296 (the first real migration, out of scope here). **Invariant:** INV-1 (log immutable; evolution read-time), INV-5b (carrier preserved). **Effort:** S. **Risk:** low (additive no-op seam).

### 3.2 #1504 (R1) — delete the legacy `.state.json` path

**The gate is an audit, not a deletion.** Task 1 of this slice is a **field-coverage audit**: enumerate every datum that today lives *only* in `<featureId>.state.json` and prove each is (i) event-sourced and (ii) folded by `workflowStateProjection`. Any file-only datum with no backing event is a blocker surfaced **before** any deletion — it becomes an emit-the-event sub-task, not a silent drop. #1555's `diffStates` over real history is the proof tool: project a representative log with vs. without the file path and assert equivalence.

**Then the change.** Make `resolveWorkflowState` (`resolve-state.ts`) **event-store-first**: when `featureId` + `eventStore` are present, materialize from `workflowStateProjection` (line 92 path) and remove the file-first branch at line 80 (`if (opts.stateFile && existsSync(...))`). Stop *writing* the file (retire its `_eventSequence` cursor + `_version` CAS). Migrate the ~10 call sites still passing `stateFile` to the event-store-only form the already-safe callers use. Preserve a file-only fallback **only** where no `eventStore` is available (CLI/legacy) if the audit proves it still needed — otherwise delete the param.

**Structural guard.** CI gate: no production code reads or writes `*.state.json` (red/green fixtures). **Invariant:** INV-1 (SQLite sole SoT), INV-2 (resolution identical across CLI/MCP facades). **Effort:** M (audit-dominated). **Risk:** med — the audit is where the unknowns are; see §5.

### 3.3 #1554 (R2) — one canonical `workflow-state@v1` reducer *(stack tip)*

**Collapse three folds + one manual table into one.** Today: `workflowStateProjection` (ViewProjection v1.1, `views/workflow-state-projection.ts`), `rehydrationReducer` (`rehydration@v1`, `projections/rehydration/reducer.ts:837`), and the manual `INITIAL_PHASE` map (`workflow-state-projection.ts:15`, flagged "kept in sync with `getInitialPhase`"). Fold #3 (`applyEventToState`, `state-store.ts:764`) is already gone via #1504.

Promote `workflowStateProjection` (most complete, already the materializer) to a single registered `workflow-state@v1` `ProjectionReducer` alongside `taskstore`/`merge-orchestrator`; bridge `ViewProjection ↔ ProjectionReducer` (both are `initial`/`init` + `apply`). Every reader folds through it; `INITIAL_PHASE` derives from the HSM (`getInitialPhase`), not a hand-synced copy.

**Structural guards (strongest first):**
- **(a) Compile-time exhaustiveness** — `switch (event.type)` with `default: assertNever(event.type)`; an unhandled new event type is a **type error** (or listed in an explicit observability-only no-op set).
- **(b) Single-fold CI gate** — `scripts/check-single-workflow-fold.mjs` (sibling of `check-begin-immediate-substrate.sh`): any `switch (event.type)` over `WorkflowEvent` outside the canonical module fails the build.
- **(c) Registry singularity** — extend the existing duplicate-`id` throw to reject a second reducer claiming the `workflow-state` domain.

**Golden replay** equates pre/post-consolidation projection over a representative log (byte-equal), cheap via #1555. **Depends on #1504.** **Invariant:** INV-1 (one left-fold). **Effort:** M. **Risk:** med (touches the rehydrate + view read paths).

> **Addendum (2026-06-20, implementation) — `rehydrationReducer` is a distinct projection, not a redundant fold.** The "collapse three folds" framing above mis-counted: `rehydrationReducer`'s embedded `workflowState` is **not** a duplicate of the canonical `workflow-state@v1` fold. It carries intentionally divergent semantics that the canonical (file-equivalent, per #1504) fold must *not* reproduce: (1) `phase` stays `''` after `workflow.started` — the canonical fold seeds `phase=getInitialPhase(type)` to match the on-disk state the #1504 equivalence proof pins; (2) a `task.completed`-with-worktree → `merge-pending` detour plus phase-reversion-to-`delegate`, with a minimal `{taskId, phase}` `mergeOrchestrator` shape (the canonical fold writes the richer terminal block mirroring the old `applyEventToState`, and never touches `phase`); (3) it folds `merge.aborted`, which is not even a built-in `EventType`; (4) all-or-nothing `featureId`/`workflowType` bail and `projectionSequence` tracking. A naive repoint would break 11 dedicated rehydration tests **and** the #1504 file-equivalence invariant for net-negative value. **Decision:** rehydration produces `RehydrationDocument` (a different projection), so INV-1 — *one* left-fold per `WorkflowStateView` — is already satisfied by `workflow-state@v1` alone. Guard (b) is therefore scoped to **`WorkflowStateView`-producing folds**; `rehydrationReducer` / `taskstore` / `merge-orchestrator` / `next-action` (which produce other state shapes) are exempt by construction. Delivered in 1554-3: the manual `INITIAL_PHASE` table → HSM derivation (fold component #3 collapsed; latent `discovery` drift fixed). The rehydration repoint (3b) is deliberately not performed.

## 4. Invariant conformance matrix

| Issue | Primary | Also | Guard added |
|---|---|---|---|
| #1556 | INV-1 (read-time evolution) | INV-5b | no-bypass + version-coverage CI gates; golden corpus |
| #1504 | INV-1 (SQLite sole SoT) | INV-2 (facade parity) | field-coverage audit gate + no `*.state.json` read/write CI gate |
| #1554 | INV-1 (one left-fold) | — | `assertNever` + single-fold gate + registry singularity |

**Guardrails held:** **INV-15** — no saga/2PC/leader-election/distributed-locks/vector-clocks; the upcaster and every fold stay local and read-time. **INV-3** — all three transport-agnostic; a future remote tier costs nothing. The design is run through `check_invariant_conformance` before plan approval.

## 5. Risks

| Risk | Mitigation |
|---|---|
| #1504 audit finds a file-only datum with no backing event | Audit is the **gate** before any deletion; emit-the-event becomes a sub-task; #1555 `diffStates` proves projection equivalence over real history before the file path is removed |
| #1554 consolidation diverges from current behavior | Golden-replay byte-equivalence over a representative log; `assertNever` is the completeness proof |
| Stack base churn (#1556 fixtures reused downstream) | Single linear stack chosen specifically to keep one fixture base; rebase bottom-up only |
| #1554 dispatched before #1504 merges | Hard order enforced — #1554 branches from #1504's tip, not `main`; checkpoint at each PR boundary |

## 6. Acceptance

W3 (and thus the `v2.11.0-preview.1` tag) is complete when, on `main`:
- **#1556** — `migrateEvent` wired at `query`; no-bypass + version-coverage gates green; golden-log corpus replays across a version bump.
- **#1504** — field-coverage audit clean (or its emit-the-event sub-tasks landed); `.state.json` read/write deleted; no-read/write gate green; `resolveWorkflowState` event-store-first with CLI/MCP parity intact.
- **#1554** — one `workflow-state@v1` reducer registered; `assertNever` + single-fold gate + registry-singularity throw in place; golden replay byte-equal pre/post.
- **Gates:** `npm run test:run` (root + `servers/exarchos-mcp`), `npm run typecheck`, `npm run lint:invariants`, `npm run skills:guard` green at each PR boundary; `check_invariant_conformance` clean on this design.
