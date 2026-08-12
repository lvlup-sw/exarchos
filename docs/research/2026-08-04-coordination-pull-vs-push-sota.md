# Coordination for parallel coding agents: SoTA synthesis and a recommendation for Exarchos

**Date:** 2026-08-04
**Workflow:** `coordination-pull-vs-push-sota` (discovery)
**Question:** Our delegation pattern is spec → decompose → push-dispatch subagents into per-task worktrees, with dependency order evaluated by the model at runtime and merges serialized by tooling.
It works, but worktrees are heavy and the structure is rigid.
`gastownhall/beads` demonstrates a work-claiming pull model with dynamic subagents.
What does SoTA research say about this coordination problem, and what is optimal and elegant for Exarchos?

---

## Executive summary

**Push-vs-pull is a false dichotomy that scheduling theory resolved decades ago, and the 2026 LLM-agent evidence independently reconverges on the same answer.**
Every mature DAG executor (Make `-j`, Bazel, Airflow, Temporal) keeps the *dependency graph* static and the *worker→task binding* dynamic: workers pull from a continuously recomputed **ready frontier**, under a **lease-based claim** for crash tolerance, with **integration serialized** through a merge queue.
Graham's 1966 anomaly results are the formal reason static assignment is dominated under variable task durations — exactly the regime LLM agents occupy — and any greedy pull schedule is within 2× of optimal with no duration knowledge at all.

