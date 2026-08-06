# Design: Design Knowledge Graph + Claiming Swarm

> **SUPERSEDED (2026-08-05).** This draft split into two final specs and is retained as provenance
> only. The knowledge half (Claims, the graph, retrieval, emission) is superseded by
> [`docs/specs/2026-08-05-design-knowledge-graph.md`](../specs/2026-08-05-design-knowledge-graph.md)
> on the [`docs/specs/2026-08-05-event-taxonomy-v2.md`](../specs/2026-08-05-event-taxonomy-v2.md)
> substrate — claims are asserted as events; the Dolt store (D-7/D-8/D-10) is withdrawn. The
> coordination half (work queue, leases, claiming) is superseded by
> [`docs/specs/2026-08-05-remote-work-claiming.md`](../specs/2026-08-05-remote-work-claiming.md),
> which scopes claiming to the remote (basileus) tier only — the local work queue proposed below
> is **not** built.

**Date:** 2026-08-04
**Status:** Superseded — see banner above
**Verified against:** `1e190435`
**Companion artifact:** [`.lavish/claim-substrate.html`](../../.lavish/claim-substrate.html) — the distilled version, reviewed across 12 revisions
**Relates to:** [#155](https://github.com/lvlup-sw/basileus/issues/155) Why-Context Engine epic · [#182](https://github.com/lvlup-sw/basileus/issues/182) roadmap · [#247](https://github.com/lvlup-sw/basileus/issues/247) sync protocol · [#395](https://github.com/lvlup-sw/basileus/issues/395) U-13 candidate

---

## Problem Statement

Context lives in two stores with no contract between them. GitHub issues are declared canonical; markdown documents hold the reasoning; neither is queryable by an agent, and nothing reconciles them. Separately, work is dispatched top-down: an orchestrator decomposes a plan and hands each task to a worker up front. Agents never see each other, work discovered mid-task has nowhere to go, and a worker that dies strands its task.

These turn out to be two problems, not one, and they need different answers.

### Measured evidence

Every row checked against the tree at `1e190435`.

| Finding | Measurement | Consequence |
|---|---|---|
| Design knowledge is unqueryable | **0 / 157** basileus docs carry structured front-matter (`docs/adrs` 0/8, `docs/designs` 0/91, `docs/decisions` 0/10, `docs/research` 0/48); exarchos specs **1 / 25** | Every agent re-derives the same context by grep. The map dies with the session. |
| Identity collides when hand-authored | `U-13-vendor-double-fidelity.md` shipped in `847c1a02`; issue #395 — still open — also claims `U-13`, renumbered 2026-07-06 because "U-13 is the next free number" | Correct when written, wrong 11 days later. Two claims hold one id; nothing detected it. |
| Canonical store is not the ingested store | #155 governance: "these issues are the canonical source of truth… docs are narrative context only." Resolved corpus (Q3) is `docs/{adrs,designs,decisions,research}` + invariants. **Issues absent.** | The engine would ingest the narrative and miss the canon. |
| Granularity is document-level | DR-5 yields one node per document. `platform-architecture.md` has 138 headings; `system-design.html` is 112 KB with no claim markers | A 3,200-line ADR containing twenty decisions becomes one node. |
| The ingestion spine runs on the wrong corpus | `appsettings.json`: 5-minute tick, 7 repos, source = `github-review-threads` filtered to `coderabbitai`. Local ADR + design sources are implemented but absent from `Scheduler.SourceNames` | Marten watermark, `SemanticDocumentIngester`, embeddings, Wolverine scheduler, `PgVectorRagCollection` — all built, aimed at CodeRabbit comments. |
| exarchos has no work queue | Task status enum is `pending \| in_progress \| complete \| failed`. `delegation-readiness-view` is a batch gate; its `readyTaskIds` tracks worktree provisioning, not dependency satisfaction | Assignment is decided up front. There is no moment where a worker chooses work. |

**Read together:** the plumbing exists on both sides; the semantics do not. What is missing is the edges that make context a graph, and the leases that make a queue a swarm.

---

## Terminology

"Claim" carries two jobs in this design. They are kept separate throughout.

| | **Claim** (noun) | **claim** (verb) |
|---|---|---|
| Is | A unit of design knowledge — decision, constraint, rationale, finding | Taking ownership of a work item |
| Belongs to | The Design Knowledge Graph (Context Engine) | The work queue |
| Shape | `Claim{ id, kind, status, edges[] }` | `claim(workItem) → lease{ owner, expiresAt }` |

Where ambiguity would bite, this document says **Claim** (knowledge) and **work-lease** (coordination). They meet in exactly one place: a work item references the Claims that bear on it.

---

## Orientation: three stores, one log

| | Event log | Work queue | Claim graph |
|---|---|---|---|
| **Answers** | What happened | What should happen next | What we believe |
| **Role** | **Source of truth** | Projection | Projection |
| **Unit** | Event | Work item | Claim |
| **Local (exarchos)** | SQLite | *Proposed* — same SQLite DB; none exists today | **Dolt** |
| **Remote (basileus)** | Marten / Postgres | Postgres queue + leases | Marten projections + index |
| **Written by** | The workflow, directly | Fold over task + lease events | Fold over Claim-bearing events |
| **Rebuildable** | No — it *is* the truth | Yes — replay claim/release | Yes — replay Claim events |
| **Branches** | No | No | **Yes — that is why Dolt** |

Only the event log is authoritative. The queue and the graph are folds over it, so nothing here introduces a second source of truth on either machine and **U-2 holds unchanged**. The Dolt graph is a *projection engine, not an event store*; the only unusual thing is that this read model needs `branch`/`diff`/`merge`, which is a requirement on the storage engine rather than on the architecture.

**Why the queue shares the log's database and the graph does not.** The local work queue lives in the same SQLite file as the event log, so the fold and the append commit in one transaction. The Claim graph cannot have that guarantee — SQLite and Dolt are separate engines and we are not doing two-phase commit — so it is applied synchronously on append and **replayed from the log if a write fails**. Read-your-own-write still holds (same machine, sub-millisecond); durability comes from the log, not from the graph.

**Where the queue and the graph touch — by reference only.** A work item carries the ids of the Claims in its scope, and a `discovered-from` chain can cross between them. They are never rows in the same table and no join is required to serve either.

---

## What exarchos coordination actually is today

This was asserted incorrectly twice during design and is recorded here so it is not re-assumed.

| Step | Mechanism | Semantics |
|---|---|---|
| 1 · Decompose | `/plan` → tasks carrying `blockedBy: string[]` | The dependency data **exists** — written down, then not used for scheduling |
| 2 · Assign | `task.assigned` events, emitted **for every task, up front** | **Push.** The orchestrator decides who gets what before any work starts |
| 3 · Provision | One worktree per assigned task | `readyTaskIds` = worktree exists; unrelated to blockers |
| 4 · Gate | `delegation-readiness` → `ready: boolean` + `blockers[]` | **All-or-nothing**: plan approved, artifact present, task count > 0, worktrees provisioned |
| 5 · Dispatch | `prepare_delegation` → subagents fan out | Static fan-out |

The status enum is the tell: `pending · in_progress · complete · failed`. No `ready`, no `claimed`, no owner, no lease, no expiry. A task is *assigned* to someone before it is *started* by anyone, so there is no contention to resolve and nothing to reclaim.

**Implication:** we are not adding leases to an existing queue. We are turning a static fan-out into a queue. That is more work than "add a TTL column" — and it is where the value is, because every failure mode below traces back to assignment being decided up front.

**What survives:** `blockedBy` is already written down by `/plan`. The dependency graph exists as data and is simply never used for scheduling. The change is not "invent dependencies", it is *compute a ready set from edges we already record, and let workers claim from it instead of being handed a list*.

---

## Constraints

Seven non-negotiables. Every decision that survived review does so because it satisfies these; most rejected alternatives died on one.

| | Constraint | Source | Forces |
|---|---|---|---|
| **C1** | The execution tier has zero outbound network | U-1 | Claiming stops at the orchestrator tier — a Firecracker VM cannot poll a queue |
| **C2** | One source of truth; everything queryable is a projection | U-2 | Queue and graph are both folds over the log |
| **C3** | Agent-path events carry `AgentId` + causation + correlation | U-9 | Claim / heartbeat / reclaim are first-class events |
| **C4** | exarchos never requires basileus | ODF §1.5, distributed-sdlc-pipeline §12 | The local graph must stand alone |
| **C5** | Understanding over recall; surface conflicts; compute answers, cache substrate | DI-1 / DI-2 / DI-3 | The four-bucket response shape |
| **C6** | Review is for invariants only | This design | Claims are never review-gated |
| **C7** | exarchos is single-machine concurrent-process; basileus is distributed | Observed | Local Dolt + remote Postgres, one direction |

---

## Design patterns

Eight shapes do the work. Each appeared independently in more than one place.

| | Pattern | Statement |
|---|---|---|
| **P1** | Log is truth; everything else is a fold | Event log → work queue (what's next) and Claim graph (what we believe). Both rebuildable, neither authoritative. |
| **P2** | Write surface ≠ read surface | Authoring must be reviewable or transactional; reading must be queryable. Different requirements get different surfaces; neither is asked to be good at both. |
| **P3** | Status tracks the fate of the producing work | `proposed → accepted → operational`, each transition driven by an event we already observe. No curation step. |
| **P4** | Scope by partition, not by filter | Branch-scoped Claims live on a Dolt branch — not filtered out of remote results, but unreachable. A filter can be forgotten; a partition cannot. |
| **P5** | Emission is machinery, not a tool call | You cannot make a model reliably call a tool. Claims are a projection of events the workflow already emits. |
| **P6** | A claim is a lease, not a flag | CAS claim + TTL + heartbeat + reaper on grace. A permanent claim strands work when a worker dies. |
| **P7** | Borrow semantics, not substrate | Take beads' lease state machine and edge taxonomy; skip `row_lock`, which exists only because Dolt lacks row locking. |
| **P8** | Systems compose by promotion, not shared storage | A durable Claim is promoted to an invariant through review. One edge, one direction, no shared table. |

---

## The Claim

A Claim is one **composable unit of context** — not an invariant.

```
Claim {
  id          // generated, collision-free by construction
  kind        // decision | constraint | rationale | finding
  status      // proposed | accepted | operational | superseded | retracted
  title       // one line, the assertion itself
  body        // the reasoning
  scope       // globs / domains / repos it bears on
  origin      // workflow + phase + agent + branch/PR ref (U-9)
  edges[]
}
```

### Edge vocabulary

| Edge | Meaning |
|---|---|
| `supersedes` | Replaces a prior Claim; target becomes `status: superseded` |
| `refines` | Narrows a broader Claim (acyclic) |
| `motivated-by` | Why this exists — points at a finding or a work item |
| `conflicts-with` | Symmetric; **surfaced, never auto-resolved** (DI-2) |
| `applies-to` | Scope edge → code, domain, or repo |
| `discovered-from` | Learned while doing X — borrowed from beads |
| `evidences` | An outcome that supports or undermines it |

`status` makes staleness self-marking: a superseded Claim is never served as live, only as history. `edges` is the composition algebra — what turns a pile of notes into something an agent can traverse.

### Status lifecycle

Every transition is driven by an event we already observe. There is no human curation step, which is what keeps the no-review-gate property from degrading the corpus.

| Status | Means | Enters when | Served as design? |
|---|---|---|---|
| `proposed` | Asserted during in-flight work; speculative | Written during `/ideate` or implementation | **No — branch-scoped only** |
| `accepted` | The work that produced it merged | PR merges — the same signal that closes the work item | Yes |
| `operational` | Evidence from real runs supports it | N outcome events `evidences` it with no contradiction | Yes — ranked above `accepted` |
| `superseded` | Replaced by a newer Claim | Another Claim declares `supersedes` | History bucket only |
| `retracted` | The work was abandoned | Branch deleted unmerged, or explicit retraction | No |

`proposed → retracted` on an unmerged branch deletion is the transition that matters most: it is currently a silent event, and the one that would otherwise leave abandoned speculation in the graph looking like design.

---

## Retrieval

Three axes: **dense semantic** (similarity), **sparse lexical** (BM25 — exact identifiers, where dense retrieval fails), and **structural** (one hop along edges from the semantic hits — the differentiator).

### Response shape

Four buckets, never one ranked list.

```jsonc
// considerations({ intent: "add a Polygon market-data adapter",
//                  scope:  ["domains/trading/**"] })
{
  "live": [                                   // applies now
    { "id":"C-118", "kind":"decision", "status":"operational",
      "title":"EODHD is the primary market-data vendor",
      "why":"applies-to domains/trading/**",  // ← the edge path that justified inclusion
      "confidence":"3 workflows referenced it, none contradicted" },
    { "id":"C-204", "kind":"constraint", "status":"accepted",
      "title":"Vendor adapters must degrade to cached quotes after hours",
      "why":"discovered-from C-197 (the after-hours fail-closed incident)" }
  ],
  "conflicts": [                              // DI-2: surfaced, never resolved
    { "between":["C-118","C-231"],
      "note":"C-231 proposes Polygon as primary for options — scope overlap" }
  ],
  "history": [                                // why NOT, not just what
    { "id":"C-062", "supersededBy":"C-118", "title":"Finnhub as primary vendor" }
  ],
  "invariants": [                             // composed in from exarchos at read time
    { "id":"U-11", "severity":"blocking",
      "title":"HTTP egress is factory-mediated" }
  ],
  "_meta": { "cursor":"1e190435", "degraded":[] }   // staleness is visible
}
```

The `history` bucket is the one most systems omit and the one that matters most. An agent told only "use EODHD" will re-propose Finnhub the moment it looks efficient. An agent told "Finnhub was superseded by EODHD" understands the shape of the decision and stops re-litigating it, while remaining unable to act on the superseded Claim.

### Where each kind lands in a workflow

| Stage | Reads | Uses it for | Prevents |
|---|---|---|---|
| `/ideate` | decisions + conflicts + history | Not re-opening a settled choice; seeing overlap before designing | Re-litigating a settled vendor choice, or picking the superseded one |
| `/plan` | constraints + invariants matching `applies-to` | Each DR-N carries the claims its tasks must respect; verification depth follows `severity` | A task planned in a way that cannot pass review |
| `/delegate` | invariants scoped by the task's modules | The subagent's prompt carries only the claims its files touch | Context bloat; an implementer that never learns U-11 exists |
| `/review` | invariants with `enforcement` | `check_invariant_conformance` — already blocking today | A bare `new HttpClient()` merging |

`/review` already works this way — it is the one stage wired to the catalog. The other three re-read prose and re-interpret it every time.

---

## Features and specs

A PRD or spec never enters the graph as a blob. It decomposes into Claims and work items and is re-rendered from them.

| Spec element (today) | Becomes | Identity |
|---|---|---|
| `**Feature:** test-mass-consolidation` | A feature id — a grouping, not a node | Stable forever |
| `## Requirements` → DR-1..DR-N | **Claims** (`kind: decision \| constraint`) | One id each, independently supersedable |
| `## Decomposition` → tasks | **Work items** with `blocks` edges | One id each, claimable |
| `**Inputs:** epic #1701 · PR #1719` | `motivated-by` edges | Already written by hand today |
| `**Revisions:** rev.0 → rev.5` | **`supersedes` edges on individual Claims** | The revision is *derived*, not stored |
| Task → DR-N traceability matrix | Work item → Claim references | Computed, not `(to be filled)` |

The revisions row is the important one. Today a spec revision rewrites a document and the reader diffs prose. Under this model **rev.5 is the set of `supersedes` edges added since rev.4** — "what changed between revisions" becomes a graph query answerable per-DR. The traceability matrices sitting at `(to be filled)` are computed the same way.

---

## Claim emission

Claims are a **projection of the event log**, not a tool the agent calls. An agent that forgets to call `write_claim()` produces no knowledge and no error, and you cannot make a model reliably call a tool.

| exarchos event | Claim written by the projection |
|---|---|
| `spec.requirement.recorded` (DR-N) | `Claim{ kind: decision \| constraint }` |
| `phase.transitioned` (ideate→plan) | Materialises the DR-N set |
| `finding.recorded` (mid-implementation) | `Claim{ kind: finding, discovered-from }` |
| `review.finding.confirmed` | `Claim{ kind: constraint }` |
| `task.completed` | `evidences` edge on Claims in scope |
| `pr.merged` | `proposed → accepted` (+ Dolt branch merge) |
| `branch.deleted` (unmerged) | `proposed → retracted` |

The agent emits the events it already emits; a Claim is a *consequence* of the workflow reaching a state. Enforcement follows for free: the phase gate queries the graph, and the graph is a deterministic function of the log, so "did the agent record its reasoning" becomes "does the log contain the event" — which the HSM already guarantees.

---

## Coordination: push vs pull

| Property | Push — dispatch (today) | Pull — claim (swarm) |
|---|---|---|
| Who decides what an agent does | The orchestrator, up front | The agent, from the ready set |
| Agent dies mid-task | **Work is lost** — must be detected and re-dispatched | Lease expires → work returns to ready |
| Work discovered mid-task | **Nowhere to put it** — lives in a transcript | `discovered-from` → back on the queue |
| Heterogeneous agents | Orchestrator must model every capability | Agents self-select by what they can claim |
| Adding the Nth agent | Orchestrator is the bottleneck | Free — it pulls like the others |
| Determinism / audit | Total order, one planner | Non-deterministic interleaving; audit needs claim/release events |
| Budget control | Orchestrator gates spend | Needs a reservation primitive before claiming |

Push is stronger on determinism and budget; pull is stronger on everything involving more than one agent for longer than one task. Since the objective is a swarm, the pull failure modes are the ones we can engineer around and the push ones are structural.

**The tier split (D-9 in the artifact, restated):** orchestrator-tier agents pull and claim; the sandbox is pushed into. The sandbox is *not* a dumb executor — per the Service Topology it holds a persistent session running the coding harness ⊕ the Exarchos engine as an inner loop, with tool calls and LLM egress hairpinning back through control-plane. It is an active agent that is simply **not a claimant**. `agent-worker` is the orchestrator for the sandboxes in its scope; it claims the work item and holds the lease.

**Two loops, one claim.** The outer loop is the swarm claiming work items. The inner loop is harness ⊕ exarchos inside the VM with its own task tracking (#298 / #300). Only the outer loop claims — inner-loop work that outgrows its item should surface as a `discovered-from` item on the outer queue, not as a second claimant.

**Precedent:** #176 (pod-level shared budget ledger with pre-execution reservation) is structurally a claim — reserve before acting, release or commit after. Work-claiming is the same lease over a different resource.

---

## Claim semantics: what beads does, and what we take

Beads landed a leasing stack (schema v54: `lease_expires_at`, `heartbeat_at`, `row_lock`). Its commit message states the failure plainly: *"A claim was previously permanent: a worker that died mid-task stranded its issue in_progress forever."* That is our failure mode today, unfixed.

| Semantic | How beads does it | basileus today | Verdict |
|---|---|---|---|
| Atomic claim | CAS — `UPDATE … WHERE assignee = ''`, `RowsAffected` is the verdict | Wolverine row-lock, one row per worker | **have it** |
| Ready set | `bd ready` — transitive over blocking deps, offline, ms | None — FIFO, no dependency graph | build |
| Lease TTL | `lease_expires_at = now + TTL`, default **5 min** | Claim is permanent | build |
| Heartbeat | Owner-only; pushes lease forward; fails once the lease is gone | None | build |
| Reclaim | Reaper reverts expired `in_progress` → ready, grace **2×TTL**, emits `lease_reclaimed` | None — dead worker strands the row | build |
| Conditional release | `unclaim --if-assignee` — CAS inverse, closes the TOCTOU window when a supervisor releases a dead worker | None | build |
| Zombie prevention | `row_lock` cell rewritten on every mutating path, forcing a serialization conflict | **Postgres row locks** | **free** |
| Discovered work | `discovered-from` — non-blocking edge | Lives in a transcript | build |

### The part we do not need

Beads' `row_lock` column exists **solely because Dolt has no row locking** and merges concurrent commits cell-by-cell. Their commit spells out the bug: a heartbeat racing a reclaim "would silently cell-merge into a zombie — an open/unassigned issue that still carries the worker's fresh heartbeat." They rewrite a shared sentinel cell on every mutating path to force a serialization conflict.

**Postgres has real row locking.** `SELECT … FOR UPDATE SKIP LOCKED` makes that entire failure class impossible by construction. Two further consequences also vanish: their lease timestamps are second-granular because Dolt rounds `DATETIME`, and their heartbeat cadence must stay far below claim cadence because *every heartbeat writes a Dolt commit*. On Postgres a heartbeat is a cheap `UPDATE` with microsecond timestamps.

### Dependency taxonomy — take it wholesale

Only blocking edges affect the ready set; everything else is graph annotation.

| Edge | Blocks? | Our use |
|---|---|---|
| `blocks` | yes | Task ordering from `/plan` — maps to today's `blockedBy` |
| `parent-child` | yes | Epic → task hierarchy |
| `waits-for` | yes | Fan-out aggregation — a synthesis step waiting on all children |
| `conditional-blocks` | yes | B runs only if A **fails** — the compensation path we hand-wire in sagas today |
| `discovered-from` | no | Work found mid-task. **The highest-value missing edge.** |
| `validates` | no | Ties a task to the check that proves it |
| `caused-by` | no | Root-cause link for causal attribution (#180) |

`conditional-blocks` is quietly the most interesting: "B runs only if A fails" is exactly the compensation shape our sagas encode imperatively. As a dependency edge, the failure path joins the same graph the ready set is computed from.

### Gates

Beads needs `gh:pr` / `gh:run` / `timer` / `human` / `bead` gates because with Dolt, *"issue state is decoupled from code state"* — closing a bead means work is done, but the code may still be on a feature branch. **Our saga already observes PR and CI state directly.** We want the gate *concept* as a first-class graph node so a human-approval or timer wait is expressible rather than hidden in saga code, but not their polling machinery.

### Use-case fit

| Assumption | beads | basileus | So |
|---|---|---|---|
| Where agents run | A developer's machine, offline-first | A server fleet in Container Apps | Their sync problem is not ours |
| Store availability | Cannot assume a server — hence embedded Dolt | Postgres is a given | We start where they had to finish |
| Concurrency primitive | Cell-merge + `row_lock` sentinel | `FOR UPDATE SKIP LOCKED` | Their hardest problem is our default |
| Heartbeat cost | Writes a Dolt commit | A cheap `UPDATE` | We can heartbeat aggressively; shorter TTLs |
| Where work comes from | Human or agent, ad hoc | Saga decomposition + discovery | We need `discovered-from` as badly as they do |
| Verification | None — gates carry no semantics | Ladder, conformance, review gates | Stays entirely ours |
| Trust boundary | None — one machine | **U-1 three tiers** | Claiming stops at the orchestrator tier |
| Audit | Dolt history | Marten event store, U-9 provenance | Claim/release must be U-9-stamped events |

Beads solved the hard version — no server, no locks, offline, cross-machine — because it had to. Taking their semantics while skipping their substrate is the point, not a compromise.

---

## Composition of concerns

| Concern | Owner | Substrate | Why there |
|---|---|---|---|
| **Claim contract** | Strategos | `Strategos.Contracts` · TypeSpec → JSON Schema | Neutral home already in use for `Diagnostics/CheckNode.tsp`; both products generate from it, neither depends on the other |
| **Invariants** | exarchos | git · `.exarchos/` catalog | Must be co-committable and reviewable with the code they constrain. 13 of them, changing monthly |
| **Event log** | exarchos / basileus | SQLite (local) · Marten (remote) | The only source of truth on either machine |
| **Claim graph** | exarchos, then basileus | **Dolt** (local) → **Marten** (remote) | Needs branch/diff/merge so branch-scoping is a partition. Ingested on merge to Dolt `main` |
| **Work queue** | exarchos / basileus | Same SQLite DB as the local event log · Postgres (remote) | A queue has no branches. Co-located with the log so the fold and the append share one transaction |
| **Lease semantics** | basileus | Postgres `FOR UPDATE SKIP LOCKED` | Real row locks make beads' zombie class impossible |
| **Serving** | basileus | `/mcp/context` on control-plane | The only tier the sandbox can reach (C1); already hosts MCP tools and external ingress |
| **Work graph tooling** | vendored | beads binary, same Dolt runtime | Its actual domain; the lease races are already solved |
| **Execution** | sandbox | harness ⊕ exarchos, hairpin via CP | An active agent, but never a claimant |

**In one sentence:** one log per machine is the truth; a queue and a graph are folded from it; the graph branches with the feature and merges with the PR; basileus ingests merged graph and serves it from the one tier everything can reach; and invariants stay in git because they are the only thing here a human must approve.

---

## Decision register

| | Decision | Status | Notes |
|---|---|---|---|
| **D-1** | Claims are provisional by default — no review gate; status hardens on merge and evidence | settled | Review is correct for invariants, a tax on context |
| **D-2** | Borrow beads' lease semantics, not its substrate — implement on the Postgres queue | settled | Skip `row_lock`; Postgres has real row locking |
| **D-3** | Proposed Claims are branch-scoped | settled | Resolves epic Q2 (branch-scoped rationale), open since June; made structural by D-9 |
| **D-4** | Context Engine hosted on control-plane | settled | Forced by C1: the sandbox can reach exactly one tier. Needs its own Bifrost priority lane and cache namespace so a read storm degrades context, not the security gate |
| **D-5** | Claim contract is TypeSpec in `Strategos.Contracts` | settled | Corrected — it already emits JSON Schema with `emitAllModels: true`. Schema ownership ≠ store ownership |
| **D-6** | ~~Derive Claims from git artifacts via the ingestion cursor~~ | **withdrawn** | Bought structural enforcement with the filesystem and eventual consistency in the local write path |
| **D-7** | exarchos ships a Dolt-backed Claim graph | proposed | The argument is **branching, not concurrency** — SQLite handles CAS claiming but cannot branch |
| **D-8** | Dolt is the source; basileus ingests and serves | proposed | Structurally identical to today's `git → Marten → projections` — a different source adapter |
| **D-9** | basileus ingests Dolt `main` only; the branch merge is the trigger | proposed | Makes D-3 structural: branch Claims are not filtered from remote results, they are unreachable |
| **D-10** | Vendor beads for the work graph; plain Dolt for the Claim graph | proposed | One runtime, two databases. Rejected: modelling Claims as beads issues |
| **D-11** | Queue and graph are both projections | settled | Dolt is a projection engine, not an event store; U-2 holds unchanged |

### Notable rejections

- **One widened catalog** (holding invariants and Claims together) — elegant on paper; puts a human review gate in front of knowledge produced several times per workflow.
- **Dolt for the invariant catalog** — better on cell-level merge and branch-scoped rules, but loses atomic co-commit with the code it constrains, which is the whole review gate.
- **Modelling Claims as beads issues** — beads has `supersedes` and `duplicates`, so it looks close. Its unit is a work item with priority, assignee and a ready queue; bending a Claim into that re-conflates the noun and the verb, and makes their schema-migration cadence a hard dependency on our knowledge model.
- **Hash ids** (`bd-a1b2`) — collision-free by construction and better across concurrent branches, but `U-1` reads better than `C-a1b2` in prose humans review. Revisit if the merge race bites.
- **A standalone Context Engine service** — cleaner isolation, but leaves the sandbox unable to reach it without widening the U-1 boundary.

### Conflict with a recorded decision

`#247 SP-3` states: *"do not stand up Kafka/Debezium or a Dolt/Noms store — git supplies the log and the content-addressing."* That was written about the **document corpus**, where git already is the source. It does not cover a graph that must branch with a feature and merge with its PR. **D-7 requires it be revisited explicitly, not quietly overridden.**

---

## Risks

| Risk | Why it is real | Mitigation |
|---|---|---|
| An unreviewed corpus fills with noise | No gate means every agent writes Claims, including wrong ones. ODF §1.3: a confidently wrong map is worse than none | `status: proposed` is the default, visible in the response, and branch-scoped. Ranking weights evidence; `conflicts-with` surfaces contradiction. Watch the proposed-to-accepted ratio |
| Lease TTL wrong in both directions | Too short and live workers get reaped mid-task; too long and dead work stalls the swarm. Beads chose 5 min for a human-paced tool | Our tasks run longer. Start at their defaults, make TTL per-item, alert on reclaim rate |
| Readiness computed per-poll gets expensive | Transitive closure over blocking edges on every poll, at swarm scale | Maintain a `ready` flag incrementally on close rather than computing on read — the IVM shape #247 SP-5 specifies |
| Two graphs drift | Work items and Claims both carry `discovered-from` | They are deliberately separate graphs with separate ids; the link is a reference. Never join them into one table |
| Swarm non-determinism breaks replay | Today's dispatch is deterministic and auditable; pull interleaving is not | Claim, heartbeat, reclaim and release are U-9-stamped events. Replay reconstructs what happened, not a canonical order |
| Claim emission silently stops | If extraction or the projection breaks, the graph quietly stops growing — and a graph that looks current but is not is worse than an empty one | Both paths observable: serve the cursor in `_meta`; alert on Claims-per-merged-PR trending to zero. **The failure must be loud, because the symptom is silence** |
| Dolt is a new runtime | Go binary on MySQL wire, `dolt sql-server` for concurrent processes, two stores in exarchos | Named as a spike question below. Do not adopt on argument alone |

---

## Sequencing

1. **Lease semantics on the existing queue** — TTL, heartbeat, reaper, U-9-stamped claim/release events. **Fixes a live defect**: a worker that dies today strands its row forever. Worth building regardless of every open question below.
2. **Dependency edges + ready set** — port beads' taxonomy; compute readiness transitively over blocking edges. `/plan` already produces `blockedBy`; wire it through instead of dropping it.
3. **Claim store** — node + edges + status lifecycle, written `proposed` with `origin` provenance including the branch ref.
4. **`considerations(scope)`** — the four-bucket response, composing invariants in from exarchos at read time.
5. **Wire the loop** — work items carry Claim ids; `discovered-from` spans both graphs; close emits `evidences`.
6. **Seed** — backfill from `docs/`, issues and specs. One-time, LLM-assisted, reviewed as a batch. `proposed` status means it need not be perfect.
7. **Promotion** — Claim → invariant via `invariants_add` + review (#242). The only coupling to exarchos's catalog.

Steps 1–2 are independent of the Context Engine and useful alone.

---

## Open questions

| Question | Turns on | Cheapest way to answer |
|---|---|---|
| Is Dolt worth a new runtime? | Whether branch-scoping justifies a Go binary, MySQL wire and a second local store | Prototype the branch → merge → ingest cycle on one real feature branch |
| Vendor the beads binary or its Go packages? | Whether the CLI/MCP boundary is too coarse for the delegation loop | Drive `bd ready` / `--claim` from `prepare-delegation` and see |
| Lease TTL for our task shapes | Ours run far longer than beads' 5-minute default | Start per-item at their defaults; alert on reclaim rate |
| Does the local queue stay SQLite? | Whether concurrent-process claiming on one box actually contends | Load-test `BEGIN IMMEDIATE` claiming at expected agent count |

Additional items carried from the epic: Azure AI Search tiering cost (Q4), and whether `system-design.html` remains the only rendered internal artifact as the corpus grows.

---

## Appendix — evidence index

| Claim | Source |
|---|---|
| 0/157 front-matter adoption | `docs/{adrs,designs,decisions,research}/*.md` at `1e190435` |
| U-13 collision | `docs/architecture/invariants/U-13-vendor-double-fidelity.md` (`847c1a02`) vs issue #395 |
| Ingestion runs on review threads | `apps/agent-host/Basileus.AgentHost/appsettings.json` → `DataFabric:Ingestion` |
| Ingestion spine components | `shared/Basileus.Core/DataFabric/`, `shared/Basileus.Infrastructure/DataFabric/`, `apps/agent-host/.../DataFabricIngestionExtensions.cs` |
| `PgVectorRagCollection` exists | `shared/Basileus.Infrastructure/Rag/PgVectorRagCollection.cs` |
| Invariant catalog is schema-validated | `.exarchos/invariants.md` (`schema-version: 3`); exarchos `src/architecture/{invariant-schema,invariants-loader,catalog-merge,check-evaluator}.ts` |
| exarchos task model + no queue | exarchos `src/workflow/schemas.ts` (`TaskStatusSchema`, `blockedBy`), `src/views/delegation-readiness-view.ts` |
| Service Topology (queue, competing consumers, sandbox inner loop) | `docs/system-design.html` §Service topology |
| `Strategos.Contracts` is TypeSpec → JSON Schema | strategos `src/Strategos.Contracts/{main.tsp,tspconfig.yaml,Diagnostics/CheckNode.tsp}` |
| beads lease stack | gastownhall/beads commit `e97839a` (schema v54: claim-TTL, heartbeat, reclaim); `639c56f` (`unclaim --if-assignee`); `65078a9` (unclaim ownership) |
| beads dependency + gate model | beads.gascity.com `/core-concepts/dependencies`, `/core-concepts/issues` |
| Dolt is content-addressed | dolthub.com/blog/2024-02-29-storage-engine (Prolly Trees + commit graph) |
| #247 SP-3 Dolt guidance | Issue #247, SP-3 acceptance criteria |
| Operational modes (local/remote/dual) | `docs/adrs/distributed-sdlc-pipeline.md` §12; ODF ADR §1.5 constraint table |
