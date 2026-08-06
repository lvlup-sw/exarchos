# Spec: Design Knowledge Graph — claims as the source of truth for design rationale

**Date:** 2026-08-05 · **Feature:** `design-knowledge-graph` · **Depth:** deep
**Inputs:**
- Problem framing: [`docs/research/2026-08-05-design-knowledge-graph-evaluation.md`](../research/2026-08-05-design-knowledge-graph-evaluation.md) (workflow `design-knowledge-graph-eval`)
- Substrate: [`docs/specs/2026-08-05-event-taxonomy-v2.md`](./2026-08-05-event-taxonomy-v2.md)
- [`docs/research/2026-08-05-structural-emission-enforcement.md`](../research/2026-08-05-structural-emission-enforcement.md)
- [`docs/audits/2026-08-04-wiring-audit.md`](../audits/2026-08-04-wiring-audit.md) — P01-02/03/05/06, P06-05/06
- [`docs/audits/structural-closure-delta-audit/unified-remediation-plan.md`](../audits/structural-closure-delta-audit/unified-remediation-plan.md)
- [`docs/adrs/system-index.md`](../adrs/system-index.md) — Agentic.Ontology primitives
- Review artifact: `.lavish/dkg-under-taxonomy-v2.html` (five rounds, sessions `d1de7038856b10d2`)
- Issues: #1125 · #1258 · #1468 · #1565 · #1685 · #1725

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` is authored
> by `/plan` into this same document.

## Constraints

Anchored to `.exarchos/invariants.md`:

- **INV-1** — the append-only log is the source of truth; projections are pure deterministic folds.
  The DKG corpus is a projection and holds **no authority**.
- **INV-2** — CLI and MCP remain presentation-only facades over one dispatch core.
- **INV-3** — capability resolution stays handshake-authoritative; no design assumes a local-only
  MCP transport.
- **INV-6** — substrate guarantees apply across workflow types.
- **INV-7** — appends serialize through the single-writer path.
- **INV-15** — no long-running daemon; reconcilers fire at boundaries the runtime already owns.
- **INV-17** — the response-economy contract bounds what any query may return.

Carried from the evaluation: **C1** closed loop (mandatory provenance) · **C3** deterministic
composition · **C4** non-destructive supersession · **C5** schema-enforced typed fields, never
free text · **C6** no LLM on the write path · **C7** single-file binary, no daemon, no network
listener · **C9** ~10⁴ nodes · **C10** survivability via plain-text export.

**Out of scope:** project management (issue *tracking* state remains workflow state); code-structure
graphs; general agent memory; LLM extraction pipelines; work-queue/claiming coordination — a
remote-level (basileus) concern, see
[`2026-08-05-remote-work-claiming.md`](./2026-08-05-remote-work-claiming.md).

## Design & Rationale

### Problem Statement

Exarchos produces design rationale continuously and persists it only as prose in markdown. Three
consequences compound: the **document is the smallest addressable unit**, so a decision cannot be
referenced or superseded independently of its file; rationale is **severed from the operations that
produced it**, so the log knows the system advanced but not what it believed; and **composition is
manual and lossy**, so the same decision is restated in four artifacts and diverges in three.

Measured cost: 115 DR-N records and 20 invariants are reachable only through a 47-line
hand-maintained routing table (`skills-src/ideate/references/constraint-anchoring.md`) that covers
the invariants and **none** of the DR-N records. The most expensive knowledge the project produces
— the alternatives it already rejected — is written once and never read again.

### Chosen Approach

Design rationale becomes a corpus of **typed claims**, asserted through the operations that produce
them, folded into a queryable local graph, and served to the model as composed **content** over MCP.

Three separations carry the design, each of which took a review round to get right:

**1. Assertion, corpus, and access are three problems.** Assertion is an event — because coupling,
provenance, multi-process concurrency and remote replication are already solved there. The corpus is
a materialized graph projection with its own access pattern (cross-feature traversal and retrieval),
which the event store cannot serve. Access is MCP, and it is the product. The claim is **no second
authority**, not no second store: INV-1 explicitly provides for projections, and `workflow_state`
already is one.

**2. Claims are authored, observed, or measured.** That trichotomy — not the eight-kind list —
determines reliability and who may produce a claim. Authored claims are gated (the content exists
nowhere else). Observed claims are reconciled from ground truth (a model restating an invariant is a
claim; a reconciler reading it is an observation). Measured claims are effect-coupled and **already
produced today** by the durable gate runner.

**3. Documents are queries, not files.** Nothing is rendered or committed. A spec is a composition
over claims at a revision. This deletes the render step, the rendered-document reconciler, and the
entire drift surface they would have created.

**On Dolt.** The evaluation proposed it because SQLite lacks versioned-table semantics. That is
true, and it points somewhere sharper: **Dolt's value is giving a mutable table an immutable
history, which is redundant when the source of truth is already an append-only log.** Asserting
claims as events removes the need for Dolt rather than conflicting with it. Dolt remains the correct
*specification vocabulary* — the evaluation's §5 mapping holds — and remains available for the
projection, because a rebuildable projection makes the substrate choice reversible by replay.

### The unification

ADRs, issues, invariants and specs are already the same thing, which is why the DKG absorbs rather
than accompanies them:

| Artifact today | Is really | Plus |
|---|---|---|
| **ADR** | a `decision` claim + its `option`s, `rejection`s, `consequence`s | a status → the supersession chain |
| **Issue** | a `problem` claim (often + `requirement` claims) | tracking state → **already event-sourced** |
| **Invariant** | a `constraint` claim, `lifecycle: binding` | enforcement metadata → claim properties |
| **Spec** | a composed view over one feature's claims | — |
| **DR-N** | a `requirement` claim with an ordinal | acceptance criteria → typed body fields |

All four are views over one corpus, differing only in which kinds they project, at what scope, and
with what lifecycle. The tracking half of an issue is not rationale — it is workflow state — which
is how the DKG absorbs an issue's rationale without becoming a project-management system.

**Consequence:** the *observed* tier is chiefly a **migration path**. Once ADRs and the invariant
catalog are claims, there is nothing left to observe from them. The permanent residue is claims
whose ground truth is **code and git, not documents**.

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | **Assertion is an event; the corpus is a projection** | Concurrency (EFF-001 multi-process fixture), provenance (C1 becomes tautological), and remote replication are solved at the appender. The corpus is derived and therefore swappable. |
| D2 | **The schema is authored in Strategos TypeSpec as a `DomainOntology`** | Cross-cutting contracts are authored there for the same reason the workflow IR and event envelope are. Exarchos consumes generated JSON Schema/Zod via #1125 and never the .NET assembly, so C7 holds. |
| D3 | **No files.** Composition returns content | A spec is a query. Deletes the render step, the document reconciler, and the drift surface. |
| D4 | **Reads are branch-scoped** | Concurrent workflows do not see each other's uncommitted code; they must not see each other's uncommitted rationale. Contradiction surfaces at merge, where conflicts already surface. |
| D5 | **Inert prerequisite machinery is wired, not worked around** | The evidence algebra, contradiction detection, atomic transition and explainable-decision paths are authored but inert. No shims and no parallel implementations. |
| D6 | **`evidence` is not a new claim kind** | `admission.evidence-recorded` is produced by the durable gate runner today. A second producer is the P02-03 defect verbatim. |

### Requirements (DR-N)

#### DR-1: Claim ontology authored in Strategos

**Acceptance criteria:**
- Claim object types (`Problem`, `Option`, `Decision`, `Rejection`, `Requirement`, `Consequence`,
  `Constraint`), the closed link vocabulary, and shared interfaces (`ISupersedable`, `IEvidenced`)
  are authored in TypeSpec as an Agentic.Ontology `DomainOntology`.
- `CrossDomainLink` binds claims to workflow IR types (`Decision → Workflow`, `Requirement → Task`,
  `Evidence → GateVerdict`). **This is C1 expressed in the type system rather than as a runtime rule.**
- `ComposedOntology` validation fails the build on a dangling cross-domain reference.
- Typed body fields carry forces, alternatives and costs — **C5**: a prose blob in a database is
  still prose.
- `BoundToTool` actions are declared for every read operation in DR-6.

#### DR-2: Consumption pipeline

**Acceptance criteria:**
- Generated JSON Schema → Zod lands in Exarchos on the #1125 pipeline; no hand-authored claim types.
- A schema change in Strategos propagates without hand-editing Exarchos types.
- Round-trip: generated Zod and the JSON Schema validate the same fixtures (the `contract/ir/`
  Ajv round-trip harness is the precedent).

#### DR-3: Claim event registration

**Acceptance criteria:**
- Two event types registered under taxonomy v2: `rationale.asserted` (T3 judgment, discriminated
  body, gate `design-rationale-complete`) and `observed.rationale` (T2 observation, naming its
  reconciler and ground-truth source).
- `admission.evidence-recorded` is **reused unchanged**; no second evidence producer (D6).
- Names obey the taxonomy-v2 grammar, so the subject/pairing census applies.
- Supersession adds no event type: a superseding claim carries a backward `supersedes` pointer and
  the projection folds forward (**C4**).
- Bodies exceeding a size threshold are stored in the content-addressed store by digest, keeping the
  event log small. `gate-runner.ts`'s `ContentAddressedStore` is the mechanism.

#### DR-4: Streams and scope

**Acceptance criteria:**
- Feature-scoped claims append to the feature stream; cross-cutting claims append to a singleton
  `rationale` stream (precedent: the singleton `worktrees` stream).
- Every claim carries `scope: { repo, featureId, branch }`.
- The singleton stream is the **ownership** boundary; `scope.branch` is the **visibility** boundary.
  An unmerged branch cannot impose a binding constraint on in-flight workflows.

#### DR-5: The corpus projection

**Acceptance criteria:**
- Registered through `ProjectionRegistry.register` like every other read model.
- Folds `rationale.asserted`, `observed.rationale`, and `admission.evidence-recorded`; derives
  `supersededBy`, reinforcement counts, and the edge table **from typed body references** — edges
  are never separately authored, so they cannot drift from the types.
- Materialized at `~/.exarchos/state/dkg.db`, behind a storage port, with FTS5 over `⌕`-marked
  fields only (identity fields stay exact-match so retrieval cannot blur `supersedes` or ordinals).
- **The corpus revision is the projection cursor.** Sequences are per-stream, so there is no global
  ordinal; the cursor supplies a monotonic `AS OF` key.
- Ranking uses weighted RRF; `binding > durable > reinforced > episodic` orders the lifecycle axis.

#### DR-6: MCP access surface

**Acceptance criteria:**
- Read operations serve **composed content**, never files: what constrains this change · what was
  already rejected and why · the current decision and what it superseded · provenance and evidence ·
  compose a spec at a revision.
- Every response is a **bounded, ranked evidence set, not an answer**, governed by INV-17 and the
  cost-of-load budget.
- A claim-diff operation returns the difference of two folds — the surface that replaces
  PR-reviewable design diffs (**it must ship before files stop being written**).
- `skills-src/ideate/references/constraint-anchoring.md` is **deleted**, not superseded.

#### DR-7: Assertion is welded to operations

**Acceptance criteria:**
- There is **no standalone rationale-recording action**. Claims are asserted at existing phase
  transitions, through an elicitation form (`elicitation.requested/fulfilled/declined` already
  registered and `auto`).
- The taxonomy-v2 ratchet rejects any attempt to register a report-coupled rationale action.
- At `workflow init`, the corpus is **read** — binding constraints and prior rejections for the
  surfaces touched — before any design exists.

#### DR-8: The completeness gate

**Acceptance criteria:**
- `design-rationale-complete` evaluates over the revision: a `decision` selects an existing
  `option`; every non-selected option carries a `rejection`; requirement ordinals are unique and
  dense; ≥1 requirement addresses a failure mode; `supersedes` targets an existing same-kind claim.
- **A denial names the missing claim and returns the form that produces it.** Unlike an
  emission-contract violation, the author *can* act here, so the Verifier Tax applies in full.
- Obligation strength scales with `designDepth` (the shipped Z1 resolver already carries the signal).
- Ships in shadow mode; enforcement is gated on the `P07-01` discipline.

#### DR-9: Observation reconcilers

**Acceptance criteria:**
- Reconcilers observe authoritative sources as claims: the invariant catalog, the ADR corpus,
  roadmap coordination rules, and the existing 115 DR-N records.
- Content-addressed, so re-running appends nothing; level-triggered at boundaries; **no daemon**.
- Reconcilers **fail closed** on an unparseable source entry rather than silently emitting fewer
  claims.
- Document-sourced reconcilers are **explicitly transitional** and retire with their source; the
  permanent set observes code and git.

#### DR-10: Concurrency and coherence

**Acceptance criteria:**
- Concurrent assertion is safe: per-stream mutex + `BEGIN IMMEDIATE` + idempotency claims; identical
  claims from two processes collapse by content address into one row with reinforcement 2.
- Projection advance is idempotent — advancing twice converges rather than corrupts.
- When the cursor lags the event tail, consumers receive a **typed degraded result**, not stale data
  (`projection.degraded` / `projection.recovered`, per P01-02).
- Reads are branch-scoped: claims asserted on branch B are invisible to a read scoped to branch A
  until merge.
- Read-your-own-writes: the asserting process observes its own claim on the next query; a cache miss
  falls through to the fold.

#### DR-11: Contradiction detection at merge

**Acceptance criteria:**
- The `select-evidence` supersession/contradiction fold is **wired** (it is inert today) and then
  widened from evidence subjects to rationale subjects.
- Two branches asserting opposed decisions over one surface produce a contradiction at merge
  preflight — the hazard the evaluation identified in §5.3.
- Contradictions are recorded as events, scoped by requirement/phase/subject.

#### DR-12: Composition determinism

**Acceptance criteria:**
- `ORDER BY (kind, ordinal, seq)` over a unique total order ⇒ the same claims at the same revision
  compose byte-identically (**C3**), proven by repeated invocation.
- `AS OF R` folds to cursor ≤ R and excludes claims superseded at or before R.
- Plain-text export exists for **C10** survivability.

#### DR-13: The corpus is provably derived

**Acceptance criteria:**
- Dropping `dkg.db` and replaying from event zero reproduces a byte-identical corpus.
- The storage port has **two adapters** (SQLite + in-memory) exercised in the suite, so a third
  backend — Dolt, or remote — is a configuration change rather than a redesign.
- No write path reaches the corpus except the projection fold.

#### DR-14: No write-only claim kinds

**Acceptance criteria:**
- The reachability `consumer` hop applies: a claim kind with no ontology action and no composition
  template fails closure.
- **This is the guard against scope creep into general agent memory** — a proposed kind must name
  its reader.

#### DR-15: Wire the prerequisite substrate

**Acceptance criteria:**
- P01-02 (projection degradation), P01-03 (evidence algebra), P01-06 (contradiction), P06-05
  (atomic transition), P06-06 (explainable decisions) are reachable from **production composition**,
  each with a seeded-failure test.
- Taxonomy-v2 Wave 0 bypasses are closed: bare booleans cannot satisfy evidence, `evidenceBypass` is
  removed, and the transition guard is the only path to a phase mutation.
- No shims and no parallel implementations (D5).

### Sequencing

| Phase | Scope | Depends on |
|---|---|---|
| **P-0** | DR-15 — wire the substrate; taxonomy-v2 Wave 0 | taxonomy-v2 Waves 0–2 |
| **P-1** | DR-1 — author the ontology in Strategos | — |
| **P-2** | DR-2, DR-3, DR-4 — consumption, event types, streams | P-1, #1125 |
| **P-3** | DR-5, DR-13 — corpus projection behind a port | P-2 |
| **P-4** | DR-6, DR-12 — MCP surface and composition | P-3 |
| **P-5** | DR-7, DR-8, DR-9, DR-10, DR-11, DR-14 — assertion, gate, reconcilers, coherence | P-0, P-4 |

**Hard dependency:** this design is expressed in taxonomy-v2 vocabulary (tier, coupling, reconciler,
the `consumer` hop). It cannot land before the registry is tiered and the grammar exists.

### Risks

| Risk | Mitigation |
|---|---|
| Cross-repo schema latency — a claim-kind change needs a Strategos release | Settle object types and links before P-3; adding a *property* is cheap, adding a *kind* is not |
| The Verifier Tax — gating without recovery (94% interception, <5% safe-success) | DR-8: the denial names the missing claim and returns its form; shadow mode first |
| No files ⇒ no PR-reviewable design diff | DR-6 claim-diff ships **before** files stop being written |
| Observation sources unevenly structured (13 of 20 invariants carry `mode:`) | DR-9 fails closed; #1468 is the durable fix |
| Corpus volume in the response budget | INV-17, lifecycle-ranked truncation, wRRF cutoff, #1685 count+LIMIT |
| Authoring cost concentrated in `/ideate` | Elicitation forms make structured authoring cheaper than prose; depth-scaling keeps low-stakes work light |
| Per-user state dir spans repositories (#1725) | Claims carry `scope.repo`; every read is repo-scoped by default — see the open question below |

### Open question

**Is the corpus per-user or per-repository?** `resolveStateDir()` defaults to `~/.exarchos/state`,
so one corpus would span every repo on the machine. Claims carry `scope.repo` either way. A
per-user corpus makes genuinely cross-repo rationale (org-wide invariants, shared architectural
decisions) expressible and matches where the event store already lives; a per-repo corpus is cleaner
to isolate and back up. **Recommendation: per-user store with repo-scoped reads by default**, with
cross-repo promotion as a later, explicit capability.

## Decomposition

> Authored by `/plan`. DR-1 … DR-15 above are the decomposition source.