The strongest 2026 empirical results say the same thing from the other direction:
naive parallel partitioning (including Claude Code Agent Teams' default) scores *below* a sequential single agent, while dependency-graph-aware partitioning beats both (Co-Coder: 68.1% vs 56.8% vs 54.1% on DevEval);
cross-agent PRs conflict at ~2× the rate of same-agent PRs (41.7% vs 19.8%);
and the production systems that work ship a hybrid — a planner that fixes design decisions and partition boundaries (push side), plus a claim mechanism over independently verifiable work items (pull side).
Anthropic's 16-agent C-compiler swarm is the pull-model existence proof, and its real coordinator was a near-perfect external test oracle, not the queue.

**Beads gets the claim layer right and almost everything Exarchos is good at wrong.**
Its CAS claim + heartbeat lease + reaper is a textbook implementation of the theory's layer 3, and its `discovered-from` edge and "ready = all blocking deps closed" query are worth adopting conceptually.
But beads v1.x abandoned git-native JSONL for a transactional DB after "race conditions and tombstone hell" (validating our event-store choice), Gas Town still runs every worker in a git worktree (pull does not remove worktrees), its dependency ordering is manual wave slinging by the operator, its flagship merge queue is partly aspirational, and it has **no review phase at all** — independent critiques converge on "throughput, not correctness: most work gets done; some work gets lost."

**Exarchos already owns three of the four reference layers; the missing link is data, not machinery.**
We validate the dependency DAG at plan time, hold a mature single-writer merge lease with dead-holder reclaim (`serialize_merge`), and even ship a `task_claim` verb with correct OCC double-claim prevention — but the verb is orphaned (the canonical loop never calls it), carries no lease, and the dependency edges are dropped at the event boundary (`TaskAssignedData` has no `blockedBy`), so no projection can compute a ready frontier today.

**Recommendation (§4): keep the planning and verification spine; replace hand-authored waves + static assignment with a ready-frontier projection and a resurrected, lease-bearing claim verb; bind worktree count to workers (~3–5), not tasks.**
That last move — provision on claim, release on completion — is what actually fixes worktree weight: concurrent worktrees drop from N tasks (37 live today, 7.1 GB) to W workers, and the rigidity complaint dissolves because order emerges from the frontier instead of being baked into wave documents.

---

## 1. The four-layer reference architecture

Three independent evidence bases — classical scheduling/distributed-systems theory, 2024–2026 LLM multi-agent research, and beads/Gas Town field experience — converge on the same composition:

| Layer | Mechanism | What it provides |
|---|---|---|
| 1. Static dependency DAG | Graph authored/derived at plan time; footprints made disjoint | Ordering correctness; minimized cross-agent interference (USL β) |
| 2. Dynamic ready frontier | Recomputed from completion events; workers pull; critical-path priority optional | Graham 2-approximation; self-correcting under variable durations; crash-recoverable |
| 3. Lease-based claim | Atomic claim + liveness + reap-on-death + fencing | Single-winner assignment; crash tolerance; at-least-once ⇒ idempotency required |
| 4. Serialized merge queue | Single-writer integration testing the merge result | "Not Rocket Science" invariant; bounds contention (USL α) |

Airflow and Temporal are layers 1–3; Bazel and Make are 1–2 in-process; bors/Zuul/GitHub merge queue are layer 4; Gas Town is 3 (+2 as a query, minus the scheduler) with a partly-built 4.
What is static is the graph, the task definitions, and the disjointness analysis; what is never static is which worker runs which task, when, and how many workers exist.

### 1.1 Theory highlights (full findings: theory agent report)

- **Graham 1966:** greedy list scheduling over a ready frontier is within (2 − 1/m)× of optimal with zero duration knowledge; with a *fixed* assignment, shortening tasks, adding workers, or removing constraints can each make completion *later* (the anomalies).
- **Why static assignment loses:** makespan under static partition is the max of per-bucket estimation errors; one mis-estimated task strands a bucket while other workers idle. LLM-agent durations vary by an order of magnitude (retries, context exhaustion, flaky tests), which is the worst case for this failure mode.
- **Work stealing (Blumofe & Leiserson 1999):** pull wins because a pulling worker's request carries perfect current information about its own availability; a pushing scheduler must estimate it. At our scale a single shared ready set is the (simpler) degenerate case and inherits the same guarantee.
- **Lease queues (SQS, `SKIP LOCKED`, Temporal heartbeats):** claim → renew → ack, reaper on expiry; unavoidable consequence is at-least-once execution, so tasks must be idempotent and writes fenced (Kleppmann). In git, a non-fast-forward push rejection *is* a compare-and-swap; an attempt-epoch in the branch name makes duplicate execution wasteful but harmless.
- **Merge queues (bors → Zuul → GitHub):** serialize integration and test the *merge result*; recover parallelism inside the serial order via speculation only when the green-rate justifies it (optimal batch size shrinks as failure rate rises — start at 1).
- **Universal Scalability Law:** coherency cost (β — merge conflicts, invalidated in-flight assumptions, spec drift) grows quadratically in agent count, so throughput is retrograde past a likely single-digit optimum. The highest-leverage engineering is reducing β at plan time via disjoint footprints, not raising N.

### 1.2 LLM multi-agent highlights (full findings: llm-mas agent report)

- **Consensus:** parallelize reading/reviewing/exploring, serialize writing (Anthropic and Cognition now agree for code); per-agent isolation is table stakes across every shipping product; decompose by context boundary, not SDLC phase; fresh-context adversarial review is the one multi-agent pattern everyone ships; verification quality, not agent count, is the binding constraint; 3–5 agents is the empirical sweet spot.
- **The decisive negative result (Co-Coder study, arXiv 2606.00953):** file-parallel and Agent-Teams-default partitioning underperform a sequential single agent; cohesion-aware partitioning on the *code's* dependency graph (symbol sharing, imports) is the highest-leverage intervention: +11.3 pts pass rate, −45% wall clock, −28% API cost, degrading gracefully to sequential as coupling rises.
- **Pull works when work items are independently verifiable and lockable:** Anthropic's C compiler ran 16 agents with no orchestrator, git-file locks as claims, agents choosing the "next most obvious problem" — against a near-perfect GCC oracle. Claude Code Agent Teams ship the same shape (file-locked self-claiming, dependency-gated tasks).
- **Pull's documented failure modes:** no horizontal awareness (2× conflict rate in the wild, 33.6k agent-PR study); claim/completion state drift stalling queues; the whole fleet converging on one blocked monolith; split-brain design decisions when no planner fixed them first.
- **Push's documented failure modes:** siblings independently resolving the same unstated design question; over-decomposition; coordination turns growing super-linearly (T ≈ 2.72·(n+0.5)^1.72); negative returns from added agents once single-agent accuracy exceeds ~45% on the task class.
- **Review is the real bottleneck:** agent PRs wait 4.6× longer for review pickup and land at 32.7% vs 84.4% for human PRs; a human "can only focus on reviewing and landing one significant change at a time" (Willison).
- **Worktree isolation dissent worth knowing:** worktrees share `.git` (hooks, config, stash, refs); `git clone --shared` benchmarks at identical cost (~1 s, ~59 MB) while actually isolating those surfaces — and Claude Code itself patched two worktree-isolation escapes in 2.1.210/2.1.218.

### 1.3 beads/Gas Town highlights (full findings: beads agent report)

- **Premise corrections:** beads v1.x is Dolt-backed — the git-native JSONL model was abandoned ("bidirectional sync, 3-way merge, two sources of truth, race conditions, and tombstone hell"); Gas Town polecats and the Refinery run in **git worktrees** off a canonical clone, so the pull model is orthogonal to worktree weight; dependency-respecting dispatch is **manual** wave-by-wave `gt sling` against `bd ready`, and capability routing is "Planned."
- **The genuinely excellent part is the claim layer:** atomic CAS claim (`bd update --claim`, `bd ready --claim` selecting+claiming in one transaction with a deliberately unbounded scan); 5-minute heartbeat-renewed leases in an ephemeral non-replicating table (moved off the issues row because heartbeat commits were "the dominant source of unbounded reachable history"); a reaper (`bd reclaim`) with a 2×-TTL grace window; a `row_lock` token forcing serialization conflicts that cell-level merges would silently swallow; and a merge-slot mutex to prevent "monkey knife fights" over conflict resolution.
- **The conceptual keepers:** `ready` as a *query* over the dependency graph rather than a plan artifact; the `discovered-from` edge recording work that emerges mid-execution; hooks/molecules making agent state durable outside the context window ("50 First Dates" — session cycling is normal operation, not failure).
- **The cautionary tale:** no review phase (the Refinery's test/lint gates are the only quality control, and its batch-then-bisect core is still phase-blocked); independent week-long evaluations report 141 orphaned processes, invisible progress, "$100/hour burns," and the verdict "throughput, not correctness: most work gets done; some work gets lost."

---

## 2. Where Exarchos stands against the reference stack

Evidence: internals agent report; file references are current as of 2026-08-04.

| Layer | Exarchos today | Verdict |
|---|---|---|
| 1. Static DAG | Strong at plan time: `#### Task` stamps with `Dependencies:`/`Files:`/`Risk Tier:`; `validateDependencyDAG` + cycle check + `checkParallelSafety` (pairwise file overlap) in the `check_task_decomposition` gate | **Best-in-class authoring, then discarded** — edges never re-checked after plan time |
| 2. Ready frontier | Absent. `delegation-readiness-view` is an all-or-nothing wave barrier (all worktrees ready, zero failed baselines); waves are hand-authored into spec markdown; `delegate → review` is gated by an all-tasks-complete barrier | **The gap.** No server-side frontier query exists; the pull design is written down only as Claude-only agent-teams prose (`adaptive-orchestration.md`), violating INV-4 by construction |
| 3. Lease claim | `task_claim` exists with correct OCC single-winner semantics (expectedSequence + retry + `ALREADY_CLAIMED`) — but no `blockedBy` check, no lease/liveness fields, no reaper, `failed` is permanently unclaimable, and the canonical delegate loop never calls it (v1 artifact of the stale distributed-SDLC ADR) | **Orphaned scaffold.** The mature lease pattern (holder pid/start-time, dead-holder reclaim, bounded wait) exists 30 lines away — for worktrees and merges, not tasks |
| 4. Merge queue | `serialize_merge`: optimistic single-writer lease in the event log, claim via `decide()` with in-closure slot check, dead-holder reclaim under the holder's original operationId, release-in-finally, dry-run default; `merge_orchestrate` fails closed on foreign leases (DR-2) | **Mature.** Batch size 1, which theory says is the right default at our green-rate |

**The single missing link is data, not machinery.**
`parseTaskStamps` already extracts `{blockedBy, files, riskTier, testLayer}` per task and `validateDependencyDAG` already folds them — but `TaskAssignedData` (`schemas.ts:850-862`) drops every one of those fields, so the graph never enters the event log and no projection can derive a ready frontier.
Everything else a pull model needs already exists as substrate: `decide()`/`withSession` for transactional claims over a fold, `idempotency_claims` surviving restart, `withStateRetry`, the `worktrees@v1` ownership-registry pattern, `WorktreeManager.reconcile` as the reap-dead-owners template, `EventSourcedTaskStore` as TTL/reap-on-read prior art, and `next_actions` as the affordance channel.

**The friction the user named, quantified:**
- *Worktrees are heavy:* 37 live worktrees totaling 7.1 GB (250–350 MB each), per-worktree `npm install` baked into the dispatch contract, zero GC invocation path in any workflow, warm-cache reuse structurally unreachable, and an `index.lock` convoy under burst creation (mitigated by stagger+retry).
- *Structure is rigid:* waves are hand-authored documents with admitted over-serialization ("same-file editors are split across waves even where no edge is strictly required"); the readiness barrier cannot start partially or absorb a late-discovered task; a crashed agent's claim wedges forever; each serial integration merge invalidates the ancestry of every in-flight worktree behind it.
- *Model-evaluated dependencies:* ordering judgment lives nowhere in the runtime — the planner authors waves, and at dispatch time the only "scheduling" is a deterministic keyword heuristic. Dependency awareness is advisory prose exactly where beads makes it a query.

---

## 3. What beads actually teaches (and what it doesn't)

Adopt the *shape*, not the system:

1. **Ready-work as a query, not a plan artifact.** `bd ready` = "all blocking dependencies closed" is layer 2 done right, and it is precisely what our event store can compute as a projection the moment dependency edges enter the log.
2. **Claim as CAS, lease as liveness, reap as recovery.** Beads' claim/heartbeat/reclaim triple matches the theory's canonical design and matches the pattern our own merge serializer already implements.
3. **`discovered-from` provenance.** First-class mid-execution task discovery is the strongest argument against pure upfront planning — plans are complete only for work you already understood.
4. **Durable coordination state outside the context window.** Our event store already is this; beads validates the architectural bet (they fled file-merge semantics for a transactional DB — the direction we started from).

Do **not** adopt:
- **A second database or tracker.** The event store + projections is our ledger; adding a beads-like store would recreate the two-sources-of-truth problem beads itself spent v0.x escaping (and our 2026-05-30 state-source RCA already litigated).
- **Contract-net-style bidding or capability auctions.** Theory: overkill; pull claiming is the degenerate contract net at zero message cost. If agent heterogeneity ever matters, a capability tag + filtered claim is sufficient.
- **Autonomy without review (GUPP maximalism).** Gas Town's outcome — "throughput, not correctness" — is what our verification ladder and adversarial review exist to prevent, and the #1670 eval says verification-depth calibration is our pipeline's one empirically proven differentiator. It is the part to protect, not trade away.
- **Claude-only claiming via the harness's native task list.** F10 (state drift) plus INV-4 parity: the claim protocol must live in the MCP dispatch core.

---

## 4. Recommendation

### 4.1 Keep the spine (it is where our proven value lives)

- **Spec/PRD → decomposition stays.** Cohesion-aware partitioning on the code's dependency structure is the highest-leverage intervention in the 2026 literature, and minimizing cross-agent interference (USL β) is a planning-time property. Our plan gates (DAG lint, parallel-safety file-overlap check, risk-tier stamping) are exactly the right artifacts — the fix is to stop *discarding* their output after plan approval.
- **Per-agent isolation stays; per-*task* provisioning goes** (§4.3).
- **`serialize_merge` stays the only integration path.** Single-writer merge testing the merge result is the industry-converged resolution; batch size 1 is correct until a measured green-rate argues for speculation.
- **The verification ladder and adversarial review stay.** Review is the system bottleneck everywhere (4.6× pickup latency, 32.7% acceptance), and it is the layer Gas Town lacks; risk-tier-calibrated verification is our one executed, positive empirical result (#1670).

### 4.2 Add the frontier + claim layer (four changes, all on existing substrate)

1. **Persist the graph: enrich `task.assigned`.** Extend `TaskAssignedData` with `blockedBy`, `files`, `riskTier`, `testLayer`, `boundaryTouching` (all already produced by `parseTaskStamps`). This is the single unlock: the dependency DAG becomes event-sourced fact instead of document prose.
2. **`task-frontier@v1` projection.** A fold over `task.*` events computing per-task readiness: `ready` = assigned ∧ unclaimed ∧ every `blockedBy` task completed; plus `blocked`, `claimed` (with holder), `failed(reclaimable)`. INV-1-compliant by construction (a projection, never a queue table with pop semantics) — this is the blackboard/Linda formulation the theory recommends and the exact analogue of `bd ready`.
3. **Resurrect `task_claim` as a real claim.** Implement via `decide()` over the frontier fold: reject blocked tasks with a typed refusal (dependency edges become *enforced* for the first time), keep the existing OCC single-winner semantics, and add what the merge lease already has — holder identity (`agentId`, pid/start-time where local), INV-10-conforming liveness (`task.claim.executing_started` + paired terminal, expiry event-derived rather than heartbeat-driven), reap via a `reconcile`-style pass (the `WorktreeManager.reconcile` template), `failed → reclaimable` so fixers re-enter through the front door, and an attempt-epoch in the task branch name as the fencing token so a falsely-reaped agent's late push is rejected rather than merged.
4. **Surface the frontier as affordances, not polling (INV-12).** `task_complete`, `task_fail`, `rehydrate`, and `prepare_delegation` already return `next_actions`; have them list newly unblocked tasks ("task-007 and task-012 are now ready — claim via task_claim"). Workers don't poll; the completion call they were already making tells them (or the orchestrator) what just became ready.

**The delegate loop then changes shape without changing owners.**
The orchestrator still spawns the team (W ≈ 3–5 workers, per both Anthropic guidance and the USL optimum), still reviews, still merges.
What disappears is wave choreography: instead of "dispatch wave A, barrier, dispatch wave B," each worker's loop is claim → implement → verify → complete → claim, and the orchestrator's monitoring loop drains the frontier instead of counting a wave.
Partial starts become natural (the frontier is never all-or-nothing), a slow task no longer strands its wave-mates, and a crashed agent's task returns to the frontier by reap instead of wedging.

**Dynamic discovery rides the same rails.**
Add a `task.discovered` emission (or `task.assigned` with a `discoveredFrom` provenance field) so mid-execution work enters the frontier with an audit edge — the wave barrier structurally could not absorb this; the frontier absorbs it for free.
Gate it with the same plan-review affordance we use today when scope changes (discovered tasks above a size threshold surface for orchestrator approval rather than self-admitting), so discovery doesn't become unreviewed scope creep.

### 4.3 Fix worktree weight by binding it to W, not N

The pull model is what makes worktrees cheap, because provisioning moves from plan time to claim time:

- **Provision on claim, release on complete.** A worktree exists only while a worker holds a task; concurrent worktrees ≈ W (3–5), not N (26+ in recent waves, 37 currently on disk). The claim verb composes with the existing `acquire_worktree` lease; claim+acquire must commit atomically (INV-13's requested/executed split covers the non-idempotent provisioning effect).
- **Give GC its missing invocation path.** `release_worktree` on `task_complete`, `WorktreeManager.reconcile` reaping dead owners, and `prune_worktrees` surfaced in the delegate/cleanup skills — all three exist; none is wired into the loop today. This alone reclaims the 7.1 GB class of waste.
- **Evaluate `git clone --shared` as the isolation unit** (spike, not commitment): benchmarked at worktree-equivalent cost while isolating refs, config, stash, and hooks — the exact surfaces our write-leak RCA and the shared-`.git` dissent identify. If it survives a Windows + CC-harness compatibility spike, it upgrades INV-11 isolation from prose toward structure; if not, worktrees remain acceptable.
- **Amortize installs.** With W long-lived workers instead of N ephemeral worktrees, per-worktree `npm install` cost drops proportionally; a shared package cache (or pnpm-style store, if ever justified) becomes an optimization rather than a necessity.

**The INV-11 crux (flagged honestly):** under push, the write boundary is set at spawn; under pull, an agent exists before it knows its task, so the boundary must be re-narrowed atomically with the claim or isolation degrades to convention.
Today isolation is already prose-only (the write-leak RCA), so the pull model doesn't weaken a guarantee we have — but the claim verb's design should treat "claim ⇒ boundary" as the invariant to build toward, and this is the first question an implementation spec must answer.

### 4.4 Fit with the roadmap and invariants

- **INV-15 framing:** this is not a saga/scheduler/supervisor import — it is a projection plus an OCC claim over the one SQLite file we already have; the queue is derived state, the reaper is the existing reconcile idiom, and no new process, timer, or daemon appears.
- **INV-5a/5d:** everything lands as actions on the existing four composites (`task_claim` hardened, `task-frontier` view under `exarchos_view tasks`/`delegation_readiness`), never a fifth tool.
- **INV-9:** the HSM remains the sole phase authority; the frontier orders work *within* the delegate phase only, and the all-tasks-complete guard simply becomes frontier-drained.
- **INV-4/INV-2:** the claim protocol lives in the MCP dispatch core with a total output schema (empty-frontier, lost-race, and blocked are typed shapes, not error strings), so every runtime gets parity — retiring the Claude-only agent-teams prose as the *only* pull path.
- **Workflow SDK (v3.0):** unchanged-runtime is preserved; `fork` combinators keep authoring topology, and the frontier is the runtime substrate that executes it. A `.workflow.ts` that declares parallel tasks compiles to the same `task.assigned`-with-edges events the frontier folds.

### 4.5 Decision summary

| Dimension | Today (push waves) | Gas Town (pull) | Recommended (hybrid) |
|---|---|---|---|
| Task source of truth | Spec markdown + state.json + events (edges in markdown only) | Dolt DB | Event store, edges on `task.assigned` |
| Dependency enforcement | Plan-time lint, then advisory | `bd ready` query; dispatch manual | Enforced at claim time via frontier fold |
| Assignment | Orchestrator pushes hand-authored waves | Agents claim from ready set | Planner shapes graph; workers claim from frontier |
| Worker binding | Static, per task | Dynamic | Dynamic (W ≈ 3–5) |
| Isolation | Worktree per task (37 live, 7.1 GB) | Worktree per polecat | Worktree (or shared-clone) per *worker*, claim-scoped, GC'd on release |
| Crash recovery | Wedged claim, manual repair | Lease + heartbeat + reaper | Event-derived liveness + reconcile reap + attempt-epoch fencing |
| Merge | `serialize_merge` single-writer (mature) | Refinery batch-then-bisect (partly aspirational) + merge slot | Keep `serialize_merge`, batch 1 |
| Review | Adversarial review + verification ladder | None (weakest link) | Keep ours — it is the moat |
| Mid-flight discovery | Structurally impossible (barrier) | `discovered-from`, spontaneous filing | `task.discovered` → frontier, gated by size threshold |

---

## 5. Risks and open questions

1. **INV-11 atomic boundary re-narrowing** (§4.3) — the crux design question for the implementation spec; candidate mechanisms: claim returns the worktree path and the runtime's isolation primitive is re-pointed, vs. worker-session-per-claim (spawn-on-claim keeps today's spawn-time binding at the cost of session reuse).
2. **At-least-once execution posture.** A falsely-reaped live agent duplicates work; fencing makes it harmless but wasteful. Acceptable at W ≤ 5; revisit if reap false-positive rate is nonzero in practice.
3. **Worker-loop ergonomics off-Claude.** The claim verb is MCP and therefore portable; what varies per runtime is the *spawn* primitive and whether a worker can loop multiple claims per session. Degenerate fallback: the orchestrator claims on a worker's behalf and dispatches one task per spawn — still frontier-driven, no wave barrier, strictly better than today.
4. **Review remains serial by design.** The frontier speeds production, not integration+review; expect the bottleneck to move there (it already is there industry-wide). Do not respond by parallelizing review below the fresh-context adversarial bar.
5. **Measure, don't assume, the parallelism optimum.** Instrument α (merge-slot wait) and β (rebase/conflict/re-verify time) from existing events and let W follow the data; the theory predicts single-digit and the industry consensus is 3–5.
6. **Speculative merge batching** is a known, deferred optimization with a clean trigger: adopt only when the measured per-task green rate at integration makes p^k favorable.

**Suggested path:** treat this report as the discover-bridge input to an `/exarchos:ideate` run for a `task-frontier` spec (changes §4.2.1–4.2.4 + §4.3 GC wiring), with the `git clone --shared` spike and INV-11 mechanism as its two explicit design questions.

---

## 6. Sources

Full source lists with URLs live in the four research-agent reports; primary anchors:

**Theory:** Graham 1966 (BSTJ 45, list-scheduling bounds and anomalies); Blumofe & Leiserson 1999 (JACM 46:5, work stealing); Smith 1980 (IEEE ToC, Contract Net); Gelernter 1985 (TOPLAS, Linda); AWS SQS visibility-timeout and Temporal activity-timeout docs; Zuul gating docs; GitHub merge-queue engineering blog; Gunther, Universal Scalability Law.

**LLM multi-agent:** Anthropic "How we built our multi-agent research system" and "Building a C compiler with 16 parallel agents"; Cognition "Don't Build Multi-Agents" (2026 revision) and "Devin can now manage Devins"; Cursor "Agent swarm model economics"; Google Research "Towards a science of scaling agent systems" (arXiv 2512.08296); MAST failure taxonomy (arXiv 2503.13657); Co-Coder cohesion-aware partitioning (arXiv 2606.00953); agent-PR conflict study (arXiv 2607.04697); LLM blackboard system (arXiv 2510.01285); Claude Code agent-teams docs; fletch.sh worktrees-vs-clones benchmark.

**beads/Gas Town:** `gastownhall/beads` and `gastownhall/gastown` READMEs, docs, and source (claimer/readyclaimer/lease/reclaim, migrations 0054–0055); Yegge, "Gas Town: from Clown Show to v1.0" and "Beads Best Practices"; tenzinwangdhen.com and paddo.dev independent critiques.

**Internal:** `servers/exarchos-mcp/src/tasks/tools.ts`; `verbs/team/prepare-delegation.ts`; `orchestrate/worktree/{merge-serializer,manager,projections/worktrees}.ts`; `event-store/{atomic-appender,schemas}.ts`; `orchestrate/{task-decomposition,parse-task-stamps}.ts`; `views/delegation-readiness-view.ts`; `skills-src/delegate/SKILL.md` + `references/{adaptive-orchestration,parallel-strategy}.md`; `.exarchos/invariants.md`; `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`; `docs/research/2026-06-21-treehouse-worktree-mining.md`; `docs/specs/2026-07-03-wlm-reconcile-enforce.md`; RCAs `2026-05-31-implementer-worktree-base.md`, `2026-06-21-worktree-isolation-write-leak.md`.
