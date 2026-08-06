# The theoretically optimal coordination strategy for coding agents

**Date:** 2026-08-04
**Status:** design-theory reference (harness constraints deliberately excluded)
**Companion:** [`2026-08-04-coordination-pull-vs-push-sota.md`](2026-08-04-coordination-pull-vs-push-sota.md) — the evidence base and the harness-constrained recommendation.
This document answers a different question: if we could design the coordination substrate freely, what would optimal look like, and how far short of it does the practical design fall?

---

## 1. Premise: what is actually being optimized

Classical scheduling theory optimizes makespan for M machines because machines are the scarce resource.
For LLM coding agents that premise is wrong.
Workers are elastic — you can spawn as many as you are willing to pay for — so worker count is a decision variable, not a constraint.

The genuinely scarce resources are three:

1. **The serial fraction.** Integration and review must serialize (§3.6, §5), and Amdahl bounds the whole system by that fraction regardless of fleet size.
2. **Interference.** The coherency term β in the Universal Scalability Law — merge conflicts, invalidated in-flight assumptions, contract drift between concurrent editors.
   β is a property of the codebase's coupling, not of the coordination architecture, and it grows quadratically with width.
3. **Verification quality.** Every strong empirical system reports oracle quality, not agent count, as the binding constraint on how much autonomy and parallelism it can afford.

The design question therefore stops being "how do I assign tasks to workers" and becomes **"where does the marginal token go"** — width across tasks, samples within a task, or scrutiny of finished work.
Most of the optimal pattern falls out of taking that reframing seriously.

## 2. The controller thesis

The theoretically optimal coordination pattern is not a fixed architecture.
It is an **adaptive controller** running on the four-layer substrate established in the companion report (static dependency DAG → dynamic ready frontier → lease-based claim → serialized merge):

> Measure the codebase's coupling and the fleet's green-rate; set width to `min(frontier width, N*)` where `N* = √((1−α)/β)`; route surplus capacity into sampling and verification rather than additional lanes; and degenerate gracefully to a single excellent agent when coupling is high or the base model is strong enough that decomposition returns negative.

Everything below is a component of that controller.
The four-layer substrate is assumed, not restated; this document covers what the ideal adds on top and what bounds it from above.

## 3. Components

### 3.1 The planner is a decision compiler, not a dispatcher

The planner's optimal output is three artifacts, and nothing else:

- **Contracts.** Every shared design decision — interface shapes, naming, invariants between tasks — written as an explicit, checkable artifact before fan-out.
  This eliminates the split-brain failure class *by construction*: no two workers can independently resolve the same question if the question is already answered.
  Parallel workers cannot see each other's reasoning, so any decision left open is a decision made twice, differently.
- **A cohesion partition.** Task boundaries computed as a minimum cut over the code's interference graph — community detection over symbol-sharing and import edges, with structural hubs isolated into their own tasks.
  Plan time is the only point where β can be reduced at all; every other layer merely copes with the β the partition left behind.
- **A hub-first ordering.** Interface and hub tasks scheduled ahead of their communities, so contracts freeze before dependents start.

What the planner must *not* output is an assignment.
Binding tasks to workers at plan time bets on task durations, and Graham's anomalies show that bet is dominated: with a fixed assignment, shortening tasks, adding workers, or removing constraints can each make completion later.

The plan is a **prior, not a commitment**.
Discovered work (the `discovered-from` pattern) updates the graph mid-execution, and the frontier absorbs it; a plan that cannot be revised mid-flight assumes both plan completeness and worker survival, and both assumptions fail routinely.

### 3.2 Execution: an evolving DAG drained by greedy pull

