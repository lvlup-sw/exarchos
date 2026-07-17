# Spec: WLM Operational Core — event-sourced liveness + integration-merge serializer

**Date:** 2026-06-26 · **Feature:** `wlm-operational-core` · **Depth:** standard
**Inputs:**
- Epic `#1574` — holistic worktree lifecycle manager + integration-branch merge serializer
- Source design: [`docs/designs/archive/2026-06-21-worktree-lifecycle-manager.md`](../designs/archive/2026-06-21-worktree-lifecycle-manager.md) (DR-4, DR-5, DR-7, DR-8, DR-12)
- Foundation already shipped (PR #1628, v2.12.0): [`docs/specs/2026-06-25-wlm-foundation.md`](2026-06-25-wlm-foundation.md) — WLM-1 (`#1575`) + WLM-2 (`#1576`)
- Bundle issues: WLM-3 `#1577` (DR-4/5) · WLM-4 `#1578` (DR-7/8)
- Roadmap: `#1599` Z2 (runtime supervision), coordination rules 2 & 3

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
>
> **Scope note.** This spec carries the **operational-core** slice of epic `#1574`, preserving the source design's DR numbering (DR-4/5/7/8 + a liveness/merge-scoped DR-12) so the bundle traces 1:1 to the epic design and the issues. Shipped: DR-1/2/3 + DR-6 (PR #1628). Deferred behind the `#1603` launcher fork: DR-9 (boundary), DR-11 (Windows-CI) → `#1579`; the **full** DR-10 agent-first surface (parity-harness across all actions, ergonomic "do NOT use for", dry-run UX) → `#1580`. The DR-10 **registration floor** (a registered Zod `outputSchema` + the three core per-action annotations, which the MCP registry requires *fail-closed at module load*) and the **dispatch wiring** for the new verbs are **NOT deferrable** and are included here (Tasks 004/006/007).

## Design & Rationale

### Problem Statement

The WLM foundation (PR #1628) landed the durable substrate — the `worktree.*` family (`adopted`/`reserved`/`released`/`orphan_detected`), the singleton-stream `worktrees@v1` projection, crash-safe ownership, and state-based GC — but two operational capabilities are missing:

1. **No liveness observability.** The foundation registered `worktree.orphan_detected` (type + fold) but **deliberately did not add** any `worktree.merge_*` liveness events, and there is **no ground-truth probe**. So `worktrees@v1` has no in-flight signal to fold (`ps`/`wait` can't answer "what worktree work is in flight?"), and the `orphan_detected` *emitter* (the probe → event path) is unbuilt. This is the substrate the v2.12 `ps`/`wait`/`describe` verbs (`#1090`) read; until it lands, `#1090` is blocked (roadmap `#1599`, rule 2).

2. **No integration-branch write serialization.** `merge_orchestrate` serializes on the *per-`featureId`* stream, so two different feature workflows merging onto the **same integration branch** share no ordering and can corrupt the shared `.git/` — Claude Code #55724 (*13 agents, 8 lost work to `index.lock`*), auto-worktree #174/#176 (*git is single-process; serialize ref updates/gc*). We feel this as stash collisions and `index.lock` flakiness under burst.

Both are the **launcher-stable operational core**: the liveness schema and the merge single-writer guarantee are required no matter who owns worktree creation (the reconciling manager today, or the `exarchos <harness>` launcher in `#1603`).

### Chosen Approach

Implements the operational-core requirements of the epic's selected **Approach A** (full alternatives in the source design; not re-litigated).

**Liveness rides the singleton `worktrees` stream (DR-4/5).** The manager's long-running ops emit a `requested`→`executed` pair on the `worktrees` stream — for merge, the new `worktree.merge_requested` (intent, carrying `{integrationRef, sourceBranch, holderPid, holderStartedAt, operationId}`) and `worktree.merge_executed` (result). This single pair is the INV-10 started/terminal signal, the INV-13 intent/result split, **and** the lease record the serializer uses (below). `worktrees@v1` folds the pair into an **integration-ref-keyed `inFlightMerges` sub-structure** (distinct from the worktreeId-keyed entries — an integration-branch merge maps to no adopted worktree). `exarchos_view{ps|wait|worktrees}` answers liveness **from that fold** (an open `worktree.merge_requested` with no paired `worktree.merge_executed` = in flight). `merge_orchestrate`'s own `merge.*` events stay on the per-`featureId` stream, **untouched** — the worktrees-stream pair is purely additive. A ground-truth probe (process-cwd + fs scan) is **pulled on demand only** (GC, orphan-detection, `ps --probe`), folding findings into `orphan_detected`/`released` — no interval/loop/daemon (INV-10/15). The probe excludes the manager's **own process ancestry** (DR-5).

**Merge serialization is an optimistic lease, not a held lock (DR-7/8).** The event-store gate serializes *appends* (short transactions); it cannot hold a lock across `merge_orchestrate`'s multi-second git work, and it must not. So single-writer is enforced **logically** by a lease in the `inFlightMerges` projection:
1. `serialize_merge` folds `inFlightMerges`. If `integrationRef` already has an unpaired in-flight merge, it **bounded-waits** via the injected sleep seam (Task 005) under an explicit timeout and re-folds (caller-bounded, not a daemon — INV-15); on expiry it returns a structured `merge-slot-timeout`. **Each wait iteration probes the current holder's `holderPid`/`holderStartedAt` (the DR-5 probe) and reclaims a provably-dead holder inline** (emits the terminal once) rather than waiting out the timeout — so a crashed holder never forces same-branch merges to eat a full timeout.
2. Otherwise it claims the slot by appending `worktree.merge_requested` via `decide` with **OCC** (`expectedSequence` = current worktrees-stream tail). **The slot-emptiness check runs INSIDE the `decide` closure** (mirroring the shipped `WorktreeManager.reserve` single-writer pattern, manager.ts:622-651), so the OCC commit is gated on the exact folded tail: a racing claimant that folded the same empty state loses with `ConcurrencyError`, re-folds (now seeing the holder), and waits, and an unrelated event bumping the tail yields a conservative conflict — never a double-claim. At most one holder per `integrationRef`.
3. The winner re-reads fresh integration HEAD, calls **unchanged** `merge_orchestrate`, then appends `worktree.merge_executed` to release the lease. **The release is a plain keyed append — NOT CAS-pinned to the claim's returned sequence** (other worktree events advance the stream meanwhile; CAS-pinning a follow-on event to a prior append's seq is the documented idempotency trap).
4. A stale lease whose `holderPid`/`holderStartedAt` is provably dead (DR-5 probe) is reclaimed via reconcile (emits the terminal once, INV-8/13).

This gives true cross-process single-writer (the lease invariant lives in the log + projection; the OCC claim serializes check-then-act) within INV-7/13/15, with `merge_orchestrate` composed unchanged. Worktree-mutating git the manager itself performs is wrapped with retry-on-`index.lock` (exp backoff + jitter) and burst-creation jitter, seam **injected** for deterministic tests.

**`#1316` Q6 resolved inline.** This slice defines and lands the worktrees-stream liveness schema (DR-4), grounded in INV-10; the generic `#1090` verbs only *read* these events. Coordination rule 2 permits `#1577` to land the schema.

### Requirements (DR-N)

Numbering inherited from the epic design. The DR-N below are the single source the decomposition traces against.

#### DR-4: Liveness protocol (worktrees-stream merge pair) + on-demand ground-truth probe

Long-running ops emit a `requested`/`executed` pair on the singleton `worktrees` stream (merge: `worktree.merge_requested` + `worktree.merge_executed`). `worktrees@v1` folds them into an **integration-ref-keyed `inFlightMerges`** map; `exarchos_view{ps|wait|worktrees}` answers from that fold, never a scan. A ground-truth probe is pulled **on demand only** and folds findings into events. This slice also builds the `worktree.orphan_detected` **emitter** (the type + reducer fold already exist).

**Acceptance criteria:**
- Given a merge in flight (`worktree.merge_requested` with no paired `worktree.merge_executed`), when `exarchos_view{action:'ps'}` is dispatched (through `handleView`), then the in-flight op is listed from the `inFlightMerges` fold **without a process scan**.
- `wait --worktree=<id>|--integration=<ref> --until=idle --timeout=<t>` resolves when the paired terminal is folded. The wait is **caller-bounded**: folds current events, and if not yet terminal bounded-polls via the **injected sleep seam** (Task 005) under `--timeout`, returning a **structured timeout** on expiry — never a hang.
- **No background interval/daemon exists** in the manager: a `setInterval`/`setTimeout`-spy assertion confirms zero background timers are created during manager ops (a caller-invoked, timeout-bounded `wait` poll is not a background loop — INV-15).
- Given a reserved worktree whose backing process is provably gone, when the probe runs on demand, then it emits `worktree.orphan_detected`/`worktree.released` and `worktrees@v1` reflects it — closing the unbuilt-emitter gap.

#### DR-5: Protected-ancestry process probe

The on-demand process-cwd probe **must** exclude the manager's own process ancestry — the orchestrator's shell can drift its cwd into an agent worktree (recurring hazard). Walk the current PID's parent chain and protect the whole ancestry before reporting in-use.

**Acceptance criteria:**
- Given the orchestrator's own shell cwd is inside worktree W, when the probe evaluates W, then the orchestrator's PID **and its full parent chain** are excluded from the in-use set; a self-rooted cwd never marks W in-use.
- Containment is symlink-canonicalized so a process cwd matches a symlinked worktree path (unix path; cross-platform portability is DR-11 → `#1579`, behind an injected process-source shim so the Windows path is not foreclosed).
- A unit test asserts a self-rooted cwd does not mark a worktree in-use.
- **No process-termination path is introduced in this slice** — the probe is read-only (in-use reporting). The protected-ancestry filter is the same filter a future termination path (DR-12/`#1580`) would reuse; termination itself is out of scope here.

#### DR-7: Integration-branch merge serializer (optimistic lease; composes `merge_orchestrate`)

`serialize_merge` guarantees **one writer to a given integration branch at a time** via an optimistic lease over `inFlightMerges` (claim by OCC append + caller-bounded wait-for-slot), delegating the merge to **unchanged** `merge_orchestrate`. No flock/PID lock (INV-7).

**Acceptance criteria:**
- Given two task branches (possibly different `featureId`s) request merge onto the **same** integration branch concurrently, when `serialize_merge` handles them, then at most one holds the lease at a time; the second bounded-waits for the first's `worktree.merge_executed` before claiming, and **neither runs `merge_orchestrate` concurrently against the branch**. The claim race is resolved by OCC on the worktrees-stream tail, so the guarantee holds **cross-process**.
- `serialize_merge` delegates to `merge_orchestrate` **unchanged**: the `merge.*` events it emits on the per-`featureId` stream match a direct call in **event-type sequence and non-volatile structural fields**, excluding all volatile/content-derived fields (event id, timestamp, sequence, and commit-derived `mergeSha`/`rollbackSha`/`recoveryPointSha`). The serializer's only additions are the two `worktrees`-stream lease events. INV-13 split and INV-14 `--abort`→`--keep` recovery pass through.
- No flock/PID/`.lock` file is introduced (the serializer writes no lock file and imports no advisory-lock library); no speculative/remote-CI behavior (Non-Goals, INV-3).
- The `worktree.merge_executed` release is a **plain keyed append**, not CAS-pinned to the claim's returned sequence (avoids the documented idempotency trap).

#### DR-8: Git-mutation lock-contention resilience

Worktree-mutating git the manager performs is wrapped with retry-on-`index.lock` (exp backoff ~200/400/800ms ±jitter); creation/adoption staggered 100–500ms under burst (#55724). Backoff/jitter/sleep seam **injectable**.

**Acceptance criteria:**
- Given a transient `Unable to create '.git/index.lock'`, when the manager performs the mutation, then it retries N times with backoff+jitter and **succeeds** without surfacing the error.
- Backoff/jitter/sleep are **injected** — a test asserts the retry sequence deterministically; burst-creation jitter is likewise injected and asserted.
- Exhausted retries return a **structured error**, never a silent no-op.

#### DR-12 (operational-core scope): Error handling & failure modes for liveness + merge

**Acceptance criteria:**
- **Crash mid-merge:** Given `worktree.merge_requested` with no paired `worktree.merge_executed`, when reconcile runs, then an **idempotent precheck** (integration HEAD / merge state) determines resume-vs-skip and emits the terminal **exactly once** (INV-8/13); no duplicate merge.
- **Stale lease reclaim:** Given an in-flight merge whose `holderPid`/`holderStartedAt` is provably dead, when **either** `serialize_merge`'s own wait loop probes the holder (inline, the live path) **or** an on-demand `reconcile` runs, then the lease is released (terminal emitted once) so a waiting `serialize_merge` can claim — no permanent deadlock and no full-timeout penalty on the live path.
- **Concurrent prune + merge on the same worktree:** `prune_worktrees` folds `inFlightMerges` and **skips** any worktree/branch holding an unpaired in-flight merge lease (re-verified under its own claim); no double-free.
- **Preserve-uncommitted on recovery:** `serialize_merge` introduces **no** `git reset --hard`; reversal passes INV-14 `--abort`→`--keep` through `merge_orchestrate` and surfaces `recoveryError` on indeterminate state.
- **cwd-drift false positive:** the orchestrator's own drifted shell never marks/teardowns a worktree (DR-5).
- **Exhausted `index.lock` retry:** surfaces the DR-8 structured error; no half-merge.

### Technical Design

**Module layout** (extend `servers/exarchos-mcp/src/orchestrate/worktree/`, created by the foundation):
- `event-store/schemas.ts` — add `worktree.merge_requested`/`worktree.merge_executed` to the `EventType` union, `EventDataSchemas`, `EventDataMap`, the `EVENT_*` classification maps, **and the total-record `EVENT_EMISSION_REGISTRY` (`Record<EventType, …>`, schemas.ts:378, which compile-breaks on a missing key)**. Keys: the **claim** append goes through `decide`, which derives `${streamId}:${reducerId}:${operationId}` (= `worktrees:worktrees@v1:<operationId>`, atomic-appender.ts:544); the **release** is a plain keyed append `<eventType>:<operationId>` per the worktree-family convention (schemas.ts:1951). Both are operationId-discriminated, so two merges onto one branch never collide — the Task 001 test asserts that **no-collision property**, not a literal key string. The integrationRef is the *lease key in the projection*, not an idempotency key.
- `views/workflow-state-projection.ts` — add `case 'worktree.merge_requested'`/`'worktree.merge_executed'` arms to the worktree case block (the `never`-exhaustive guard compile-breaks otherwise — a consumer beyond `worktrees@v1`).
- `orchestrate/worktree/projections/worktrees.ts` — extend `worktrees@v1` with the integration-ref-keyed `inFlightMerges` map folding the merge pair, plus folding probe-emitted `orphan_detected`/`released`.
- `orchestrate/worktree/pure/probe.ts` — process+fs scan behind an **injected process source**; symlink-canonicalized containment; protected-ancestry subtraction (DR-5).
- `orchestrate/worktree/git-retry.ts` — injected backoff/jitter/sleep seam + `index.lock` retry wrapper + burst jitter (DR-8); the sleep seam is reused by Task 004's bounded `wait`.
- `orchestrate/worktree/merge-serializer.ts` — the optimistic-lease loop (fold → wait-for-slot → OCC claim → fresh-HEAD re-read → unchanged `merge_orchestrate` → plain release).
- **Dispatch wiring (DOA-class guard):** `orchestrate/worktree/handlers.ts` gains `handleSerializeMerge`, `handleViewPs`, `handleViewWait`; `orchestrate/composite.ts` `ACTION_HANDLERS` gains `serialize_merge`; `views/composite.ts` `handleView` switch gains `case 'ps'`/`case 'wait'`. The orchestrate side is guarded by `OrchestrateActions_MatchCompositeHandlers_InSync` (registry.test.ts:801); the view side currently has only a *superset* guard (`views/describe.coverage.test.ts`), so this slice adds the missing `ViewActions_MatchCompositeHandlers_InSync` equality twin (Task 007). All new-verb tests run **through `handleView`/`handleOrchestrate`**, not the module in isolation.

**State & serialization.** Liveness + lease live only in `worktree.*` events + `worktrees@v1` over `WORKTREES_STREAM` (`'worktrees'`, manager.ts:98). Cross-process ordering = SQLite WAL `BEGIN IMMEDIATE` + per-stream version gate via `decide`/`appendComputed` `expectedSequence` (the only cross-process guard, INV-7; throws `ConcurrencyError`, retried by `withStateRetry`). Idempotency keys (INV-8) make the claim append crash-collapse. The lease (not a held DB lock) is what serializes the *merge execution*.

**MCP-server typecheck.** Per the separate-typecheck gotcha, the schema-union and projection edits must be verified by `cd servers/exarchos-mcp && npm run typecheck` (root typecheck does not cover it).

### Integration Points

- `merge-orchestrate.ts` / `execute-merge.ts` — **unchanged**; `serialize_merge` is a caller (DR-7).
- `event-store/schemas.ts` + both count-pin tests (`event-store/schemas.test.ts`, `__tests__/event-store/schemas.test.ts`) — EventTypes 136 → 138 (DR-4/7).
- `views/workflow-state-projection.ts` — exhaustive worktree case arms (DR-4).
- `orchestrate/worktree/{projections/worktrees.ts,pure/probe.ts,git-retry.ts,merge-serializer.ts,manager.ts,handlers.ts}` (DR-4/5/7/8).
- `orchestrate/composite.ts` + `views/composite.ts` — dispatch wiring (DR-4/7).
- `registry.ts` — register `serialize_merge`/`ps`/`wait` with `outputSchema` + 3 core annotations (fail-closed at load); full DR-10 polish → `#1580`.
- v2.12 verbs (`#1090`) — first consumers of this liveness substrate.

### Alternatives considered

- **Gate-by-append (hold the worktrees-stream lock across the merge).** Rejected: the WAL write-lock + in-process mutex release when the append commits; `merge_orchestrate` runs outside any lock, so two processes could both claim then merge concurrently. The lease + bounded-wait enforces single-writer logically without holding a DB lock across an external side effect.
- **Emit merge liveness on the per-`featureId` stream and cross-fold it.** Rejected: `worktrees@v1` is stream-scoped over the singleton stream; cross-folding breaks the single-projection model.
- **flock/PID file keyed on the branch.** Rejected: violates INV-7 and isn't crash-safe.
- **Bundle `#1578` with `#1579` (boundary + Windows-CI).** Rejected: `#1579` is launcher-exposed (`#1603`); liveness + merge are launcher-stable.

### Open Questions

- **`#1603` launcher fork (deferral, not a blocker).** If launcher-owns-creation is adopted, it becomes the event **producer** — schema + fold + lease are unchanged; the DR-5 probe is still needed (crash-orphans + cwd-drift survive a launcher). `#1579`/`#1580` deferred until `#1603`.
- **Serialization granularity.** Single-writer is per-`integrationRef` (the lease key). Worktree-mutating ops still append to the singleton `worktrees` stream, so the OCC claim is per-stream but the *invariant* is per-branch; finer per-branch streams are a future optimization — out of scope.
- **`wait` push vs bounded-poll.** Bounded-poll via the injected sleep seam under timeout (no daemon). The `#1315` subscription primitive is the future push replacement.
- **`ps`/`wait` verb home.** This slice lands the events + a manager-scoped read path; the generic verbs ship under `#1090` (resolves source-design OQ-1).

## Decomposition

Maps every task to DR-N from `## Design & Rationale`. All work extends `servers/exarchos-mcp/src/orchestrate/worktree/` (PR #1628).

### Scope

**Target:** Partial — operational-core: DR-4 (liveness), DR-5 (probe), DR-7 (merge lease), DR-8 (lock resilience), DR-12 (liveness/merge subset).
**Excluded:** DR-1/2/3 + DR-6 shipped (PR #1628). DR-9 + DR-11 → `#1579`. Full DR-10 surface polish → `#1580`. The DR-10 **registration floor** + the **dispatch wiring** are **included** (Tasks 004/006/007) — both are fail-closed/DOA hazards, not deferrable.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-4 | Liveness (worktrees-stream merge pair + `inFlightMerges`) + on-demand probe + ps/wait dispatch | 001, 003, 004, 007 |
| DR-5 | Protected-ancestry process probe (read-only) | 002 |
| DR-7 | Integration-branch merge serializer (optimistic lease; composes `merge_orchestrate`) | 001, 006, 007 |
| DR-8 | Git-mutation lock-contention resilience | 005 |
| DR-12 | Error handling & failure modes (liveness + merge subset) | 008 |

### Tasks

`riskTier` selects verification depth (ladder in `@skills/_shared/references/verification.md`). Tests judged **test-after by adequacy**.

#### Task 001: Add `worktree.merge_requested`/`worktree.merge_executed` to the event-store union

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-4, DR-7

Extend the central discriminated union (`EventType`, `EventDataSchemas`, `EventDataMap`, `EVENT_*` maps, and the total-record `EVENT_EMISSION_REGISTRY` at schemas.ts:378). Update **both** EventTypes count pins (136 → 138) and the `never`-exhaustive consumer in `views/workflow-state-projection.ts`. The claim event is appended through `decide` (key derived as `${streamId}:${reducerId}:${operationId}`), the release through a plain keyed append (`<eventType>:<operationId>`); both are operationId-discriminated. Broad blast (every reducer/exhaustive switch + total record) → high. Verify via `cd servers/exarchos-mcp && npm run typecheck` (separate gate).

**Verification (high):** medium set + union-exhaustiveness/integration check (both count pins + classification-map completeness + MCP-server typecheck).
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts`, `servers/exarchos-mcp/src/event-store/schemas.test.ts`, `servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts`, `servers/exarchos-mcp/src/views/workflow-state-projection.ts`
**Expected tests:** `EventTypes_IncludesWorktreeMergeRequestedAndExecuted`, `EventTypes_CountIs138_BothPinsUpdated`, `WorktreeMergeEvents_ClassificationMaps_Exhaustive`, `WorktreeMergeEvents_IdempotencyKey_PerOperationId_NoCollisionAcrossMergesOnSameBranch`, `WorkflowStateProjection_HandlesNewWorktreeMergeTypes_Exhaustive`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 002: Protected-ancestry process probe (`pure/probe.ts`)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5

Process enumeration behind an **injected process source**; symlink-canonicalized cwd→worktree containment; subtract the current PID's full parent chain before reporting in-use. Read-only — returns event payloads; no termination path. Process source shimmed so the unix path is correct and Windows (DR-11 → `#1579`) is not foreclosed.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/pure/probe.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/pure/probe.test.ts`
**Expected tests:** `Probe_SelfRootedCwd_ExcludedFromInUseSet`, `Probe_OwnerAncestryChain_FullyProtected`, `Probe_SymlinkedWorktreePath_ContainmentMatches`, `Probe_DeadOwner_ReportedReleasable`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 003: Fold merge pair into `inFlightMerges` + probe emissions in `worktrees@v1`; orphan emitter

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-4

Extend `worktrees@v1` (at `orchestrate/worktree/projections/worktrees.ts`) with an **integration-ref-keyed `inFlightMerges`** map folding `worktree.merge_requested`/`worktree.merge_executed` (an integration merge maps to no worktreeId entry, so it needs its own sub-structure); fold probe-emitted `orphan_detected`/`released`; wire the probe → `worktree.orphan_detected` emitter. Broad blast → high.

**Verification (high):** medium set + integration suite (cold-rebuild equals live state; `assertReducerImmutable`).
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.test.ts`
**Expected tests:** `WorktreesProjection_MergeRequestedNoExecuted_AppearsInInFlightMerges`, `WorktreesProjection_MergeRequestedThenExecuted_ClearsInFlightMerges`, `WorktreesProjection_IntegrationMergeWithNoWorktreeEntry_HasHomeInInFlightMerges`, `WorktreesProjection_ProbeFinding_EmitsAndFoldsOrphanDetected`, `WorktreesProjection_ColdRebuild_EqualsLiveState`, `WorktreesReducer_AssertReducerImmutable_Passes`
**Dependencies:** 001, 002
**Parallelizable:** No

#### Task 004: Liveness emission + `exarchos_view{ps|wait|worktrees}` read path **through `handleView`**

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-4

**Read-only** view path (the merge-pair *emission* is owned solely by Task 006; this task does not append liveness events). Add `case 'ps'`/`case 'wait'` to the `handleView` switch + `handleViewPs`/`handleViewWait` in `handlers.ts`, folding `inFlightMerges`. `wait` bounded-polls via the injected sleep seam (Task 005) under an explicit timeout → structured timeout, never hangs. Tests dispatch **through `handleView`** (DOA-class lesson). Include the no-background-timer spy assertion.

**Verification (high):** medium set + integration suite across the view dispatch seam.
**Files:** `servers/exarchos-mcp/src/views/composite.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/handlers.test.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts`
**Expected tests:** `HandleView_Ps_ListsInFlightFromInFlightMerges_NoProcessScan`, `HandleView_Ps_Probe_PullsOnDemandAndEmits`, `HandleView_Wait_AlreadyTerminal_ResolvesImmediately`, `HandleView_Wait_InFlightThenTerminal_ResolvesWithinTimeout`, `HandleView_Wait_Timeout_ReturnsStructuredTimeoutNotHang`, `Manager_NoBackgroundTimer_SetIntervalSpyZeroCalls`
**Dependencies:** 001, 003, 005
**Parallelizable:** No

#### Task 005: Injectable backoff/jitter/sleep seam + `index.lock` retry wrapper

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-8

Retry-on-`index.lock` (exp backoff ±jitter) + burst-creation jitter; backoff/jitter/sleep injected (mirrors `merge_orchestrate`'s seam). Exposes the sleep seam reused by Task 004's bounded `wait` and Task 006's wait-for-slot.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/git-retry.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/git-retry.test.ts`
**Expected tests:** `GitRetry_TransientIndexLock_RetriesWithBackoffAndSucceeds`, `GitRetry_InjectedSeam_AssertsDeterministicRetrySequence`, `GitRetry_BurstCreationJitter_AssertedDeterministically`, `GitRetry_ExhaustedRetries_ReturnsStructuredErrorNotSilentNoOp`
**Dependencies:** None
**Parallelizable:** Yes

#### Task 006: `serialize_merge` optimistic-lease funnel **through `handleOrchestrate`** (composes `merge_orchestrate`)

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-7

Lease loop in `merge-serializer.ts`: fold `inFlightMerges` → bounded wait-for-slot (Task 005 seam) → OCC claim `worktree.merge_requested` (`expectedSequence`, `ConcurrencyError`→`withStateRetry`) → re-read fresh integration HEAD → **unchanged** `merge_orchestrate` → **plain** `worktree.merge_executed` release (not CAS-pinned). Wire `serialize_merge` into `ACTION_HANDLERS` + `handleSerializeMerge`; tests dispatch **through `handleOrchestrate`**.

**Verification (high):** medium set + integration suite (real-SQLite two-featureId concurrent merge onto one integration branch; `merge.*` featureId-stream events compared to a direct call excluding volatile + commit-derived sha fields).
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.test.ts`, `servers/exarchos-mcp/src/orchestrate/composite.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts`
**Expected tests:** `SerializeMerge_TwoFeatureIdsSameBranch_SecondWaitsForFirstExecutedBeforeClaiming`, `SerializeMerge_ConcurrentClaims_OccResolvesSingleHolderCrossProcess`, `SerializeMerge_MergeOrchestrateComposedUnchanged_FeatureStreamEventsMatchModuloVolatileAndShas`, `SerializeMerge_ReleaseIsPlainKeyedAppend_NotCasPinnedToClaimSeq`, `SerializeMerge_WritesNoLockFile_ImportsNoFlockLib`, `HandleOrchestrate_SerializeMerge_RoutesToHandler_NotUnknownAction`
**Dependencies:** 001, 003, 005
**Parallelizable:** No

#### Task 007: Register `serialize_merge`/`ps`/`wait` (outputSchema + annotations) + close the view-side parity hole

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-4, DR-7

Register the three new actions, **each with a Zod `outputSchema` + the three core annotations** (destructive/readOnly/idempotent) — `validateAction` throws fail-closed at module load otherwise. Add the missing `ViewActions_MatchCompositeHandlers_InSync` equality guard (the existing view guard is superset-only, letting a registered-but-unrouted verb ship DOA). Visible composite-tool count stays at 4.

**Verification (medium):** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Files:** `servers/exarchos-mcp/src/registry.ts`, `servers/exarchos-mcp/src/registry.test.ts`, `servers/exarchos-mcp/src/views/describe.coverage.test.ts`
**Expected tests:** `Registry_NewActions_DeclareOutputSchemaAndCoreAnnotations`, `Registry_ModuleLoad_DoesNotThrowOnNewActions`, `ViewActions_MatchCompositeHandlers_InSync`, `Registry_VisibleCompositeToolCount_StaysFour`
**Dependencies:** 004, 006
**Parallelizable:** No

#### Task 008: Error handling & failure modes (crash-resume, stale-lease, concurrent prune+merge, retry exhaustion)

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-12

Crash-mid-merge → idempotent precheck → **exactly one** terminal (INV-8/13). Stale lease (dead `holderPid`/`holderStartedAt` per DR-5) reclaimed **inline by `serialize_merge`'s wait loop** (live path) or by an on-demand reconcile → no deadlock, no full-timeout penalty. Concurrent prune+merge: `prune_worktrees` folds `inFlightMerges` and **skips** a worktree/branch with an unpaired in-flight merge (re-verified under its claim; no double-free). Exhausted `index.lock` retry → DR-8 structured error, no half-merge. `serialize_merge` introduces no `reset --hard`; reversal surfaces `recoveryError` from the composed-unchanged `merge_orchestrate` (INV-14).

**Verification (high):** medium set + integration suite (real-SQLite crash/concurrency).
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/recovery.test.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.ts`
**Expected tests:** `Recovery_MergeRequestedNoExecuted_ResumeEmitsSingleExecuted`, `Recovery_StaleLeaseDeadHolder_WaitLoopReclaimsInlineNoFullTimeout`, `Recovery_StaleLeaseDeadHolder_ReconcilePathAlsoReclaims`, `Recovery_ConcurrentPruneAndMerge_PruneSkipsBranchWithInFlightLease`, `Recovery_ExhaustedIndexLockRetry_SurfacesStructuredErrorNoHalfMerge`, `Recovery_SerializerIntroducesNoResetHard_SurfacesRecoveryErrorFromMergeOrchestrate`
**Dependencies:** 003, 004, 006
**Parallelizable:** No

### Parallelization

- **Wave 1 (parallel):** Task 001 (event union), Task 002 (probe), Task 005 (git-retry seam) — no shared files.
- **Wave 2:** Task 003 (reducer + `inFlightMerges`; needs 001+002).
- **Wave 3 (parallel):** Task 004 (view dispatch; needs 001+003+005), Task 006 (lease serializer; needs 001+003+005). **Coordination:** both edit `orchestrate/worktree/handlers.ts` (004 adds `handleViewPs`/`handleViewWait`; 006 adds `handleSerializeMerge`) — additive, non-overlapping functions; if run in separate worktrees, rebase/merge `handlers.ts` carefully (or sequence 006 → 004).
- **Wave 4 (parallel):** Task 007 (registry + parity guard; needs 004+006), Task 008 (error/edge; needs 003+004+006).
- **Critical path:** 001 → 003 → {004 | 006} → 008.

### Completion checklist

- [x] Every DR-N maps to ≥1 task (DR-4/5/7/8/12 covered)
- [x] Every task `Implements:` a DR-N that exists here (no forward-dangling references)
- [x] Every task carries a `riskTier` (001/003/004/006/008 high; 002/005/007 medium)
- [x] Medium/high tasks carry adequacy-judged tests (test-after); new verbs tested **through dispatch** (`handleView`/`handleOrchestrate`) per the DOA-action lesson
- [x] Round-1 HIGH (H1–H4) + round-2 HIGH (lease-not-gate, idempotency-key collision, DOA dispatch wiring) + MEDIUM (worktreeId-keyed projection home, modulo-volatile sha set, missed schema consumers) all closed
- [x] Open questions resolved or explicitly deferred (`#1316` Q6 inline; `#1603`/`#1579`/`#1580` deferred; serialization granularity, `wait` mechanism, termination-out-of-scope stated)
- [ ] Ready for `plan-review`
