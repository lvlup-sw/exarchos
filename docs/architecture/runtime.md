# Runtime Architecture

> **Status:** Canonical — see #1118 (codify principles), #1109 (cross-cutting invariants)
> **Related:** [`projections.md`](projections.md), [`docs/designs/2026-05-08-durable-event-store-substrate.md`](../designs/2026-05-08-durable-event-store-substrate.md), [`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`](../research/2026-05-08-1119-merge-orchestrator-audit.md), [`docs/designs/2026-05-11-marten-followups.md`](../designs/2026-05-11-marten-followups.md)
> **Audience:** anyone making architectural decisions about Exarchos itself (not consumers of the plugin)

---

## 1. Framing

Exarchos is a runtime for software-development workflows where multiple cooperating AI agents — running concurrently on one developer's machine — read and write the same shared state (git repo, event log, workflow state).

It is a **concurrent system, not a distributed one**: no network between participants, no untrusted actors, no clock skew, no replication. The right reference frame is therefore database-flavored — write-ahead logging, optimistic concurrency, projections-as-cache — not distributed-systems-flavored (saga, BFT consensus, scheduler-agent-supervisor).

The runtime exposes a small set of typed verbs through two equivalent facades (CLI, MCP). Behind those facades is a single dispatch core that reads from and writes to an append-only event log. Everything observable about the system is reconstructable from that log alone.

