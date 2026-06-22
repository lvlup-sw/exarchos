# Design: Worktree Lifecycle Manager (+ integration-branch merge serializer)

**Date:** 2026-06-21
**Workflow:** `worktree-lifecycle-manager` (feature)
**Discovery input:** [`docs/research/2026-06-21-treehouse-worktree-mining.md`](../research/2026-06-21-treehouse-worktree-mining.md)
**Prior art consolidated:** `setup-worktree.ts`, `worktree-baseref.ts`, `dispatch-guard.ts`, and the hardened `merge-orchestrate.ts` (PR #1571).
**Frame:** `.exarchos/invariants.md` — INV-15 single-machine, INV-1 event-sourcing, INV-7 serialization, INV-8/13 idempotency/two-event, INV-10 liveness, INV-11 posture, INV-14 recovery, INV-5a–d/INV-2 surface, INV-3 basileus-forward.

---

## Problem Statement

Exarchos's git-worktree handling is scattered (`setup-worktree`, `worktree-baseref`, `dispatch-guard`) and has **no durable ownership, no liveness model, and no garbage collection**. Meanwhile the industry has converged on worktree-per-agent as the default isolation primitive (Claude Code, Codex, Cursor 2.0, Copilot), and the failure modes are now well-documented: concurrent git across worktrees corrupts the shared `.git/` (Claude Code #55724 — *13 parallel agents, 8 lost uncommitted work to `index.lock`*; auto-worktree #174/#176 — *"git is single-process; serialize ref updates/gc"*; TildAlice — index/reflog/config races). Locally we already feel this as the open #1301 boundary leak, stash collisions, stale-worktree-after-push data loss, and unbounded `.claude/worktrees/agent-*` accumulation.

We will build a **holistic, in-process Worktree Lifecycle Manager**: it *reconciles* harness-created worktrees (it does **not** pool — Claude Code/Codex/Cursor own creation), gives each a crash-safe **ownership reservation** and **event-sourced liveness**, **garbage-collects** safely, **serializes** worktree-mutating git through one writer, and funnels task-branch merges through the **existing hardened `merge_orchestrate`**. Runtime isolation (ports/DB/containers), pooling, lifecycle hooks, and remote merge-queue/CI are explicitly **out of scope** (see Non-Goals).

---

## Chosen Approach

**Approach A — Event-sourced reconciler with on-demand ground-truth probe** (selected over scan-first supervisor and guard-first MVP).

Worktree state is a **projection over `worktree.*` events**, never a side file (INV-1; rejecting treehouse's `treehouse-state.json`). Liveness rides the **INV-10 protocol** (`*.executing_started` + terminal). Treehouse's two best ideas — process-cwd in-use detection and PID+start-time ownership — are **re-hosted onto events**: the process/filesystem scan becomes an **on-demand reconcile probe** (pulled by `ps`, GC, orphan-detection) that *folds its result into an event*, not a polling loop. Cross-process serialization reuses the **StreamLockManager + SQLite WAL** (INV-7) — *no `flock`, no PID file*. The merge serializer is a thin **single-writer funnel** in front of unchanged `merge_orchestrate` (INV-13/14 preserved).

```
                 ┌──────────────── WorktreeManager (in-process lib) ─────────────────┐
 harness creates │  reconcile/adopt ─► worktree.adopted ─► [projection: worktrees]    │
 agent-* worktree│  reserve(pid,startedAt) ─► worktree.reserved ─► ownership          │
 ───────────────►│  liveness: *.executing_started + terminal (INV-10)                 │
                 │  probe (on demand): process-cwd scan ⊕ fs scan ─► folds to event   │
                 │  GC: prune_worktrees  (safety ladder, dry-run default)             │
                 │  mergeSerializer ──one-writer (StreamLockManager)──► merge_orchestrate
                 └───────────────────────────────────────────────────────────────────┘
 surface:  exarchos_orchestrate{acquire_worktree|release_worktree|prune_worktrees|serialize_merge}
           exarchos_view{worktrees|ps|wait}        CLI parity (INV-2)        NO daemon (INV-15)
```

---

## Approaches Considered

### Option 1: Event-sourced reconciler with on-demand ground-truth probe (CHOSEN)

**Approach:** Worktree state is a projection over `worktree.*` events; liveness rides the INV-10 protocol; treehouse's process-cwd + PID/start-time mechanisms are re-hosted as an on-demand reconcile *probe* that folds findings into events. Serialization reuses StreamLockManager + WAL.

**Pros:**
- Maximally invariant-aligned (INV-1/7/10/15); auditable, crash-recoverable.
- Delivers the v2.12 `ps`/`wait` liveness substrate as a byproduct.
- Durable ownership resolves stash-collision / stale-worktree hazards.

**Cons:**
- Most upfront design (event schemas, projection, reconcile fold).
- Probe must be *pulled* at the right moments rather than always-fresh.

**Best when:** the goal is a holistic, durable manager that stays clean against the always-load invariants — our case.

### Option 2: Periodic-scan supervisor (scan-first, highest treehouse fidelity)

**Approach:** Port treehouse's `healState` faithfully as a reconcile loop that periodically scans filesystem + processes to derive state.

**Pros:**
- Simplest mental model; proven design; minimal event surface.

**Cons:**
- It is **active polling** — INV-10 explicitly *replaces* this — and trends toward a quasi-daemon (INV-15).
- Scan-as-truth sits in tension with INV-1 (state must be an event fold).

**Best when:** event coverage is too sparse to derive liveness — not our situation.

### Option 3: Guard-first minimal (MVP)

**Approach:** Manager is mainly a boundary enforcer + stateless GC, leaning on INV-11 posture + the #1568 hook to close #1301, plus a `prune_worktrees` that probes ground-truth at run time with no persistent ownership.

**Pros:**
- Smallest surface, fastest to ship, directly closes the open boundary leak.

**Cons:**
- No durable ownership/liveness → no `ps`/`wait` substrate; doesn't address stash/stale-worktree ownership; not "holistic."

**Best when:** a quick safety-floor increment is wanted and the full vision is deferred. (Retained here as the natural *first slice* inside Option 1's roadmap.)

## Requirements

### DR-1: Event-sourced worktree lifecycle projection
All durable worktree state is a left-fold over a new `worktree.*` event family: `worktree.adopted`, `worktree.reserved`, `worktree.released`, `worktree.merge_requested`, `worktree.merge_executed`, `worktree.orphan_detected`, `worktree.pruned`. A `worktrees@v1` projection reduces them to current pool/ownership/liveness state.

**Acceptance criteria:**
- Given a sequence of `worktree.*` events
  When the `worktrees@v1` reducer folds them
  Then state is reproducible byte-for-byte from the log alone (no side file)
  And the reducer passes `assertReducerImmutable` (pure, deterministic, structural-sharing).
- No `worktree-state.json`-style authority exists; a cold rebuild via `reconcile` yields identical state (INV-1).
- Event schemas registered in `event-store/schemas.ts` with idempotency-key support (INV-8).

### DR-2: Reconcile/adopt harness-created worktrees (no pool, harness-neutral)
The manager adopts worktrees created by *any* harness's native isolation rather than creating its own pool. Adoption keys off the `worktree.*` event stream and `git worktree list --porcelain` ground truth, never a harness-specific creation callback (INV-4/6).

**Acceptance criteria:**
- Given a Claude Code `.claude/worktrees/agent-*` (or Codex/Cursor equivalent) appears
  When `acquire_worktree`/reconcile runs
  Then it is adopted (`worktree.adopted`) and tracked without having been created by the manager.
- No code path assumes a specific harness owns creation; adoption works for a worktree created by hand.
- No reuse/pool semantics: a released worktree is GC-eligible, not recycled into a warm pool.

### DR-3: Crash-safe ownership reservation
Ownership = `{ownerPid, ownerStartedAt}` carried on `worktree.reserved`. `ownerStartedAt` (process create-time) defeats PID reuse. "Heal" is a **reconcile fold**: a reservation whose owner is provably dead is collapsed to `worktree.released` by a probe-fed event — not by a mutating loop.

**Acceptance criteria:**
- Given a reserved worktree whose owner process is gone (PID absent, or PID present but `startedAt` mismatched)
  When a reconcile/probe runs
  Then a `worktree.released` event is emitted and the projection shows it idle.
- A live owner (PID present ∧ `startedAt` matches) is never released.
- Reservation is event-sourced; there is no advisory lock file (INV-7).

### DR-4: Liveness protocol + on-demand ground-truth probe (`ps`/`wait` substrate)
Long-running worktree operations emit `<surface>.executing_started` at entry and a paired terminal event (INV-10). `exarchos_view{action:'ps'|'wait'|'worktrees'}` answers liveness **from events**; a ground-truth probe (process-cwd + fs scan) is invoked *on demand* only to reconcile orphans/stalls, and its finding is written as an event — never a continuous poll (INV-10 "replaces active polling"; INV-15 no daemon).

**Acceptance criteria:**
- Given a worktree merge in flight
  When `exarchos_view{action:'ps'}` is called
  Then the in-flight operation is listed from `*.executing_started` without a fresh process scan.
- `wait --worktree=<id> --until=idle --timeout=<t>` resolves from terminal events; on timeout returns a structured timeout, not a hang.
- The probe runs only when explicitly pulled (GC, orphan-detection, `ps --probe`); there is no background interval/loop.

### DR-5: Protected-ancestry process probe
The process-cwd probe (and any teardown that terminates processes) **must** exclude the manager's own process ancestry — the orchestrator's shell can drift its cwd into an agent worktree (known hazard). Port treehouse's `filterProtectedProcesses`: walk the current PID's parent chain and protect the whole ancestry before reporting in-use or terminating.

**Acceptance criteria:**
- Given the orchestrator's own shell cwd is inside worktree W
  When the probe evaluates W
  Then the orchestrator's PID and its full parent chain are excluded from the "in-use" set and from any termination set.
- Termination (if ever invoked) is SIGTERM → grace → SIGKILL on unix, `TerminateProcess` on windows, and never targets a protected PID.
- A unit test asserts a self-rooted cwd does not mark a worktree in-use.

### DR-6: Safe worktree GC (`prune_worktrees`)
A worktree-disk GC distinct from the existing workflow-prune. Safety ladder: skip in-use (probe) → skip dirty (`git status --porcelain --untracked-files=all`) → skip unmerged (`merge-base --is-ancestor HEAD <integrationRef>`) → classify backing-repo-missing **orphans**. Dry-run is the default; **fail-closed** when origin is unreachable; plan→reserve→re-verify→commit (TOCTOU defense).

**Acceptance criteria:**
- Default invocation deletes nothing; it reports candidates + reclaimable bytes, with skip reasons grouped.
- Given a worktree with untracked-only changes (config hides untracked)
  When prune evaluates it
  Then it is skipped as dirty (untracked-aware), not deleted.
- An orphan (backing `.git` gitdir missing) is reported "content could not be verified" and is deleted only with explicit `--prune-orphans --yes`.
- Origin unreachable ⇒ candidate left untouched with `origin unreachable (cannot verify)`.

### DR-7: Integration-branch merge serializer (composes `merge_orchestrate`)
A `serialize_merge` funnel guarantees **one writer to the integration branch at a time** (the transferable kernel from merge-queue SoTA: serialize the single writer, keep integration green), delegating the actual merge to unchanged `merge_orchestrate`. Serialization is via the per-stream StreamLockManager (INV-7), not a new lock.

**Acceptance criteria:**
- Given two task branches request merge onto the same integration branch concurrently
  When `serialize_merge` handles them
  Then they execute strictly sequentially against fresh integration HEAD; neither observes the other's partial state.
- `serialize_merge` delegates to `merge_orchestrate` unchanged; INV-13 `requested`/`executed` split and INV-14 `--abort`→`--keep` recovery are preserved end-to-end.
- No speculative/remote-CI behavior is introduced (that is basileus/remote territory — Non-Goals, INV-3).

### DR-8: Git-mutation lock-contention resilience
Worktree-mutating git operations the manager performs are wrapped with retry-on-`index.lock` (exponential backoff ~200/400/800ms, ±jitter), and creation/adoption staggers with 100-500ms jitter under burst dispatch (grounded in #55724). The retry seam is injectable for deterministic tests (mirrors merge-orchestrate's jitter+sleep seam).

**Acceptance criteria:**
- Given a transient `Unable to create '.git/index.lock'` error
  When the manager performs the git mutation
  Then it retries up to N times with backoff+jitter and succeeds without surfacing the error.
- Backoff/jitter/sleep are injected, so a test asserts retry sequence deterministically.
- Persistent lock (exhausted retries) returns a structured error, never a silent no-op.

### DR-9: Capability-boundary enforcement (close #1301)
A `task-isolated` agent must be unable to write outside its assigned worktree (INV-11, by construction). The manager surfaces a boundary assertion usable at the resolver/dispatch gate and verifiable post-hoc, complementing the #1568 native-isolation write-deny hook.

**Acceptance criteria:**
- Given a `task-isolated` agent and a write targeting a path outside its worktree
  When the boundary check evaluates
  Then the write is rejected at the boundary (not merely flagged in prose).
- A regression test reproduces the #1301 leak shape and asserts it is now blocked.
- `shared-mutating` verbs (`serialize_merge`, `prune_worktrees`) gate at the resolver before the handler (mirrors merge_orchestrate posture, INV-11).

### DR-10: Agent-first surface, no daemon
New verbs ride the existing 4 composite tools as actions — `exarchos_orchestrate{acquire_worktree, release_worktree, prune_worktrees, serialize_merge}`, `exarchos_view{worktrees, ps, wait}` — schema-constrained, dry-run-capable, with "do NOT use for" guidance; CLI parity over the shared dispatch core. No new visible tool, no long-running process.

**Acceptance criteria:**
- Visible composite-tool count stays at 4; total visible tools <15 (INV-5a/5d).
- Each new action declares per-action annotations (destructive/readOnly/idempotent) and a registered Zod `outputSchema`; CLI≡MCP parity proven by a parity test (INV-2/5b).
- Mutating actions default to `--dry-run`; observation verbs (`worktrees`/`ps`/`wait`) are read-only (INV-5c).
- No daemon/background service is introduced (INV-15).

### DR-11: Cross-platform substrate
The process probe and serialization work on unix, macOS, and Windows. The probe uses a portable process library (process cwd + create-time); path comparison is symlink-resolved (macOS `/private/var`). No platform syscall leaks into shared code; a Windows CI lane covers the manager.

**Acceptance criteria:**
- Probe correctly resolves process cwd and create-time on linux/macos/windows in unit tests (platform-shimmed).
- Path containment uses realpath/symlink resolution so a process cwd matches a symlinked worktree path.
- A Windows CI job runs the manager's test suite (addresses the standing Windows-CI gap).

### DR-12: Error handling, failure modes, and edge cases
Covers the non-happy paths surfaced by the SoTA and prior RCAs.

**Acceptance criteria:**
- **Crash mid-operation:** Given `*.executing_started` with no terminal event, when reconcile runs, then an idempotent precheck determines resume-vs-skip and emits the terminal event once (INV-8/13); no duplicate side effect.
- **Preserve-uncommitted on teardown:** Given a worktree with uncommitted changes, when GC/teardown targets it, then it is **never** deleted — it is skipped/reported (status-porcelain guard; #55724 Fix 2). Recovery never uses `git reset --hard` (INV-14: `--abort`→`--keep`, surfacing `recoveryError`).
- **cwd-drift false positive:** the orchestrator's own drifted shell never marks/teardowns a worktree (DR-5).
- **Origin unreachable / orphan unverifiable:** fail-closed; never deleted without explicit orphan opt-in (DR-6).
- **Concurrent prune+merge on same worktree:** the StreamLockManager serializes; the loser re-verifies under lock and aborts safely (no double-free).
- **Stale worktree after external push:** adoption re-verifies HEAD/ancestry before any mutation so a reused worktree cannot silently drop newly-pushed files.

---

## Technical Design

**Module layout (TS, in-process):** `servers/exarchos-mcp/src/orchestrate/worktree/` — `manager.ts` (facade), `pure/probe.ts` (process+fs scan, protected-ancestry, pure-ish with injected process source), `pure/prune-ladder.ts` (safety ladder, ported from treehouse `analyzeIdleWorktree`), `merge-serializer.ts` (StreamLockManager funnel → `merge_orchestrate`), and `projections/worktrees.ts` (reducer). Existing `setup-worktree.ts` / `worktree-baseref.ts` / `dispatch-guard.ts` are folded behind `manager.ts` (no behavior change beyond cohesion).

**State & serialization:** ownership/liveness live only in `worktree.*` events + `worktrees@v1` projection. Cross-process ordering = SQLite WAL `BEGIN IMMEDIATE` + `PRIMARY KEY(stream_id, sequence)`; in-process ordering = StreamLockManager per-stream Promise mutex (INV-7). Idempotency keys on every append (INV-8), shaped like merge-keys (`<streamId>:worktree:<id>:<eventType>`).

**Probe:** enumerate processes → resolve each cwd (symlink-canonicalized) → containment test vs worktree path; subtract the protected ancestry of the current PID (DR-5). Pulled on demand; result written as `worktree.orphan_detected`/`worktree.released`. Never a loop.

**Merge serializer:** acquires the integration stream's lock, re-reads fresh integration HEAD, then calls `merge_orchestrate` unchanged; releases on terminal event. This is the *local* analogue of a merge queue's single-writer guarantee — explicitly **not** speculative CI.

---

## Integration Points

- **`merge_orchestrate` (unchanged):** `serialize_merge` is a caller; INV-13/14 guarantees pass through untouched (PR #1571 preserved).
- **Event store / schemas:** new `worktree.*` types in `event-store/schemas.ts`; `worktrees@v1` registered in `projections/`.
- **Composite registry:** new actions on `exarchos_orchestrate` / `exarchos_view` in `registry.ts` + `composite.ts`; CLI flags auto-emit from each action's Zod schema (schema-driven flags).
- **Capability resolver:** `serialize_merge`/`prune_worktrees` declared `shared-mutating`; boundary assertion feeds the dispatch gate (INV-11) alongside the #1568 hook.
- **v2.12 lifecycle verbs:** `ps`/`wait`/`worktrees` are the first concrete consumers of the INV-10 liveness substrate.
- **Replaces/absorbs:** `setup-worktree.ts`, `worktree-baseref.ts`, `dispatch-guard.ts`.

---

## Testing Strategy

- **Reducer:** `assertReducerImmutable` + golden-fold tests for `worktrees@v1`; cold-rebuild equals live state (DR-1).
- **Probe:** platform-shimmed process source; protected-ancestry test (self-rooted cwd → not in-use, DR-5); symlink-path containment (DR-11).
- **GC ladder:** table tests over in-use/dirty/unmerged/orphan/origin-unreachable; dry-run default; TOCTOU re-verify (DR-6/DR-12).
- **Merge serializer:** real-SQLite concurrent-merge test asserting strict serialization + that `merge_orchestrate` events are unchanged (DR-7); crash-then-resume single-`executed` (DR-12).
- **Lock resilience:** injected backoff/jitter asserts deterministic retry; exhaustion → structured error (DR-8).
- **Boundary:** #1301-shape regression now blocked (DR-9).
- **Parity:** CLI≡MCP for every new action; registered `outputSchema` validates (DR-10).
- **Windows CI lane** runs the suite (DR-11).

---

## Non-Goals (explicit, per scope decisions)

- **No pool / reuse / warm worktrees** — harnesses own creation; manager reconciles (decision 2).
- **No runtime isolation** (ports/DB/containers/`.env`) and **no lifecycle hooks** — worktrees isolate code, not runtime; that layer is the harness/container's job (decision 3; penligent/Coasts).
- **No remote merge queue / speculative CI / batching-bisection** — remote-PR/CI-shaped, belongs to basileus (INV-3).
- **No re-homing of `merge_orchestrate`** — composed, not folded (decision 1).
- **No daemon/service** — in-process library + composite actions only (decision 4; INV-15).

---

## Invariant Conformance

| INV | How satisfied | DR |
|---|---|---|
| INV-1 | worktree state = projection over events, no side file | DR-1 |
| INV-7 | serialization via StreamLockManager + WAL, no flock | DR-3,7 |
| INV-8/13 | idempotency keys; requested/executed split; crash precheck | DR-1,7,12 |
| INV-10 | event-emitted liveness; probe on-demand, not polling | DR-4 |
| INV-11 | task-isolated boundary by construction; posture gating | DR-9 |
| INV-14 | `--abort`→`--keep`, never `--hard`; `recoveryError` | DR-12 |
| INV-15 | no daemon, no distributed lock, local rewind | DR-4,10 |
| INV-5a/b/c/d, INV-2 | composite actions, schema-constrained, parity, dry-run | DR-10 |
| INV-3 | strictly local; remote merge-queue excluded | Non-Goals |
| INV-4/6 | harness/workflow-neutral adoption, no harness coupling | DR-2 |

---

## Open Questions

1. **`ps`/`wait` ownership:** should these ship under this feature, or land first as the standalone v2.12 lifecycle-verb work and be *consumed* here? (Leaning: define the events here; the generic verbs can land in either order since they only read events.)
2. **Boundary enforcement depth (DR-9):** is the #1568 hook + a resolver-gate assertion sufficient for INV-11 "by construction," or is a stronger sandbox needed? (May warrant a focused spike.)
3. **Prune cadence:** manual `prune_worktrees` only (v1), or a documented "run after synthesize" convention? (No background loop regardless — INV-15.)
4. **Increment slicing:** suggest landing order DR-1/3 (events+ownership) → DR-6 (GC) → DR-4/5 (liveness+probe) → DR-7/8 (serializer+resilience) → DR-9/11 (boundary+windows). DR-2/10/12 are cross-cutting.

---

## Sources

**Internal:** discovery report (above); merge-orchestrator audit (`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`); `.exarchos/invariants.md`; PR #1571; issues #1301/#1220/#1356/#1512/#1568/#1085/#1402.
**SoTA — worktree-per-agent & runtime-isolation boundary:** Zylos Research (2026-02); penligent.ai & appxlab (2026-03/04) *worktrees isolate code not runtime*; stos.dev *first line of isolation*; Container-Use/Dagger (InfoQ 2025-08); Sandcastle (codeline.co 2026-05); worktrunk (max-sixty).
**SoTA — concurrency hazards:** Claude Code #55724 (*13 agents → 8 lost work; retry 200/400/800ms; status-porcelain before cleanup; creation jitter*); auto-worktree #174/#176 (*git single-process; serialize ref updates/gc*); TildAlice (index/reflog/config races); Antigravity Lab (*funnel merges through one point*).
**SoTA — merge-queue single-writer kernel:** Graphite (stack-aware, fast-forward); Mergify (speculative checks/batch/bisection — noted as remote-shaped, out of scope); Aviator (fast-forwarding/queue modes).
