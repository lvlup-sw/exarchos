# Merge Orchestrator Audit (#1119) — Process-Manager Conformance

**Date:** 2026-05-08 (revised)
**Scope:** v2.9.0 implementation of `merge_orchestrate` (issue [#1119](https://github.com/lvlup-sw/exarchos/issues/1119), PR [#1193](https://github.com/lvlup-sw/exarchos/pull/1193))
**Pairs with:** `/design-invariants`, `/axiom:backend-quality`
**Reads forward to:** spike [#1259](https://github.com/lvlup-sw/exarchos/issues/1259) (v2.10 durable event-store substrate), v2.12 process-lifecycle verbs
**Verdict:** Implementation passes structural invariant gates today. **Several findings disappear once #1259's SQLite substrate flip lands**; the remaining standing findings are handler-author concerns the substrate cannot address (git semantics, retry classification, tool description). Saga vocabulary in the design and tests is misleading and should be retired.

## Canonical framing

> **Exarchos is a single-machine event-sourced process manager with cooperative agents.**

This audit is conducted against that framing rather than against generic distributed-systems patterns. The distinction matters — most "saga" / "compensating transaction" / "scheduler-agent-supervisor" guidance solves problems we don't have (network partitions, untrusted services, cross-service data fragmentation). What we have is concurrent local access to a write-ahead log with cooperative agents reading and writing the same git repo and event store.

The right reference frame is therefore **database-flavored**:

- The event store is a write-ahead log with total order per stream.
- Workflow state is a projection over events (cache, not authority).
- Concurrency control is optimistic: `expectedSequence` for events, version CAS for state.
- Recovery is "look at the log, see where you stopped, continue or revert" — not "send compensating commands to remote participants."
- Liveness is observed by generic process-lifecycle primitives, not per-feature supervisors.

Once you read the design through this lens, the saga framing in `docs/designs/2026-04-26-autonomous-merge-orchestrator.md` and the v2.11 e2e tests labeled "saga" (#1235, #1236) are mis-named. `merge_orchestrate` is a single local database-style transaction with a recovery point — not a saga.

## Substrate context: how #1259 reshapes this audit

The v2.10 `durable-event-store-substrate` design (`docs/designs/2026-05-08-durable-event-store-substrate.md`) flips storage to SQLite-backed:

- `BEGIN IMMEDIATE` transaction wraps idempotency-key check + sequence allocation + event INSERT + outbox INSERT.
- `PRIMARY KEY (stream_id, sequence)` makes duplicate sequences physically impossible.
- `UNIQUE INDEX (idempotency_key)` makes duplicate appends physically impossible.
- C2 namespaces streams as `<feature-id>/<subagent-id>`; cross-stream propagation is a query over the events table.
- C4 removes `workflow.set({phase})` — `workflow.transition(target)` is the only canonical phase mutation.
- C5 introduces `AgentPosture = 'read-only' | 'task-isolated' | 'shared-mutating'` as a type-system enforcement of cooperation.

v2.11 (#1284 EventSourcedTaskStore) sets the precedent for derived state: TaskStore becomes a reducer over `task.*` events. v2.12 introduces process-lifecycle verbs (`ps`, `describe`, `wait`, `export`) — the active supervisor primitive at the runtime layer, not bolted onto features.

The v2.10/v2.11/v2.12 trajectory is the canonical framing made physical. Where this audit's findings overlap that work, the substrate flip resolves them by construction. Where they don't, they stand as handler-author concerns.

## Artifacts under review

| Artifact | Path |
|---|---|
| Design | `docs/designs/2026-04-26-autonomous-merge-orchestrator.md` |
| Plan (25 tasks) | `docs/plans/2026-04-26-autonomous-merge-orchestrator.md` |
| Composer | `servers/exarchos-mcp/src/verbs/merge/merge-orchestrate.ts` (557 LOC) |
| Executor | `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` (403 LOC) |
| Pure preflight | `servers/exarchos-mcp/src/verbs/pure/merge-preflight.ts` (259 LOC) |
| Pure executor | `servers/exarchos-mcp/src/verbs/pure/execute-merge.ts` (145 LOC) |
| Local-git adapter | `servers/exarchos-mcp/src/verbs/merge/local-git-merge.ts` (126 LOC) |
| HSM transitions | `servers/exarchos-mcp/src/workflow/hsm-definitions.ts:23-156` |
| Next-action surfacing | `servers/exarchos-mcp/src/next-actions-computer.ts:100-129` |
| Event schemas | `servers/exarchos-mcp/src/event-store/schemas.ts:955-1043` |
| Composite registration | `servers/exarchos-mcp/src/verbs/composite.ts:289-292` |
| Tool registry | `servers/exarchos-mcp/src/registry.ts:978-1002` |
| CLI (top-level) | `servers/exarchos-mcp/src/adapters/cli.ts:715-761` |
| Tests | `merge-orchestrate.test.ts`, `execute-merge.test.ts`, `local-git-merge.test.ts`, two `pure/*.test.ts`, `merge-orchestrate.parity.test.ts`, `merge-orchestrate.integration.test.ts` (2,755 LOC) |

## Scorecard against runtime guarantees

The runtime guarantees a single-machine event-sourced process manager needs (RT-1..RT-6 derived from the canonical framing):

| Guarantee | Need | Current implementation | Post-#1259 |
|---|---|---|---|
| **RT-1** Event log is the source of truth | All durable state derivable from events | ⚠️ Partial — `mergeOrchestrator.phase` is eagerly written by handler, not derived | ✅ via #1284 precedent (make field a projection) |
| **RT-2** Total order within a stream | Monotonic sequence per stream | ✅ Already (sequence sidecar today; SQLite autoincrement post-#1259) | ✅ Strengthened (PK constraint) |
| **RT-3** Atomic append | Single-transaction event commit | ⚠️ JSONL + `.seq` dual-write today | ✅ `BEGIN IMMEDIATE` transaction |
| **RT-4** Single writer per stream via OCC | `expectedSequence` CAS on append | ❌ Handler doesn't pass `expectedSequence` to `eventStore.append` | ✅ PK constraint makes duplicate sequences impossible |
| **RT-5** Idempotent at-least-once delivery | Append-layer idempotency keys collapse duplicates | ❌ Idempotency keys exist at next-action layer only, not at append | ✅ `UNIQUE INDEX (idempotency_key)` enforces at storage |
| **RT-6** Operations atomic against the log | Event-first commit, retry-safe | ✅ Event-first commit point honored (`execute-merge.ts:296-301`) | ✅ Strengthened |

This is the heart of the audit: the implementation is well-engineered against its own design, but **three of six runtime guarantees are observed loosely today and become structural post-#1259.** The right action is to land #1259 first, then verify merge_orchestrate honors the strengthened guarantees, rather than patch them by hand at the handler level.

## Findings ledger

Findings are split into three categories. **Substrate-resolved** findings disappear when #1259 lands; the audit notes them so the regression risk is tracked across the cutover. **Handler-author standing** findings persist regardless of substrate. **Vocabulary** findings are documentation-only but architecturally significant.

### Substrate-resolved (verify post-#1259 cutover)

#### S-1 (RT-4): Handler does not pass `expectedSequence` to event appends

**File:** `merge-orchestrate.ts:410-425`, `execute-merge.ts:306-331`
**Description:** `eventStore.append` is called without `expectedSequence`, meaning two concurrent merge_orchestrate invocations on the same stream could both succeed at the append layer. Today this is mitigated by the per-stream Promise mutex in `AtomicAppender` plus the HSM `merge-pending` substate (only one orchestrator can be in-flight per workflow), but it's discipline-by-convention rather than a substrate guarantee.
**Resolution:** Post-#1259, `PRIMARY KEY (stream_id, sequence)` makes duplicate sequences physically impossible. Handler discipline at the append layer becomes redundant — the storage rejects the second writer.
**Verification gate:** Bundle test `store.race.test.ts` (DR-12 in #1259 design) covers 50 concurrent appenders to one stream; merge_orchestrate is one such consumer.

#### S-2 (RT-5): No append-layer idempotency keys for `merge.executed` / `merge.rollback`

**File:** `execute-merge.ts:306-331`
**Description:** A crash between event append and state write, followed by a `resume: true` retry, would append a second `merge.executed` event for the same `(featureId, taskId)`. The handler comment at `merge-orchestrate.ts:376-383` acknowledges idempotency at the *git* level ("VCS handlers are idempotent on already-merged branches") but not at the *event log* level. The event timeline pollutes; projections that count events over-count.
**Resolution:** Post-#1259, `UNIQUE INDEX (idempotency_key)` on the events table makes duplicate appends impossible. The handler should pass `idempotencyKey: ${streamId}:merge_orchestrate:${taskId}:${eventType}` — the next-action layer already computes this prefix (`next-actions-computer.ts:118`), reuse it.
**Verification gate:** A new test under `merge-orchestrate.integration.test.ts` simulates crash-then-resume and asserts only one `merge.executed` event in the timeline.

#### S-3 (RT-1): `mergeOrchestrator.phase` is eagerly written, not derived

**File:** `execute-merge.ts:151-201` (`buildDefaultPersistState`); `merge-orchestrate.ts:196-224`
**Description:** The `mergeOrchestrator` field on `WorkflowState` is mutated directly by the handler. Per INV-1's "stores-as-projections" rule, derived state should be a reducer over events. The current dual-write (event-first commit + state-file mutation) is pragmatic but not idiomatic — the state file is a second source of truth for a field that is fully derivable from `merge.preflight | merge.executed | merge.rollback`.
**Resolution:** Follow the #1284 EventSourcedTaskStore precedent. Register a reducer in `projections/` that folds `merge.*` events into `mergeOrchestrator`. Handler stops calling `persistState`; the field is computed on demand. The existing `reconcile` action becomes the cold-rebuild path.
**Verification gate:** `assertReducerImmutable` harness applied to the new projection; `mergeOrchestrator` removed from `WorkflowState` type or marked as projection-derived.

#### S-4 (INV-5b): Successful direct-call ToolResult lacks workflow context for next_actions

**File:** `merge-orchestrate.ts:548-557`; `next-actions-from-result.ts:51-95`
**Description:** Success returns `{phase, mergeSha, rollbackSha, preflight}` without `workflowType` / `featureId`, so `nextActionsFromResult` yields `[]` for direct callers — even though the HSM has a defined `merge-pending → delegate` exit transition.
**Resolution:** Post-#1287 (`structuredContent` + registered `outputSchema`) and #1288 (`next_actions` in registered schema), envelope discipline becomes structural. The `outputSchema` for `merge_orchestrate` will declare workflow-context fields, and the schema validator enforces population.
**Verification gate:** Parity test asserts `next_actions: [{verb: 'delegate', ...}]` after a successful merge_orchestrate.

#### S-5 (INV-5b): Error responses omit `validTargets` / `expectedShape` / `suggestedFix`

**File:** Every error return in `merge-orchestrate.ts` and `execute-merge.ts`
**Description:** All error returns populate `code` + `message` only. The format envelope defines structured fields agents need to self-correct without re-prompting humans.
**Resolution:** Post-#1285 (Elicitation form mode), `INVALID_INPUT` becomes a capability-gated form prompt rather than a free-text error. Other error paths still need structured fields, but the substrate flip changes the expected shape (registered `outputSchema` for errors).
**Verification gate:** `outputSchema` registration covers all error-code variants with structured field requirements.

#### S-6 (DIM-7): No supervisor for stuck `executing` phase

**File:** `execute-merge.ts:115` (the `await args.persistState({ phase: 'executing', ... })` write)
**Description:** If the executor crashes between `executing` and the terminal event, the workflow stays in `merge-pending`. Original audit recommended a per-feature supervisor probe.
**Resolution (reframed):** The right primitive is generic, not per-feature. v2.12 process-lifecycle verbs (`exarchos_view({action: 'ps'})`, `wait`, `describe`) ARE the supervisor surface for the runtime. The merge orchestrator's contribution should be liveness *signals* (e.g. `merge.executing_started` event with timestamp; optionally `merge.heartbeat`) that v2.12 verbs can query. **Do not bolt a stuck-checker onto merge_orchestrate.**
**Verification gate:** v2.12 `wait --workflow=<id> --phase=delegate --timeout=10m` resolves merge-pending stalls without merge-specific code.

### Handler-author standing

These are git-domain and tool-design concerns the substrate cannot address. They should be fixed in the merge_orchestrate implementation regardless of #1259.

#### H-1 (DIM-7): `git reset --hard` discards unrecoverable drift

**File:** `pure/execute-merge.ts:130-144`; `local-git-merge.ts:104-115`
**Severity:** MEDIUM
**Description:** Rollback runs `git reset --hard <rollbackSha>`. Drift acquired during the merge window (external editor saving a file mid-merge) is silently destroyed. DR-MO-4 drift preflight catches drift *before* the rollbackSha is recorded, but not drift introduced during execution. Independent industry finding (max-sixty/worktrunk PR #1623, March 2026) replaced `reset --hard` with safer alternatives for exactly this reason.
**Required fix:** Two-tier strategy:
1. **Prefer git's native abort verbs.** `git merge --abort` and `git rebase --abort` already restore the worktree to its pre-merge state cleanly. The local-git adapter uses `--abort` only on the rebase strategy's catch path (`local-git-merge.ts:104-105`); generalize to all strategies.
2. **Fall back to `git reset --keep <rollbackSha>`.** `--keep` refuses to discard local modifications — surfaces drift as a conflict instead of destroying it. Extends `rollbackError` taxonomy with `'reset-keep-blocked'` so callers see the indeterminate state explicitly.
3. **Never `--hard`.** Document the rule in the merge-orchestrator skill.

#### H-2 (DIM-7): Timeout collapses with merge-failure into rollback

**File:** `pure/execute-merge.ts:88-95` (`categorizeFailure`)
**Severity:** MEDIUM
**Description:** `RollbackReason` discriminates `'timeout' | 'verification-failed' | 'merge-failed'`, but all three trigger immediate rollback. Industry guidance (Temporal *Retry logic in Workflows*) treats timeout as transient by default — bounded retry-with-backoff before rollback recovers a class of failures the current code throws away.
**Required fix:**
1. In `categorizeFailure`, route `'timeout'` to a retry loop (max 2 attempts, exponential backoff with jitter) before falling back to rollback.
2. Emit `merge.retry_attempt` events for observability (register in `event-store/schemas.ts`).
3. `'verification-failed'` and `'merge-failed'` continue to rollback immediately.

#### H-3 (INV-5a): Tool description lacks "do NOT use for" guidance

**File:** `servers/exarchos-mcp/src/registry.ts:981`
**Severity:** LOW
**Description:** Per Anthropic's *Writing effective tools for agents*, descriptions should include negative-space guidance.
**Required fix:** Append: *"Use for: landing a sub-agent worktree branch onto a local integration branch with rollback. Do NOT use for: remote PR merges (use `merge_pr`), draft branch protection (use `verify_worktree`), workflow synthesis (use `request_synthesize`)."*

#### H-4 (DIM-5): Duplicate `defaultGitExec` across composer and executor

**File:** `merge-orchestrate.ts:164-188` and `execute-merge.ts:114-135`
**Severity:** LOW
**Description:** Both files define a private `defaultGitExec` doing the same thing. There's now a third copy elsewhere in the tree (per the inline comment "matches `post-merge.ts:48`"). Hygiene smell, drift surface.
**Required fix:** Extract to `verbs/vcs/git-exec-default.ts` (or extend `setup-worktree.ts`'s `gitExec`); single source.

### Vocabulary (documentation-only, but architecturally significant)

#### V-1: Saga vocabulary in design and event types

**Files:** `docs/designs/2026-04-26-autonomous-merge-orchestrator.md`; `pure/execute-merge.ts:RollbackReason`; `event-store/schemas.ts:MergeRollbackData`
**Description:** The design imports saga framework (compensation, pivot transaction, scheduler-agent-supervisor) for what is structurally a single local database-style transaction with a recovery point. The vocabulary tells future readers the wrong mental model and drags in research that doesn't fit single-machine local execution.
**Required fix:** Rename in code:
- `pure/execute-merge.ts:RollbackReason` → `RecoveryReason`
- `merge.rollback` event → `merge.recovered` (with one-release deprecation envelope per #1259's #DR-4 pattern)
- Comments referring to "compensation" → "recovery"

In docs:
- Replace "compensating transaction" with "recovery point" in design doc.
- v2.11 e2e test issues #1235 and #1236 ("F6 saga e2e — synthesize → cleanup with compensation") should be retitled as "F6 process-manager lifecycle e2e — crash recovery via WAL replay."

#### V-2: Capability posture not declared

**File:** Wherever `merge_orchestrate` is registered (`registry.ts:978-1002`)
**Description:** Post-C5 (#1259), every action declares its `AgentPosture`. `merge_orchestrate` mutates the main worktree's branch state — its posture is `shared-mutating`. This isn't declared today because C5 doesn't exist yet, but the design doc should anticipate it.
**Required fix:** When C5 lands, register `merge_orchestrate` with `posture: 'shared-mutating'`. Callers without that posture clearance fail at the resolver gate.

## Industry-pattern alignment matrix (rebased)

The original audit cited saga / compensating-transaction / scheduler-agent-supervisor research as the reference frame. Under the canonical framing, those patterns are wrong-shape for a single-machine system. The right reference frame is database-flavored.

### Adopted (or being adopted via #1259 trajectory)

| Pattern | Source | Status |
|---|---|---|
| Write-ahead log (WAL) for atomic append | C. Mohan et al., *ARIES* (1992); SQLite docs | ✅ Today (JSONL+sidecar approximation); ✅ Strict post-#1259 |
| Total order via monotonic sequence within partition | LSM-trees, Kafka per-partition ordering | ✅ Per-stream sequence today and post-#1259 |
| Optimistic concurrency control with version CAS | Bernstein & Goodman, *Concurrency Control in Distributed Database Systems* (1981) | ✅ State-file CAS via `withStateRetry`; ⚠️ Not on event appends today — physical post-#1259 |
| Idempotent at-least-once delivery via dedup keys | Stripe API, AWS SQS deduplication | ⚠️ Next-action layer only today; ✅ Append layer post-#1259 |
| Event sourcing as ledger; state as projection | Greg Young; Microsoft *Event Sourcing pattern* (read narrowly: log-as-truth, projections-as-cache) | ✅ Framework supports; ⚠️ `mergeOrchestrator.phase` not yet a projection — will follow #1284 EventSourcedTaskStore precedent |
| Recovery point / checkpoint-restore | Database transaction semantics; filesystem snapshots | ✅ Adopted (rollback SHA is the recovery point) |
| Forward recovery for transient failures | Temporal *failure-handling* | ⚠️ Partial — timeout currently rolls back; see H-2 |
| Single-path API for state mutation (no back doors) | CQRS; HSM discipline | ⚠️ `workflow.set({phase})` exists today; ✅ Removed by C4 in #1259 |

### Considered, not adopted (wrong shape for single-machine)

| Pattern | Why it doesn't fit |
|---|---|
| Saga orchestration / choreography (Garcia-Molina & Salem 1987; Microsoft Saga; Akka) | Saga solves "multiple independently-owned services with their own data stores and no cross-service transaction." We have one git repo, one event store, one state directory; agents are not independent service owners. The compensation primitive isn't "send command to remote service" — it's "rewind local state." |
| Compensating Transaction pattern (Microsoft) | Same root cause: solves cross-service eventual consistency. Local recovery via `git X --abort` / `reset --keep` is the right primitive, not "issue compensating commands to participants." |
| Scheduler-Agent-Supervisor (Microsoft) | The Supervisor role addresses distributed liveness — agents on remote nodes that crash and need health-checking from a central scheduler. Locally, liveness is observed by generic process-lifecycle verbs (v2.12 `ps`/`wait`), not a per-feature supervisor. |
| Pivot transaction (saga) | The concept (after pivot, forward-only) is real — but it's just "an event has been observed by other consumers." Database-flavored framing names this "the transaction has committed; subsequent failures need their own recovery path." Same idea, less imported framework. |
| Two-phase commit, leader election, vector clocks, BFT consensus | Solve problems that don't exist on a single machine. |

The findings the original audit drew from saga research (idempotency keys, recovery points, forward vs backward recovery) are still valid — they're general distributed-coordination guidance, not saga-specific. They're cited under the database-flavored frame above without dragging the saga conceptual scaffolding along.

### Standing handler-author concern

| Pattern | Source | Status |
|---|---|---|
| Prefer git's native abort over destructive reset | max-sixty/worktrunk PR #1623 (March 2026) | ❌ Not adopted — see H-1 |

## Recommendations (rebased, prioritized)

### R-1 (P0, ALIGN-WITH-#1259): Drop saga vocabulary; rename to recovery-shaped names

Documentation and code rename. Mechanical, no behavior change. Tells future readers the right mental model. Must coordinate with #1259's #DR-4 deprecation envelope pattern (`hsm.deprecated_action_invoked` precedent) for the `merge.rollback` → `merge.recovered` event-type rename.

**Steps:**
1. Code: `RollbackReason` → `RecoveryReason`; `rollbackSha` → `recoveryPointSha`; comments scrubbed.
2. Event: register `merge.recovered` in `event-store/schemas.ts` (V-1 catalog); deprecate `merge.rollback` for one release with re-emission.
3. Design doc: replace saga framing with database-transaction framing.
4. v2.11 e2e issues #1235/#1236: retitle as "process-manager lifecycle e2e."

### R-2 (P0, SUBSTRATE-DEFERRED): Coordinate merge_orchestrate cutover with #1259

When the substrate flip lands, this audit's S-1..S-6 findings resolve by construction. The merge_orchestrate handler needs a coordinated update:

**Steps:**
1. Add `idempotencyKey` parameter to every `eventStore.append` call (S-2). Reuse the prefix from `next-actions-computer.ts:118`.
2. Convert `mergeOrchestrator` to a reducer over `merge.*` events (S-3). Mirror #1284's `EventSourcedTaskStore` shape.
3. Remove `persistState` callbacks from the handler signature; the projection covers it.
4. Verify `merge-pending` HSM transitions go through `workflow.transition`, not deprecated `workflow.set({phase})` (C4 alignment).
5. Declare `posture: 'shared-mutating'` for `merge_orchestrate` when C5 lands (V-2).

### R-3 (P1, HANDLER-AUTHOR): Replace `git reset --hard` with `--abort` / `--keep`

H-1. Independent of substrate work; should land in v2.11 polish.

**Steps:**
1. In `local-git-merge.ts`, generalize the `rebase --abort` cleanup pattern to all strategies (`merge --abort` for the merge strategy).
2. In `pure/execute-merge.ts:130-144`, replace `['reset', '--hard', rollbackSha]` with `['reset', '--keep', rollbackSha]`. Extend `rollbackError` taxonomy: `'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift'`.
3. New test: drift-during-merge fixture asserts `rollbackError === 'reset-keep-blocked'`.

### R-4 (P1, HANDLER-AUTHOR): Differentiate timeout from merge-failure

H-2. Independent of substrate. Treat timeout as transient with bounded retry; everything else rolls back.

**Steps:**
1. In `pure/execute-merge.ts:88-95`, route `'timeout'` through bounded retry-with-backoff before falling back to rollback.
2. Register `merge.retry_attempt` event in `event-store/schemas.ts`.
3. `'verification-failed'` and `'merge-failed'` continue to immediate rollback.

### R-5 (P1, RUNTIME-LAYER): Emit liveness signals for v2.12 supervisor primitives

S-6 reframed. Don't add a per-feature supervisor — emit signals the generic v2.12 verbs can query.

**Steps:**
1. Emit `merge.executing_started` with timestamp at `execute-merge.ts:115`.
2. Optionally, periodic `merge.heartbeat` events during long merges (probably unnecessary — merges complete in seconds).
3. Coordinate with v2.12 `wait --workflow --phase` semantics; verify `wait --workflow=<id> --phase=delegate` resolves merge-pending stalls without merge-specific code.

### R-6 (P2, HYGIENE): Tool description + dedupe `defaultGitExec`

H-3 + H-4. Cheap. Improves agent tool-selection accuracy and reduces drift surface.

## The clean version of the merge orchestrator

Stated against the canonical framing, with substrate trajectory + handler fixes folded in:

> `merge_orchestrate` is a single local database-style transaction that lands a sub-agent worktree branch onto the integration branch. The transaction has a **recovery point** (pre-merge HEAD), an **attempt event** (`merge.executed`), and a **recovery event** (`merge.recovered`). The recovery primitive is `git X --abort` first, `git reset --keep` second — never `--hard`. **Phase state is a projection over `merge.*` events**, not eagerly written. **Idempotency keys at the append layer** make retry safe (enforced by SQLite `UNIQUE INDEX` post-#1259). The HSM enters `merge-pending` on worktree-bearing `task.completed` and exits on the recovery or attempt event reaching the parent stream. **Liveness is observed through generic v2.12 process-lifecycle verbs** (`ps`, `wait`), not a per-feature supervisor. **Capability posture is `shared-mutating`** (mutates the main worktree's branch state); callers without that clearance fail at the resolver gate. Timeouts retry with bounded backoff before rollback; verification and merge failures roll back immediately.

That description doesn't say "saga," doesn't reach for compensating transactions, doesn't dual-write derived state, and doesn't need a scheduler-agent-supervisor pattern. It's a database transaction with a WAL, written for a single machine with cooperative agents.

## Compliance summary

The design's compliance claims (`#1109 compliance matrix` lines 281-287; `Backend-quality compliance matrix` lines 289-302) are accurate against the implementation as audited. The matrix overstates DIM-7 ("auto-recovery from drift is deliberately disabled") because rollback uses `--hard` (H-1); the safety claim is partial. The matrix is silent on RT-1/RT-4/RT-5 (S-1, S-2, S-3) because the design framed in saga terms rather than runtime-guarantee terms.

After R-1 through R-5 land, the implementation should be re-audited against the runtime-guarantee scorecard rather than the saga-derived matrix.

## What this audit did NOT cover

- Performance (the design's "preflight under 2s" / "drift detection under 500ms" targets) — not measured here.
- Security review of git command construction (CodeQL-style injection check).
- Cross-comparison with PR #1213's eight DR fixes (separate audit if needed).
- Skill reference content (`recovery-runbook.md`, `local-git-semantics.md`) — read but not audited as code.

## Sources

### Database-flavored reference frame (adopted)
- C. Mohan et al., *ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging* (1992) — WAL semantics.
- P. A. Bernstein, N. Goodman, *Concurrency Control in Distributed Database Systems* (1981) — optimistic concurrency control.
- Greg Young, [*Why Event Sourced Systems Fail*](https://fwdays.com/en/event/highload-fwdays-2020/review/why-event-sourced-systems-fail) — log-as-truth, projections-as-cache.
- Microsoft, [*Event Sourcing pattern*](https://learn.microsoft.com/azure/architecture/patterns/event-sourcing) — read narrowly, ignoring the saga framing.
- SQLite, [*Atomic Commit in SQLite*](https://www.sqlite.org/atomiccommit.html) — substrate semantics relevant post-#1259.

### Considered, not adopted (wrong shape for single-machine)
- Microsoft, [*Saga distributed transactions pattern*](https://learn.microsoft.com/azure/architecture/patterns/saga)
- Microsoft, [*Compensating Transaction pattern*](https://learn.microsoft.com/azure/architecture/patterns/compensating-transaction)
- Microsoft, [*Scheduler Agent Supervisor pattern*](https://learn.microsoft.com/azure/architecture/patterns/scheduler-agent-supervisor)
- Daftuar A. (2026-03), [*Saga Orchestration vs. Choreography*](https://aloknecessary.github.io/blogs/saga-orchestration-vs-choreography/)
- Temporal, [*Saga Compensating Transactions*](https://temporal.io/blog/compensating-actions-part-of-a-complete-breakfast-with-sagas) — Temporal's saga implementation; cited because the failure-handling guidance (Temporal *Retry logic in Workflows*) generalizes, but the saga framework itself doesn't fit single-machine.

### Git automation hazards (handler-author standing)
- max-sixty/worktrunk PR [#1623](https://github.com/max-sixty/worktrunk/pull/1623) — *replace `reset --hard` with safe `read-tree` for worktree sync* (2026-03)
- kaeawc/auto-worktree issue [#176](https://github.com/kaeawc/auto-worktree/issues/176) — *Warn about git's single-process limitation with concurrent worktree operations* (2026-01)
- Termdock — *Git Worktree Conflicts with Multiple AI Agents: Diagnosis and Fixes*

### Internal references
- `docs/designs/2026-04-26-autonomous-merge-orchestrator.md` — feature design under audit
- `docs/plans/2026-04-26-autonomous-merge-orchestrator.md`
- `docs/designs/2026-05-08-durable-event-store-substrate.md` — v2.10 substrate spike
- `docs/designs/2026-05-06-v29-bug-cluster-combined-fix.md` — v2.9 bug-cluster surgical fixes
- `docs/designs/2026-04-18-strategic-framing-exarchos-basileus.md` — local vs remote scope split
- `.claude/skills/design-invariants/SKILL.md` and `references/INV-1..INV-5d`
- `~/.claude/plugins/cache/lvlup-sw/axiom/0.2.7/skills/backend-quality/SKILL.md`

### Issues and PRs
- [#1109](https://github.com/lvlup-sw/exarchos/issues/1109) cross-cutting constraints
- [#1119](https://github.com/lvlup-sw/exarchos/issues/1119) merge orchestrator (this audit's scope)
- [#1185](https://github.com/lvlup-sw/exarchos/pull/1185) EventStore single composition root
- [#1193](https://github.com/lvlup-sw/exarchos/pull/1193) merge orchestrator implementation
- [#1194](https://github.com/lvlup-sw/exarchos/pull/1194) local-git-merge adapter
- [#1212](https://github.com/lvlup-sw/exarchos/issues/1212) ancestry remediation hint
- [#1235](https://github.com/lvlup-sw/exarchos/issues/1235), [#1236](https://github.com/lvlup-sw/exarchos/issues/1236) F6 e2e tests (recommended retitling per V-1)
- [#1259](https://github.com/lvlup-sw/exarchos/issues/1259) durable event-store substrate spike (the substrate flip resolving S-1..S-6)
- [#1266](https://github.com/lvlup-sw/exarchos/issues/1266), [#1268](https://github.com/lvlup-sw/exarchos/issues/1268), [#1287](https://github.com/lvlup-sw/exarchos/issues/1287), [#1288](https://github.com/lvlup-sw/exarchos/issues/1288) MCP spec alignment
- [#1284](https://github.com/lvlup-sw/exarchos/issues/1284) EventSourcedTaskStore (precedent for S-3)
- [#1285](https://github.com/lvlup-sw/exarchos/issues/1285) Elicitation form mode (resolution path for S-5)
