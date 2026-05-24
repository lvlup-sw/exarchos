# Runtime Invariants Research Survey

> **Workflow:** `workload-agnostic-runtime-invariants` (discovery, Phase A per charter)
> **Date:** 2026-05-20
> **Status:** Research deliverable D1 of 5
> **Parent:** epic #1441
> **Companion:** [`docs/research/2026-05-20-runtime-invariants-gap-analysis.md`](2026-05-20-runtime-invariants-gap-analysis.md) (D2)

## 1. Purpose

External research corpus for the v2 invariant catalog. Every candidate invariant from D2 must have ≥3 external citations per the charter acceptance criterion. This document organizes the corpus by research question (RQ-1..RQ-6) and maps each source to the candidate invariant it grounds.

The catalog's v1 incarnation has zero external citations — all `references:` fields point to internal `.claude/skills/design-invariants/references/INV-*.md` files or other Exarchos files. This is fine for the *operational projection* (the skill body), but wrong for the *source of truth* the catalog claims to be. D5 (v2 spec) will require citations alongside internal references.

## 2. RQ-1 — Workload-agnostic runtime design

**Formal definition target:** A runtime is *workload-agnostic* if its substrate guarantees hold independently of which workload type executes over it. Contrast with *workload-aware*, which exposes workload-shape hints to the substrate for optimization.

### Sources

**[S1] Agent Workflow Protocol — `runtime.md`**
URL: https://github.com/veegee82/agent-workflow-protocol/blob/main/docs/runtime.md
The AWP project's `runtime.md` explicitly separates protocol (normative) from runtime (pluggable): *"AWP is intentionally runtime-agnostic. The protocol (YAML manifests, agent contracts, validation rules) is normative; the runtime that executes a workflow is pluggable."* Direct precedent for Exarchos's platform + workload separation. Lists four responsibilities every runtime must have: parse/validate, resolve providers, execute orchestration, enforce output contract — a useful skeleton to compare against runtime.md §3's L1–L9 layering.
**Grounds:** INV-6 sharpening (workload-agnosticism as primary statement, not skill-grep operational), INV-4 (platform half).

**[S2] Conductor — durable-execution overview**
URL: https://conductor-oss.github.io/conductor/devguide/concepts/conductor.html
Counterexample. Conductor is a "durable execution engine" but bakes workflow concepts in — workers poll for tasks, retries are configured at workflow definition time, language polyglot is a first-class concern. Useful negative reference: workload-agnostic ≠ "any code runs anywhere"; it means the runtime *makes no shape assumption* while the workload *declares* its shape through topology. Conductor's strength (retry policies as first-class) is also its workload-shape coupling.
**Grounds:** Negative reference for D5 §scope; helps disambiguate "agnostic" from "polyglot."

**[S3] NVIDIA Dynamo — agentic workloads doc**
URL: https://github.com/ai-dynamo/dynamo/blob/main/docs/features/agentic_workloads.md
Dynamo uses *"workload-agnostic scheduling"* as a term to **reject** in favor of *"workload-aware inference."* The argument: agents have predictable structure; the runtime can leverage that for KV-cache prefetching, eviction, and scheduling. Useful disambiguation for Exarchos's framing — Exarchos is workload-agnostic at the **runtime guarantee** layer (RT-1..RT-6 hold regardless of workflow type) while being workload-*aware* at the **topology layer** (each workflow-type's `topology.yaml` declares its HSM and gates). This split should be made explicit in D5.
**Grounds:** D5 §framing — the "agnostic at substrate, aware at topology" pattern.

**[S4] Harn workflow runtime docs**
URL: https://harnlang.com/workflow-runtime.html
*"Harn's workflow runtime is the layer above raw llm_call() and agent_loop(). It gives host applications a typed, inspectable, replayable orchestration boundary instead of pushing orchestration logic into app code."* Independent design landing on similar primitives: typed orchestration boundary, replay, artifact provenance. Direct architectural parallel to Exarchos's L5 (dispatch core) over L3 (projections) over L2 (event store).
**Grounds:** Convergence evidence for INV-1 + INV-2.

