# Spec: WLM slice 3 — reconcile + enforce (wire the guarantees the foundation built)

**Date:** 2026-07-03 · **Feature:** `wlm-next-slice` · **Depth:** standard
**Inputs:** epic #1574 · design `docs/designs/2026-06-21-worktree-lifecycle-manager.md` (epic DR-1..DR-12) · shipped specs `docs/specs/2026-06-25-wlm-foundation.md`, `docs/specs/2026-06-26-wlm-operational-core.md` · post-merge audit of PRs #1628 + #1631 (event `exarchos-feature-audit` seq 1) · issues #1579, #1580, #1633 (review deferrals), #1634, #1635 · merged #1568 (closed #1301)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **Numbering note:** DR-N below are THIS slice's requirements. Epic-level requirements are cited as `epic DR-N`.

## Design & Rationale

### Problem Statement

WLM-1..4 (PRs #1628, #1631) shipped a genuinely sound substrate — the post-merge audit kill-probed the load-bearing claims (dead-owner release, dirty-skip GC, in-process single-writer guard) and all went red on revert; the event schema, projection purity, dispatch wiring, and fail-closed ladders held up under adversarial trace.
But the audit returned **FAIL (2 HIGH, 4 MEDIUM)** because the epic's two headline *guarantees* exist without being *in force*:

**HIGH-1 — epic DR-8 shipped as dead code.** `withIndexLockRetry`, `burstStagger`, and `IndexLockContentionError` (`git-retry.ts`) have **zero production call sites**: `manager.ts:1589` runs `git worktree remove --force` unwrapped, `merge-orchestrate.ts` never references the retry seam, and the creation path (`setup-worktree.ts`) has no stagger.
`recovery.test.ts:406` even asserts "merge_orchestrate's DR-8 retry seam exhausts" while injecting the error by hand — a green test masking an unwired seam (the same built-but-unwired signature the #1603 launcher review caught).
Provenance: the wiring was *started and lost*, not forgotten — the stale worktree `.claude/worktrees/agent-a5171342a1827e641/` (branch `fix/wlm-oc-review-cycle2`) holds uncommitted WIP wiring `withIndexLockRetry` into the manager's remove path (`manager.ts:1603` there) plus prune-test updates; it never reached the PR.
Same class, second member: `resumeCrashedMerge` (`merge-serializer.ts:712`, the DR-12 standalone crash-resume entry) has zero callers outside its own test — only the inline dead-holder reclaim in the wait loop is live.

**HIGH-2 — the single-writer guarantee is opt-in, and nothing opts in.** `serialize_merge` has zero callers: no skill, command, or handler routes through it, while seven skill surfaces (`merge-orchestrator`, `delegation`, `synthesis`, `shepherd`, `git-worktrees`) still direct agents at raw `merge_orchestrate`, which takes no lease.
Two agents following current guidance can still race an integration branch — the exact #55724 class the epic exists to kill.
Live evidence of non-adoption: the `worktrees` projection is empty while a stale review-cycle worktree (`fix/wlm-oc-review-cycle2`) sits on disk; the GC has no invocation path in any workflow.

**MEDIUMs (rolled-forward deferrals + adjacent hazards):**
- `worktree.remove.*` two-stream split: `compensation.ts:436` appends to the `featureId` stream, prune to the singleton `worktrees` stream; the foundation spec deferred unification "to WLM-3/WLM-4", which shipped without it (DIM-1 single-source violation; advisory-view staleness).
- Prune emits no INV-10 liveness pair — an in-flight `prune_worktrees` is invisible to `ps`/`wait` (foundation spec called closing this "a one-line add in WLM-3"; it rolled forward).
- Cancel-compensation teardown (`compensation.ts:455`) force-removes with **no dirty guard** — uncommitted work in a cancelled workflow's worktree is destroyed (pre-existing, unclaimed by the slices, but it is the epic's own DR-12 shape and bypasses the ladder the epic built).
- No GC cadence: `prune_worktrees` is documented nowhere in the workflow surfaces, so accumulation continues unbounded (epic OQ-3 deferral, still unresolved).

Meanwhile the remaining epic children have drifted from reality: #1579 says "closing the open #1301 boundary leak", but #1301 is **closed** (root-fixed by merged #1568), and its Windows-CI criterion is partially delivered (the `test-windows` lane + zero-count guard ran green on both merges).
This slice therefore reconciles #1579 to its true remainder, folds in the audit's fixes, and absorbs the two open launcher-teardown deferrals (#1634, #1635) that touch the same probe/lease seams.

### Chosen Approach

Make the shipped guarantees *structural at their chokepoints* rather than available-by-convention, and close every rolled-forward deferral so the epic's ledger is honest before its final slice.

Three moves: (1) wire the DR-8 resilience kernel at the real git-mutation sites and prove the wiring with call-site-level tests plus a grep-gate so an unwired-kernel regression is a CI failure, not a review catch; (2) enforce single-writer at the handler — `merge_orchestrate` fail-closes when a foreign live lease holds the integration ref, `serialize_merge` passes its lease proof through, and all seven skill surfaces reroute — so the guarantee binds callers who never heard of the serializer; (3) deliver the re-scoped remainder of epic DR-9/DR-11 (resolver posture gate, Windows-portable probe, required Windows lane) plus the deferral closures (stream unification, prune liveness, compensation dirty-guard, GC cadence).

WLM-6 (#1580, full agent-first surface polish) and the legacy-trio consolidation (`setup-worktree.ts` / `worktree-baseref.ts` / `dispatch-guard.ts` re-homing) stay out — the latter carries every existing worktree caller's blast radius and remains the final slice's cohesion work.

### Requirements (DR-N)

#### DR-1: Wire the index.lock resilience kernel at every worktree-mutating git chokepoint

Route the existing `withIndexLockRetry` around the real mutation sites — the prune executor (`manager.ts` remove path), the compensation remove path, and `merge_orchestrate`'s `GitExec` seam — and apply `burstStagger` at the worktree-creation seam (`setup-worktree.ts`, wired in place; no re-homing).
Correct the false `recovery.test.ts` comment that claims the seam already exists.

**Acceptance criteria:**
- Given a transient `index.lock` failure injected at a REAL call site (not a hand-thrown error), when the prune executor / composed merge runs, then the operation retries with the asserted backoff sequence and succeeds.
- Given exhausted retries at a real call site, then the structured `IndexLockContentionError` propagates to the caller end-to-end — never a silent no-op or half-state (error-handling AC).
- A structural guard (lint/grep gate in CI, SIV-1) fails when a worktree-mutating git invocation anywhere under `orchestrate/` (including `merge-orchestrate.ts`, `git-exec-default.ts`, `setup-worktree.ts`, and `orchestrate/worktree/`) or in `workflow/compensation.ts` does not route through a retry adapter — the merge seam and the creation seam are inside the gate's scope, not outside it.
- A named test exercises the DEFAULT executor composition against a real repo with a real `index.lock` file on disk (not the DI seam): the default path retries and succeeds, proving the production composition — not just the kernel — is wired.
- Kill-probe: removing the wrapper from any wired site turns at least one test red.

#### DR-2: Enforce single-writer integration merges at the handler chokepoint

`merge_orchestrate` fail-closes when the target integration ref carries a live foreign merge lease (structured error naming `serialize_merge` as the path); `serialize_merge` threads its lease `operationId` through so its own composed call passes.
Reroute all seven skill/command surfaces to present `serialize_merge` as the integration-merge path, and surface `prune_worktrees` cadence ("after synthesize") in the synthesis/cleanup guidance + `next_actions` affordance (INV-12).

**Acceptance criteria:**
- Given a live foreign lease on `integrationRef`, when `merge_orchestrate` is invoked directly, then it returns a structured fail-closed error (no git side effect) that names `serialize_merge` (error-handling AC).
- Given no lease or a dead-holder lease, direct `merge_orchestrate` behaves exactly as today (back-compat; dead holder is not a blocker).
- `serialize_merge`'s composed call succeeds under its own lease; the byte-equality timeline oracle stays green.
- A skills-src grep gate proves no skill/command directs raw `merge_orchestrate` for integration-branch merges; CLI≡MCP parity preserved (INV-2).

#### DR-3: Close the rolled-forward event/teardown deferrals

Unify `worktree.remove.*` onto the singleton `worktrees` stream (or add a cross-stream reconcile fold) so compensation-triggered removals reach the `worktrees@v1` view; emit the INV-10 pair for `prune_worktrees` so an in-flight prune is `ps`/`wait`-visible; give the cancel-compensation teardown the dirty-guard the ladder already enforces.

**Acceptance criteria:**
- Given a workflow-cancel compensation that removes a worktree, then compensation adopts the path into the `worktrees` stream first when no entry exists (adopt-then-remove, mirroring the prune step-0 adopt-gate), emits the INV-13 pair there, and after fold the view shows no live entry for the removed path (DIM-1 restored, not vacuously); crash-resume is idempotent, with the operationId precheck reading the `worktrees` stream and falling back to the legacy featureId stream for pre-deploy orphans.
- Given uncommitted changes (including untracked-only) in a worktree targeted by compensation teardown, then it is skipped-and-surfaced, never `--force`-removed; recovery never uses `git reset --hard` (INV-14) (error-handling AC).
- Given an in-flight `prune_worktrees`, `exarchos_view{ps}` lists it from events and `wait --until=idle` resolves on its terminal event.
- Replay of pre-unification events folds without error (schema/migration safety).
- `resumeCrashedMerge` is either wired into a real recovery entry point (reconcile / `ps probe:true` / serializer startup precheck) with a caller-level test, or deleted in favor of the live inline reclaim — no dead export remains (error-handling AC: a crash between `merge_requested` and `merge_executed` is recovered from a production path, emitting exactly one terminal event).

#### DR-4: Re-scoped epic DR-9 — resolver posture gate + post-hoc boundary verification

#1301 is closed by merged #1568; the remainder is: declare `serialize_merge`/`prune_worktrees` `shared-mutating` and gate them at the capability resolver **before** the handler (mirrors `merge_orchestrate` posture, INV-11); provide the post-hoc boundary verifiability assertion; pin the #1301 leak shape with a regression test if #1568 did not already land one.

**Acceptance criteria:**
- Given a `task-isolated` or `read-only` caller, when it invokes a `shared-mutating` worktree verb, then the resolver rejects before the handler runs (structured error, no side effect) (error-handling AC).
- A regression test reproduces the #1301 leak shape and asserts it is blocked (reuse #1568's if present; add otherwise).
- The boundary guarantee is asserted per-runtime (INV-4 parity: the gate lives in the resolver/dispatch core, not a harness hook).

#### DR-5: Re-scoped epic DR-11 — Windows-portable probe + required Windows lane

The process probe (cwd + create-time) works on win32 behind the existing injected process-source shim; path containment reuses the launcher's canonicalization (`toPosix` + `realpathSync.native` 8.3 handling); the `test-windows` CI lane becomes a **required** check.

**Acceptance criteria:**
- Probe resolves process cwd + create-time on linux/macos/windows in platform-shimmed unit tests; unsupported platforms keep returning `unknown` fail-closed (never dead) (error-handling AC).
- Symlinked (macOS `/private/var`) and 8.3-shortened (Windows) worktree paths containment-match.
- `pure/path-containment.test.ts`'s `skipIf(win32)` case is replaced by a Windows-correct equivalent; the windows-latest lane runs the worktree suite green and is marked required in branch protection.
- #1633(a) prerequisite: `ReservationOwner`/`ReserveInput`/probe types thread `ownerStartedAt: string | null` end-to-end (the `''`-vs-`min(1)` class already fixed for `holderStartedAt`), so a create-time-unresolvable platform reserves with `null`, never `''`.

#### DR-6: Launcher teardown probe reconciliation (#1634, #1635)

Fold the two open Seer deferrals riding the same seams: the signal-path teardown occupancy probe racing the exiting child (reservation lingers until next GC), and the async origin probe in teardown + non-empty `holderStartedAt` guarantee.

**Acceptance criteria:**
- Given a child exiting during signal-path teardown, the occupancy probe re-checks after the reaped exit (or the reservation is released on the terminal launch event) — no lingering reservation until GC.
- Origin probe in teardown is non-blocking/async-safe; `holderStartedAt` on launcher-emitted claims is non-empty or explicitly `null` per schema (never empty-string).

### Technical Design

- **DR-1 wiring (two adapters, because the seams differ in shape):** the retry kernel's constants/classifier (`isIndexLockError`, backoff constants, `IndexLockContentionError`) are shared, but the call sites are not throw-based async functions, so `git-retry.ts` gains two thin adapters. (a) **Async result-aware** `withIndexLockRetryResult` for async contexts — the manager's remove path (`this.gitRunner.run(['worktree','remove',…])`, `manager.ts:~1588`) and `compensation.ts`'s `runCommand` remove — engaging on a result predicate (`exitCode !== 0 ∧ stderr matches index.lock`), not thrown errors, since these executors return failures. (b) **Sync result-aware** `withIndexLockRetrySync` wrapping `defaultGitExec` in `git-exec-default.ts` — `GitExec` is synchronous (`pure/merge-preflight.ts:49`) and already blocks on `spawnSync` for every git command, so a bounded sync sleep between retries (worst case ~1.5s) adds nothing qualitatively new to the event-loop profile; this keeps the pure merge pipeline's sync contract untouched and `merge_orchestrate` composed-unchanged. A naive async wrap is type-infeasible and, because `defaultGitExec` never throws, would be inert — rejected. `burstStagger` wires inside `setup-worktree.ts`'s creation entry (async context). The CI grep-gate lists the allowed wrapped idioms and fails on naked mutation spawns (same mechanism as `check-windows-portability.mjs`).
- **DR-2 lease guard (atomic with the threading — they cannot land separately):** the guard is a preflight inside `handleMergeOrchestrate`: fold `worktrees@v1`, look up `inFlightMerges[integrationRef]` where the lookup key is pinned to the bare-branch equivalence `targetBranch ≡ integrationRef` (the serializer writes bare branch names, `merge-serializer.ts:244`; merge_orchestrate builds `refs/heads/${targetBranch}` internally — the guard must look up the key shape the serializer writes). **Foreign live lease** is defined as: holder `operationId ≠` the caller-provided `leaseOperationId` AND holder liveness ∈ {alive, unknown} (DR-5 probe semantics; `unknown` counts as held; provably dead proceeds). Matching by `operationId` — not pid — means a crash-resumed caller from a new pid passes by presenting the original claim's `operationId`. `serialize_merge` threads its `leaseOperationId` in the same change, so its own composed call passes and the byte-equality timeline oracle stays green; guard + threading ship as ONE task. Reroutes touch `skills-src/{merge-orchestrator (SKILL + 2 references),delegation,synthesis,shepherd,git-worktrees,cleanup}` + regenerated `skills/` variants, and depend on the guard+threading task having landed.
- **DR-3 stream unification:** compensation's teardown emits to the `worktrees` stream via the same `appendLifecycle` idiom as the manager (keyed `worktree.remove.requested:<operationId>`); the `workflow-state-projection` continues folding the featureId-stream copies already in history (reducers stay total over old events).
- **DR-5:** extend `pure/process-identity.ts`'s platform table with the win32 source; containment goes through the launcher's canonicalizer in `utils/paths.ts`.
- **Invariants preserved:** INV-1/7/8 (all new writes are keyed events through existing appenders), INV-10 (prune pair), INV-11 (resolver gate), INV-13/14 (compensation keeps the two-event split, gains refuse-to-discard), INV-2/5a/5b (no new visible tool; guard errors ride the structured envelope), INV-15 (no daemon; probes stay pulled), INV-16 (win32 paths).

### Integration Points

- `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` — wrap remove-path mutations; prune liveness pair.
- `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts` — lease-guard preflight + wrapped `GitExec`.
- `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.ts` — thread `leaseOperationId` into the composed call.
- `servers/exarchos-mcp/src/workflow/compensation.ts` — dirty-guard, stream unification, retry wrapping.
- `servers/exarchos-mcp/src/orchestrate/setup-worktree.ts` — burst stagger (in place, no re-homing).
- `servers/exarchos-mcp/src/capabilities/resolver.ts` — shared-mutating posture gate.
- `skills-src/merge-orchestrator|delegation|synthesis|shepherd|git-worktrees` — reroute + cadence guidance (then `npm run build:skills`).
- `.github/workflows/ci.yml` + branch protection — grep-gate; `test-windows` required.
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` / launcher teardown path — DR-6 fixes.

### Alternatives considered

- **Skill-reroute only for single-writer (no handler guard).** Rejected as the sole mechanism: S1/conventional — any caller (or stale harness cache) bypasses it; the audit exists because convention did not bind.
- **Hide `merge_orchestrate` behind `serialize_merge` (retire the visible action).** Rejected here: breaks CLI/MCP back-compat and the composed-unchanged tenet; candidate for WLM-6 surface polish at most.
- **Full legacy-trio consolidation now.** Rejected: the foundation spec correctly priced its blast radius (every existing worktree caller); this slice wires *into* those files without re-homing them.
- **Making the lease guard advisory (warn, not fail).** Rejected: an advisory guard on a data-loss race is the procedural-signal trap the verification ladder retires; fail-closed with a dead-holder escape hatch keeps liveness.

### Open Questions

- Does the DR-2 lease guard conflict with the epic's "`merge_orchestrate` unchanged" non-goal? Position taken here: the non-goal was re-homing/behavioral rewrite; entry validation that fail-closes before any side effect preserves the composition contract. **Resolve at plan-review.**
- Branch-protection change (required `test-windows`) needs repo-admin action — in-slice task or ops follow-up? Recommend in-slice with a `gh api` task, falling back to a documented manual step.
- #1634's fix shape (probe-after-reap vs release-on-terminal-event) — decide in decomposition after reading the launcher teardown path; both satisfy DR-6's AC.
- #1633(b) `mergeSha`-required-when-`status:merged` superRefine: include only if DR-2's lease-guard work already plumbs a real `mergeSha` from `merge_orchestrate` through the resume path; otherwise leave in #1633 (adding the refine without the plumbing reintroduces the invalid-raw-event class).
- **Accepted deferral (do not fold):** #1633(c) null-create-time self-recovery stays fail-closed by Reed's decision — the self-identity model is designed with the v3.2 remote-agent layer, not point-patched here.

## Decomposition

### Scope

**Target:** Full design (DR-1..DR-6).
**Excluded:** WLM-6 full surface polish (#1580); legacy-trio consolidation (re-homing `setup-worktree.ts`/`worktree-baseref.ts`/`dispatch-guard.ts`); #1633(b) unless DR-2 plumbs `mergeSha` for free; #1633(c) (decided v3.2 deferral).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Wire index.lock resilience at real chokepoints | 001, 002, 003, 004, 009 |
| DR-2 | Single-writer enforced at the handler + reroute | 004, 005, 007, 008 |
| DR-3 | Deferral closures: stream unify, prune liveness, dirty-guard, crash-resume wiring | 009, 010, 011, 020, 021 |
| DR-4 | Resolver posture gate + #1301 regression pin | 012, 013 |
| DR-5 | Windows-portable probe + required lane | 014, 015, 016, 017 |
| DR-6 | Launcher teardown reconciliation (#1634/#1635) | 018, 019 |

### Tasks

#### Task 001: Wrap the prune-executor remove path with `withIndexLockRetry`
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/manager.prune.test.ts`
**Verification:** scoped tests + kill-probe + integration suite across the prune seam. Tests: `PruneExecutor_TransientIndexLock_RetriesWithBackoffThenRemoves`, `PruneExecutor_ExhaustedIndexLockRetry_PropagatesStructuredErrorNoDelete`.
**Salvage:** review + adapt the uncommitted WIP in `.claude/worktrees/agent-a5171342a1827e641/` (`withIndexLockRetry` at its `manager.ts:1603` + prune-test edits) — treat as a draft, re-verify; then release/reclaim that worktree via `prune_worktrees` (dogfood: dry-run → apply).
**Dependencies:** None · **Parallelizable:** Yes

#### Task 002: Retry adapters + wrap the default GitExec composition; correct the false retry-seam comment
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/git-retry.ts` (adapters: `withIndexLockRetryResult` async, `withIndexLockRetrySync`), `servers/exarchos-mcp/src/orchestrate/git-exec-default.ts` (wrap `defaultGitExec`), `servers/exarchos-mcp/src/orchestrate/worktree/git-retry.test.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/recovery.test.ts`
**Verification:** high ladder. Adapters engage on a result predicate (`exitCode !== 0 ∧ stderr` index.lock match) — `defaultGitExec` never throws. Tests: `WithIndexLockRetrySync_ContentionResult_RetriesWithBackoffThenSucceeds` (injected clock/sleep seam), `DefaultGitExecComposition_RealIndexLockFile_RetriesAndSucceeds` (REAL repo + real `index.lock` on disk, default composition — not the DI seam), `DefaultGitExecComposition_PersistentLock_ReturnsContentionResultNotSilentFailure`; comment at `recovery.test.ts:406` corrected to describe the now-real seam.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 003: Burst stagger at the worktree-creation seam
**Risk Tier:** medium
**Implements:** DR-1
**Files:** `servers/exarchos-mcp/src/orchestrate/setup-worktree.ts`, `servers/exarchos-mcp/src/orchestrate/setup-worktree.test.ts`
**Verification:** scoped tests + kill-probe. Tests: `SetupWorktree_BurstCreation_StaggersWithinConfiguredJitterWindow` (injected sleep seam), `SetupWorktree_SingleCreation_NoStaggerDelay`.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 004: CI wiring grep-gate (two rules)
**Risk Tier:** medium
**Implements:** DR-1, DR-2
**Files:** `scripts/check-wlm-wiring.mjs`, `.github/workflows/ci.yml`, `scripts/check-wlm-wiring.test.mjs` (or vitest equivalent)
**Verification:** scoped tests. Rule 1: worktree-mutating git spawns anywhere under `src/orchestrate/` (including `merge-orchestrate.ts`, `git-exec-default.ts`, `setup-worktree.ts`) + `workflow/compensation.ts` must route through a retry adapter — written against the ACTUAL idioms (`gitRunner.run`, `runCommand`, `defaultGitExec`), file-count rule so silent scope shrink fails the gate. Rule 2: no `skills-src/` file (counts files, not skills — merge-orchestrator contributes 3) directs raw `merge_orchestrate` for integration merges. Tests: `WiringGate_NakedWorktreeMutation_Fails`, `WiringGate_WrappedIdioms_Pass`, `WiringGate_SkillRawMergeOrchestrate_Fails`, `WiringGate_MergeSeamOutsideWorktreeDir_StillInScope`.
**Dependencies:** 001, 002, 003, 007, 009 (all wrapped idioms + reroutes in place) · **Parallelizable:** No (tail of DR-1/DR-2 chains)

#### Task 005: Lease-guard preflight + lease threading (ATOMIC — guard and threading ship together)
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.ts`, `servers/exarchos-mcp/src/registry.ts` (input schema: optional `leaseOperationId`), `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.ts`, `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.test.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.test.ts`
**Verification:** high ladder. Foreign-lease semantics per Technical Design: `operationId` mismatch ∧ liveness ∈ {alive, unknown}; lookup key pinned to the serializer's bare-branch shape. Tests: `MergeOrchestrate_ForeignLiveLeaseOnTarget_FailsClosedNamingSerializeMerge`, `MergeOrchestrate_NoLease_BehavesAsToday`, `MergeOrchestrate_DeadHolderLease_ProceedsAfterProbe`, `MergeOrchestrate_UnknownHolderLiveness_FailsClosed`, `MergeOrchestrate_LeaseKeyShape_MatchesSerializerBareBranch`, `SerializeMerge_OwnLeaseThreadedThroughComposedCall_PassesGuard`, `SerializeMerge_CrashResumedNewPid_OriginalOperationId_PassesGuard`, and the byte-equality timeline oracle stays green. Watch the registration-schema field-collision class: `leaseOperationId` keeps one base type across actions.
**Dependencies:** 002 (merge-orchestrate.ts file chain) · **Parallelizable:** No

#### Task 007: Reroute skill surfaces to `serialize_merge` + GC cadence guidance
**Risk Tier:** medium
**Implements:** DR-2
**Files:** `skills-src/merge-orchestrator/SKILL.md` + `references/recovery-runbook.md` + `references/local-git-semantics.md`, `skills-src/delegation/SKILL.md`, `skills-src/synthesis/SKILL.md`, `skills-src/shepherd/SKILL.md`, `skills-src/git-worktrees/SKILL.md`, `skills-src/cleanup/SKILL.md` (cadence guidance half of the AC), regenerated `skills/<runtime>/**` + `command-aliases/**`
**Verification:** `npm run build:skills` + `skills:guard` clean; snapshot/batch-baseline dual update; every reroute names when raw `merge_orchestrate` is still legitimate (non-integration merges).
**Dependencies:** 005 (guard AND threading landed — a reroute before threading would direct agents at a serializer whose composed call fail-closes) · **Parallelizable:** Yes (after 005)

#### Task 008: `next_actions` prune-cadence affordance after synthesize
**Risk Tier:** medium
**Implements:** DR-2
**Files:** `servers/exarchos-mcp/src/next-actions-computer.ts` (or synthesize handler), co-located test
**Verification:** scoped tests + kill-probe. Tests: `NextActions_PostSynthesize_SuggestsPruneWorktreesDryRun`, `NextActions_OtherPhases_NoPruneSuggestion`. Owns the ripple into `tests/load-bearing-golden.test.ts` — regenerate `tests/fixtures/load-bearing/rehydrate-demo.expected-document.json` under the `GOLDEN-FIXTURE-UPDATE:` PR-body protocol if the NextAction shape/content changes.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 009: Unify compensation `worktree.remove.*` onto the `worktrees` stream (+ retry wrap)
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-3 (and DR-1 for this call site)
**Files:** `servers/exarchos-mcp/src/workflow/compensation.ts`, `servers/exarchos-mcp/src/workflow/compensation.test.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.test.ts`
**Verification:** high ladder. Adopt-then-remove: when the path has no `worktrees` entry, compensation first emits `worktree.adopted` (canonical worktreeId derived the same way the manager does), then the INV-13 pair — so the view genuinely reflects the removal (no vacuous pass by seeding state production never creates). `recoverWorktreeRemoveOperationId` relocates to query the `worktrees` stream WITH a legacy fallback that also scans the featureId stream, so a compensation that crashed pre-deploy (requested on the old stream, no executed) resumes under the original operationId instead of minting a second pair. Tests: `Compensation_WorktreeRemove_AdoptsThenEmitsPairOnWorktreesStream_ViewDropsEntry`, `Compensation_CrashBetweenRequestedAndExecuted_ResumesIdempotently`, `Compensation_PreDeployCrashLegacyFeatureStreamRequested_ResumedUnderOriginalOperationId`, `WorktreesReducer_PreUnificationHistoryReplay_FoldsWithoutError`.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 010: Compensation teardown dirty-guard (INV-14)
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/workflow/compensation.ts`, `servers/exarchos-mcp/src/workflow/compensation.test.ts`
**Verification:** high ladder. Tests: `Compensation_DirtyWorktreeIncludingUntrackedOnly_SkippedAndSurfacedNeverForceRemoved`, `Compensation_CleanWorktree_RemovedAsBefore`, `Compensation_SkipResult_CarriesScannableReason`.
**Dependencies:** 009 (same file) · **Parallelizable:** No

#### Task 011: Prune INV-10 liveness pair — events, reducer, manager emission
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/event-store/schemas.ts` (pair types), `servers/exarchos-mcp/src/orchestrate/worktree/projections/worktrees.ts` (+ tests), `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` (emission around the prune run)
**Verification:** high ladder. Tests: `WorktreesReducer_PrunePair_FoldsAndClears`, `PruneWorktrees_Run_EmitsStartedAndTerminalExactlyOnce`; reducer purity via `assertReducerImmutable`. Count-pin updates (`EventTypes` N→N+2) — check both conflicted and bare pins. Cleanup rider: collapse the byte-identical duplicate `export interface InFlightMerge` declarations in `projections/worktrees.ts` (~150/~176) into one.
**Dependencies:** 001 (manager.ts chain), 009 (worktrees projection tests chain) · **Parallelizable:** No (file chains)

#### Task 021: `ps`/`wait` surface the prune pair — idle mode + schema
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts` (`handleViewPs`/`handleViewWait`), `servers/exarchos-mcp/src/views/composite.ts`, `servers/exarchos-mcp/src/registry.ts` (`wait` input schema gains `until: 'idle'` — flag auto-emits via `addFlagsFromSchema`), `servers/exarchos-mcp/src/orchestrate/worktree/handlers.test.ts`
**Verification:** high ladder. Today `ps` lists only `inFlightMerges` and `wait` resolves only on `worktree.merge_executed` — no idle mode exists; this task adds it. Tests: `PruneWorktrees_InFlight_VisibleViaPs`, `Wait_UntilIdle_ResolvesOnPruneTerminal`, `Wait_UntilIdle_Timeout_StructuredNotHang`, `WaitSchema_UntilIdleFlag_ParityCliMcp`. Owns its ripple into `tests/load-bearing-golden.test.ts` (regen under `GOLDEN-FIXTURE-UPDATE:` protocol if the document/NextAction shape moves).
**Dependencies:** 011, 008 (golden-fixture chain), 005 (registry.ts chain) · **Parallelizable:** No

#### Task 012: `shared-mutating` posture + resolver gate for worktree verbs
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-4
**Files:** `servers/exarchos-mcp/src/capabilities/resolver.ts`, `servers/exarchos-mcp/src/registry.ts`, co-located tests
**Verification:** high ladder. Tests: `Resolver_TaskIsolatedCaller_SerializeMerge_RejectedBeforeHandler`, `Resolver_ReadOnlyCaller_PruneWorktrees_RejectedBeforeHandler`, `Resolver_SharedMutatingCaller_Proceeds`; rejection is structured, no side effect (verify via event-store emptiness).
**Dependencies:** 005 (registry.ts file chain) · **Parallelizable:** No

#### Task 013: #1301-shape regression audit/pin
**Risk Tier:** medium
**Implements:** DR-4
**Files:** audit `#1568`'s shipped tests; if absent, add `servers/exarchos-mcp/src/orchestrate/worktree/boundary.regression.test.ts`
**Verification:** scoped test reproducing the leak shape (implementer edit escaping its worktree) asserting it is blocked at the resolver/hook boundary.
**Dependencies:** 012 · **Parallelizable:** No

#### Task 014: Null-ready `ownerStartedAt` threading (#1633a)
**Risk Tier:** medium
**Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/manager.ts` (`ReservationOwner`/`ReserveInput`), `servers/exarchos-mcp/src/orchestrate/worktree/pure/process-identity.ts`, `servers/exarchos-mcp/src/event-store/schemas.ts` (`WorktreeReservedData.ownerStartedAt` `.nullable()`), co-located tests
**Verification:** scoped tests + kill-probe. Tests: `Reserve_UnresolvableCreateTime_StoresNullNeverEmptyString`, `ReservationLiveness_NullOwnerStartedAt_TreatedFailClosed`.
**Dependencies:** 011 (manager.ts + schemas.ts file chains) · **Parallelizable:** No

#### Task 015: win32 process source (cwd + create-time) behind the shim
**Risk Tier:** medium
**Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/pure/process-identity.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/pure/probe.ts`, platform-shimmed tests
**Verification:** scoped tests + kill-probe. Tests: `ProcessSource_Win32_ResolvesCwdAndCreateTime` (shimmed), `ProcessSource_UnsupportedPlatform_ReturnsUnknownFailClosed`; no platform syscall leaks into shared code (INV-16 idioms: `runCommandSync`/`resolveExecutable`, no `.cmd` direct spawn).
**Dependencies:** 014 · **Parallelizable:** No

#### Task 016: win32 path containment (8.3 + symlink canonicalization)
**Risk Tier:** medium
**Implements:** DR-5
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/pure/path-containment.ts`, `servers/exarchos-mcp/src/orchestrate/worktree/pure/path-containment.test.ts`, reuse `servers/exarchos-mcp/src/utils/paths.ts`
**Verification:** scoped tests + kill-probe. Tests: `PathContainment_Win32ShortName_MatchesViaNativeRealpath` (shape-based), `PathContainment_MacOSPrivateVarSymlink_Matches`; the `skipIf(win32)` case replaced with a Windows-correct equivalent.
**Dependencies:** None · **Parallelizable:** Yes

#### Task 017: Mark `test-windows` lane required
**Risk Tier:** low
**Implements:** DR-5
**Files:** branch-protection/ruleset via `gh api` (scripted, documented fallback), `docs/guides/` note
**Verification:** static — `gh api` read-back shows the check required; CI on this slice's PR passes the lane.
**Dependencies:** 015, 016 · **Parallelizable:** No (final)

#### Task 018: #1634 — teardown occupancy probe race
**Risk Tier:** medium
**Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/launcher/` (primary — `verb.ts` + teardown path per #1632), co-located tests (`wlm-compose.test.ts`)
**Verification:** scoped tests + kill-probe. Tests: `Teardown_ChildExitsDuringSignalPath_ReservationReleasedNotLingering` (decide probe-after-reap vs release-on-terminal at implementation; either satisfies AC).
**Dependencies:** None · **Parallelizable:** Yes

#### Task 020: Wire or excise `resumeCrashedMerge`
**Risk Tier:** high · **Boundary Touching:** true
**Implements:** DR-3
**Files:** `servers/exarchos-mcp/src/orchestrate/worktree/merge-serializer.ts`, its production entry point (reconcile / `ps probe:true` / serializer startup precheck — decide at implementation), `servers/exarchos-mcp/src/orchestrate/worktree/recovery.test.ts`
**Verification:** high ladder. Tests: `CrashedMerge_RecoveredFromProductionEntryPoint_ExactlyOneTerminalEvent` (caller-level, not module-level); if excised instead, the inline-reclaim path must cover the `Recovery_MergeRequestedNoExecuted_ResumeEmitsSingleExecuted` scenario and the dead export is removed.
**Dependencies:** 005 (merge-serializer.ts file chain) · **Parallelizable:** No

#### Task 019: #1635 — async origin probe in teardown + launcher `holderStartedAt`
**Risk Tier:** medium
**Implements:** DR-6
**Files:** `servers/exarchos-mcp/src/launcher/` (primary), co-located tests
**Verification:** scoped tests + kill-probe. Tests: `Teardown_OriginProbe_NonBlocking`, `LauncherClaim_HolderStartedAt_NonEmptyOrNullPerSchema`.
**Dependencies:** 014 (null-threading contract), 018 (same launcher files) · **Parallelizable:** No

### Parallelization

Waves derive from FILE-CLUSTER chains (one owner per hot file at a time — the same-file rule applies everywhere, not just 009→010):

- **manager.ts chain:** 001 → 011 → 014
- **merge seam chain (merge-orchestrate.ts / git-exec-default.ts / merge-serializer.ts / registry.ts):** 002 → 005 → {012, 020} (sequential between themselves: 012 then 020 or vice versa — 012 owns registry.ts, 020 owns merge-serializer.ts, disjoint after 005)
- **compensation chain:** 009 → 010
- **worktrees projection tests:** 009 → 011
- **golden fixture + registry(wait):** 008 → 021 (021 also after 011 and 005)
- **launcher chain:** 018 → 019 (019 also after 014)
- **win32 chain:** (011 →) 014 → 015 → 017; 016 independent → 017

Waves:
- **Wave 1 (parallel worktrees):** 001, 002, 003, 008, 009, 016, 018
- **Wave 2:** 005, 010, 011
- **Wave 3:** 007, 012, 020, 014
- **Wave 4:** 013, 015, 019, 021
- **Wave 5 (tail):** 004 (gate — needs all wrapped idioms + reroutes), then 017 (main worktree, branch protection)
- High-blast note: waves merging reducer/schema/registry changes (009, 011, 014, 005, 021) require the full-suite integration gate between merges (`check_integration_suite`), not just per-task scopes.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions resolved or explicitly deferred with rationale
- [ ] Ready for `plan-review`