Multi-process serialization is provided entirely by the SQLite WAL substrate: `BEGIN IMMEDIATE` acquires write ownership, and the `(streamId, sequence)` PRIMARY KEY enforces per-stream append ordering. There is no process-level mutex, PID lock, or advisory lock file — any number of OS processes may attach to the same event store simultaneously. See §4 for the full concurrency model. (PID locking was removed in #1343 / Wave A.)

### One-line characterization

> **Exarchos is a single-machine event-sourced process manager with cooperative agents.**

This phrase governs every architectural decision below. When a candidate design imports framework from outside this framing — saga compensation, scheduler-agent-supervisor, distributed consensus — the framing rejects it.

---

## 2. Runtime guarantees

Six guarantees the runtime provides to every consumer. Most are enforced at the storage layer post-#1259; a few remain handler-discipline.

| ID | Guarantee | Enforcement |
|---|---|---|
| RT-1 | Event log is the source of truth | Discipline — handlers append before mutating projections; reconcile is the rebuild path |
| RT-2 | Total order within a stream | Per-stream sequence allocation with composite PRIMARY KEY `(streamId, sequence)`; PK enforcement (with OCC retry on conflict) rejects concurrent inserts at the same slot |
| RT-3 | Atomic append | `BEGIN IMMEDIATE` transaction wrapping idempotency-key check + sequence allocation + event INSERT + outbox INSERT |
| RT-4 | Single writer per stream | `PRIMARY KEY (streamId, sequence)` rejects duplicate sequences; OCC retry on conflict |
| RT-5 | Idempotent at-least-once delivery | `UNIQUE INDEX (idempotency_key)` collapses duplicate appends |
| RT-6 | Operations atomic against the log | Event-first commit point; handlers retry-safe; reducers replay-safe |

These guarantees come from database research (Mohan et al., *ARIES* 1992; Bernstein & Goodman, *Concurrency Control in Distributed Database Systems* 1981), not from distributed-systems research. The single-machine substrate makes them physical rather than emergent.

---

## 3. Layered architecture

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │  L9  Cooperative Agents (Claude Code, Codex, Cursor, OpenCode, ...)  │
   │      consume next_actions; declare posture; never poll               │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │ MCP / CLI
   ┌─────────────────────────────────▼────────────────────────────────────┐
   │  L8  Adapters (cli.ts, mcp.ts)         L7  Lifecycle Verbs (v2.12)  │
   │      zero behavior; format only            ps / describe / wait     │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │
   ┌─────────────────────────────────▼────────────────────────────────────┐
   │  L6  Composite Tools — exarchos_{workflow,event,orchestrate,view}   │
   │      action discriminator; per-action outputSchema + annotations    │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │
   ┌─────────────────────────────────▼────────────────────────────────────┐
   │  L5  Dispatch Core (core/dispatch.ts)                                │
   │      typed (verb, args, DispatchContext) → ToolResult                │
   └────┬───────────────┬─────────────┬────────────────┬─────────────────┘
        │               │             │                │
   ┌────▼─────┐  ┌──────▼──────┐  ┌───▼─────────┐  ┌───▼──────────────┐
   │ L4 HSM   │  │ L4 Resolver │  │ L4 Pruner   │  │ L4 Phase Contract│
   │ phase    │  │ posture ⊕   │  │ generic     │  │ topology.yaml    │
   │ guards   │  │ handshake   │  │ scorer      │  │ typed loader     │
   └────┬─────┘  └─────────────┘  └─────────────┘  └──────────────────┘
        │
   ┌────▼─────────────────────────────────────────────────────────────────┐
   │  L3  Projections — reducers (state, event) → state                   │
   │      WorkflowState · TaskStore · MergeOrchestratorState · NextAction │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │ replay / reconcile
   ┌─────────────────────────────────▼────────────────────────────────────┐
   │  L2  Event Store — AtomicAppender                                    │
   │      total order; OCC; idempotency keys; cross-stream queries        │
   └─────────────────────────────────┬────────────────────────────────────┘
                                     │
   ┌─────────────────────────────────▼────────────────────────────────────┐
   │  L1  Storage — bun:sqlite (WAL)                                      │
   │      events / sequences / idempotency_claims / workflow_state        │
   │      outbox / view_cache / streams / projection_snapshots /          │
   │      schema_version                                                  │
   └──────────────────────────────────────────────────────────────────────┘
```

### L1 — Storage

SQLite via `bun:sqlite`. ACID. WAL journal mode (`PRAGMA journal_mode = WAL`) with `busy_timeout = 5000ms` as the C-layer contention-absorption tier. Schema includes `events`, `workflow_state`, `outbox`, `view_cache`, `sequences`, `idempotency_claims`, `streams`, `projection_snapshots`, `schema_version`. Storage handle is injected via `DispatchContext`; nothing imports `Database` outside `storage/sqlite-backend.ts` (CI gate enforces). See [`docs/designs/2026-05-08-durable-event-store-substrate.md`](../designs/2026-05-08-durable-event-store-substrate.md) §C1.

### L2 — Event store

`AtomicAppender` interface: `append(stream, event, expectedSequence?, idempotencyKey?) → AppendResult`. Body is one SQLite transaction. Cross-stream propagation is `eventStore.queryByType('task.completed', { streamPrefix: featureId })` — a query over the events table, never a read of derived state. Streams are namespaced `<feature-id>/<subagent-id>` post-C2.

### L3 — Projections

Reducers over the event stream. Pure (`apply: (state, event) => state`), deterministic, no I/O. Each reducer ships three test types: given/when/then unit tests per event type, immutability harness, registry-registration test. Snapshots are an optimization, not authority. `reconcile` rebuilds cold. See [`projections.md`](projections.md) for the canonical projection contract.

### L4 — Workflow primitives

Four pure modules consumed by the dispatch core:

- **HSM** — per-workflow-type state machine (`feature`, `oneshot`, `debug`, `refactor`, `discovery`). Transitions are guarded; only `workflow.transition(target)` mutates phase; `workflow.set({phase})` is deprecated post-#1259 C4 and routed through `transition` for one release.
- **Capability resolver** — merges `posture` (declared in agent spec YAML) with handshake-declared capabilities. Handshake is authoritative. `posture: 'shared-mutating'` is required for any action that writes outside the agent's task-isolated scope.
- **Phase contract loader** — typed loader at lifecycle start; `Topology.phases[name].staleness = { expectedMaxDwellMinutes, signals[], freshnessRequires }` declared in `topology.yaml`. Pruner is a generic scorer over declared signals.
- **Pruner** — single-signal heuristic when no contract is declared; multi-signal scorer when declared. Phase-contract-missing emits an observable event at startup.

### L5 — Dispatch core

Single function: `dispatch(verb, args, ctx) → ToolResult`. `DispatchContext` carries storage, event store, resolver, telemetry, project config. CLI and MCP both call this — zero behavior in adapters. Parity tests assert byte-equal `ToolResult` across both surfaces.

### L6 — Composite tools

Four visible: `exarchos_workflow`, `exarchos_event`, `exarchos_orchestrate`, `exarchos_view`. Each accepts an `action` discriminator. Per-action: registered `outputSchema` (Zod, post-#1287), tool annotations (`destructiveHint` / `readOnlyHint` / `idempotentHint` / `openWorldHint`, post-#1289), `describe` entry returning schema and emission catalog. Agents pull schemas progressively via `describe({actions: [...]})` to avoid loading 30+ schemas upfront.

### L7 — Process lifecycle verbs (v2.12)

`ps`, `describe`, `wait`, `export`. Generic queries over the event log: `ps` lists in-flight workflows by reading liveness-start events without corresponding terminal events; `wait --workflow=<id> --phase=<target> --timeout=<ms>` blocks until the projection reaches the target. Every long-running operation (merge, shepherd, TDD swarm) emits `<surface>.executing_started` so these verbs work without per-feature code.

Launcher-spawned sessions ride the same convention (v2.12.0-preview.1, DR-7): `ps` / `wait` answer a launch's liveness from the `launch.executing_started` / `launch.executed` pair **alone** — a pure fold of `worktrees@v1`, no process scan (the opt-in `ps --probe` reclaim path is the only thing that consults the live process table). The launcher is the lifecycle authority; direct (non-launcher) launches answer lifecycle from event-sourced reconciliation (INV-10, reconcile-on-next-entry — never a daemon), which is also the documented `generic`-runtime contract. Known follow-up: spawn-time injection *degradation* is recorded on the launcher lifecycle result but not yet on the `launch.executing_started` event, so these verbs surface launch *liveness* — not injection *degradation* — from events alone.

### L8 — Adapters

`cli.ts` parses argv, maps exit codes, renders for humans. `mcp.ts` translates MCP tool calls and uses `structuredContent` (post-#1287) as the spec-native carrier. Both call dispatch core. Neither carries behavior — verified by parity harness.

### L9 — Cooperative agents

Each agent has a declared posture. Consumes `next_actions` from response envelopes — does not poll. Reads progressively via composite-tool `describe` actions. Self-corrects from `_meta.deprecation` envelopes during contract migrations and from `error.suggestedFix` / `expectedShape` on transition failures. Concurrent agents serialize against the shared event store via OCC, not via cooperative locking.

---

## 4. Concurrency model

Concurrency is single-machine, multi-process, multi-agent. Sources of concurrent access:

- The CLI and MCP server may run simultaneously (developer in shell + agent in IDE).
- Multiple sub-agents in parallel git worktrees, each with its own MCP client.
- The orchestrator agent + sub-agents, all writing to the same feature workflow.

**Serialization is two-tiered, with no process-level mutex or lock file:**

**Tier 1 — In-process:** `AtomicAppender` owns a `StreamLockManager`: a per-stream Promise-chain mutex. Concurrent appends to the same stream from the same Node.js process run sequentially via the chain; no two in-process writers hold the same stream lock simultaneously. This tier does not protect cross-process writes — that is the substrate's job.

**Tier 2 — Cross-process (substrate):** SQLite WAL journal mode (`PRAGMA journal_mode = WAL`) and two specific mechanisms:

- **`BEGIN IMMEDIATE`:** Opens every write transaction in immediate mode, acquiring the database write lock up-front. A writer that observes the database busy retries through SQLite's own C-layer backoff (`busy_timeout = 5000ms`) before the JS-layer retry budget kicks in (`SqliteBusyExhaustedError` after 5 JS-layer attempts). Concurrent readers are never blocked by writers in WAL mode.
- **`PRIMARY KEY (streamId, sequence)`:** Rejects duplicate sequences at the constraint layer. If two cross-process writers race and both attempt the same sequence, the loser's transaction raises a constraint violation; `AtomicAppender` translates that to `{ ok: false, reason: 'sequence-conflict' }` and the caller retries against the new tail (optimistic concurrency).

Prior to #1343 (Wave A), `EventStore.initialize()` acquired a per-`stateDir` PID lock so that only one OS process could attach to a given event store at a time. That contract was removed: `initialize()` is now an idempotent no-op marker, and any number of `EventStore` instances may attach to the same `stateDir` from any number of OS processes. The WAL substrate's `BEGIN IMMEDIATE` + PK constraint is the sole cross-process serialization primitive.

**Additional per-layer serialization:**

- **At workflow state:** Version CAS via `withStateRetry` + `VersionConflictError`.
- **At HSM:** Phase substates serialize feature-level concurrency. Only one orchestrator can be in `merge-pending` at a time per feature; the substate exit transition waits on terminal events from the current attempt.
- **At namespaced streams:** Sub-agents write to `<feature>/<sub-id>`; the parent stream `<feature>` reduces over them when needed (`team.disbanded`, etc.).

What we do **not** need: distributed consensus, leader election, vector clocks, BFT — single-machine context eliminates the problems those primitives solve.

> **See also:** `docs/designs/2026-05-11-marten-followups.md` §"Task A4 — PID lock demotion" and issue #1343 for the rationale and implementation history.

### Process-manager handlers (two-event split)

Handlers that perform non-idempotent external side effects (GitHub API calls, git mutations on shared branches, worktree removal) split each operation into two events:

```text
*.requested  → handler validates intent, persists full payload
              → handler performs external side effect (with idempotent precheck)
*.executed   → handler persists result (id, url, deletedFlag, ...)
```

The split is the canonical event-sourcing process-manager pattern (Akka *Effect.thenRun*; Wolverine *Aggregate Handler Workflow*; Greg Young, *Why Event Sourced Systems Fail* §"retry traps"). Three properties hold by construction:

1. **No re-fire on retry.** When `withStateRetry` re-enters the handler after `ConcurrencyError`, the `*.requested` event is already in the stream; its `appendComputed(idempotencyKey: operationId)` collapses the second emit to a no-op. The external side effect runs once.
2. **Recovery from mid-operation interruption.** If the runtime crashes between `*.requested` and `*.executed`, the next invocation observes `*.requested` without a paired `*.executed` and runs an idempotent precheck (e.g., "does the PR with these `(head, base)` already exist?"). On a hit, it emits `*.executed` referencing the prior side effect's result; on a miss, it performs the side effect cleanly.
3. **Full intent preserved.** `*.requested` carries the entire input payload (title, body, labels — not just `operationId`), so a recovery reader can reconstitute the operation from the event log alone, without consulting external state. INV-1 LOW from the v2.10.0-preview.2 audit.

Reference consumers (one event-pair each):

| Handler | Events | Idempotent precheck |
|---|---|---|
| `merge-orchestrate` (#1313, preview.2) | `merge.requested` / `merge.executed` | branch tip + already-merged commit detection |
| `create-pr` (#1342 P1.B) | `pr.create.requested` / `pr.create.executed` | `(head, base)` PR existence query |
| `add-pr-comment` (#1342 P1.B) | `pr.comment.requested` / `pr.comment.executed` | `<!-- exarchos-op:UUID -->` body marker scan |
| `create-issue` (#1342 P1.B) | `issue.create.requested` / `issue.create.executed` | `<!-- exarchos-op:UUID -->` body marker scan |
| `delete-feature-branches` (#1342 P1.B) | `branch.delete.requested` / `branch.delete.executed` | `git rev-parse --verify` + `git ls-remote --heads` |
| `cleanup-worktrees` (#1342 P1.B) | `worktree.remove.requested` / `worktree.remove.executed` | `git worktree list` filter |

The CI grep gate `scripts/check-withsession-idempotency.sh` enforces that any new `.withSession({...})` call site adopts the contract markers (`operationId` or explicit `allowNonIdempotent: true`), so the pattern stays load-bearing as new handlers are added.

---

## 5. Recovery model

Three layers of recovery, each at its own granularity.

**Crash atomicity (L1).** A SQLite transaction is either fully committed or fully rolled back. There is no half-committed event. If the runtime crashes between `BEGIN IMMEDIATE` and `COMMIT`, the partial writes never become visible.

**Replay from event log (L3).** Every projection is a pure fold over events. `reconcile` rebuilds projections from event 0; `replay` from a snapshot. State files are caches that can always be rebuilt — they are never authoritative. If a state-file write fails after a successful event append, the next reconcile recovers the correct state.

**Local recovery (L4 handlers).** When an external operation needs reversal — e.g. a git merge that produced an invalid result — handlers use the most-native available recovery primitive. For git: `git X --abort` first (the operation knows how to clean itself up); `git reset --keep <recoveryPointSha>` second (refuses to discard local modifications). Never `git reset --hard`. The `recoveryError` field on terminal results discriminates `'reset-keep-blocked' | 'reset-failed' | 'unexpected-mid-merge-drift'` so callers see indeterminate states explicitly rather than as silent successes.

Resume after crash: handler reads the projection, sees the last terminal phase, falls through accordingly. The `resume: true` flag exists for explicit resumption; idempotency keys at the append layer ensure that a re-run after a previously-successful operation collapses to a no-op.

---

## 6. Observability model

Events are the only source of truth. Everything else — projections, state files, view caches — is a cache derived from events. Three observable categories:

- **Lifecycle events** — phase transitions, task assignments, gate executions. `workflow.transition`, `task.assigned`, `gate.executed`, `merge.preflight`, `merge.executed`, `merge.recovered`. These are the events the HSM consumes and the projections fold.
- **Liveness signals** — `<surface>.executing_started` events emitted at the entry of long-running operations. `merge.executing_started` (#1309) is the first; shepherd and TDD swarm follow the pattern. v2.12 `ps` and `wait` query these to detect stuck operations.
- **Telemetry events** — `dispatch.preflight`, `stash.detected`, deprecation invocations, migration steps. Observable but not load-bearing for state.

Operators inspect the timeline through `exarchos_event({action: 'query'})`; agents inspect through `next_actions` envelope hints; developers inspect through CLI `ps` / `describe` / `wait`. All three see the same underlying event stream.

---

## 7. Agent cooperation model

Agents are first-class participants, not external clients. Three primitives govern cooperation:

**Posture declaration.** Every agent declares one of `read-only | task-isolated | shared-mutating`. The capability resolver derives the full capability set from posture + runtime profile (Claude / Codex / OpenCode / Cursor / Copilot / generic). Postures are unrepresentable-by-construction: a `read-only` posture cannot mutate the working tree; a `task-isolated` posture cannot write outside its assigned worktree; only `shared-mutating` can call actions like `merge_orchestrate`.

**Handshake-authoritative capabilities.** Posture is the YAML half; the MCP `initialize` handshake declares the runtime half. Mismatches resolve in favor of the handshake — agents can only use what they negotiated. `runtimes/<name>.yaml` capability fields are not read at runtime; the resolver is the only authority.

**Next-actions consumption.** Agents read `next_actions` from envelope responses — derived from the HSM topology + projection state — and dispatch the listed verbs. They do not poll. `merge_orchestrate` is auto-dispatched in `merge-pending` because the projection surfaces the verb; remove the verb from `next_actions` and the merge stops auto-firing. This makes autonomy a property of state + topology, not a hidden side effect of any handler.

---

## 8. What this deliberately is not

| Pattern | Why it's not used |
|---|---|
| Saga (multi-step distributed transaction with cross-service compensation) | We have one repo, one event store, one state directory. Compensation is rewinding local state, not sending commands to remote services. |
| Scheduler-Agent-Supervisor (Microsoft) | The Supervisor role addresses distributed liveness. Locally, v2.12 lifecycle verbs handle this generically. |
| Two-phase commit / leader election / vector clocks / BFT consensus | Single machine. None of the problems these primitives solve exist. |
| Active polling / heartbeat infrastructure | Agents consume `next_actions` from envelopes; the runtime doesn't poll agents. Liveness is event-emitted, queryable via lifecycle verbs. |
| Workflow engine in the agent runtime (Temporal-style worker loops) | Exarchos delegates active execution to the host runtime (Claude Code, Codex, etc.). Basileus is the autonomous-platform tier; Exarchos is the local-tier dispatcher. |
| Distributed locks / mutex services | OCC + SQLite WAL lock cover all serialization needs. |

---

## 9. Cross-cutting invariants (#1109)

Each invariant maps to one or more layers:

| Invariant | Primary layer | Enforcement |
|---|---|---|
| INV-1 event-sourcing integrity | L2 + L3 | Storage rejects duplicate sequences; projections are pure folds; reconcile rebuilds; events as authority |
| INV-2 facade equivalence | L8 | Adapters are zero-behavior; parity harness asserts byte-equal results |
| INV-3 basileus-forward | L4 (resolver) | Handshake-authoritative capabilities; storage backend is transport-agnostic; cross-stream queries are primitives a remote backend can implement |
| INV-4 platform-agnosticity | L4 (resolver) + L9 | Posture-derived capabilities; runtime YAMLs not read at runtime; skill content rendered per-runtime |
| INV-5a input ergonomics | L6 | Tool descriptions include "do NOT use for" guidance; describe actions return schemas |
| INV-5b output contract | L5 + L6 | `ToolResult` envelope with `next_actions` from L4 HSM/projection state; registered `outputSchema` per action |
| INV-5c Aspire verbs | L6 | Verbs are noun-shaped (workflow, event, orchestrate, view); composite tools group, actions verb |
| INV-5d action discriminator | L6 | Four composite tools with `action` field; per-action schemas + annotations; `describe` for progressive discovery |

---

## 10. Strategic context

### Local vs remote tiers

Per the [strategic framing memo](../designs/2026-04-18-strategic-framing-exarchos-basileus.md), Exarchos is the **local-tier** runtime: developer-attended, single-machine, cooperative-agents. Basileus is the **autonomous-platform** tier: VM-sandboxed agents, durable execution, remote MCP transport.

This architecture document is therefore scoped to local-tier guarantees. Where designs need to cross the local/remote boundary, INV-3 (basileus-forward) governs: storage backends are transport-agnostic; capability resolution is handshake-authoritative; cross-stream queries are primitives that a remote backend can implement.

### Authoring tier (v3.0)

The Workflow Builder SDK (#1258, v3.0) is the **authoring** tier — the API by which workflows are defined. The SDK compiles to typed JSON IR consumed by the dispatch core. Once v3.0 lands, `hsm-definitions.ts` is deleted; the SDK is the only way to define a workflow. The architecture above is unchanged — the SDK is a producer of the same HSM structures L4 already consumes.

---

## 11. The minimal description

If you had to compress the architecture to one paragraph: Exarchos is a single SQLite database with a typed dispatch core in front of it. Events are the authority; projections are caches over events; workflow state is one such projection. CLI and MCP are interchangeable facades. Concurrency is handled by SQLite's WAL plus optimistic concurrency on event sequence and state version. Recovery is "replay the log." Agents declare a posture and receive next-action affordances from response envelopes. Long-running operations emit liveness events that v2.12 lifecycle verbs query. Cooperation is by construction — postures make unsafe actions unrepresentable; handshake-declared capabilities prevent privilege escalation; namespaced streams keep sub-agents from interfering. The system has the shape of a small, opinionated database — and that's the right shape for what it actually does.

---

## References

- [`projections.md`](projections.md) — projection reducer contract
- [`docs/designs/2026-05-08-durable-event-store-substrate.md`](../designs/2026-05-08-durable-event-store-substrate.md) — v2.10 substrate (#1259)
- [`docs/designs/2026-05-11-marten-followups.md`](../designs/2026-05-11-marten-followups.md) — PID lock demotion + Marten leverage follow-ups (#1343, #1342)
- [`docs/designs/2026-04-18-strategic-framing-exarchos-basileus.md`](../designs/2026-04-18-strategic-framing-exarchos-basileus.md) — local vs remote tiers
- [`docs/research/2026-05-08-1119-merge-orchestrator-audit.md`](../research/2026-05-08-1119-merge-orchestrator-audit.md) — audit that surfaced the runtime-guarantee framing
- [`.exarchos/invariants.md`](../../.exarchos/invariants.md) — INV-1..INV-15 catalog (relocated from `docs/architecture/invariants.md` in T-19); audit behavior is performed by the `check_invariant_conformance` gate (the `design-invariants` skill was retired in T-23)
- Issues: #1109 (cross-cutting invariants), #1118 (codify principles), #1119 (merge orchestrator), #1259 (substrate spike), #1284 (EventSourcedTaskStore), #1302 (audit follow-up epic), #1343 (PID lock demotion), #1342 (Marten leverage epic)
