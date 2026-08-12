# Spec: Event Taxonomy v2 — tiered catalog + level-triggered emission substrate

**Date:** 2026-08-05 · **Feature:** `event-taxonomy-v2` · **Depth:** deep
**Inputs:**
- Discovery report: [`docs/research/2026-08-05-structural-emission-enforcement.md`](../research/2026-08-05-structural-emission-enforcement.md) (workflow `discover-structural-emission-enforcement`)
- Review artifact: `.lavish/event-taxonomy-v2.html` (three review rounds, session `a78091bb20840225`)
- [`docs/audits/2026-08-04-wiring-audit.md`](../audits/2026-08-04-wiring-audit.md) — P01-03, P02-03, P06-05
- [`docs/audits/structural-closure-delta-audit/unified-remediation-plan.md`](../audits/structural-closure-delta-audit/unified-remediation-plan.md) — PROGRAM-03/04/05/06/07
- [`docs/research/2026-05-24-auto-emission-audit.md`](../research/2026-05-24-auto-emission-audit.md) — the A/B/C classification
- [`docs/adrs/2026-05-24-hook-layer-observe-only.md`](../adrs/2026-05-24-hook-layer-observe-only.md)
- Issues: #1599 · #1601 · #1473 · #1258 · #1716 · #1727 · #1647 · #1708

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` is authored
> by `/plan` into this same document.

## Constraints

Anchored to `.exarchos/invariants.md`:

- **INV-1** — the append-only event log is the source of truth; projections are pure deterministic
  folds. **Level-triggering applies to *sensing*, never to state:** a reconciler observes ground
  truth and *appends events*; it never writes projected state directly.
- **INV-2** — CLI and MCP remain presentation-only facades over one dispatch core.
- **INV-6** — substrate guarantees apply across workflow types; workflow-specific behavior belongs
  in topology and playbooks. This is the invariant the current catalog violates.
- **INV-7** — appends are serialized through the single-writer path.
- **INV-9** — the HSM transition guard is the sole authority for phase sequencing.
- **INV-13** — intent/result event pairs, correlated by `operationId`.
- **INV-15** — no long-running daemon. Reconcilers fire at boundaries the runtime already owns.

Out of scope: harness hook wiring (capability-tiered accelerator, tracked separately); filesystem
write confinement (#1601 established this is not an Exarchos-owned chokepoint); the admission gate
on judgment events (R3 in the discovery report — a sibling spec).

## Design & Rationale

### Problem Statement

The event store drifts from on-disk reality, and reconciliation is a recurring manual cost. The
discovery report established that this is not an instruction-quality problem: measured per-step
process-instruction compliance for frontier models is near zero for steps that are not
instrumentally required, and Exarchos declares 4–7 model-emitted beats per phase across a six-phase
workflow, so a clean end-to-end log is the unlikely case by construction.

Three specific defects make it structural rather than incidental:

**1. The registry records authorship, not reliability.** `source: 'auto' | 'model'` says who
composes the payload. It does not say what the emission is welded to. All 169 types still require
*some* tool call — `review.routed` is `auto`, but exists only if the model calls `review triage`.
The `auto` bucket therefore mixes *effect-coupled* emissions (written in the same transaction as an
effect Exarchos performs, unforgettable) with *call-coupled* ones (the underlying fact moves whether
or not anyone calls). The 25 `model` types are *report-coupled*: a dedicated append that accomplishes
nothing else, and therefore the first thing dropped under context pressure.

**2. The catalog is workflow-overfitted.** It conflates substrate facts (`workflow.transition`),
capability facts (`gate.executed`), and procedure beats (`shepherd.iteration`, `stack.submitted` —
which encodes *Graphite*, not a capability). `PHASE_EXPECTED_EVENTS` is keyed by literal built-in
phase names including `overhaul-*` near-duplicates: a per-built-in-workflow table living in the
substrate, which INV-6 forbids and which #1258 makes untenable. #1716 is the symptom from outside —
a skill prescribes unregistered `discovery.*` types, every append fails, and *"agents learn to skip
the step."*

**3. Detection exists and is discarded.** `_eventHints.missing` is computed
(`check-event-emissions.ts:36-79`) and consumed only by the CLI pretty-printer
(`cli-format.ts:96-103`). `hsm-transition-guard.ts` has no predicate of the form "expected event
was never emitted." The system detects drift it will not act on.

Structural closure has already been *observing* the right discipline without naming it: the branch
adds 21 new event types and **not one is `model`**. The discipline is conventional; nothing enforces
it.

### Chosen Approach

Make **coupling** a first-class, type-enforced property, and add a **level-triggered observation
tier** so the log can learn facts nobody reported.

Every registered event declares a **tier** (why it may exist), which determines its **coupling**
(what produces it, hence how reliable it is), and obeys one **grammar** (so mechanical checks can
reason about it). Emission has exactly four producers: effect-coupled, observation-coupled,
judgment-coupled, and harness hooks as a transport into the first — never a separate authority.

The design deliberately introduces **no new enforcement instrument**. It reuses the existing census
shape and two-way-ratchet error vocabulary (`vcs-ownership.ts`, `adapter-ownership-seam.ts`,
`effect-port-seam.ts`, `layer-boundaries-seam.ts`), the P04-01 effect ledger's occurrence scanner,
the existing `idempotency_claims` table, and the shipped contract compiler. If it required a novel
guard, that would be evidence it was the wrong design.

**Prerequisite, outside this spec.** The 2026-08-04 wiring audit found `makeArtifactGuard` accepts
any non-null (`{"artifacts":{"plan":true}}` clears a phase gate), `task_complete`'s only path
through is an agent-supplied `evidenceBypass`, and three modules call `executeTransition` directly
— **INV-9 is violated today**. P01-03, P02-03, and P06-05 must close first; a correct taxonomy
feeding a bypassable guard changes nothing.

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | **Delete duplicate types in Wave 5, frozen for replay** | Follows the shipped `merge.rollback` `retired` precedent. Deletion removes the ability to *append*, never to *read*. Deprecating instead would leave the P02-03 duplicate-signal defect live another release. |
| D2 | **Per-resource-class ground-truth authority** | Git wins for refs/worktrees; the VCS API wins for PR state; the log wins for intent, decisions, and evidence. A single blanket rule mis-handles the case where both are "right". |
| D3 | **T4 declaration site is the Workflow Builder IR (#1258); `registerEventType` is the bridge** | The IR is the correct long-term home. To avoid blocking on the SDK, the same data is carried through the existing `registerEventType` seam (`schemas.ts:495-525`) until #1258 lands. This is **distinct from** the `registerCustomTool` family #1708 deletes at v3.0. |
| D4 | **`EmissionVerifier` hard-fails in CI/dev; telemetry in production** | A contract violation is an **Exarchos bug, not agent misbehavior** — the contract says the *handler* emits, so the agent has no action that would make it land. Blocking the agent punishes the party that cannot fix it. (The Verifier Tax evidence applies instead to the admission gate on judgment events, where the agent *can* act.) |
| D5 | **Full meta-model integration** | Tighten `AutoEmitSpecSchema.event` from `z.string()`, add tier/coupling, and extend `REACHABILITY_HOPS` with `event` + `consumer`. Partial integration leaves write-only events and duplicate producers invisible to the census that exists to catch exactly that. |

### Requirements (DR-N)

#### DR-1: Tiered, coupling-typed event registration

`EventRegistration` is a discriminated union in which report-coupling is **not a constructible
variant**. Each tier carries the fields that make its rationale checkable.

```ts
type EventRegistration =
  | { tier: 'substrate';      rationale: SubstrateRationale }
  | { tier: 'capability';     provider: EffectProviderId; consumedBy: ConsumerId[] }
  | { tier: 'observation';    reconciler: ReconcilerId; groundTruth: GroundTruthSource }
  | { tier: 'judgment';       gate: GateClass; contentSchema: z.ZodSchema }
  | { tier: 'workflow-local'; workflow: WorkflowDefinitionId };