**[S5] Novita Agent Runtime announcement**
URL: https://blogs.novita.ai/novita-agent-runtime-agentcore-compatible/
*"Framework agnostic. Novita Agent Runtime works with LangGraph, Microsoft AutoGen, Google ADK, OpenAI Agents SDK, CrewAI, and custom implementations."* Demonstrates that "framework-agnostic" + "model-agnostic" are recognized industry-level decoupling axes — Exarchos's "workload-agnostic" adds a third axis (workflow-type-agnostic) that the others don't name. Worth surfacing in D5 as a *strengthening* of the agnosticism family.
**Grounds:** D5 §framing — positioning Exarchos's agnosticism axes.

## 3. RQ-2 — Process-manager pattern

**Pattern target:** Non-idempotent external side effects split into `*.requested` → `*.executed` event pairs with idempotent precheck on recovery.

### Sources

**[S6] Akka Persistence — Effect / thenRun docs**
URL: https://doc.akka.io/api/akka-core/current/akka/persistence/typed/scaladsl/Effect$.html
URL: https://doc.akka.io/docs/akka/snapshot/typed/persistence.html
Canonical formulation: *"The event handler must only update the state and never perform side effects, as those would also be executed during recovery of the persistent actor. Side effects should be performed in `thenRun` from the command handler after persisting the event or from the `RecoveryCompleted` after Recovery."* This is the architectural rule Exarchos's two-event split implements — the `*.requested` event captures intent (state update), the side effect runs *after* persistence, and the `*.executed` event captures outcome. The Akka docs also warn: *"Side effects are not run when the actor is restarted or started again after being stopped"* — which is exactly why Exarchos needs the recovery-precheck step on resume.
**Grounds:** INV-13 (process-manager-two-event-split), INV-8 (idempotency-at-the-boundary).

**[S7] Wolverine — Aggregate Handler Workflow blog (Jeremy Miller)**
URL: https://jeremydmiller.com/2023/12/06/building-a-critter-stack-application-wolverines-aggregate-handler-workflow-ftw/
Wolverine's `[AggregateHandler]` attribute is the .NET sibling pattern: the handler is a pure function over `(command, current_aggregate_state) → (events, outgoing_messages)`. The middleware around it does OCC-protected event append (Marten's `FetchForWriting`) and outbox publish. Optimistic concurrency is **default**: *"The Wolverine aggregate handler workflow triggered by the `[AggregateHandler]` usage up above happily builds in optimistic concurrency protection such that an attempt to save the pending transaction will throw an exception if something else has modified that Incident between the command starting and the call to persist all changes."*
**Grounds:** INV-7 (substrate-serialization — OCC default), INV-13.

**[S8] Wolverine PR #1858 — idempotency protections**
URL: https://github.com/JasperFx/wolverine/pull/1858
2025-11 PR adding *"improved option for enforcing message idempotency on non-transactional handlers."* Key concept: `Envelope.IsPersisted` property tracked in inbox implementations; configurable on a chain-by-chain basis; supports inline and buffered idempotency checks. Direct analog to Exarchos's idempotency-key carrier and the `withSession({operationId})` contract.
**Grounds:** INV-8 (idempotency-at-the-boundary).

**[S9] Wolverine retry-on-errors blog (Jeremy Miller)**
URL: https://jeremydmiller.com/2025/01/29/retry-on-errors-in-wolverine/
*"Wolverine can still use any 'Retry' or 'Discard' error handling policies, and if Wolverine does a retry, it effectively starts from a completely clean slate so you don't have to worry about any dirty state from scoped services used by the initial failed attempt to process the message."* The "clean slate on retry" property is exactly what Exarchos's `withSession` provides via `appendComputed(idempotencyKey: operationId)` — the retry doesn't pollute state because the `*.requested` event idempotency-collapses.
**Grounds:** INV-8, INV-13.

**[S10] Greg Young — "Why Event Sourced Systems Fail" talk (Fwdays 2020)**
URL: https://www.youtube.com/watch?v=FKFu78ZEIi8
URL: https://www.slideshare.net/slideshow/greg-young-why-event-sourced-systems-fail/239067872
Canonical talk listing the most common failure modes for event-sourced systems. The two most relevant to Exarchos: (1) versioning over time — events written years ago must remain readable; (2) eventual consistency myths — "include version in query" pattern collapses most eventual-consistency complaints. The talk's broader message is conservative: *most* event-sourcing failures come from teams treating projections as authoritative rather than as caches over the log. Direct grounding for INV-1.
**Grounds:** INV-1 (event-sourcing-integrity).