The ready frontier — tasks whose blocking predecessors are complete — is recomputed on every completion event, and workers pull from it.
Greedy, work-conserving pull is within 2× of the optimal schedule with zero duration knowledge (Graham's bound, `T_P ≤ T₁/P + T_∞`), and it is self-correcting under the order-of-magnitude duration variance that LLM agents exhibit: a slow task simply means its worker takes fewer subsequent ones, rather than stranding a wave.

Priority intelligence belongs *on top of* the frontier as an ordering, never as a binding.
Critical-path-first is the classical default; it improves the constant while the frontier mechanism supplies the guarantee.

### 3.3 Affinity-aware claiming

A worker's context is warm capital.
The agent that just implemented module X is better positioned for the next X-adjacent task, and rebuilding that context is the real switching cost between tasks.
Classical scheduling has this exact structure in cache-affinity work stealing: prefer local work; steal anything rather than idle.
The optimal claim rule is therefore: rank ready tasks by overlap with the claimant's recent footprint, but take *any* ready task over idling.

Confidence note: this is the component with the weakest direct evidence (§6).
It is well-established for cache lines and plausible for LLM context, but unmeasured; it should ship as a ranking, never a constraint, and earn trust through instrumentation.

### 3.4 Surplus allocation: sampling, speculation, scrutiny

The deepest departure from classical scheduling.
On classical machines an idle worker is pure waste; a *stochastic* worker can re-run an already-claimed task, because LLM attempts are samples from a distribution, and selection among samples has measured value (DEI: a committee whose best member resolves 27.3% reaches 34.3% through candidate selection alone).

When the frontier is narrower than the fleet — precisely the regime where wave systems idle — surplus capacity has three productive sinks:

1. **Best-of-n on critical-path tasks.** The critical path is where wall-clock lives; n samples plus a judge buy quality exactly where it compounds.
2. **Speculative execution past unmerged blockers.** Start a dependent task against its blocker's unmerged branch — Zuul's speculation lifted upstream from CI into implementation — and discard cheaply if the blocker fails review.
   The economics are `p^k`: speculation pays only when the blocker's review green-rate p is high, which makes the adoption trigger a measurement rather than a judgment call.
3. **Verification amplification.** Additional adversarial reviewers on high-blast-radius items.

Width, sampling, and scrutiny draw from one budget, and the optimum rebalances among them continuously.
A fixed fleet size is the tell that a system is not doing this.

### 3.5 Verification is the system's error-correcting code

Treat implementation as a noisy channel and verification as the decoder: the achievable rate — autonomy × parallelism — is set by oracle quality.
This is why a 16-agent, orchestrator-free swarm could build a working C compiler against GCC's torture suite, and why Gas Town, with no review layer, leaks correctness at scale ("throughput, not correctness").

Two consequences:

- **Oracle-first investment.** Tokens spent improving the verifier (test adequacy, mutation kill-rate) raise the ceiling on everything else; tokens spent on width against a weak oracle buy faster wrong answers.
- **Depth calibrated to blast radius.** Verification effort should track a task's failure cost, not a universal ceremony.
  This is, notably, the single mechanism the Exarchos delegation pipeline has *empirically validated* (#1670: verification-depth calibration was the one surviving positive result).

### 3.6 Integration: serialized truth, speculatively pipelined

Integration remains single-writer, and not as a compromise.
Testing the merge result forces a total order on truth, and code carries global invariants, so no CRDT-style commutative merge can exist for it.
The optimal system:

- pipelines speculation above the serial point (batch size from the `p^k` economics, adaptive as green-rate moves — the Zuul congestion-window pattern);
- shrinks the conflict rate itself by detecting overlap at the *entity* level rather than the line level, since entity-level disjointness is what the cohesion partition was optimizing for;
- accepts that the ceiling on the serial point can be raised (Cursor's purpose-built VCS: ~60× commit throughput) but never removed.

### 3.7 Communication: blackboard for facts, contracts for decisions, otherwise silence

Peer-to-peer chatter is the quadratic coordination term; the optimum deletes it structurally rather than managing it.

- **State** lives in a shared ledger any agent can read (the blackboard/Linda formulation).
  This is also what makes workers disposable: identity and progress survive any session, so session cycling is normal operation rather than failure.
- **Decisions** live in the planner's frozen contracts.
- **Discoveries** enter as ledger events with provenance edges, not messages.
- The only messages that remain are **affordances**: "something you can act on changed."

### 3.8 Failure handling: resample over repair

At-least-once execution with fencing is the standard queue result (a false reap must be harmless, enforced by a monotonic attempt epoch the integration step checks).
The LLM-specific addition: when an attempt dies half-done, a fresh attempt with clean context usually beats sending an agent to do archaeology on a broken worktree.
Reap aggressively; treat attempts as idempotent samples; reserve repair for failures whose diagnosis is itself the valuable output.

## 4. The control law

Definitions, so the controller is measurable rather than aspirational:

- **α (contention):** fraction of task wall-clock spent waiting on the serialized integration slot.
  Measurable as the delta between merge-slot request and execution events.
- **β (coherency):** per-pair interference cost — conflict resolution, rebase-and-re-verify cycles, fix cycles attributable to concurrent edits — as a fraction of task cost.
  Measurable from merge failures and fix-cycle events.
- **p (green-rate):** probability a completed task passes review and integration unchanged.
- **N\* = √((1−α)/β):** the width beyond which throughput is retrograde (USL).

Control law:

1. Width `W = min(frontier width, N*)`, with N\* recomputed from trailing measurements.
2. Surplus (fleet beyond W, or W beyond frontier) routes to §3.4 sinks in order of measured marginal value; default priority is verification amplification → best-of-n on the critical path → speculation (speculation last because its payoff condition `p^k` is the most fragile).
3. Degeneracy condition: if the cohesion partition's min-cut cost exceeds a threshold — the code is effectively sequential — or single-agent task accuracy is high enough that decomposition returns negative, set W = 1 and skip the coordination machinery entirely.
4. All three inputs (α, β, p) are trailing observables from the event ledger; the controller adds no processes, timers, or heartbeats — it is a fold plus a hint.

## 5. Irreducible limits

Three bounds no coordination pattern can beat, which together explain why the optimum is adaptive rather than fixed:

1. **Sequential depth (T_∞).** Some chains of reasoning about a codebase cannot be parallelized; Brent's bound holds at any fleet size.
2. **The review point.** As long as a human or trusted serial judge accepts changes, Amdahl caps the system there — and the field's empirics say that is already where the bottleneck sits (agent PRs wait 4.6× longer for review pickup; acceptance 32.7% vs 84.4% for human PRs).
   Speeding production without widening trusted review moves queue length, not throughput.
3. **β is exogenous.** A tightly coupled codebase has an optimal width of one, and no scheduler changes that; only refactoring does.
   The strongest empirical results agree from both directions: cohesion-aware partitioning degrades gracefully to sequential as coupling rises (Co-Coder), and added agents go *negative* once single-agent accuracy on the task class passes ~45% (capability saturation, β = −0.236, p = 0.004).

The third limit carries a forward-looking corollary worth stating plainly: **as base models improve, the optimal width shrinks.**
A healthy implementation of this controller should be expected to recommend delegation less often over time, and a version of it that never says "just use one agent" is broken.

## 6. Confidence ledger

Claims are not equally supported; anything built on the low-confidence rows should be instrumented before it is relied upon.

| Claim | Basis | Confidence |
|---|---|---|
| Static graph + dynamic binding dominates static assignment | Graham bounds/anomalies; universal production convergence | High |
| Integration must serialize; merge-result testing forces total order | Logical necessity; bors/Zuul/merge-queue lineage | High |
| Verification quality binds achievable autonomy × parallelism | Convergent empirics (C-compiler swarm, Gas Town failure modes, Thoughtworks) | High |
| Optimal width is small and codebase-dependent | USL + measured 3–5 sweet spot (Google, Anthropic) + saturation result | Medium-high |
| Cohesion partitioning beats naive partitioning and sequential | One strong controlled study (Co-Coder) + corroborating conflict data | Medium-high |
| Resample-over-repair for failed attempts | Practitioner convergence (Gas Town NDI, fleet operators); no controlled study | Medium |
| Best-of-n sampling beats idle width for code tasks | DEI is strong but measured on issue-resolution ensembles, not in-flight task sampling | Medium (mechanism) / Low (transfer) |
| Speculation past unmerged blockers pays at high green-rate | Sound economics (`p^k`); evidence is from CI, extrapolated to implementation | Low-medium; adopt only on measured trigger |
| Affinity-aware claiming improves LLM worker throughput | Cache-affinity analogy + practice anecdote; unmeasured for LLM context | Low; ship as ranking, instrument, then decide |

## 7. Mapping to Exarchos

Nearly every component has an existing landing surface; the gap is usually wiring, not machinery.

| Ideal component | Exarchos surface | Status |
|---|---|---|
| Contracts as frozen decisions (§3.1) | Spec DR-N sections + `check_contract_drift`; add per-task `Contracts:` stamps | Mostly exists |
| Cohesion partition (§3.1) | `checkParallelSafety` upgraded from pairwise file overlap to sem/import-graph cohesion scoring | Gate upgrade |
| Hub-first ordering (§3.1) | Lint in `validateDependencyDAG`: hubs must block their community | Small addition |
| Plan as prior (§3.1) | `task.discovered` events + event-sourced plan revision (closes the revision re-stamp gap) | New, small |
| Ready frontier (§3.2) | `task-frontier@v1` fold; blocked on dependency edges entering `task.assigned` | Companion report §4.2 — the foundation |
| Lease-bearing claim (§3.2) | Hardened `task_claim` via `decide()`, INV-10 event-derived liveness, reconcile reap, attempt-epoch fencing | Companion report §4.2 |
| Affinity ranking (§3.3) | Sort order in the frontier fold by footprint overlap with claimant history; surfaced in `next_actions` | Cheap once frontier exists; instrument via `delegation_timeline` |
| Best-of-n sampling (§3.4) | Attempt-epoch branches already permit n parallel attempts; missing piece is a judge review selecting a winner | Deferred; trigger = frontier-starved fleet + eval evidence |
| Speculation past blockers (§3.4) | `setup_worktree` with `sourceBranch` = blocker's branch; ancestry preflight already refuses bad landings | Deferred; trigger = measured p makes `p^k` favorable |
| Oracle-first verification (§3.5) | Verification ladder + mutation-adequacy gate; amplify reviewers on high tier when surplus exists | Exists; amplification later |
| Serialized truth + speculation (§3.6) | `serialize_merge` batch-1; batching trigger from measured green-rate | Exists; trigger later |
| Entity-level conflict detection (§3.6) | weave (`weave_potential_conflicts`, `weave_preview_merge`) as merge-preflight enrichment | Installed, unwired |
| Blackboard communication (§3.7) | The event store already is this; peer chatter already absent | Done |
| Resample over repair (§3.8) | `task_fail` → reclaimable + fresh-attempt-by-default policy; fixer reserved for informative failures | Policy change |
| Width controller (§4) | A view, not a daemon: α from merge-slot wait events, β from conflict/fix-cycle events, N\* as a `prepare_delegation` quality hint | New view; INV-15-clean by construction |
| Degeneracy to W=1 (§4) | Parallelism-viability verdict from `check_task_decomposition` routing to oneshot/inline | Routing change; converts Co-Coder's result into a gate verdict |

**Sequencing.**
Wave 1 is the companion report's §4.2 unchanged (edges → frontier → claim → affordances → GC wiring); nothing above works without it.
Wave 2 is the cheap ideal upgrades: affinity ranking, the α/β width hint, the parallelism-viability verdict, resample-first failure policy, contract stamps with hub-first ordering.
Wave 3 is the gated set — speculation, sampling, weave preflight, review amplification — each with its trigger metric named in advance so adoption is a measurement, not a debate.

**Caveats.**
α/β estimates will be noisy at per-feature event volumes (a handful of merges per feature); the width hint should present as a range, lean on cross-feature history, and never be trusted to a decimal place.
And the mapping inherits §5's corollary: built honestly, this controller should argue with enthusiasm for fleets more often as models improve.
That is the system working.

## 8. References

Evidence for every empirical claim above is sourced in the companion report (`2026-08-04-coordination-pull-vs-push-sota.md`, §6), whose four underlying research dossiers cover:
scheduling theory (Graham 1966; Blumofe & Leiserson 1999; Gunther's USL; Smith's Contract Net; Gelernter's Linda; Zuul/bors/GitHub merge-queue lineage);
LLM multi-agent empirics 2024–2026 (Anthropic multi-agent research system and C-compiler swarm; Cognition; Cursor swarm economics; Google agent-scaling study, arXiv 2512.08296; Co-Coder, arXiv 2606.00953; MAST, arXiv 2503.13657; agent-PR conflict study, arXiv 2607.04697; DEI, arXiv 2408.07060);
and the beads/Gas Town field record (`gastownhall/beads`, `gastownhall/gastown`, Yegge's retrospectives, independent critiques).
Exarchos-internal evidence: `docs/evals/2026-07-09-1670-delegation-pipeline-empirical.md`, `.exarchos/invariants.md`, and the delegation-internals findings summarized in the companion report §2.
