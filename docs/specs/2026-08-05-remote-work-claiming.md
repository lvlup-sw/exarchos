# Spec: Work claiming — coordination is a remote-tier concern

**Date:** 2026-08-05 · **Feature:** `remote-work-claiming` · **Depth:** standard
**Owner:** basileus (claiming machinery) · exarchos (boundary consequences only)
**Inputs:**
- Draft: [`docs/research/2026-08-04-dkg-claiming-swarm.md`](../research/2026-08-04-dkg-claiming-swarm.md)
  (superseded — this spec is the final form of its coordination half)
- Review artifact: `.lavish/claim-substrate.html` (12 revisions)
- SoTA report: [`docs/research/2026-08-04-coordination-pull-vs-push-sota.md`](../research/2026-08-04-coordination-pull-vs-push-sota.md)
  + companion `2026-08-04-theoretical-optimum-coordination.md` (PR #1732, lands separately)
- Sibling specs: [`2026-08-05-design-knowledge-graph.md`](./2026-08-05-design-knowledge-graph.md) ·
  [`2026-08-05-event-taxonomy-v2.md`](./2026-08-05-event-taxonomy-v2.md)
- Issues: exarchos #1258 · basileus #155 · #176 · #182 · #247

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` is authored
> by `/plan` into this same document. Only the exarchos-owned DRs (DR-1…DR-6) decompose here;
> DR-7…DR-12 port to the basileus epic (#155/#182) as the contract this spec fixes.

## Constraints

Anchored to `.exarchos/invariants.md` (exarchos side):

- **INV-1** — the append-only log is the source of truth; the ready frontier and any queue are
  projections and hold no authority.
- **INV-6** — substrate guarantees apply across workflow types; no per-workflow scheduler logic in
  the substrate.
- **INV-7** — appends serialize through the single-writer path.
- **INV-10** — liveness is event-derived; no worker self-reporting is trusted over the log.
- **INV-12** — newly-actionable work surfaces through `next_actions`; nothing polls.
- **INV-13** — intent/result event pairs, correlated by `operationId`; lease lifecycle events obey it.
- **INV-15** — no long-running daemon locally.

Anchored to basileus invariants (remote side):

- **U-1** — three tiers; the execution tier has zero outbound network. A sandbox cannot poll a
  queue, so **claiming stops at the orchestrator tier**.
- **U-2** — one source of truth per machine; queue and ready set are folds over the log.
- **U-9** — agent-path events carry `AgentId` + causation + correlation; every claim, heartbeat,
  reclaim and release is a U-9-stamped event.

Carried from the draft: **C4** exarchos never requires basileus — the local workflow must stand
alone; **C7** exarchos is single-machine concurrent-process, basileus is distributed.

**Out of scope:** the knowledge graph (sibling DKG spec); sandbox inner-loop task tracking
(basileus #298/#300); harness hook wiring.

## Design & Rationale

### Problem Statement

The 2026-08-04 draft treated two problems — design knowledge and work coordination — and proposed
machinery for both at both tiers, including a local SQLite work queue that does not exist today.
The knowledge half is settled by the sibling specs: claims are asserted as events, folded into a
local corpus, served over MCP; Dolt is withdrawn. The coordination half remained open, with the
draft's sequencing pointed at "turning a static fan-out into a queue" locally.

The open question this spec closes: **where does the claiming system live?**

### The boundary decision

**Claiming machinery exists only at the remote tier. Locally, workflows run independently.**

An Exarchos workflow is one orchestrator, one machine, one process hierarchy. Workflows do not
share a scheduler, and within a workflow a task is dispatched by the orchestrator that decomposed
it — there is no moment at which two workers contend for one task, so a CAS claim has nothing to
decide and a lease protects against a failure mode the local topology cannot produce unobserved.
Every property claiming buys exists to solve a fleet problem exarchos does not have locally:

| Property | Local (exarchos) | Remote (basileus) |
|---|---|---|
| Dead worker | The dispatching orchestrator observes its own subagents; WLM `reconcile`/`adopt` and the `merge-serializer` lease pattern already reap | No single observer over the fleet — lease TTL + reaper is the only structural liveness answer |
| Work discovered mid-task | Plan revision in the same stream (tasks re-stamped), or a filed follow-up | `discovered-from` queue item — structural, no transcript loss |
| Contention for a task | None — a task is assigned before it is started | Real — CAS claim is the verdict |
| Heterogeneous workers | The dispatch prompt carries capability; W is bounded (~3–5) | Agents self-select by what they can claim |
| The Nth agent | Bounded by one machine and one orchestrator | Free — it pulls like the others |
| Budget | The orchestrator gates spend | Reservation before claim (#176) |

**Refinement of the pull-vs-push SoTA report (PR #1732).** The report concluded static task→agent
binding is dominated and recommended a ready-frontier projection plus a lease-bearing `task_claim`.
This spec keeps the half of that recommendation that is **data** — the dependency graph flowing
into events and a frontier fold ordering dispatch — and moves the half that is **machinery** to
the tier that has the failure modes. Push-vs-pull was the report's own diagnosis of a false
dichotomy; the real axis is local-vs-remote: locally the planner and the worker pool share one
process hierarchy, so "pull" degenerates to the orchestrator reading its own frontier; remotely
there is no shared hierarchy, so leases are the only liveness signal.

### Chosen Approach

1. **Locally, the frontier is data, not a queue.** `blockedBy`/`files`/`riskTier` flow into
   `task.assigned`; a `task-frontier` fold computes the ready set; newly-unblocked tasks surface
   via `next_actions`. Dispatch stays push. The local task status enum — `pending · in_progress ·
   complete · failed` — gains no `ready`, `claimed`, owner, lease, or expiry. Its shape is the
   tripwire that keeps a queue from growing back locally.
2. **Remotely, the queue is the coordination surface.** Postgres queue + leases with beads'
   semantics on `FOR UPDATE SKIP LOCKED`. Orchestrator-tier agents claim; the sandbox is pushed
   into (U-1) — it is an active agent that is not a claimant.
3. **The seam is the plan graph.** When a workflow's tasks execute remotely, basileus ingests the
   decomposition — tasks, blocking edges, scope, risk tier — as queue items, and the lease
   lifecycle returns as U-9-stamped events that exarchos folds like any others. Exarchos never
   requires basileus (C4); the seam is an export, not a dependency.
4. **No Dolt anywhere; beads is a semantics donor, not a dependency.** The DKG spec removed the
   branching requirement (claims-as-events, branch-scoped reads via `scope.branch`), which was the
   entire argument for Dolt (draft D-7). With it fall D-8 and D-10, and the recorded conflict with
   basileus #247 SP-3 dissolves — no Dolt/Noms store stands up, so SP-3 stands unrevised.

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | **Claiming machinery is remote-only; workflows run independently locally** | The table above: every claiming property answers a fleet problem. Locally each is either absent or already owned by an existing mechanism. Machinery without a failure mode is dead weight with a maintenance bill. |
| D2 | **The frontier data ships locally anyway** | It fixes the real local gap (the dependency graph is written by `/plan` and then unused for ordering) *and* is the seed of the remote queue. One graph, two consumers. |
| D3 | **Local `task_claim` is retired, not hardened** | It is orphaned (the canonical loop never calls it) and lease-less. Hardening it (the SoTA report's rec #3) builds the fleet mechanism at the tier without the fleet. Reversed by D1; taxonomy-v2 DR-13's "one task lifecycle owned by the dispatch/claim path" resolves locally to *dispatch* only. |
| D4 | **Beads semantics on Postgres; skip `row_lock`** | Carried from draft D-2. Real row locks make the cell-merge zombie class impossible by construction; heartbeats become cheap `UPDATE`s. |
| D5 | **Draft D-7/D-8/D-10 withdrawn** | Dolt's motivation (branch-scoped claims) is served by the DKG's event-sourced design; vendoring beads inherits its schema cadence for no remaining benefit. |
| D6 | **Worktrees ∝ workers stays, locally** | Orthogonal to pull-vs-push (measured: 37 live worktrees / 7.1 GB for what ~3–5 workers need). Provision on dispatch, release on complete, GC wired into the loop. |

### Requirements (DR-N)

#### Exarchos-owned

##### DR-1: `task.assigned` carries the graph

**Acceptance criteria:**
- `TaskAssignedData` carries `blockedBy`, `files`, and `riskTier`; the projection can compute a
  ready frontier from events alone (today it structurally cannot — the schema drops them).
- Plan revision **re-stamps the stored task graph**: after a revision, stored `blockedBy` equals
  the spec's dependency edges (closes the known re-stamp gap where patching the plan leaves the
  stored graph on the old revision).
- A replay fixture proves the frontier is derivable from a pre-existing stream plus the new fields.

##### DR-2: `task-frontier` fold

**Acceptance criteria:**
- A registered projection computes the ready set — transitive over blocking edges — from
  `task.assigned`/`task.completed`/`task.failed`; no filesystem or `.state.json` input.
- Liveness is event-derived (INV-10); `failed` tasks are re-dispatchable, not terminal-by-accident.
- Newly-unblocked tasks surface through `next_actions` (INV-12). Nothing polls; no daemon (INV-15).
- The fold is consumed by the **orchestrator for dispatch ordering** — it produces advice for a
  push dispatcher, not a claimable set.

##### DR-3: Local claiming machinery is retired

**Acceptance criteria:**
- The orphaned local `task_claim` action is deleted; a call returns a typed error naming the remote
  surface, not `UNKNOWN_ACTION`.
- No lease, owner, or expiry column exists in local task state; the status enum is unchanged.
- A registry census entry (taxonomy-v2 DR-3 shape) asserts no locally-registered
  `*.claimed`/`lease.*` event types; the ratchet holds the count at zero so a local claim verb
  cannot quietly return.

##### DR-4: Worktrees bound to workers, not tasks

**Acceptance criteria:**
- Worktrees are provisioned on dispatch and released on task completion; concurrent worktrees ≈ W
  workers, not N tasks.
- The existing GC (`release_worktree`/`reconcile`/`prune`) is invoked by the loop, not left as a
  manual recovery path.

##### DR-5: Plan-graph export seam

**Acceptance criteria:**
- A single serialization of the decomposition (tasks, blocking edges, scope, `riskTier`,
  originating feature/revision) is producible from the event store on demand; content-addressed so
  re-export of an unchanged plan is a no-op.
- The schema rides the existing typed-schema seam until #1258's Workflow Builder IR lands, then is
  declared there (same bridge discipline as taxonomy-v2 D3).
- Export is **pull by basileus, never push by exarchos** — C4 holds: a machine with no basileus
  reachable behaves identically.

##### DR-6: Remote lease events fold locally

**Acceptance criteria:**
- `task.claim.requested/executed/failed`, heartbeat, reclaim, and release event types are
  registered under the taxonomy-v2 grammar with INV-13 pairing, sourced **only** from the remote
  ingestion path.
- When a workflow's tasks execute remotely, exarchos folds these into `taskProgress` exactly as it
  folds local dispatch events — one task lifecycle, two producers, distinguished by provenance.
- Replay over a mixed local/remote stream produces a deterministic projection.

#### Basileus-owned (the contract; ported to #155/#182)

##### DR-7: Queue + lease schema

- Atomic claim via CAS under `FOR UPDATE SKIP LOCKED`; per-item TTL (default from beads' 5 min,
  tuned per task shape); owner-only heartbeat that fails once the lease is gone; reaper reverts
  expired `in_progress` → ready at grace 2×TTL; conditional release (`if-assignee`) closes the
  supervisor TOCTOU window. Every transition is a U-9-stamped event.

##### DR-8: Ready set maintained incrementally

- The ready flag updates on close/claim/reclaim (the IVM shape of #247 SP-5), never computed by
  transitive closure per poll.

##### DR-9: Dependency taxonomy

- Blocking: `blocks`, `parent-child`, `waits-for`, `conditional-blocks` (the compensation path as
  an edge, not saga code). Annotation: `discovered-from`, `validates`, `caused-by`.
  `discovered-from` is the highest-value edge: work found mid-task becomes a queue item instead of
  dying in a transcript.

##### DR-10: Tier split enforced structurally

- Only orchestrator-tier agents hold leases. The sandbox executes what its `agent-worker` claimed
  and has **no route to the queue** — enforced by U-1's zero-egress execution tier, not by policy.
  Inner-loop work that outgrows its item surfaces as a `discovered-from` item on the outer queue,
  never as a second claimant.

##### DR-11: Budget reservation precedes claim

- The #176 pod-ledger shape: reserve before acting, commit or release after. A claim without a
  reservation is refused.

##### DR-12: Gates as graph nodes

- Human-approval and timer waits are first-class blocking nodes in the work graph, not saga code.
  No polling machinery is ported from beads — the saga already observes PR and CI state directly.

### Draft decision register — final disposition

| Draft | Was | Now |
|---|---|---|
| D-1 claims provisional, no review gate | settled | Absorbed by DKG spec (lifecycle + branch-scoped reads) |
| D-2 beads semantics, not substrate | settled | This spec D4 / DR-7 |
| D-3 proposed claims branch-scoped | settled | DKG spec D4 (`scope.branch` visibility boundary) |
| D-4 Context Engine on control-plane | settled | Unchanged, basileus-side |
| D-5 claim contract in Strategos TypeSpec | settled | DKG spec D2/DR-1 (`DomainOntology`) |
| D-6 derive claims from git artifacts | withdrawn | Stays withdrawn |
| D-7 exarchos ships a Dolt claim graph | proposed | **Withdrawn** — claims-as-events removed the branching requirement |
| D-8 Dolt is the source; basileus ingests | proposed | **Withdrawn** — basileus ingests events/exports; #247 SP-3 stands unrevised |
| D-9 ingest on branch merge only | proposed | Reframed — merge remains the remote-ingestion trigger; partition is `scope.branch`, not a Dolt branch |
| D-10 vendor beads | proposed | **Withdrawn** — semantics donor only (this spec D4) |
| D-11 queue and graph are both projections | settled | Unchanged (INV-1/U-2) |

### Sequencing

| Phase | Scope | Owner | Notes |
|---|---|---|---|
| **S-1** | DR-1, DR-2 — graph data + frontier fold | exarchos | Independent; fixes the real local gap (dependency data written, never used for ordering) |
| **S-2** | DR-3, DR-4 — retire local claiming; worktrees ∝ workers | exarchos | DR-3 rides the taxonomy-v2 census substrate |
| **S-3** | DR-7, DR-8, DR-9 — leases + ready set + edges | basileus | Fixes the live defect: a permanent claim strands work when a worker dies |
| **S-4** | DR-5, DR-6 — export seam + remote fold | both | Schema bridge until #1258; first end-to-end remote execution |
| **S-5** | DR-10, DR-11, DR-12 — tier enforcement, budget, gates | basileus | — |

None of this blocks the DKG spec's P-0…P-5; the two designs share only the taxonomy-v2 substrate.

### Risks

| Risk | Mitigation |
|---|---|
| The local frontier fold quietly grows back into a queue | DR-3's census ratchet; the unchanged status enum is the tripwire — any PR adding `ready`/`claimed` states locally is re-opening D1, not implementing it |
| Queue seeded from a stale plan graph after revision | DR-1 re-stamp requirement; export is content-addressed so a stale export is detectable, not silent |
| Lease TTL wrong in both directions (reaped live workers vs stalled dead work) | Per-item TTL; start at beads defaults; alert on reclaim rate |
| Remote non-determinism breaks replay/audit | U-9-stamped claim/heartbeat/reclaim/release; replay reconstructs what happened, not a canonical order |
| Lease-event ingestion silently stops, remote progress invisible locally | DR-6 registers under taxonomy-v2, so the emission census and `_eventHints` apply; the failure must be loud because the symptom is silence |
| Locally-discovered work still has no structured home | Accepted for the local tier: plan revision or a filed follow-up. The structural answer (`discovered-from`) exists exactly where the swarm does |

## Decomposition

> Authored by `/plan`. DR-1 … DR-6 above are the decomposition source; DR-7 … DR-12 port to
> basileus #155/#182.