**[S11] Greg Young — *Versioning in an Event Sourced System* (Leanpub)**
URL: https://leanpub.com/esversioning
Book-length treatment. Chapter on "Versioning Process Managers" is directly relevant — process managers (Exarchos's term: HSM/workflow handlers) need their own versioning strategy because their intermediate state crosses event-version boundaries. Strategies named: "Upcasting State," "Take Over," with warning that mid-flight process managers are a versioning hazard.
**Grounds:** INV-9 (HSM-as-state-machine), INV-13.

**[S12] Greg Young — "Event Sourcing: The Bad Parts" (CodeCrafts 2022)**
URL: https://www.youtube.com/watch?v=K4bj31fJGFk
Companion talk: the explicitly-negative case. Useful for D5's "what Exarchos chooses to *not* solve" framing — Greg Young's catalog of bad parts overlaps significantly with runtime.md §8's rejected patterns (saga, in-runtime workflow engine).
**Grounds:** INV-15 (single-machine-frame) negative reference.

## 4. RQ-3 — Event-sourcing substrate

**Substrate target:** Write-ahead logging, total order via composite PK, atomic transaction, idempotency at the storage layer.

### Sources

**[S13] Mohan et al., *ARIES* (ACM TODS 1992)**
URL: https://dl.acm.org/doi/10.1145/128765.128770
URL: https://cs.stanford.edu/people/chrismre/cs345/rl/aries.pdf
URL: https://people.eecs.berkeley.edu/~brewer/cs262/Aries.pdf
URL: https://web.eecs.umich.edu/~prabal/teaching/resources/eecs582/mohan92aries.pdf
The canonical paper on transaction recovery using write-ahead logging. Key concepts that map directly to Exarchos's substrate: **WAL protocol** ("log records representing changes to data must be written to stable storage before the data is allowed to replace the previous version") — this is the rule SQLite WAL enforces; **LSN per page** (log sequence number) ≈ Exarchos's `(streamId, sequence)` composite PK; **paradigm of repeating history** (redo all updates before rolling back losers) ≈ Exarchos's `reconcile` operation. ARIES is the theoretical grounding for *why* SQLite WAL is a sufficient substrate for Exarchos's RT-1..RT-6 guarantees.
**Grounds:** INV-7 (substrate-serialization), INV-1 (event-sourcing-integrity), INV-15 (single-machine-frame — ARIES is a single-machine recovery algorithm).

**[S14] Bernstein & Goodman, *Concurrency Control in Distributed Database Systems* (ACM Computing Surveys 1981)**
URL: https://dl.acm.org/doi/10.1145/356842.356846
URL: https://people.eecs.berkeley.edu/~brewer/cs262/concurrency-distributed-databases.pdf
URL: https://apps.dtic.mil/sti/tr/pdf/ADA087996.pdf
The survey that established the decomposition of concurrency control into read-write and write-write synchronization, then into "two basic techniques: two-phase locking and timestamp ordering." Exarchos's choice is **neither** — it uses OCC (optimistic concurrency control via `(streamId, sequence)` PK conflict detection). The companion citation in the survey is Kung & Robinson's "On Optimistic Methods for Concurrency Control" (ACM TODS 1981) which formalized OCC. Bernstein/Goodman positions OCC as the third method *not* surveyed — Exarchos's substrate descends from that line.
**Grounds:** INV-7 (substrate-serialization — OCC primitive).

**[S15] Mark Miller, *Robust Composition: Towards a Unified Approach to Access Control and Concurrency Control* (PhD dissertation, JHU 2006)**
URL: https://papers.agoric.com/papers/robust-composition/full-text
URL: https://papers.agoric.com/assets/pdf/papers/robust-composition.pdf
URL: https://jscholarship.library.jhu.edu/items/b8376e55-208e-4fcc-81a2-ad5a7de0acbb
While primarily a capability-security paper (covered under RQ-4), Miller treats access control *and* concurrency control as the same problem — both are about *bounding what an unanalyzed component can do*. The dissertation introduces "vats" as persistent process-like units; intra-vat messages are sequential, inter-vat is via the Pluribus protocol with cryptographic capabilities. This framing is relevant to RQ-3 because it provides a *unified* substrate model — Exarchos's two-tier serialization (in-process Promise-chain + cross-process WAL PK) is a less-general instance of the vat model.
**Grounds:** INV-7, INV-11 (cross-cite from RQ-4).

## 5. RQ-4 — Capability-based security and posture

**Posture target:** Agent declares `read-only | task-isolated | shared-mutating`; capability resolver merges with handshake-declared runtime capabilities; mismatches resolve to handshake (handshake-authoritative).

### Sources

**[S16] Mark Miller, *Robust Composition* (2006)** *(re-cited from S15)*
The capability model is the architectural ancestor of Exarchos's posture system. The dissertation establishes: **All Authority Accessed Only by References** — "the authority an object has to affect or be affected the world outside of itself should be exactly represented by the references it holds." Exarchos's `task-isolated` posture is a direct instance: a sub-agent's "references" (worktree path, event-store namespace) literally cannot reach outside its scope, so it has no authority to mutate sibling worktrees. The `shared-mutating` posture is the rights-amplified case — the agent receives the references that let it cross into shared state.
**Grounds:** INV-11 (posture-declared-capabilities).

**[S17] Miller et al., *Paradigm Lost: Abstraction Mechanisms for Access Control* (JHU SRL 2003)**
URL: https://srl.cs.jhu.edu/pubs/SRL2003-03.pdf
Develops the **Principle of Least Authority (POLA)** as a stronger form of POLP (least privilege): *"The principle is to give programs (or any active agent) the minimum authority which is sufficient for them to perform their intended (by the invoker) task."* The paper draws a crucial distinction: *"Permission is relative to a frame of reference. Authority is invariant."* Exarchos's posture declaration is *authority*-shaped, not *permission*-shaped — a `task-isolated` posture states what the agent *can do*, regardless of frame.
**Grounds:** INV-11.

**[S18] erights.org — *From Objects to Capabilities***
URL: http://erights.org/elib/capability/ode/ode-capabilities.html
The original capability model formulation: *"For each process, there is a table associating small numbers (similar in spirit to Unix file descriptors) with the capabilities held by that process. These small numbers serve the same function as variable names do in the lambda calculus."* The lineage: KeyKOS (Hardy 1985), EROS (Shapiro 1999), Dennis & van Horn 1966. Useful for D5 §References when citing capability-based security history.
**Grounds:** INV-11.

**[S19] erights.org — *Capabilities As A Cryptographic Protocol***
URL: http://erights.org/elib/capability/ode/ode-protocol.html
Describes the Pluribus protocol's handshake: vat-to-vat connection establishes via SSL-style key agreement, then capability references are exchanged over the authenticated channel. Direct architectural parallel to MCP's `initialize` handshake — Exarchos's "handshake-authoritative" rule is the same shape: *the capability set declared at handshake-time is authoritative for the session.*
**Grounds:** INV-11 (handshake-authoritative half).

**[S20] erights.org — POLA wiki**
URL: http://wiki.erights.org/wiki/POLA
*"We intentionally use the name POLA instead of the usual POLP because the second name is distracting. It is not enough to focus on permissions of the subject. We must consider its authority."* Short pointer; cite alongside S17.
**Grounds:** INV-11.

**[S21] anip-protocol — SPEC.md**
URL: https://github.com/anip-protocol/anip/blob/main/SPEC.md
**Convergent independent design.** Uses both `posture` and `handshake` in a capability-token-DAG context. From the SPEC: *"posture (OPTIONAL, v0.7) — governance posture summary. Exposes trust-relevant service characteristics that agents can inspect before invocation"* and *"The handshake is the first substantive interaction. The agent declares what profiles it needs; the service responds with whether it can satisfy them. Tasks declare their own profile requirements — matching happens before any capability is invoked."* Two-vocabulary convergence between Exarchos and an unrelated protocol is **strong evidence** that the posture/handshake pattern is the load-bearing primitive for agent runtimes, not Exarchos-idiosyncratic.
**Grounds:** INV-11 — strongest single citation.

## 6. RQ-5 — Affordance theory

**Affordance target:** `next_actions` envelope hints make valid runtime transitions *perceptible* to agents; agents read affordances rather than poll. Autonomy is a property of state + topology, not handler-internal logic.

### Sources

**[S22] Norman, *Affordance, Conventions, and Design* (ACM Interactions 1999)**
URL: https://interactions.acm.org/archive/view/may-june-1999/affordance-conventions-and-design1
URL: https://www.lri.fr/~mbl/ENS/DEA-IHM/papers/Norman-Affordances.pdf
Norman's mid-career clarification of the term. *"The word affordance was coined by the perceptual psychologist J. J. Gibson to refer to the actionable properties between the world and an actor (a person or animal). To Gibson, affordances are relationships. They exist naturally: they do not have to be visible, known, or desirable."* The Norman-vs-Gibson distinction is critical for Exarchos: **`next_actions` are *perceived* affordances (Norman) — they make the *real* affordances (Gibson — the set of verbs the HSM/projection actually permit) visible to the agent.** A misaligned `next_actions` envelope is a usability failure (the perceived affordance doesn't match the real one); a missing one is a discoverability failure (the real affordance exists but isn't perceptible).
**Grounds:** INV-12 (next-actions-as-affordance).

**[S23] Norman — *Affordances and Design* (jnd.org)**
URL: https://jnd.org/affordances-and-design/
Personal website essay restating the distinction. *"In product design, where one deals with real, physical objects, there can be both real and perceived affordances, and the two need not be the same. In graphical, screen-based interfaces, all that the designer has available is control over perceived affordances."* For Exarchos: the runtime controls the *real* affordances (HSM topology + projection state); the *perceived* affordances are the `next_actions` envelope. The runtime engineer's job is to make these match.
**Grounds:** INV-12.

**[S24] Interaction Design Foundation — Affordances glossary**
URL: https://interaction-design.org/literature/book/the-glossary-of-human-computer-interaction/affordances
Distills the Gibson/Norman distinction crisply: *"We both design for usefulness by creating affordances (the possibilities for action in the design) that match the goals of the user (the relativity of the affordance vis-à-vis the user) and we improve the usability by designing the information that specifies the affordances (perceptual information as shadows on buttons to afford clickability etc.)."* The "perceptual information that specifies the affordance" is `next_actions` — the runtime makes the action set perceivable to the agent.
**Grounds:** INV-12.

**[S25] McGrenere & Ho, *Affordances: Clarifying and Evolving a Concept* (Graphics Interface 2000)**
URL: https://graphicsinterface.org/wp-content/uploads/gi2000-24.pdf
Academic disambiguation paper. Key contribution for Exarchos: *"In general, an underlying affordance or function can still exist regardless of correct interpretation or even perception by the user."* This is the formal statement of the invariant: **the existence of the affordance does not depend on the agent perceiving it.** Removing a verb from `next_actions` does *not* remove the affordance — it removes the agent's path to invoking it. INV-12 should state this precisely: `next_actions` is the *publication* mechanism for affordances; the topology + projection are the *source*.
**Grounds:** INV-12.

## 7. RQ-6 — Deliberate non-patterns

**Negative-reference target:** runtime.md §8 names six rejected patterns. Each rejection is itself an invariant ("Exarchos does not do X").

### Sources

**[S26] Microsoft Azure Architecture Center — Scheduler Agent Supervisor pattern**
URL: https://learn.microsoft.com/en-us/azure/architecture/patterns/scheduler-agent-supervisor
The canonical reference. SAS exists *because* distributed systems lack a globally-consistent state store and lack reliable communication between coordinator and workers. The pattern's Supervisor role re-runs failed steps, maintaining retry counts in state, with escalation to Compensating Transaction (saga). Exarchos rejects SAS because the local substrate (SQLite WAL + OCC) eliminates the distributed-failure-mode that motivates SAS in the first place.
**Grounds:** INV-15 (single-machine-frame), INV-10 (liveness-event-protocol — v2.12 verbs do generically what Supervisor does specifically).

**[S27] Clemens Vasters — *Cloud Architecture: The Scheduler-Agent-Supervisor Pattern* (2010)**
URL: https://learn.microsoft.com/en-us/archive/blogs/clemensv/cloud-architecture-the-scheduler-agent-supervisor-pattern
The origin blog. *"We need to do a set of coordinated action across a distributed set of resources – a distributed transaction or saga of sorts."* Crystal-clear statement of the problem SAS solves and the assumption it makes (distributed resources, transient communication failures). Exarchos's framing — *"It is a concurrent system, not a distributed one"* — explicitly rejects this assumption. Strong negative reference.
**Grounds:** INV-15.

**[S28] Microsoft Azure Architecture Center — Saga design pattern**
URL: https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
*"A saga is a sequence of local transactions where each service updates its data and initiates the next step through events or messages. If a step fails, the saga performs compensating transactions to undo completed steps."* Two consequences directly grounded in distributed-systems pain: *"Compensating transactions might not always succeed, which can leave the system in an inconsistent state"* and *"Adopting the Saga pattern requires a different mindset."* Exarchos rejects saga because compensation is **local rewind** (replay over the event log), not **remote command dispatch** (saga choreography or orchestration).
**Grounds:** INV-15.

**[S29] Azure-Samples/saga-orchestration-serverless — alternatives-and-considerations.md**
URL: https://github.com/Azure-Samples/saga-orchestration-serverless/blob/main/docs/architecture/alternatives-and-considerations.md
Useful for the *positive* characterization of when saga *is* the right pattern (multi-service, distributed data stores, no central state authority). Helps D5 articulate the boundary: Exarchos can choose differently because it has the central state authority (the event store) saga assumes is absent.
**Grounds:** INV-15.

## 8. Citation coverage — final per-candidate audit

| Candidate | Citations | Threshold met? |
|---|---|---|
| INV-7 substrate-serialization | S13 (ARIES, 4 URLs), S14 (Bernstein/Goodman, 3 URLs), S15 (Miller cross-cite) | ≥7 — PASS |
| INV-8 idempotency-at-the-boundary | S6 (Akka), S8 (Wolverine #1858), S9 (Wolverine retry) | 3 — PASS |
| INV-9 HSM-as-state-machine | S11 (Greg Young versioning ch.) — **still under-cited** | 1 — **FAIL** |
| INV-10 liveness-event-protocol | S2 (Conductor), S1 (AWP), S26 (Microsoft SAS — as substitutable concern) | 3 — PASS (thin) |
| INV-11 posture-declared-capabilities | S15/S16 (Miller), S17 (Paradigm Lost), S18–S20 (erights.org), S21 (anip-protocol) | ≥6 — PASS |
| INV-12 next-actions-as-affordance | S22 (Norman 1999), S23 (Norman jnd.org), S24 (HCI glossary), S25 (McGrenere/Ho 2000) | 4 — PASS |
| INV-13 process-manager-two-event-split | S6 (Akka), S7 (Wolverine AggregateHandler), S8 (Wolverine PR), S10/S11 (Greg Young) | ≥5 — PASS |
| INV-14 native-primitive-first-recovery | (no external citations) | 0 — **FAIL** |
| INV-15 single-machine-frame | S26, S27, S28, S29 (Microsoft SAS + saga, Vasters origin) | 4 — PASS |

**Two persistent failures to address in D5:**

- **INV-9 (HSM-as-state-machine):** needs Harel statecharts citation. Harel 1987 *"Statecharts: A Visual Formalism for Complex Systems"* is the canonical reference. Easy backfill in D5 §References.
- **INV-14 (native-primitive-first-recovery):** zero external grounding. Options: (a) backfill with ARIES Compensation Log Records (S13) as the abstract analog — the "use the operation's own recovery primitive before falling back to substrate-level undo" rule; (b) downgrade to an **operational pattern** documented in a skill body, not a catalog entry. D5 must rule on this.

## 9. Convergent-design observations

Three independent designs surfaced during gathering that converge on Exarchos-like primitives:

1. **`anip-protocol`** uses both *posture* and *handshake* in capability-token contexts. (S21)
2. **`agent-workflow-protocol`** separates runtime-agnostic protocol from pluggable runtime. (S1)
3. **`harnlang.com`** describes a "typed, inspectable, replayable orchestration boundary." (S4)

These independent convergences are themselves evidence that the candidate invariants describe load-bearing properties of agent runtimes generally, not Exarchos's idiosyncratic choices. The catalog's framing (D5) should cite these as **convergent independent design** rather than presenting Exarchos's invariants as original inventions.

## 10. References

All sources catalogued above. Survey deliverable per charter Phase A.
