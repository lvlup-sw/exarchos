# Spec: Worktree Lifecycle Manager — Foundation (ownership + GC)

**Date:** 2026-06-25 · **Feature:** `wlm-foundation` · **Depth:** standard
**Inputs:** parent design [`docs/designs/2026-06-21-worktree-lifecycle-manager.md`](../designs/2026-06-21-worktree-lifecycle-manager.md) (DR-1/2/3, DR-6) · discovery [`docs/research/2026-06-21-treehouse-worktree-mining.md`](../research/2026-06-21-treehouse-worktree-mining.md) · roadmap epic #1574 (children #1575 WLM-1, #1576 WLM-2) · master tracker #1599 (Z2 / v2.12.0)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` (added by `/plan`) maps tasks → DR-N within this same document.
>
> This spec is a **scope-and-decompose** pass over an already-authored epic design. The architecture decisions (Approach A, the alternatives, the full INV conformance matrix) live in the parent design doc and are **cited, not duplicated** (CONTEXT-AUTHORING: link, don't repeat). This document carves the first two shippable slices of #1574 — WLM-1 (#1575) and WLM-2 (#1576) — into one v2.12.0 bundle.

## Design & Rationale

### Problem Statement

Exarchos's git-worktree handling is scattered across `setup-worktree.ts`, `worktree-baseref.ts`, and `dispatch-guard.ts` with **no durable ownership, no liveness model, and no garbage collection**. Two consequences bite us repeatedly:

1. **No crash-safe ownership.** Worktrees carry no durable record of which process owns them. This is the root of the stash-collision hazard (one agent's `git stash pop` pulls a sibling's WIP), the stale-worktree-after-external-push data loss (reusing a worktree silently drops newly-pushed files on commit), and the #1301 boundary leak. Ownership today is convention, not construction.
2. **Zero worktree-disk GC.** `prune-stale-workflows.ts` prunes *stale workflows*, not *worktree disk*. Abandoned `.claude/worktrees/agent-*` directories and backing-repo-missing orphans accumulate **unbounded** — there is no safe reclaim path, and the naive one (`rm -rf` the dir) risks deleting a worktree with uncommitted work (the exact failure in Claude Code #55724: *13 parallel agents, 8 lost uncommitted work*).

The industry has converged on worktree-per-agent as the default isolation primitive (Claude Code, Codex, Cursor 2.0, Copilot), and the failure modes — concurrent git corrupting the shared `.git/`, `index.lock` races, lost uncommitted work on cleanup — are well-documented. This bundle builds the **foundation** that the rest of the Worktree Lifecycle Manager (#1574) stands on: durable, event-sourced ownership (the substrate that later makes liveness queryable) and a **safe** disk GC (the reclaim path that refuses to destroy un-saved work).

### Chosen Approach

**Approach A — event-sourced reconciler with on-demand ground-truth probe** (selected in the parent design over a periodic-scan supervisor and a guard-first MVP; see [parent §Approaches Considered](../designs/2026-06-21-worktree-lifecycle-manager.md#approaches-considered)).

All durable worktree state is a **left-fold over a new `worktree.*` event family** (INV-1) — never a side file (rejecting treehouse's `treehouse-state.json`). Ownership is `{ownerPid, ownerStartedAt}` carried on `worktree.reserved`; `ownerStartedAt` (process create-time) defeats PID reuse, and "heal" is a **reconcile fold** — a reservation whose owner is provably dead is collapsed to `worktree.released` by a probe-fed event, not a mutating loop. Cross-process serialization reuses the existing **StreamLockManager + SQLite WAL** (INV-7) — *no `flock`, no PID lock file*. The GC is a **safety-ladder** (`prune_worktrees`) that defaults to dry-run and **fails closed** — it reports candidates and reclaimable bytes but deletes nothing it cannot prove is safe.

This bundle is the design's own recommended first two slices ([parent Open Question 4](../designs/2026-06-21-worktree-lifecycle-manager.md#open-questions): *DR-1/3 events+ownership → DR-6 GC → …*). It is **gate-free** — independent of the #1316 lifecycle-verbs spike and the Z2 verbs track — which is why it can start now while the spike proceeds in parallel.

**This bundle delivers** the WLM-1 ownership substrate (DR-1/2/3) and the WLM-2 safe GC (DR-6), plus the minimal cross-cutting slices each needs: the surface for three composite actions (DR-10 slice), cross-platform process-identity + path containment (DR-11 slice), and the non-happy-path guarantees (DR-12 slice). It explicitly **defers** the full liveness protocol and process-cwd probe (DR-4/5, WLM-3 #1577 — gated on #1316 Q6), the merge serializer (DR-7/8, WLM-4), and capability-boundary enforcement (DR-9, WLM-5).

### Requirements (DR-N)

DR numbers are preserved from the parent design doc so traceability resolves 1:1 against epic #1574 and the child issues. DR-1/2/3 are WLM-1 (#1575); DR-6 is WLM-2 (#1576); DR-10s/11s/12s are **bundle slices** of the parent's cross-cutting DR-10/11/12 — only the portion these two slices require.

#### DR-1: Event-sourced worktree lifecycle projection

All durable worktree state is a left-fold over the `worktree.*` event family. This bundle adds **four** new ownership/lifecycle types — `worktree.adopted`, `worktree.reserved`, `worktree.released`, `worktree.orphan_detected` — and **reuses the existing** `worktree.remove.requested` / `worktree.remove.executed` pair (already in `event-store/schemas.ts:209–210`, `operationId`-correlated) for the GC disk deletion rather than inventing a parallel `worktree.pruned` (see DR-6; INV-13 two-event split). Task 001 audits the existing family (`worktree.created`, `worktree.baseline`, `worktree.remove.*`) and reconciles — `worktree.adopted` is distinct from `worktree.created` (adopt = track a worktree the manager did **not** create). A `worktrees@v1` projection reduces the family to current pool/ownership/liveness state. There is no side file.

**Stream identity (keystone — resolves the projection's fold signature).** The four new lifecycle events and the reused `worktree.remove.*` events append to a **dedicated singleton `worktrees` stream** (not per-`featureId`), so `worktrees@v1` is a **single-stream** fold — no cross-stream projection over every workflow. Each event payload carries `{ worktreeId, path, featureId?, ownerPid?, ownerStartedAt?, operationId }`; `featureId` is the owning workflow when known (null for a hand-made or not-yet-attached worktree). This is the single decision Tasks 002/004/005/007 build against: the projection key is `worktreeId`, the owning-workflow lookup for DR-6's `integrationRef` reads each entry's `featureId`, and adoption of a harness worktree with no workflow leaves `featureId: null`.

**`worktrees@v1` projection entry shape** (Task 002 defines it; 004/007 query it):
```ts
interface WorktreeEntry {
  worktreeId: string;                 // stable id = canonical (symlink-resolved) worktree path
  path: string;
  featureId: string | null;           // owning workflow, or null (hand-made / unattached)
  state: 'adopted' | 'reserved' | 'released' | 'orphan';
  ownerPid: number | null;
  ownerStartedAt: string | null;      // process create-time; null unless state === 'reserved'
}
```

**Idempotency key (corrects a per-invocation-collision hazard; aligned to the real convention).** The codebase keys two-component as `<eventType>:<operationId>` — confirmed for the reused pair at `compensation.ts:442/490` (`worktree.remove.requested:${operationId}`). The four new lifecycle events adopt the **same** two-component convention — `worktree.reserved:<operationId>`, `worktree.released:<operationId>`, etc. — with `operationId` minted **once per reserve/release/adopt invocation**. That per-invocation `operationId` is the discriminator: a *re-acquisition* of the same path mints a new `operationId`, so its key differs from the prior reservation's. A path-only key (`worktree:<id>:reserved`, no `operationId`) would collide on re-acquisition — the UNIQUE INDEX would silently collapse it to a no-op, leaving the projection's `ownerPid`/`ownerStartedAt` stale from the dead owner (the exact PID-reuse corruption DR-3 must prevent). The reused `worktree.remove.*` events keep their existing `worktree.remove.<phase>:${operationId}` key unchanged.

**Acceptance criteria:**
- Given a sequence of `worktree.*` events, when the `worktrees@v1` reducer folds them, then state is reproducible byte-for-byte from the log alone, and the reducer passes `assertReducerImmutable` (pure, deterministic, structural-sharing).
- **Operational cold rebuild (not just reducer determinism):** given on-disk worktrees + a populated event log, when `manager.reconcile()` runs (`git worktree list --porcelain` ground-truth probe ⊕ event replay), then its `worktrees@v1` projection equals a fresh from-zero event-log replay (INV-1). *(Tested at the manager seam in **Task 005** — it owns the real git probe; Task 004 covers reducer + reserve/release with an injected probe.)*
- **No side file:** during a reserve→release cycle, no `worktree-state.json`/`*.json` ownership cache is written to disk; state is recoverable from the event log alone (INV-1 audit-prompt: no adapter-local mutable cache).
- **Per-invocation key uniqueness:** given a worktree at a fixed path reserved → released → re-acquired, the three appends produce **distinct** idempotency keys (no silent collapse); the projection reflects the second owner's `ownerPid`/`ownerStartedAt` (INV-8).
- Event schemas registered/reconciled in `event-store/schemas.ts` with idempotency-key support.

#### DR-2: Reconcile/adopt harness-created worktrees (no pool, harness-neutral)

The manager **adopts** worktrees created by any harness's native isolation rather than creating its own pool. Adoption keys off the `worktree.*` event stream and `git worktree list --porcelain` ground truth — never a harness-specific creation callback (INV-4/6). A released worktree is GC-eligible, not recycled into a warm pool.

**Acceptance criteria:**
- Given a Claude Code `.claude/worktrees/agent-*` (or Codex/Cursor equivalent, or a hand-made worktree) appears, when `acquire_worktree`/reconcile runs, then it is adopted (`worktree.adopted`) and tracked without the manager having created it.
- No code path assumes a specific harness owns creation; adoption works for a worktree created by hand.
- No reuse/pool semantics: a `worktree.released` worktree is GC-eligible, never recycled.

#### DR-3: Crash-safe ownership reservation

Ownership = `{ownerPid, ownerStartedAt}` carried on `worktree.reserved`. `ownerStartedAt` (process create-time) defeats PID reuse. "Heal" is a reconcile fold: a reservation whose owner is provably dead is collapsed to `worktree.released` by a probe-fed event — not by a mutating loop. Reservation is event-sourced; there is no advisory lock file (INV-7).

**Acceptance criteria:**
- Given a reserved worktree whose owner process is gone (PID absent, or PID present but `startedAt` mismatched), when a reconcile/probe runs, then a `worktree.released` event is emitted and the projection shows it idle.
- A live owner (PID present ∧ `startedAt` matches) is **never** released.
- Reservation produces no advisory lock file; ownership is recoverable purely from the event log after a crash (INV-7).

#### DR-6: Safe worktree GC (`prune_worktrees`)

> **`worktree.orphan_detected` emitter deferral (review follow-up).** The `worktree.orphan_detected` event TYPE is registered + folded by `worktrees@v1` in this bundle (so WLM-3 can emit it without a schema migration), but its **emitter is deferred to WLM-3 (DR-4/5 on-demand ground-truth probe)** — like the rest of the liveness probe. The foundation GC does **not** depend on it: the common released-then-orphaned case (a `released` worktree whose backing repo later vanishes) is still reclaimed structurally by the pure ladder's `backingGitdirPresent === false` rung (tested). So the `orphan` projection state is reachable only once WLM-3 lands; foundation GC safety is unaffected.

A worktree-disk GC distinct from the existing workflow-prune. The handler **reconciles/adopts first, then evaluates** (see ordering note), running this safety ladder per worktree: **(0)** **adopt-gate** — any on-disk worktree with no adoption record is reconciled (`worktree.adopted`) before the ladder runs, so a freshly-created-but-unadopted worktree is never evaluated as a bare directory → **(1)** skip if in-use → **(2)** skip if dirty (`git status --porcelain --untracked-files=all`, untracked-aware) → **(3)** skip if unmerged (`git merge-base --is-ancestor HEAD <integrationRef>`) → **(4)** classify backing-repo-missing **orphans** (`.git` gitdir pointer → stat). Dry-run is the default; **fail-closed** when origin is unreachable; plan → reserve → re-verify → commit (TOCTOU defense). The actual disk deletion is a **two-event split** — `worktree.remove.requested` (intent) before `git worktree remove`, `worktree.remove.executed` (result) after — reusing the existing pair (INV-13), so a crash between re-verify and deletion is recoverable by an idempotent precheck.

> **Sequencing note (load-bearing).** Step 1 ("skip if in-use") is satisfied in this bundle by the **DR-3 ownership liveness** — a worktree that is `reserved` with a live owner (PID present ∧ `startedAt` matches) is skipped. The richer process-**cwd** in-use detection (DR-4/5, WLM-3 #1577) is a *refinement* that lands later and is gated on #1316 Q6; it is **not** required for a correct, conservative GC, and the implementer must not block on #1316/#1577.
>
> **Ordering note + deletion-eligibility (closes the unadopted-clean-worktree hole — NO mtime heuristic).** The "errs only toward not-deleting" guarantee holds **only after adoption**: an on-disk worktree a harness just created but that has *no* `worktree.adopted`/`worktree.reserved` event would otherwise pass steps 1–3 (no reservation ⇒ not in-use; clean tree; HEAD ancestor of integration) and be deleted *while an agent is actively working in it* — the #55724 failure mode. Step 0 (adopt-gate) reconciles every on-disk worktree into the event log **before** the ladder runs. The eligibility rule is then **state-based, not time-based**: a worktree is deletion-eligible **only if its `worktrees@v1` state is `released` or `orphan`.** Any worktree in state `adopted` or `reserved` is skipped — including an adopted-but-never-reserved worktree (a just-created harness dir) and a long-running agent's worktree (reserved, live owner). **No mtime / recency guard is used** — mtime is unsafe (a long-running agent's worktree has a stale mtime yet is in active use). A worktree only becomes `released` via explicit `release_worktree` or a DR-3 reconcile fold that proved the owner dead; a crashed-agent worktree therefore becomes eligible, an active one never does. The GC **depends on adopt (DR-2 / Task 005)**.

**`integrationRef` resolution (closes Open Question 2 — single source of truth, with the per-worktree lookup path).** Because `prune_worktrees` iterates **all** on-disk worktrees (across different workflows, or none), the handler resolves `integrationRef` **per candidate**: read the candidate's `featureId` from its `worktrees@v1` entry, then load **that** workflow's `synthesis.integrationBranch` — the **same** field `setup-worktree.ts:256–260` and `merge_orchestrate` use. Resolution outcomes: `featureId` present ∧ `integrationBranch` resolvable ⇒ run step 3; `featureId` null (hand-made / unattached) **or** `integrationBranch` unresolvable ⇒ the candidate is **unverifiable → fail-closed (skipped)**, never deleted by the unmerged path (it may still be reported as an orphan only under explicit `--prune-orphans --yes`). The pure ladder (Task 006) receives the resolved ref injected; the handler (Task 007) owns the per-worktree lookup traversal. No second source of truth is introduced.

**Acceptance criteria:**
- Default invocation deletes nothing; it reports candidates + reclaimable bytes, with skip reasons grouped/scannable.
- Given a worktree with untracked-only changes (config hides untracked), when prune evaluates it, then it is skipped as **dirty** (untracked-aware: `--untracked-files=all`), not deleted.
- **Eligibility is state-based:** only worktrees in state `released` or `orphan` are deletion-eligible; `adopted` and `reserved` are always skipped.
- A worktree that is `reserved` with a live owner is skipped as **in-use** (DR-3 ownership), not deleted.
- **Unadopted clean worktree (just-created):** given an on-disk worktree with no prior event and a clean tree, when prune runs, step 0 adopts it (state `adopted`) and it is **not** deleted (reproduces + blocks the #55724 shape).
- **Long-running un-released worktree (stale mtime, no reservation):** given an on-disk worktree adopted but not `released`, with an old mtime, when prune runs, it is **not** deleted — proving eligibility is state-based, not time-based (this case distinguishes the safe implementation from an mtime guard).
- An orphan (backing `.git` gitdir missing) is reported "content could not be verified" and is deleted only with explicit `--prune-orphans --yes`.
- Origin unreachable, `featureId` null, **or** `integrationBranch` unresolvable ⇒ the candidate is left untouched with reason `cannot verify` (fail-closed).
- Disk deletion emits `worktree.remove.requested` before and `worktree.remove.executed` after; a crash between them is resumed by an idempotent precheck (worktree already absent ⇒ emit `executed` once, no duplicate removal) (INV-13/8).

#### DR-10s: Agent-first surface for the foundation actions (bundle slice of DR-10)

The new verbs ride the existing 4 composite tools as actions — `exarchos_orchestrate{acquire_worktree, release_worktree, prune_worktrees}` and `exarchos_view{worktrees}` — schema-constrained, with "do NOT use for" guidance, and CLI parity over the shared dispatch core. No new visible tool, no long-running process. (The `serialize_merge`, `ps`, and `wait` actions are out of this bundle — WLM-4 / verbs track.)

**Action semantics (explicit):** `acquire_worktree` = **adopt-then-reserve composite** (idempotent — adopts the worktree if not yet tracked, DR-2, then reserves ownership, DR-3); `release_worktree` = drop the caller's reservation (`worktree.released`); `prune_worktrees` = the GC (DR-6); `worktrees` = read the `worktrees@v1` projection.

**Acceptance criteria:**
- Visible composite-tool count stays at 4; total visible tools <15 (INV-5a/5d).
- Each new action declares per-action annotations and a registered Zod `outputSchema`. **Annotation `safety` values (enforced by `registry.ts` `ActionAnnotationsSchema.superRefine`):** `prune_worktrees` → `safety: 'compensable'` + `destructive: true` + `idempotent: true` + dry-run-default (`destructive: true` is **only** valid under `safety: 'compensable'` — `local-mutation` rejects it at module load); `acquire_worktree`/`release_worktree` → `safety: 'local-mutation'`, `readOnly: false`, `idempotent: true`; `worktrees` → `safety: 'read-only'`, `readOnly: true`, `destructive: false`. CLI≡MCP parity proven by a parity test (INV-2/5b).
- The mutating action `prune_worktrees` defaults to `--dry-run`; the observation action `worktrees` is read-only (INV-5c).
- No daemon/background service is introduced (INV-15).

> **Known INV-10 advisory gap (deferred, not a defect).** This bundle does **not** emit a `<surface>.executing_started` liveness event for an in-flight `prune_worktrees`, so once the v2.12 `ps`/`wait` verbs ship (WLM-3 #1577 / #1090), a running prune is not yet observable through them. That liveness wiring is DR-4's scope (WLM-3, gated on #1316 Q6) and is intentionally out of this slice. Recorded here so the gap is a *documented deferral* rather than a silent omission; closing it is a one-line add in WLM-3.

#### DR-11s: Cross-platform process identity + path containment (bundle slice of DR-11)

The ownership probe (DR-3) and the GC orphan/path checks (DR-6) work on linux, macOS, and Windows. Process identity uses a portable process library (PID liveness + create-time); path containment is symlink-resolved (macOS `/private/var`). No platform syscall leaks into shared code. *(The full process-cwd enumeration + protected-ancestry probe is DR-5/WLM-3 — out of this bundle; this slice covers only the create-time + path-containment portability that DR-3/DR-6 need.)*

**Acceptance criteria:**
- PID liveness + process create-time resolve correctly on linux/macos/windows in platform-shimmed unit tests.
- Path containment uses realpath/symlink resolution so a worktree path under a symlinked root matches correctly.
- A Windows CI lane runs this bundle's test suite (addresses the standing Windows-CI gap; INV-16).

#### DR-12s: Error handling, failure modes, and edge cases (bundle slice of DR-12)

Covers the non-happy paths these two slices own. *(Required: at least one DR covering error handling.)*

**Acceptance criteria:**
- **Crash mid-reservation:** Given a `worktree.reserved` with no terminal `released`, when reconcile runs against a dead owner, then exactly one `worktree.released` is emitted (idempotent precheck; no duplicate releases on repeated reconcile) (INV-8).
- **Preserve-uncommitted on GC:** Given a worktree with uncommitted (including untracked-only) changes, when `prune_worktrees` targets it, then it is **never** deleted — it is skipped/reported (status-porcelain guard; #55724 Fix 2). The GC never invokes `git reset --hard` (INV-14).
- **Origin unreachable / orphan unverifiable:** fail-closed; never deleted without explicit `--prune-orphans --yes` (DR-6).
- **Stale worktree after external push:** adoption (DR-2) re-verifies HEAD/ancestry before reporting a worktree adoptable, so a reused worktree cannot silently drop newly-pushed files.
- **Concurrent reconcile/prune on the same worktree:** the StreamLockManager serializes the appends; the loser re-verifies under lock and aborts safely (no double-release, no double-free).

### Technical Design

**Module layout** (per [parent §Technical Design](../designs/2026-06-21-worktree-lifecycle-manager.md#technical-design)) — new `servers/exarchos-mcp/src/orchestrate/worktree/`:
- `manager.ts` — in-process facade; the bundle's `acquire_worktree` / `release_worktree` / `prune_worktrees` / `worktrees` entry points fold behind it. **This bundle does NOT modify or absorb `setup-worktree.ts` / `worktree-baseref.ts` / `dispatch-guard.ts`** — `manager.ts` is introduced *alongside* them and only routes the four new actions. Folding those existing files behind the facade is the epic's larger consolidation and is **explicitly deferred** to a later WLM slice (it carries the blast radius of every existing worktree caller, out of scope here). No task in this bundle touches those three files.
- `projections/worktrees.ts` — the `worktrees@v1` reducer (DR-1).
- `pure/ownership.ts` — PID + create-time liveness check (DR-3), portable process source injected for tests (DR-11s).
- `pure/prune-ladder.ts` — the safety ladder, ported from treehouse `analyzeIdleWorktree` (DR-6); pure over an injected git/fs/probe source.

**State, stream & serialization.** Ownership/liveness live only in `worktree.*` events on a **dedicated singleton `worktrees` stream** (decided above in DR-1 — not per-`featureId`, so `worktrees@v1` is a single-stream fold; `featureId` rides each payload). Cross-process ordering = SQLite WAL `BEGIN IMMEDIATE` + `PRIMARY KEY(stream_id, sequence)`; in-process ordering = StreamLockManager per-stream Promise mutex on the `worktrees` stream (INV-7). Two-component idempotency keys `<eventType>:<operationId>` on every append (INV-8), matching `compensation.ts:442/490`.

**GC ladder.** `plan → reserve → re-verify → commit`: the ladder first computes a deletion plan (dry-run output), and on a real run re-verifies each candidate **under the stream lock** immediately before deletion (TOCTOU defense), so a worktree that became dirty/reserved between plan and commit is dropped from the set.

**Invariants preserved:** INV-1 (state = event fold), INV-7 (StreamLockManager + WAL, no flock), INV-8 (idempotency keys), INV-14 (no `reset --hard` in any GC/recovery path), INV-5a/b/c/d + INV-2 (composite actions, schema-constrained, dry-run, parity), INV-15 (no daemon). Full conformance matrix: [parent §Invariant Conformance](../designs/2026-06-21-worktree-lifecycle-manager.md#invariant-conformance).

### Integration Points

- `servers/exarchos-mcp/src/event-store/schemas.ts` — add the four new `worktree.*` lifecycle types + reuse `worktree.remove.*`; idempotency keys.
- `servers/exarchos-mcp/src/registry.ts` — register `acquire_worktree` / `release_worktree` / `prune_worktrees` on `exarchos_orchestrate` and `worktrees` on `exarchos_view` (CLI flags auto-emit from each action's Zod schema — see [[project_cli_schema_driven_flags]]).
- **Dispatch wiring (or actions are DOA — [[project_composite_dispatch_handler_gap]]):** `servers/exarchos-mcp/src/orchestrate/composite.ts` — add the three orchestrate actions to the `ACTION_HANDLERS` map (handled by `handleOrchestrate`); `servers/exarchos-mcp/src/views/composite.ts` — add the `worktrees` case to `handleView`. A registered action with no dispatch branch returns `UNKNOWN_ACTION` at runtime; tests must dispatch **through** `handleOrchestrate`/`handleView`, not just inspect registry metadata.
- `servers/exarchos-mcp/src/orchestrate/` — new `worktree/` module **only**. The existing `setup-worktree.ts` / `worktree-baseref.ts` / `dispatch-guard.ts` are **not modified in this bundle** (their consolidation behind `manager.ts` is deferred to a later WLM slice).
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts` (`integrationBranch`) / `workflow/schemas.ts` (`synthesis.integrationBranch`) — read-only source the prune handler resolves `integrationRef` from (same path as `setup-worktree.ts`).
- Projection registry — register `worktrees@v1` alongside the existing projections.

### Alternatives considered

Decided in the parent design ([§Approaches Considered](../designs/2026-06-21-worktree-lifecycle-manager.md#approaches-considered)); summarized for self-containment:
- **Option 2 — periodic-scan supervisor** (port treehouse `healState` as a reconcile loop). Rejected: it is *active polling*, which INV-10 explicitly replaces, and it trends toward a quasi-daemon (INV-15); scan-as-truth sits in tension with INV-1.
- **Option 3 — guard-first MVP** (boundary enforcer + stateless GC, no durable ownership). Rejected as the *endpoint* but **retained as this bundle's spirit**: it is the natural first slice of Option A's roadmap. We take its fast safety-floor (the GC) but pair it with the durable, event-sourced ownership Option 3 lacks — so the foundation is holistic rather than a throwaway.

### Open Questions

- **In-use check fidelity (DR-6 step 1).** This bundle uses DR-3 ownership liveness for "in-use"; WLM-3 (#1577) later adds process-cwd detection. Resolution: ship the conservative ownership-based check now (errs toward not-deleting, **after** the step-0 adopt-gate), refine in WLM-3. **No blocking dependency** — captured in the DR-6 sequencing + ordering notes.
- **`integrationRef` resolution for DR-6 step 3.** ✅ **Resolved (plan-review):** derive from `workflowState.synthesis.integrationBranch` — the same source `setup-worktree.ts:256–260` and `merge_orchestrate` use. Handler (Task 007) resolves it; pure ladder (Task 006) receives it injected; null ⇒ fail-closed. No second source of truth. (See DR-6 `integrationRef` note.)
- **Prune cadence (parent OQ-3).** Manual `prune_worktrees` only for v1; a documented "run after synthesize" convention is deferred. No background loop regardless (INV-15).
- **Compensation-path `worktree.remove.*` stream split (known residual).** The existing `compensation.ts:437` appends `worktree.remove.*` to the **`featureId` stream**, while this bundle's GC appends to the **`worktrees` stream**. The single-stream `worktrees@v1` fold therefore does **not** reflect compensation-triggered removals, so the read-only `worktrees` view could show an entry whose disk worktree was already removed by a compensation cleanup. **This is safe** — the GC ladder reads disk ground-truth (`git worktree list --porcelain`) via the step-0 adopt-gate, so it never acts on a stale projection entry; only the advisory `worktrees` view is affected, and a subsequent reconcile/adopt-gate corrects it. Documented as a known residual; unifying the two removal paths onto one stream (or a cross-stream reconcile) is deferred to WLM-3/WLM-4. Not a blocker for this bundle.

## Decomposition

The decomposition maps every task to one or more DR-N from the Design & Rationale section above. Tests are judged **test-after by adequacy** (the failing-test-first ceremony is not required); each task's verification depth follows its `riskTier` per the ladder in `@skills/_shared/references/verification.md`.

### Scope

**Target:** Partial — the **foundation** slices of epic #1574: WLM-1 (#1575, DR-1/2/3) + WLM-2 (#1576, DR-6), plus the bundle slices of DR-10/11/12 these two require.
**Excluded (deferred to later WLM slices):** DR-4/5 full liveness + process-cwd probe (WLM-3 #1577, gated on #1316 Q6); DR-7/8 merge serializer + lock-contention resilience (WLM-4 #1578); DR-9 capability-boundary enforcement (WLM-5 #1579); DR-10 `serialize_merge`/`ps`/`wait` actions. The DR-6 "skip in-use" step uses DR-3 ownership liveness in this bundle (see the DR-6 sequencing note) — **no dependency on #1316/#1577.**

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Event-sourced lifecycle projection — **foundation events only** (4 new lifecycle types + reused `worktree.remove.*`; `worktree.merge_*`/`worktree.pruned` deferred to WLM-4); `worktrees` stream + `worktrees@v1`; operational reconcile (Task 005) + per-invocation key | 001, 002, 004, 005 |
| DR-2 | Reconcile/adopt harness-created worktrees (no pool) | 005 |
| DR-3 | Crash-safe ownership reservation | 003, 004 |
| DR-6 | Safe worktree GC (`prune_worktrees`: adopt-gate + ladder + two-event deletion) | 006, 007 |
| DR-10s | Agent-first surface (3 orchestrate actions + `worktrees` view) | 008 |
| DR-11s | Cross-platform process identity + path containment | 003, 009 |
| DR-12s | Error handling / failure modes / edge cases | 004, 005, 007 |

### Tasks

#### Task 001: Reconcile the `worktree.*` event family + per-invocation idempotency keys
**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe — assert every new event type validates under Zod; assert the **per-invocation key uniqueness** property (the G1 fix).
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.ts`
- `servers/exarchos-mcp/src/event-store/schemas.test.ts`
**Expected tests:** `WorktreeSchemas_FourNewLifecycleTypes_RegisteredAndValidate`, `WorktreeSchemas_ReuseExistingRemoveRequestedExecuted_NotDuplicated`, `WorktreeSchemas_LifecycleKey_IncludesOperationId`, `WorktreeSchemas_ReserveReleaseReacquire_ProducesDistinctKeys_NoSilentCollapse`, `WorktreeSchemas_MalformedPayload_RejectedByZod`
**Dependencies:** None
**Parallelizable:** Yes (Wave A)

> **Audit-then-add, do not duplicate.** The existing family already has `worktree.created`, `worktree.baseline`, and `worktree.remove.requested`/`worktree.remove.executed` (schemas.ts:209–210). This task adds **only four new** types — `adopted`, `reserved`, `released`, `orphan_detected` — appended to the dedicated **`worktrees` stream** (DR-1), with `featureId` on each payload. It **reuses** `worktree.remove.*` for the GC disk deletion (DR-6, INV-13) and does **not** add `worktree.pruned`, `merge_requested`, or `merge_executed`. Keys use the **existing two-component convention** `<eventType>:<operationId>` (e.g. `worktree.reserved:<operationId>`), matching `compensation.ts:442/490` — `operationId` minted per invocation is the discriminator, so re-acquisition of a path cannot collapse onto a dead owner's key (G1). **No five-component compound key** (that was the prior draft's mistake).
>
> **`worktreeId` keying for the reused remove events (no schema change).** `WorktreeRemoveRequestedData`/`ExecutedData` (schemas.ts:1878–1891) carry `operationId + worktreePath`, not `worktreeId`. Since `worktreeId` is **defined as** the canonical (symlink-resolved) worktree path, the `worktrees@v1` reducer canonicalizes the event's `worktreePath` → `worktreeId` to fold remove events onto the right entry — the existing schema is reused **as-is**, no new field. Task 001 adds no field to the remove pair; it only confirms this canonicalization equivalence is documented for Task 002's reducer.

#### Task 002: `worktrees@v1` projection reducer
**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Verification (medium):** scoped tests + kill-probe — golden-fold, `assertReducerImmutable`, cold-rebuild equality.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.ts` (reducer)
- `servers/exarchos-mcp/src/orchestrate/worktree/projections/index.ts` (barrel — `defaultRegistry.register(worktreesReducer)` self-registration, DR-1 convention)
- `servers/exarchos-mcp/src/projections/index.ts` (add the side-effect import line for the barrel — **without it `aggregateStream('worktrees@v1')` throws `UnknownProjectionIdError`**)
- `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.test.ts`
**Defines** the `WorktreeEntry` projection shape (`worktreeId`, `path`, `featureId`, `state ∈ {adopted,reserved,released,orphan}`, `ownerPid`, `ownerStartedAt`) keyed by `worktreeId` over the single `worktrees` stream (per DR-1). Tasks 004/007 query this shape.
**Expected tests:** `WorktreesReducer_FoldEvents_ReproducesStateFromLogAlone`, `WorktreesReducer_AnyEventOrder_PassesAssertReducerImmutable`, `WorktreesReducer_ColdRebuild_EqualsLiveState`, `WorktreesReducer_EntryCarriesFeatureIdAndOwnerFields` (the shape Task 007's lookup depends on), `WorktreesReducer_RemoveExecuted_DropsEntryFromProjection` (fold of `worktree.remove.executed` **removes** the entry — there is no `removed` state; absence is the terminal), `Projection_WorktreesV1_IsRegistered_AggregateStreamResolves` (the registration guard — fails with `UnknownProjectionIdError` if the side-effect import is missing)
**Dependencies:** 001
**Parallelizable:** No (after 001)

> The operational `manager.reconcile()` equality (real git probe ⊕ replay) is asserted in **Task 005** (it owns the `git worktree list --porcelain` probe); the no-side-file regression anchor is in **Task 004** (the manager seam). Neither belongs in this pure-reducer task.

#### Task 003: Portable process-identity + symlink-resolved path-containment primitives
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-11s, DR-3
**Verification (medium):** scoped tests + kill-probe — platform-shimmed process source (injected); symlink-resolved containment.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/process-identity.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/path-containment.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/process-identity.test.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/path-containment.test.ts`
**Expected tests:** `ProcessIdentity_PidAbsentOrStartedAtMismatch_ReportsDead`, `ProcessIdentity_PidPresentAndStartedAtMatches_ReportsAlive`, `ProcessIdentity_CreateTime_ResolvesOnLinuxMacWindows` (platform-shimmed), `PathContainment_SymlinkedRoot_ResolvesRealpathAndMatches`
**Dependencies:** None
**Parallelizable:** Yes (Wave A)

#### Task 004: Crash-safe ownership reservation + heal-as-reconcile-fold
**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-3, DR-12s
**Verification (high):** medium set + integration suite across the event-store seam — real-SQLite reserve/release, crash-then-resume yields exactly one `released`, no advisory lock file on disk.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/ownership.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/ownership.test.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` (reserve/release/reconcile entry points)
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.reconcile.test.ts`
**Expected tests:** `Reconcile_DeadOwner_EmitsReleasedExactlyOnce`, `Reconcile_LiveOwnerPidAndStartedAtMatch_NeverReleases`, `Reconcile_RepeatedRun_IsIdempotent` (DR-12s crash-mid-reservation), `Reservation_LeavesNoAdvisoryLockFile`, `ReserveRelease_WritesNoJsonSideFile` (DR-1 no-side-file, G9), `Reconcile_ConcurrentSameWorktree_StreamLockSerializes_NoDoubleRelease`, `Reserve_AppendsToWorktreesStream_WithOperationIdKey` (DR-1 stream identity)
**Dependencies:** 001, 002, 003
**Parallelizable:** No (join point; introduces `manager.ts` reserve/release/reconcile with an **injected** probe; the real git probe lands in Task 005)

#### Task 005: Adopt harness-created worktrees (no pool) + stale-after-push re-verify
**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2, DR-12s
**Verification (high):** medium set + integration across the git↔event-store seam — adopt via `git worktree list --porcelain`, re-verify HEAD/ancestry before reporting adoptable.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` (adopt path)
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.adopt.test.ts`
**Expected tests:** `Adopt_HarnessOrHandMadeWorktree_AdoptedWithoutManagerCreating`, `Adopt_NoHarnessSpecificCreationAssumption`, `Adopt_HandMadeWorktree_RecordsFeatureIdNull` (DR-1/DR-6 lookup), `Adopt_StaleAfterExternalPush_ReverifiesHeadBeforeMutation` (DR-12s), `Released_WorktreeIsGcEligible_NotRecycledIntoPool`, `Reconcile_RealGitProbePlusReplay_EqualsFreshEventLogReplay` (DR-1 operational cold-rebuild via real `git worktree list --porcelain`, G7 — moved here because this task owns the probe)
**Dependencies:** 004 (shares `manager.ts` — pinned order 004 → 005 → 007 serializes all facade edits)
**Parallelizable:** No — strictly between 004 and 007 on the `manager.ts` chain. Task 006 (pure ladder, different file) may run concurrently with 005.

#### Task 006: GC safety-ladder (pure)
**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-6
**Verification (medium):** scoped tests + kill-probe — table tests over in-use / dirty / unmerged / orphan / origin-unreachable classifications against an injected git+fs+probe source.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/prune-ladder.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/pure/prune-ladder.test.ts`
**Expected tests:** `PruneLadder_ReservedLiveOwner_SkippedInUse`, `PruneLadder_UntrackedOnlyChanges_SkippedDirty` (untracked-aware), `PruneLadder_HeadNotAncestorOfInjectedIntegrationRef_SkippedUnmerged`, `PruneLadder_NullIntegrationRef_TreatedUnverifiable_FailClosed`, `PruneLadder_NoAdoptionRecord_ClassifiedUnverifiable_NotDeletable` (the G6 conservative classification at the pure layer), `PruneLadder_BackingGitdirMissing_ClassifiedOrphan`, `PruneLadder_OriginUnreachable_LeftUntouchedFailClosed`
**Dependencies:** 003 (the ladder is pure over injected inputs — `integrationRef`, in-use predicate, adoption record, git/fs source — so no hard dep on 004/005; the handler in 007 supplies them)
**Parallelizable:** Yes (with 004/005 — different files)

> The ladder stays pure: `integrationRef`, the in-use predicate, and the adoption record are **injected**. Step-0 adopt-gate orchestration lives in the handler (Task 007); the ladder only classifies. A worktree presented with no adoption record is classified *unverifiable → not deletable* (defense in depth behind the handler's adopt-gate).

#### Task 007: `prune_worktrees` handler — adopt-gate, TOCTOU-safe, two-event deletion
**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-6, DR-12s
**Verification (high):** medium set + integration suite — real-SQLite concurrent prune; step-0 adopt-gate → ladder → `plan → reserve → re-verify-under-lock → commit`; default dry-run deletes nothing; resolves `integrationRef` from `workflowState.synthesis.integrationBranch`; deletion via the `worktree.remove.requested`/`executed` two-event split; never `git reset --hard`.
**Files:**
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` (prune entry point)
- `servers/exarchos-mcp/src/orchestrate/worktree/manager.prune.test.ts`
**Expected tests:** `Prune_DefaultInvocation_DeletesNothing_ReportsCandidatesAndBytes`, `Prune_AdoptGate_ReconcilesUnadoptedWorktreesBeforeLadder` (G6 step-0), `Prune_OnlyReleasedOrOrphanState_IsDeletionEligible` (state-based rule), `Prune_UnadoptedCleanWorktree_NotDeleted_ReproducesAndBlocks55724` (G6), `Prune_LongRunningUnreleasedWorktree_StaleMtime_NotDeleted` (state-based, NOT mtime — distinguishes safe impl), `Prune_ResolvesIntegrationRefPerWorktreeFromFeatureId` (G2 per-worktree lookup), `Prune_NullFeatureIdOrUnresolvableBranch_FailsClosed` (G2), `Prune_UncommittedOrUntracked_NeverDeleted` (DR-12s preserve-uncommitted; #55724 Fix 2), `Prune_Orphan_OnlyDeletedWithExplicitPruneOrphansYes`, `Prune_OriginUnreachable_FailsClosed`, `Prune_Deletion_EmitsRemoveRequestedThenExecuted` (INV-13, G3), `Prune_CrashBetweenRequestedAndDelete_ResumesIdempotently_SingleExecuted` (DR-12s, G3), `Prune_ConcurrentWithReconcile_ReverifiesUnderLock_NoDoubleFree` (DR-12s), `Prune_RecoveryPath_NeverUsesResetHard`
**Dependencies:** 002, 004, **005** (the step-0 adopt-gate calls the adopt path — G6), 006
**Parallelizable:** No — runs **after 005** (both share `manager.ts`; pinned order 004 → 005 → 007 serializes facade edits, closing G5)

#### Task 008: Register + **dispatch-wire** composite actions (registry + handlers) + parity
**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-10s
**Verification (medium):** scoped tests + kill-probe — registered Zod `outputSchema` + annotations per action; **tests dispatch THROUGH `handleOrchestrate`/`handleView`** (not registry-metadata-only) so a missing dispatch branch fails loudly; CLI≡MCP parity; visible composite-tool count stays at 4.
**Files:**
- `servers/exarchos-mcp/src/registry.ts` (action registration + outputSchemas + annotations)
- `servers/exarchos-mcp/src/orchestrate/composite.ts` (add `acquire_worktree`/`release_worktree`/`prune_worktrees` to the `ACTION_HANDLERS` map — `handleOrchestrate`)
- `servers/exarchos-mcp/src/views/composite.ts` (add the `worktrees` case to `handleView`)
- `servers/exarchos-mcp/src/orchestrate/worktree/dispatch.parity.test.ts`
**Expected tests:** `Dispatch_ThreeOrchestrateActions_RouteThroughHandleOrchestrate_NotUnknownAction` (the DOA-actions guard — [[project_composite_dispatch_handler_gap]]), `Dispatch_WorktreesAction_RouteThroughHandleView_NotUnknownAction`, `Registry_VisibleCompositeToolCount_StaysFour`, `Registry_AllFourActions_RegisterOutputSchemaAndAnnotations` (table-driven over **all four**, asserting the `safety` field too: `acquire_worktree`/`release_worktree` `local-mutation`+idempotent; `prune_worktrees` `compensable`+destructive+idempotent+dryRunDefault; `worktrees` `read-only`+readOnly — G10 + the superRefine constraint), `Registry_ModuleLoads_WithoutSuperRefineRejection` (guards the `destructive`⇒`compensable` constraint at load), `Parity_CliEqualsMcp_ForEveryNewAction`
**Dependencies:** 004, 005, 007
**Parallelizable:** No (join — needs the handlers from 004/005/007)

#### Task 009: Windows CI lane for the worktree suite
**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-11s
**Verification (medium):** the CI YAML is a pipeline boundary (gates merge). A `test-windows` job **already exists** (`.github/workflows/ci.yml:189`, `runs-on: windows-latest`, `npm run test:run` at `:223`, #1170) and already runs the worktree suite inside the full run — so DR-11s AC-3 is largely satisfied **already**. This task does **not** add a new lane (a redundant full-suite run); it adds a **zero-count guard** so a future path-filter/exclusion regression that silently drops the worktree tests fails the job (per the Windows-CI fragility cluster: spawn-timeout flake, npm-ci browser wedge, NTFS handle-close).
**Files:**
- `.github/workflows/ci.yml` (extend the existing `test-windows` job — add one guard step after `npm run test:run`)
**Expected verification:** a single pinned guard step on the existing `test-windows` job parses `vitest run --reporter=json` and **fails the job if the executed worktree-test count is 0** (`numPassedTests + numFailedTests === 0` ⇒ exit 1), so a misconfigured filter that runs zero worktree tests fails the job rather than passing it. **No new `windows-latest` job is created.**
**Dependencies:** 008
**Parallelizable:** No (last — needs the full suite present)

### Parallelization

**Wave A (concurrent worktrees):** 001 (schemas) ∥ 003 (process/path primitives) — fully independent.
**Wave B:** 002 (reducer, after 001) ∥ 006 (pure GC ladder, after 003) — different files, different deps.
**Join → 004** (ownership + heal + operational reconcile) — needs 001, 002, 003; introduces `manager.ts`.
**`manager.ts` chain (strictly serial — closes G5):** 004 → 005 (adopt) → 007 (prune handler). All three edit the same facade file, so they are **pinned sequential** (declared in their `Dependencies`, not just prose) to avoid concurrent-edit conflicts and the stash-collision / facade-edit-leak hazards (CLAUDE.md worktree dispatch discipline). 007 additionally needs 006 (pure ladder); 006 runs concurrently with 005 on the `manager.ts` chain since it is a different file.
**Join → 008** (registry + parity) — needs the handlers from 004/005/007.
**Final → 009** (Windows CI) — needs the suite from 008.

**Critical path:** 001 → 002 → 004 → 005 → 007 → 008 → 009 (seven tasks — the serialized `manager.ts` chain dominates). The pure-helper tasks (003, 006) and the schema/reducer pair parallelize off the critical path; 006 must land before 007 but overlaps the 004→005 segment.