```

**Acceptance criteria:**
- All 169 existing types are annotated with a tier; the union is exhaustive (`tsc` proves it).
- A registration attempting report-coupling does not compile — there is no variant to construct.
- A `capability` registration naming an unresolvable `EffectProviderId` fails at boot.
- A CI ratchet pins the report-coupled count at its current value and permits only decrease.
- `EventEmissionSource` is derived from tier, not independently authored; a seeded disagreement fails.

#### DR-2: Compile-time event-name grammar

```ts
type WellFormedEventName =
  | `${Subject}.${Seg}`
  | `${Subject}.${Seg}.${Outcome}`;   // Outcome = requested | executed | failed
```

**Acceptance criteria:**
- The catalog is declared `as const satisfies readonly WellFormedEventName[]`.
- Seeding `workflow.checkpoint_written` or `team.task.assigned` fails `tsc --noEmit`.
- The constraint lives in a **compiled source module**, not a test — `tsconfig.json` excludes
  `**/*.test.ts` (cf. `launcher/injection-seam.ts`, and #1684 for why this matters).
- `EVENT_NAME_PATTERN` (`schemas.ts:479`) is extended to require a registered `SubjectKind`, so the
  runtime `registerEventType` path enforces the same grammar.

#### DR-3: Grammar and tier census (two-way ratchet)

A pure function over the registry, in the established census shape.

**Acceptance criteria:**
- Emits `UNPAIRED_INTENT`, `UNPAIRED_RESULT`, `UNKNOWN_SUBJECT`, `ORPHAN_SUBJECT`, `TIER_LEAK`.
- Two-way: both a missing pair member **and** a `SubjectKind` with no reconciler/provider fail.
- Wired to an unfiltered CI path (per #1711's filtered-gate convention — a gate in a path-filtered
  job is skipped-as-passed on the PRs it exists to police).

#### DR-4: Effect ledger — emission as a precondition of the effect landing

**This extends a shipped module rather than introducing one.** `dispatch/core/effect-carrier.ts` already
implements the P04-01 typed effect carrier: `EffectPlan` carries `owner`, `idempotent`, and
`compensation`, and `runEffect(mode, plan, execute)` returns a three-arm `EffectOutcome` whose
dry-run arm is structurally incapable of performing the effect. What it does **not** carry is any
event coupling — the module references no event store, no append, and no event type. DR-4 closes
exactly that gap.

**Acceptance criteria:**
- `EffectPlan` gains a required `emits: EventType`, so an effect cannot be planned without naming
  the event that records it.
- `runEffect` requires an appender and returns `Committed<T>`; `T` is not reachable without the
  append having occurred. The dry-run arm is unchanged and still appends nothing.
- A handler that performs an effect without committing its event fails to compile (it holds an
  unusable carrier).
- Boot-time bijection: every `plan.emits` names a registered T1 event and every T1 event is named
  by exactly one **primary** owner. Owners declare `role: 'primary' | 'recovery'`.
- Seeding a second primary producer for one event fails boot with `UNOWNED_EVENT` /
  `STALE_PROVIDER` — the `adapter-ownership-seam.ts` vocabulary, not a new one.
- Idempotency key is `<eventType>:<operationId>`, reusing `idempotency_claims`; no new storage.
- `VcsMutationOwner` (`vcs/mutation-owner.ts`) is the first migrated consumer, since it already
  owns the merge/branch effects DR-13 re-couples.

#### DR-5: Reconciler interface and content-addressed observation

**Acceptance criteria:**
- `Reconciler<S>` exposes `observe(scope)` (I/O, no writes, no appends) and `diff(observed,
  projected)` (pure, no I/O).
- `observationKey = obs:<subject>:<subjectId>:<sha256(canonicalize(facts))>`.
- **Idempotency proof:** running a reconciler N times against an unchanged world appends exactly
  one event. A fixture asserts this for N ≥ 100.
- `effect-port-seam.ts` governs the reconciler layer: its declared port is exactly `process` +
  `network`, so a reconciler structurally cannot mutate.
- `layer-boundaries-seam.ts` forbids `reconcilers/ → workflow/`, so a reconciler cannot reach the
  transition guard.

#### DR-6: Boundary-triggered reconciliation (no daemon)

**Acceptance criteria:**
- Reconcilers fire at session start, phase transition, launcher spawn/teardown, and immediately
  before admission evaluation. **No timer, no daemon** (INV-15).
- A handle-snapshot assertion proves no process or timer outlives the triggering operation.
- Ship order: `worktree` and `branch` first (git is unambiguous), then `pr`.
- **Exit proof:** a manually-deleted worktree produces `divergence.detected` at the next boundary
  with no tool call from the agent.
- Per-reconciler staleness window and content-hash short-circuit bound the latency cost; the VCS
  reconciler is gated behind an explicit window.

#### DR-7: Divergence recording and authority precedence

**Acceptance criteria:**
- `divergence.detected` records subject, observed value, projected value, and the authority that
  resolves it (per D2).
- Authority precedence is declared per resource class as data, not branched in code.
- The reconciler **proposes**; a separate `reconcile.repair` action with its own effect provider
  disposes. Auto-repair is permitted only where ground truth is unambiguous; everything else
  surfaces in `next_actions`.
- Divergence and `projections/degraded-result.ts` surface through **one** consumer contract.

#### DR-8: EmissionVerifier

**Acceptance criteria:**
- A post-dispatch interceptor in the existing `dispatch/core/dispatch.ts` chain asserts every
  `condition: 'always'` contract landed for the operation.
- On violation it appends `emission.contract-violated` carrying action, missing set, `operationId`.
- **Fails the response in CI/dev; telemetry-only in production** (D4), selected by policy, not build flag.
- A seeded handler that skips its declared emission fails the CI suite.

#### DR-9: Derive `PHASE_EXPECTED_EVENTS`

**Acceptance criteria:**
- The table is **deleted as a hand-maintained artifact** and derived from the union of `autoEmits`
  across the phase's reachable actions plus the workflow definition's T4 declarations.
- No built-in phase name appears as a literal key in substrate code.
- `_eventHints.missing` is computed from the derived set; behavior is unchanged for existing phases
  (a golden fixture pins the current output).

#### DR-10: Contract meta-model tightening

**Acceptance criteria:**
- `AutoEmitSpecSchema.event` changes from `z.string()` (`meta-model.ts:93`) to a catalog-validated
  `EventTypeRef`; `tier` and `coupling` are added to `EvidencePolicy`.
- A stale `autoEmits` row naming an unregistered type fails compilation.
- Compilation remains byte-stable across repeated runs (`P03-03`).
- Lands as its own PR, separate from the taxonomy waves — `contract/` is under active change.

#### DR-11: Reachability `event` and `consumer` hops

**Acceptance criteria:**
- `REACHABILITY_HOPS` becomes `schema → route → handler → owner → event → consumer → output →
  artifact → fixture`.
- `HOP_AUTHORITIES.event = 'runtime'` (resolved against the P04-01 effect ledger) and
  `HOP_AUTHORITIES.consumer = 'runtime'` (projection + gate registries). Neither is `self`; the
  co-located prohibition test still passes.
- Each new hop has a `kill-fixtures.test.ts` entry: mutating the real upstream authority drops the
  census below 100%.
- Two `owner → event` predecessors for one event fails closure (this *is* the P02-03 defect).
- A T1 event whose `consumer` hop is `missing` fails closure (this *is* #1716's discipline).

#### DR-12: Oracle emission axis

**Acceptance criteria:**
- `oracle/oracle-seam.ts` observes that a declared `emits` **actually appended**, rather than
  reading the declaration back.
- A seeded handler declaring an emission it does not perform is caught **even when the generated
  files agree** — the `P03-09` requirement that absent observation must not become positive assurance.

#### DR-13: Catalog disposition

Removes the report-coupled class entirely: ~13 deleted as duplicates or derivable projections,
7 re-coupled to providers they already route through, 2 become observations, 5 remain
model-authored but gated.

**Acceptance criteria:**
- `worktree.created`, `worktree.baseline`, `test.result`, `typecheck.result` deleted; consumers read
  the existing INV-13 pair and `admission.evidence-recorded`.
- `merge.requested` becomes effect-coupled — an INV-13 **intent** must be at least as reliable as
  its result, or the pair cannot be correlated after a crash.
- `team.task.*` deleted; one task lifecycle owned by the dispatch/claim path.
- `team.spawned` / `team.disbanded` **remain `model`-emitted, annotated `blockedBy: '#1473'`** — the
  runbook executor does not exist (see Sequencing). They are the only permitted exemption; the
  ratchet pins the report-coupled count at exactly 2 at Wave 5 exit.
- `shepherd.iteration`, `stack.submitted` demoted to T4 (D3).
- Report-coupled count is **2 (both exempted and tracked)**, down from 25, and the DR-1 ratchet
  prevents any other type from joining them. It reaches **0** when #1473 lands.

#### DR-14: Replay and compatibility

**Acceptance criteria:**
- Deleted types move to a frozen `LEGACY_EVENT_TYPES` map that reducers still fold; a replay fixture
  over a pre-migration stream produces byte-identical projected state.
- Renames fold via directional upcast (`P03-02`); historical streams are never rewritten.
- An older installed binary appending a deleted type fails with a typed error, not a validation
  crash (`P05-04` install/cache freshness).

#### DR-15: Wave sequencing and anti-inertness

The wiring audit's dominant finding is **shipping a correct mechanism nothing calls** (13 inert,
36 not-leveraged of 48 packages).

**Acceptance criteria:**
- Every wave exit is a **seeded-failure test against production composition**, never "the module
  exists" or a unit test over a mock.
- Waves: (1) type the registry + DR-10 · (2) effect ledger + DR-11 · (3) reconcilers · (4) verifier
  + grammar census + DR-12 · (5) cutover, deletion, T4 demotion.
- Waves 1–4 have no external dependency and may proceed as soon as Wave 0 closes.
- Wave 5 is gated on the `P07-01` discipline: zero unexplained disagreements across ≥20 live
  workflows.
- A follow-up issue is filed against #1473 to flip the two exempted types and drive the
  report-coupled count from 2 to 0 once the runbook executor exists.

### Sequencing against the roadmap

Verified against the working tree (`feature/structural-closure-remediation`, treated as main).
**Every substrate this design consumes already ships**, which is why the work is v2.12-shaped: it
builds on the structural-closure substrate that exists, not on the v3.0 SDK that does not.

#### Substrate confirmed present

| Component | Path | Consumed by |
|---|---|---|
| Emission registry + name pattern | `event-store/schemas.ts` (`EVENT_EMISSION_REGISTRY`, `EVENT_NAME_PATTERN:479`, `registerEventType:495`) | DR-1, DR-2, DR-13 |
| Typed effect carrier (P04-01) | `dispatch/core/effect-carrier.ts` — `EffectPlan`, `runEffect`, dry-run arm | DR-4 |
| VCS mutation owner | `vcs/mutation-owner.ts` — `VcsMutationOwner` | DR-4, DR-13 |
| Contract compiler | `contract/compiler/{compile,meta-model,runtime-authority}.ts` | DR-10 |
| Reachability census | `contract/reachability/graph.ts` — `REACHABILITY_HOPS`, `HOP_AUTHORITIES` | DR-11 |
| Independent oracle | `contract/oracle/oracle-seam.ts` | DR-12 |
| Architecture censuses | `architecture/{effect-ledger,adapter-ownership-seam,effect-port-seam,layer-boundaries-seam}.ts` | DR-3, DR-4, DR-5 |
| Reconciliation precedent | `orchestrate/reconcile-state.ts`, WLM `adopt`, `worktrees@v1` fold | DR-5, DR-6, DR-7 |
| Dispatch interceptor chain | `dispatch/core/dispatch.ts` | DR-8 |
| Durable gate runner | `orchestrate/gate-runner.ts`, `gate-provider-registry.ts` | DR-13 |
| Atomic append + claims | `event-store/atomic-appender.ts`, `idempotency_claims` | DR-4, DR-5 |

#### Actionable now — 13 of 15 DRs, Waves 1–4 in full

DR-1, DR-2, DR-3, DR-4, DR-5, DR-6, DR-7, DR-8, DR-9, DR-10, DR-11, DR-12, DR-14. None has an
external dependency; each extends a module listed above.

#### Blocked on future feature work — exactly one item

**`team.spawned` / `team.disbanded` auto-emission (a single row of DR-13).** `runbooks/` contains
`definitions.ts` + `handler.ts`, which *serve steps to the model* — **there is no executor that runs
them**. #1473's premise therefore holds unchanged: auto-emitting these requires a runbook-executor
seam, which is #1258 (Z3 / v3.0) work.

**Disposition:** these two types stay `model`-emitted through Wave 5, annotated `tier: 'capability'`
with a documented `blockedBy: '#1473'` so the DR-1 ratchet counts them as known debt rather than
silently permitting them. They are the *only* types allowed to remain report-coupled at Wave 5 exit,
and the ratchet pins that count at exactly 2 so no other type can hide behind the exemption.

#### Bridged, not blocked

**T4 demotion of `shepherd.iteration` and `stack.submitted`** wants the Workflow Builder IR (#1258).
Per D3 it rides the existing `registerEventType` seam in the interim. That seam is **distinct from
the `registerCustomTool` family #1708 deletes at v3.0**, so the v3.0 cutover does not invalidate the
bridge.

#### Precedes everything — open defects, not future features

Wave 0 (P01-03, P02-03, P06-05) is fixable on this branch today. It is sequenced first because
INV-9 is violated until it closes, not because it awaits anything.

#### Explicitly out of this spec

The admission gate on judgment events (R3 in the discovery report) is a sibling spec. It is the
mechanism that reaches the five irreducible T3 events, and it is where the Verifier Tax evidence
applies — DR-8 deliberately does not attempt it.

### Risks

| Risk | Mitigation |
|---|---|
| Reconciler latency at every boundary | Content-hash short-circuit; per-reconciler TTL; VCS reconciler behind an explicit staleness window |
| `Pending<E>` ergonomics tax at every effect call site | A `performAndCommit()` helper covers the common case; the split form is required only where intent and result straddle a real-world operation |
| Provider bijection too strict for recovery paths | `role: 'primary' \| 'recovery'`; exactly one primary required |
| Ground-truth ambiguity where both sources are "right" | D2 per-resource-class authority declared as data |
| `contract/` churn collides with DR-10 | DR-10 lands as an isolated PR |
| #1473 never lands, stranding the two exempted types | They are annotated `blockedBy` and ratchet-pinned at 2, so the exemption cannot silently widen; a follow-up issue tracks the flip |
| The mechanism ships and nothing calls it | DR-15 — seeded-failure exits against production composition |

## Decomposition

> Authored by `/plan`. DR-1 … DR-15 above are the decomposition source.
