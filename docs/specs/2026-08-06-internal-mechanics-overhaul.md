# Spec: Internal mechanics overhaul — one authority per contract, bound mechanically, IR-shaped

**Date:** 2026-08-06 · **Feature:** `internal-mechanics-overhaul` · **Depth:** deep
**Method:** `proof-driven-development` (Design mode) — `~/.agents/skills/proof-driven-development`

**Inputs:**
- **Supersedes** [`docs/specs/2026-08-05-event-taxonomy-v2.md`](./2026-08-05-event-taxonomy-v2.md) — its DR-1…DR-15 are absorbed below with provenance noted per DR. *(That file is currently **untracked** in the working checkout; commit it before this spec lands so the supersession has a git ancestor — see Risk R-9.)*
- Discovery workflow `mcp-spec-2026-07-28-migration`:
  - [`docs/research/2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md`](../research/2026-08-06-mcp-spec-2026-07-28-migration-evaluation.md)
  - [`docs/research/2026-08-06-mcp-2026-07-28-architectural-composition.md`](../research/2026-08-06-mcp-2026-07-28-architectural-composition.md) — MC-1…MC-4
- Inherited from the superseded spec: discovery report `2026-08-05-structural-emission-enforcement.md`; `2026-08-04-wiring-audit.md` (P01-03, P02-03, P06-05); `structural-closure-delta-audit/unified-remediation-plan.md`; `2026-05-24-auto-emission-audit.md`; `2026-05-24-hook-layer-observe-only.md`
- Issues: #1599 · #1601 · #1473 · #1258 · #1716 · #1727 · #1647 · #1708 · #1692 · #1679

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` is authored by `/plan` into this same document.

---

## Constraints

Anchored to `.exarchos/invariants.md` (always-load tier, plus reference-only entries that bind here).

**Directly governing:** **INV-1** (append-only log is SoT; projections are pure folds — level-triggering applies to *sensing*, never to state) · **INV-2** (facade equivalence) · **INV-6** (substrate guarantees are workflow-agnostic — the invariant the current event catalog violates) · **INV-7** (single-writer appends) · **INV-8** (idempotency at the boundary) · **INV-12** (`next_actions` as affordance) · **INV-15** (no daemon) · **INV-5a** (input ergonomics).

**Reference-only but binding:** **INV-9** (violated today — Wave 0 precedes everything) · **INV-13** (intent/result pairs) · **INV-17** (names `outputSchema` totality as the precondition for equivalence-by-construction).

**Two always-load invariants carry text this program falsifies** — amended by DR-23, not silently outgrown:

- **INV-5b** *(output-contract)* asserts *"long-running ops use Tasks (SEP-1686) not NDJSON."* MCP `2026-07-28` moves Tasks out of core into an extension and deletes `tasks/result` and `tasks/list`. It further asserts the carrier is *"structuredContent with a registered outputSchema per action"* — true in presence, ~90% vacuous in substance (DR-4).
- **INV-11** *(posture-declared-capabilities)* asserts *"The MCP initialize handshake declares the runtime half… handshake-authoritative."* The revision **deletes the handshake**. The principle (unrepresentable-by-construction) survives and strengthens; the named mechanism does not.

**Out of scope:** harness hook wiring; filesystem write confinement (#1601 — not an Exarchos-owned chokepoint); the admission gate on judgment events (sibling spec); MCP Apps for `exarchos_view` (needs its own ADR against the no-GUI envelope); remote/HTTP MCP surface (v3.2 DKG).

---

## Design & Rationale

### Problem Statement

Exarchos declares more contracts than it binds. Across four independent boundaries, the same defect appears: **a declaration exists, is enforced, and cannot fail.**

1. **The event registry records authorship, not reliability.** `source: 'auto' | 'model'` says who composes the payload, not what the emission is welded to. All 169 types require *some* tool call. The 25 `model` types are report-coupled — a dedicated append accomplishing nothing else, therefore the first thing dropped under context pressure.
2. **`outputSchema` records presence, not substance.** The field is required at the interface boundary and `validateAction` fails the import without it — but **106 of 118 declarations are `EnvelopeSchema(z.unknown())`**. INV-17 names `outputSchema` totality as *the precondition that makes facade equivalence hold by construction*; a vacuous schema satisfies totality trivially, because it is total over all shapes including wrong ones. For nine actions in ten, INV-2's "schema-checked in addition to byte-checked" is byte-checked plus a tautology.
3. **The CLI's single-authority idiom exists and has decayed.** Flags derive from each action's Zod schema — and **1,565 lines of `adapters/cli.ts` carry 14 hand-written `.command(...)` registrations** across 8 top-level verbs. `merge_orchestrate` is declared twice: once as the only `posture: 'shared-mutating'` action, once by hand. `cli-vocab-guard` already walks the real composition root (`buildCli(ctx)`) — but its policy is a *banned-vocabulary set*, so a hand-written command with good vocabulary passes. The guard that looks like it would catch this is measuring a different property.
4. **Detection exists and is discarded.** `_eventHints.missing` is computed (`check-event-emissions.ts:36-79`) and consumed only by the CLI pretty-printer (`cli-format.ts:96-103`). `hsm-transition-guard.ts` has no predicate of the form "expected event was never emitted."

Two structural aggravators: the catalog is **workflow-overfitted** (`PHASE_EXPECTED_EVENTS` keyed by literal built-in phase names, which INV-6 forbids and #1258 makes untenable), and **INV-2's quantifier leaks** — it ranges over "the same DispatchContext **+ arguments**", and both halves carry divergence its adapter-focused audit cannot see (three optional capability adapters; a `task: { ttl }` key only the MCP facade can send).

This is not an instruction-quality problem. Per the superseded spec's discovery pass, measured per-step process-instruction compliance for frontier models is near zero for steps that are not instrumentally required. **Correctness currently depends on someone being careful.** PDD's objective is to make the class unwritable.

### Chosen Approach

**Every contract surface declares exactly one authority, every other representation is mechanically bound to it, and the declaration is shaped as the IR it will become.**

Three moves, in that order:

**1. Bind before building (Wave 1).** PDD's decision table is unambiguous: *"The single-authority pattern exists but later code bypasses it → add the guard that makes derivation mandatory **before** adding another instance of the pattern."* Wave 1 therefore ships **guards, not architecture** — a derivation guard, a non-vacuity ratchet, the coupling union, and an authority-topology census. Each has a **kill fixture already present in the codebase**, so no guard ships unproven.

**2. Assign each obligation to its cheapest sound proof rung.** Construction/generation > types > structural analysis > contract tests > production-path tests > human judgment. This is why the program is not organized around a single mechanism: the event coupling belongs at rung 2 (an unconstructible variant), the CLI surface at rung 1 (generated), the emission contract at rung 3 (census), and reconciliation at rung 5 (production-path). Picking one spine would force claims onto the wrong rung.

**3. Shape every declaration as the IR (#1258).** Per D3, the Workflow Builder IR is the declared long-term home and `registerEventType` is the bridge. This program generalizes that from events to the whole contract surface: **the registry is the IR's current storage, not a competing authority.** #1258 then relocates the declaration site without re-opening a single class this program closes.

**No new enforcement instrument.** Every guard extends a shipped mechanism — `cli-vocab-guard`'s `buildCli` walk, the census/ratchet vocabulary (`vcs-ownership.ts`, `adapter-ownership-seam.ts`, `effect-port-seam.ts`, `layer-boundaries-seam.ts`), the P04-01 effect ledger's occurrence scanner, `idempotency_claims`, the dispatch interceptor chain, the shipped contract compiler. If a guard required a novel instrument, that would be evidence it was the wrong design.

**Prerequisite (Wave 0, outside the DR space).** The 2026-08-04 wiring audit found `makeArtifactGuard` accepts any non-null, `task_complete`'s only path through is an agent-supplied `evidenceBypass`, and three modules call `executeTransition` directly — **INV-9 is violated today**. P01-03, P02-03, P06-05 close first. A correct contract feeding a bypassable guard changes nothing.

### Authority topology

PDD deliverable 2. Representation counts are measured, not estimated. **More than one authoritative representation is a finding regardless of whether the copies currently agree.**

| Boundary | Representations | Authoritative | Mechanically bound? | Finding |
|---|---:|---|---|---|
| **Action contract** | registry descriptor; 10 derived consumers (composites ×4, launcher verb, docs generator, description-budget, rehydration fingerprint, CLI, MCP) | registry | Yes for the 10 | **Holds.** The idiom is real — which is what makes the bypasses below findings rather than noise. |
| **CLI surface** | registry-derived tree; **14 hand-written `.command(...)`** | *contested* | **No** | **2 authorities.** `cli-vocab-guard` binds vocabulary, not derivation. `merge_orchestrate` declared twice. → **G1** |
| **Response shape** | `outputSchema` (118); `Envelope<T>` type; the runtime payload | `outputSchema` nominally | **No** — 106 vacuous | Authority exists but asserts nothing. → **G2** |
| **Event catalog** | `EVENT_EMISSION_REGISTRY`; `autoEmits` rows (`z.string()`); `PHASE_EXPECTED_EVENTS` (hand-maintained); skill prose (#1716) | registry nominally | **No** | 4 representations, none bound. → **G3, G5, DR-10, DR-16** |
| **Effect ↔ event** | `EffectPlan`; the append site | *none* | **No** | `effect-carrier.ts` references no event store. → **G4/DR-7** |
| **Capability/posture** | agent-spec YAML; `posture-mapping.ts`; MCP handshake; INV-11 text | handshake ("handshake-authoritative") | Partially | **Authority is being deleted** by the spec revision. → **DR-14, DR-23** |
| **Phase sequencing** | HSM topology; `PHASE_EXPECTED_EVENTS`; playbooks | HSM guard (INV-9) | **Bypassed today** | 3 direct `executeTransition` callers. → **Wave 0** |

### Guards

PDD deliverable 1, specified per §3a. Ranked by findings eliminated. **Every guard names a kill fixture that exists in the codebase today** — a guard with no current failing subject has not been shown to work.

#### G1 — CLI derivation guard *(new policy on an existing mechanism)*

| Field | Value |
|---|---|
| **Policy** | Every command name, alias, and long flag in the built Commander tree traces to a registry declaration. Policy is **data** — an allowlist file, not prose in a test body. |
| **Mechanism** | Extend `scripts/cli-vocab-guard.ts`, which already walks the rendered surface from `buildCli(ctx)` — the real composition root. Add a derivation predicate beside the existing banned-vocabulary predicate. |
| **Kill fixture** | `merge-orchestrate` — declared as both a registered action and a hand-written command. The guard must reject the hand-written definition. |
| **Self-test** | Seed a hand-written `.command('nonce')` with clean vocabulary; the guard must fail. Proves guard-execution failure cannot pass as success. |
| **Protected path** | CI, **unfiltered** — per #1711, a gate in a path-filtered job is skipped-as-passed on exactly the PRs it exists to police. |
| **Exceptions** | The 8 current top-level verbs enter an allowlist, each with an owner and a wave-scoped expiry. The allowlist may only shrink (DR-5). |

#### G2 — `outputSchema` non-vacuity ratchet *(new policy on an existing mechanism)*

| Field | Value |
|---|---|
| **Policy** | `EnvelopeSchema(z.unknown())` is a **finding**, not a pass. Count may only decrease; new actions may not construct it. |
| **Mechanism** | Registry-enumeration snapshot + two-way ratchet, reusing the type-debt ratchet idiom already in CI. |
| **Kill fixture** | The 106 current vacuous declarations — the ratchet's initial value, and its proof of a live subject. |
| **Self-test** | Add a new action declaring `EnvelopeSchema(z.unknown())`; CI must fail. |
| **Protected path** | CI, unfiltered. |
| **Exceptions** | Allowlist keyed by action id, owner, expiry. Entries expire per wave; expiry is enforced, not advisory. |

#### G3 — Event coupling union *(absorbed: superseded DR-1)*

Report-coupling is **not a constructible variant**, so the class is unwritable at rung 2 rather than detected at rung 4. **Kill fixture:** the 25 currently report-coupled types. **Self-test:** a seeded disagreement between tier and derived `EventEmissionSource` fails. **Exceptions:** `team.spawned` / `team.disbanded`, `blockedBy: '#1473'`, ratchet pinned at exactly 2.

#### G4 — Effect ledger bijection *(absorbed: superseded DR-4)*

An effect cannot be planned without naming the event that records it; `T` is unreachable without the append. **Kill fixture:** `VcsMutationOwner`'s current merge/branch effects, which perform effects with no event coupling. **Self-test:** seed a second primary producer → boot fails with `UNOWNED_EVENT`/`STALE_PROVIDER` (existing vocabulary, not new).

#### G5 — Authority-topology census *(new — generalizes superseded DR-3/DR-11)*

| Field | Value |
|---|---|
| **Policy** | Every declared boundary names exactly one authority; every other representation names what binds it. Unbound representation, or >1 authority, fails closure. |
| **Mechanism** | Extend `contract/reachability/graph.ts`: `REACHABILITY_HOPS` gains `event` + `consumer`; `HOP_AUTHORITIES` for both is `'runtime'`, never `'self'` (the co-located prohibition test must still pass). |
| **Kill fixture** | The CLI-surface row above (2 authorities) and the event-catalog row (4 unbound representations). Both fail on day one. |
| **Self-test** | `kill-fixtures.test.ts` entry per new hop: mutating the real upstream authority drops the census below 100%. |
| **Protected path** | CI, unfiltered. |
| **Exceptions** | None. A boundary that cannot name one authority is a design finding, not an allowlist candidate. |

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Absorb the taxonomy spec rather than layer on it** | Both inputs are one defect class. Two programs would define G1–G5 twice and maintain two ratchet sets. The taxonomy spec is unfiled, so nothing is stranded. |
| **D2** | **Registry is the IR's current storage, not a competing authority** | Per D3 of the superseded spec, the IR is the destination. Every declaration this program adds is IR-shaped, so #1258 **relocates** the declaration site rather than re-binding every representation. Binding is written against the *seam* (`registerEventType`, the registry descriptor), never the storage shape. |
| **D3** | **Wave 1 ships guards, not architecture** | PDD: add the guard that makes derivation mandatory *before* another instance of the pattern. Another correct instance without enforcement decays exactly as the first did. |
| **D4** | **Each obligation lands on its cheapest sound rung; no single spine** | Coupling → rung 2; CLI surface → rung 1; emission contract → rung 3; reconciliation → rung 5. A single-mechanism design forces claims onto the wrong rung (see Alternatives B and C). |
| **D5** | **Adopt MRTR before the era cutover** | The SDK's legacy shim runs an `inputRequired()` handler unchanged on 2025-era connections, so the refactor is not gated on the wire switch — and it converts elicitation from a context capability into a result shape, closing an INV-2 divergence early. |
| **D6** | **Mint the MRTR resumption handle in the core, from the event store** | The spec's `requestState` exists because stateless HTTP servers have nowhere to put resumption state. Exarchos owns a database. Core mints the handle; the MCP facade wraps it in the SDK's signed codec; the CLI passes it as an ordinary argument. One core contract, two renderings — and no reserved-flag concept needed in the generator. |
| **D7** | **Delete duplicate event types in Wave 5, frozen for replay** | Inherited. Follows the shipped `merge.rollback` `retired` precedent. Deletion removes the ability to *append*, never to *read*. |
| **D8** | **`EmissionVerifier` hard-fails in CI/dev; telemetry in production** | Inherited. A contract violation is an **Exarchos bug, not agent misbehavior** — the contract says the *handler* emits, so the agent has no action that would make it land. |
| **D9** | **Amend INV-5b and INV-11 rather than outgrow them** | Their text names mechanisms the spec revision deletes. An invariant whose text is false is worse than none — it is an authority asserting something untrue. Authored through `/exarchos:invariants` (DR-23). |

---

### Requirements (DR-N)

Provenance is marked per DR: **[T-n]** = absorbed from superseded taxonomy DR-n; **[MC-n]** = from the MCP composition report; **[new]** = introduced here.

#### Wave 1 — Authority: bind before building

##### DR-1: IR-shaped declaration envelope **[new — D2]**

Every declaration this program introduces (event tier, action contract, CLI verb) is defined as an IR-shaped record carried through the existing seam, so #1258 relocates the declaration site rather than re-binding representations.

**Acceptance criteria:**
- A single `Declaration<K>` envelope type carries `kind`, `id`, `authority`, and `boundTo[]`; event/action/CLI-verb declarations are instances, not parallel shapes.
- Declarations are consumed **only** through the seam accessor; a direct read of registry storage from a consumer fails `layer-boundaries-seam.ts`.
- **Relocation proof:** a fixture moves one declaration's storage from the registry to an in-memory stand-in IR and asserts every guard (G1–G5) still passes unchanged, with no consumer edit. This is the load-bearing proof of D2 — without it, "IR-shaped" is a claim, not a property.
- The envelope is additive: existing registrations compile untouched.

##### DR-2: Tiered, coupling-typed event registration **[T-1]**

`EventRegistration` is a discriminated union in which report-coupling is **not a constructible variant**.

```ts
type EventRegistration =
  | { tier: 'substrate';      rationale: SubstrateRationale }
  | { tier: 'capability';     provider: EffectProviderId; consumedBy: ConsumerId[] }
  | { tier: 'observation';    reconciler: ReconcilerId; groundTruth: GroundTruthSource }
  | { tier: 'judgment';       gate: GateClass; contentSchema: z.ZodSchema }
  | { tier: 'workflow-local'; workflow: WorkflowDefinitionId };
```

**Acceptance criteria:**
- All 169 existing types carry a tier; the union is exhaustive (`tsc` proves it).
- A registration attempting report-coupling does not compile — there is no variant to construct.
- A `capability` registration naming an unresolvable `EffectProviderId` fails at boot.
- **G3** ratchet pins the report-coupled count at its current value, permitting only decrease.
- `EventEmissionSource` is *derived* from tier, not independently authored; a seeded disagreement fails.

##### DR-3: Compile-time event-name grammar **[T-2]**

**Acceptance criteria:**
- A `WellFormedEventName` template-literal type rejects malformed names at compile time.
- The grammar census is a two-way ratchet reusing the existing error vocabulary.
- Wired to an **unfiltered** CI path (#1711 — a gate in a path-filtered job is skipped-as-passed on the PRs it polices).

##### DR-4: `outputSchema` non-vacuity **[MC-3 — new]**

**Acceptance criteria:**
- **G2** ships with the ratchet seeded at the measured 106; the count may only decrease.
- A new action declaring `EnvelopeSchema(z.unknown())` fails CI (G2 self-test).
- INV-17's audit treats a vacuous declaration as a **violation of the precondition it names**, not a pass.
- The 12 currently-typed declarations (10 `withCappedShape`, 2 HSM) are the migration template; the DR-10 worktree surface is the reference implementation.
- **Ordering proof:** a fixture asserts DR-8's fourth envelope state **cannot** be declared satisfied for an action whose `outputSchema` is vacuous — the vacuity ratchet and the envelope obligation are wired to the same census, so the 106 cannot silently absorb the new state.

##### DR-5: CLI derivation guard **[MC-1 — new]**

**Acceptance criteria:**
- **G1** ships, extending `cli-vocab-guard`'s `buildCli(ctx)` walk with a derivation predicate.
- `merge-orchestrate`'s hand-written definition is rejected (kill fixture); its registry declaration is the survivor, preserving `posture: 'shared-mutating'` on the single remaining definition.
- The 8 top-level verbs enter an allowlist with per-entry owner and wave-scoped expiry; **the allowlist may only shrink**, enforced by ratchet.
- A seeded hand-written command with clean vocabulary fails the guard (self-test) — proving the guard measures derivation, not vocabulary.

##### DR-6: Authority-topology census **[new — generalizes T-3/T-11]**

**Acceptance criteria:**
- **G5** ships; the census enumerates every boundary in the Authority-topology table and asserts one authority + bound representations.
- The CLI-surface and event-catalog rows **fail on introduction** — the census is proven live against real subjects before any remediation lands.
- Two `owner → event` predecessors for one event fails closure (*this is the P02-03 defect*).
- A T1 event whose `consumer` hop is `missing` fails closure (*this is #1716's discipline*).

#### Wave 2 — Effect and envelope

##### DR-7: Effect ledger — emission as a precondition of the effect landing **[T-4]**

Extends the shipped `core/effect-carrier.ts` (P04-01), which carries `owner`/`idempotent`/`compensation` but **no event coupling**.

**Acceptance criteria:**
- `EffectPlan` gains a required `emits: EventType`; an effect cannot be planned without naming the event that records it.
- `runEffect` requires an appender and returns `Committed<T>`; `T` is unreachable without the append. The dry-run arm is unchanged and still appends nothing.
- A handler performing an effect without committing its event **fails to compile** (it holds an unusable carrier).
- Boot-time bijection: every `plan.emits` names a registered T1 event; every T1 event has exactly one **primary** owner (`role: 'primary' | 'recovery'`).
- Idempotency key is `<eventType>:<operationId>`, reusing `idempotency_claims` — no new storage (INV-8).
- `VcsMutationOwner` is the first migrated consumer (G4 kill fixture).

##### DR-8: The fourth envelope state **[MC-2/MC-3 — new]**

MRTR's `input_required` is neither success nor failure. Overloading `success: false` routes it through the DR-7 `errorCode` → exit-code table and surfaces as `INVALID_INPUT: 1` — a false statement about a resumable call.

**Acceptance criteria:**
- `Envelope<T>` gains a third discriminated state, designed once, at the envelope level.
- `CLI_EXIT_CODES` gains a distinct code, **derived from the envelope discriminator**, not switched on in the adapter. A CLI-side special-case fails INV-2's audit.
- The state lands in all 12 typed `outputSchema` declarations; DR-4's ordering proof prevents the 106 vacuous ones from silently absorbing it.
- `input_required` reconciles with `next_actions` semantics (INV-12) rather than sitting beside them — one affordance contract, not two.
- **Error-path criterion:** a malformed or expired resumption attempt returns a typed envelope, never a validation crash; an `input_required` that can never be satisfied (no capability, no operator) degrades to a typed terminal error rather than an infinite retry.

##### DR-9: Core-minted resumption handle **[MC-2 — new, D6]**

**Acceptance criteria:**
- Dispatch mints the handle from the event store (pending-input event / stream position) and returns it in the `input_required` envelope.
- The MCP facade wraps it in the SDK's `createRequestStateCodec` (HMAC-SHA256, **signed not encrypted** — the client can decode it). Nothing confidential rides inside; the payload binds principal, originating method, and expiry.
- The CLI passes the same handle as an ordinary argument — emittable by the existing flag generator, so **no reserved-flag concept is required**.
- **Facade-parity proof:** one production-path fixture drives the same flow through both facades and asserts byte-identical envelopes. Note the SDK constraint: `InMemoryTransport.createLinkedPair()` is 2025-era only, so 2026-era coverage spawns `serveStdio` as a child process.
- **Error-path criterion:** a handle failing verification is rejected above the tool funnel with a typed `-32602`, and replay of a consumed handle is idempotent per INV-8 rather than double-appending.
- Flows with no `featureId` (cold `describe`, onboarding) are explicitly scoped: they use an opaque token, and the census records that exception.

##### DR-10: Contract meta-model tightening **[T-10]**

**Acceptance criteria:**
- `AutoEmitSpecSchema.event` changes from `z.string()` (`meta-model.ts:93`) to a catalog-validated `EventTypeRef`; `tier` and `coupling` are added to `EvidencePolicy`.
- A stale `autoEmits` row naming an unregistered type fails compilation.
- Compilation remains byte-stable across repeated runs (P03-03).
- **Lands as its own PR**, separate from the waves — `contract/` is under active change.

#### Wave 3 — Observation

##### DR-11: Reconciler interface and content-addressed observation **[T-5]**

**Acceptance criteria:**
- `Reconciler<S>` exposes `observe(scope)` (I/O, no writes, no appends) and `diff(observed, projected)` (pure, no I/O).
- `observationKey = obs:<subject>:<subjectId>:<sha256(canonicalize(facts))>`.
- **Idempotency proof:** N runs against an unchanged world append exactly one event; fixture asserts N ≥ 100.
- `effect-port-seam.ts` governs the layer — declared port is exactly `process` + `network`, so a reconciler structurally cannot mutate (INV-1: sensing, never state).
- `layer-boundaries-seam.ts` forbids `reconcilers/ → workflow/`.

##### DR-12: Boundary-triggered reconciliation **[T-6]**

**Acceptance criteria:**
- Reconcilers fire at session start, phase transition, launcher spawn/teardown, and immediately before admission evaluation. **No timer, no daemon** (INV-15).
- A handle-snapshot assertion proves no process or timer outlives the triggering operation.
- Ship order: `worktree`, `branch` (git is unambiguous), then `pr`.
- **Exit proof:** a manually-deleted worktree produces `divergence.detected` at the next boundary **with no tool call from the agent**.
- Per-reconciler staleness window + content-hash short-circuit bound latency; the VCS reconciler sits behind an explicit window.

##### DR-13: Divergence recording and authority precedence **[T-7]**

**Acceptance criteria:**
- `divergence.detected` records subject, observed, projected, and the resolving authority.
- Authority precedence is declared **per resource class as data**, not branched in code (git wins for refs/worktrees; VCS API for PR state; the log for intent/decisions/evidence).
- The reconciler **proposes**; a separate `reconcile.repair` action with its own effect provider disposes. Auto-repair only where ground truth is unambiguous; everything else surfaces in `next_actions` (INV-12).
- Divergence and `projections/degraded-result.ts` surface through **one** consumer contract.

##### DR-14: Per-request capability resolution **[MC-2 — new]**

`CapabilityResolver` is snapshotted once per handshake and backs the POLA gates. The revision deletes the handshake; capabilities arrive per request in `ctx.mcpReq.envelope`. The CLI already builds a fresh resolver per process — this adopts the CLI's lifetime on the MCP side.

**Acceptance criteria:**
- The resolver is request-scoped; one seam serves both eras (handshake-authoritative on 2025, envelope-authoritative on 2026).
- `enforceReadonlyGate`, `enforceSharedMutatingGate`, and `mintCapabilitiesForKind` are unchanged in *semantics*; only the capability source moves. A dedicated **security review** gates this DR — it is a trust-boundary change.
- The cross-handshake cache-bleed workaround (CodeRabbit MAJOR #1423, cleared inside `snapshot()`) is **deleted**, and a fixture proves the bug class is unreachable rather than patched.
- **Error-path criterion:** a request whose envelope declares no capabilities resolves to the *narrowest* posture, never the widest — absent declaration fails closed.

#### Wave 4 — Verification

##### DR-15: EmissionVerifier **[T-8]**

**Acceptance criteria:**
- A post-dispatch interceptor in the existing `core/dispatch.ts` chain asserts every `condition: 'always'` contract landed for the operation.
- On violation it appends `emission.contract-violated` carrying action, missing set, `operationId`.
- **Fails the response in CI/dev; telemetry-only in production** (D8), selected by **policy, not build flag**.
- A seeded handler that skips its declared emission fails the CI suite.
- **Indeterminate is distinct from pass:** a verifier that cannot evaluate (store unavailable, operation unresolvable) reports `indeterminate` and does **not** promote — per PDD, protected actions must not promote on fail *or* indeterminate.

##### DR-16: Derive `PHASE_EXPECTED_EVENTS` **[T-9]**

**Acceptance criteria:**
- The table is **deleted as a hand-maintained artifact**, derived from the union of `autoEmits` across the phase's reachable actions plus T4 declarations.
- **No built-in phase name appears as a literal key in substrate code** (INV-6).
- `_eventHints.missing` is computed from the derived set; a golden fixture pins current output so behavior is unchanged for existing phases.

##### DR-17: Reachability `event` and `consumer` hops **[T-11]**

**Acceptance criteria:**
- `REACHABILITY_HOPS` becomes `schema → route → handler → owner → event → consumer → output → artifact → fixture`.
- `HOP_AUTHORITIES.event = 'runtime'` (resolved against the effect ledger); `HOP_AUTHORITIES.consumer = 'runtime'` (projection + gate registries). Neither is `self`; the co-located prohibition test still passes.
- Each new hop has a `kill-fixtures.test.ts` entry.

##### DR-18: Oracle emission axis **[T-12]**

**Acceptance criteria:**
- `oracle/oracle-seam.ts` observes that a declared `emits` **actually appended**, rather than reading the declaration back.
- A seeded handler declaring an emission it does not perform is caught **even when the generated files agree** (P03-09: absent observation must not become positive assurance).

##### DR-19: Full CLI generation **[MC-1 — new]**

**Acceptance criteria:**
- Top-level operational verbs gain a registry descriptor; the 14 hand-written `.command(...)` registrations are retired, and G1's allowlist reaches **zero**.
- A `skills:guard`-style drift gate re-derives the CLI tree and fails CI on any difference.
- Presentation rules (DR-7 exit-code table, `input_required` rendering) derive from the envelope discriminator.
- **Vacuity becomes visible:** generating a typed renderer from a vacuous `outputSchema` is impossible, so DR-4's remaining ratchet entries surface as build-time holes rather than weak assertions.

#### Wave 5 — Cutover

##### DR-20: Catalog disposition **[T-13]**

**Acceptance criteria:**
- `worktree.created`, `worktree.baseline`, `test.result`, `typecheck.result` deleted; consumers read the INV-13 pair and `admission.evidence-recorded`.
- `merge.requested` becomes effect-coupled — an INV-13 **intent** must be at least as reliable as its result, or the pair cannot be correlated after a crash.
- `team.task.*` deleted; one task lifecycle owned by the dispatch/claim path.
- `team.spawned` / `team.disbanded` remain `model`-emitted, annotated `blockedBy: '#1473'` — the only permitted exemption; ratchet pins the count at exactly **2** at Wave 5 exit, reaching **0** when #1473 lands.
- `shepherd.iteration`, `stack.submitted` demoted to T4.

##### DR-21: Replay and compatibility **[T-14]**

**Acceptance criteria:**
- Deleted types move to a frozen `LEGACY_EVENT_TYPES` map that reducers still fold; a replay fixture over a pre-migration stream produces **byte-identical** projected state.
- Renames fold via directional upcast (P03-02); historical streams are never rewritten.
- An older installed binary appending a deleted type fails with a **typed error, not a validation crash** (P05-04).

##### DR-22: MCP era cutover and Tasks re-platform **[MC-4 — new]**

**Acceptance criteria:**
- `serveStdio(() => buildServer())` replaces `server.connect(new StdioServerTransport())`; **dual-era retained** (no `legacy: 'reject'`).
- The Tasks surface is re-platformed per the Wave-0 audit of its 14 files: `tasks/get` survives as the polling primitive, `tasks/result`/`tasks/list` are retired, `tasks/update` is added, and task creation becomes **server-directed from `longRunning` registry metadata** — retiring the `task: { ttl }` key only the MCP facade could send.
- `tasksGet`'s `task.polled` write is **removed**; it is re-based on the pure-fold discipline `VIEW_FOLLOW_ACTIONS` already proves (`cli.ts:239`).
- `hidden: true` is resolved — expose-and-annotate, or move off the tool registry. A CLI-reachable tool absent from the MCP contract contradicts the #1608 reframe.
- The local `patch-package` patch is removed if SEP-2106 covers both its fixes (2020-12 target **and** the DU-root `type: 'object'` splice); `tools-list-2020-12.test.ts` is retained as a conformance test.
- **Error-path criterion:** an era-mismatched method is rejected with the SDK's typed error before reaching the transport, never a silent no-op.

##### DR-23: Invariant amendments **[new — D9]**

**Acceptance criteria:**
- **INV-5b** amended: the Tasks clause reflects the extension lifecycle; the `outputSchema` clause states the **non-vacuity** requirement G2 enforces.
- **INV-11** amended: capability declaration is per-request-envelope-authoritative on 2026-era connections, handshake-authoritative on 2025-era; the unrepresentable-by-construction principle is unchanged.
- **INV-2** amended to quantify over the *facade*, closing the context-and-arguments loophole: capability adapters on `DispatchContext` and facade-exclusive arguments that gate behaviour are violations, not exemptions.
- **INV-17** corrected: `withCappedShape` covers baseline ∪ capped; `degraded` is a `_meta` marker (`economyDegraded`) admitted by envelope structure — the "triple" is a pair plus a flag.
- All amendments authored through `/exarchos:invariants`; **no hand-edited catalog YAML**.

##### DR-24: Wave sequencing and anti-inertness **[T-15]**

The wiring audit's dominant finding is **shipping a correct mechanism nothing calls** (13 inert, 36 not-leveraged of 48 packages).

**Acceptance criteria:**
- Every wave exit is a **seeded-failure test against production composition** — never "the module exists", never a unit test over a mock.
- Waves 1–4 have no external dependency and may proceed as soon as Wave 0 closes.
- Wave 5 is gated on P07-01: zero unexplained disagreements across ≥20 live workflows.
- A follow-up issue is filed against #1473 to drive the report-coupled count from 2 to 0.
- **Each guard's self-test runs in the same CI job as the guard**, so guard-execution failure cannot pass as success.

---

### Obligation map

PDD deliverable 3. `Failure signal` distinguishes fail from indeterminate; "nothing" is a reportable answer.

| Property | Scope | Consequence if false | Primary proof (rung) | Proof artifact | Failure signal | Rollback |
|---|---|---|---|---|---|---|
| Every event's reliability is declared, not assumed | event catalog | Log drifts; agents learn to skip steps | 2 — types | G3 union + ratchet | `tsc` fail; ratchet delta | Revert union; types are additive |
| No report-coupled emission can be registered | event catalog | The 25-type class regrows | 2 — types | Unconstructible variant | Compile error | Allowlist (2 exempted, pinned) |
| Every effect's event lands with it | effect ledger | Post-crash state unreconstructable | 2 — types | `Committed<T>` carrier | Compile error; boot bijection | `role: 'recovery'` escape; revert carrier |
| Every action's response shape is substantive | response contract | INV-17's precondition is a tautology | 3 — structural | G2 ratchet | Ratchet delta | Allowlist w/ expiry |
| Every CLI verb derives from the registry | CLI surface | Verbs outside the parity harness | 1 — generation | G1 + DR-19 drift gate | Guard non-zero exit | Allowlist w/ expiry; guard is additive |
| One authority per boundary | all | Silent divergence between agreeing copies | 3 — structural | G5 census | Closure < 100% | Census is observe-only until Wave 4 |
| A declared emission actually appended | dispatch | Detection exists and is discarded | 5 — production path | DR-15 verifier + DR-18 oracle | `emission.contract-violated`; **indeterminate ≠ pass** | Policy switch to telemetry-only |
| Projected state matches ground truth | reconcilers | Manual reconciliation cost recurs | 5 — production path | DR-12 exit proof | `divergence.detected` | Per-reconciler disable; observe-only mode |
| `input_required` is not success or failure | envelope | Exit code lies about a resumable call | 2 — types | DR-8 discriminated state | Type error; parity fixture | Additive state; removable pre-wire-exposure |
| Resumption is auditable | dispatch | Un-auditable resumption in an event-sourced system | 1 — construction | DR-9 core-minted handle | Typed rejection; INV-8 claim | Fall back to opaque token |
| Capability resolution fails closed | POLA gates | Trust boundary widens silently | 2 — types | DR-14 narrowest-posture default | Typed denial | Dual-era seam retains handshake path |
| Deleted event types still replay | event store | Historical streams unreadable | 4 — contract test | DR-21 byte-identical fixture | Fixture diff | `LEGACY_EVENT_TYPES` is frozen, not removed |
| Invariant text is true | catalog | An authority asserting something false | 6 — human judgment | DR-23 via `/exarchos:invariants` | **Nothing** — reportable gap | Catalog is versioned; revert |

### Compatibility classification

PDD deliverable 5. Reverse-dependency closure per changed shared contract.

| Contract | Change | Class | Reverse closure | Rollback |
|---|---|---|---|---|
| `Envelope<T>` | +1 discriminated state | **Breaking** for exhaustive consumers | 118 actions, both facades, parity harness, DR-7 exit table | Additive until wire-exposed; irreversible once clients branch on it |
| `EventRegistration` | union replaces flat record | **Breaking** at registration sites | 169 registrations | Types only; revert is mechanical |
| `EffectPlan` | `emits` becomes required | **Breaking** at all effect call sites | every `runEffect` caller | `performAndCommit()` helper absorbs the common case |
| `ToolAction` | + top-level-verb descriptor | **Additive** | registry consumers (10) | Optional field |
| `CapabilityResolver` | lifetime connection → request | **Breaking** internally; behaviour-preserving | POLA gates, dispatch, `applyCacheHints` | Dual-era seam keeps the handshake path live |
| MCP wire | 2025 → dual-era | **Non-breaking** during the window | all clients | Pin legacy; `serveStdio` default is dual |
| `PHASE_EXPECTED_EVENTS` | hand-maintained → derived | **Behaviour-preserving** | `_eventHints` consumers | Golden fixture pins output |
| Deleted event types | append removed, read retained | **Breaking** for appenders only | Wave-5 scope | Frozen `LEGACY_EVENT_TYPES` |

**Irreversible by construction:** event-type deletion (append capability); any `Envelope<T>` state once a released client branches on it. Everything else is revertible.

### Technical Design

Wave 0 closes the INV-9 defects. Wave 1 lands G1–G5 as **observe-then-enforce**: each guard ships wired to its kill fixture, proven to fail, then flipped to blocking within the same wave — so no guard is ever merged unproven, and none blocks CI before its subject is remediated.

Waves 2–4 land the mechanisms each guard now protects, in cheapest-rung order: types (DR-2, DR-7, DR-8), then generation (DR-19), then structural analysis (DR-17), then production-path (DR-12, DR-15, DR-18). Wave 5 is cutover — catalog deletion, era switch, invariant amendment.

The **relocation proof** (DR-1) is the spine that makes D2 real: at any wave boundary, moving a declaration's storage must leave every guard passing with no consumer edit. If that fixture ever needs a consumer change, the binding was written against storage rather than the seam, and #1258 would re-open the classes this program closed.

### Integration Points

`core/dispatch.ts` (interceptor chain — DR-15) · `core/effect-carrier.ts` (DR-7) · `event-store/schemas.ts` (`registerEventType` seam — DR-1, DR-2) · `event-store/atomic-appender.ts` + `idempotency_claims` (DR-7, DR-9, DR-11) · `contract/{compiler,reachability,oracle}` (DR-10, DR-17, DR-18) · `architecture/*-seam.ts` (G1–G5 vocabulary) · `scripts/cli-vocab-guard.ts` (G1) · `adapters/{cli,mcp}.ts` (DR-19, DR-22) · `capabilities/resolver.ts` (DR-14) · `orchestrate/reconcile-state.ts` (DR-11–13) · `.exarchos/invariants.md` via `/exarchos:invariants` (DR-23).

### Exploration

Research pre-pass: discovery workflow **`mcp-spec-2026-07-28-migration`** (gathering → synthesizing → completed), producing the migration evaluation and the architectural-composition report cited in Inputs. The discovery preceded this ideation rather than being escalated from it, so no `discover_bridge` `correlationId` stitches the two — provenance is by explicit path citation. The composition report's MC-1…MC-4 are the direct source of DR-4, DR-5, DR-8, DR-9, DR-14, DR-19, and DR-22.

### Alternatives considered

**B — Contract compiler as the authority.** Make the registry a compiled artifact so violations are unwritable at rung 1 rather than ratcheted at rung 3. Genuinely stronger where it applies, and its instinct is absorbed per-obligation in D4. Rejected as the *spine* because the superseded spec isolates DR-10 into its own PR precisely because `contract/` is under active change — making that churn the program's critical path trades a distributed risk for a single point of total failure.

**C — IR-first (#1258).** Build the Workflow Builder IR now and land everything on the declared destination, one migration instead of two. Rejected because #1258 is v3.0 work and the superseded spec is v2.12-shaped specifically so *"Waves 1–4 have no external dependency."* Forfeiting that makes the whole program hostage to the largest unshipped roadmap item. **D2 preserves C's benefit without its dependency:** declarations are IR-shaped now, so #1258 relocates rather than re-binds — and DR-1's relocation proof is what keeps that honest.

**Layered (two programs, taxonomy v2 as prerequisite).** Preserves the review-hardened DR-1…DR-15 verbatim and yields smaller shippable units. Rejected per D1: G1–G5 would be defined twice with two ratchet sets, and the shared defect class would be remediated from two directions with no single census proving closure.

### Open Questions

1. **How far should `outputSchema` tightening go** — full per-action data shapes, or tiered (typed for DR-10 + HSM surfaces, structured-but-loose elsewhere)? DR-4 argues the 90% floor is untenable; the ceiling is a scope call that sets Wave 4's size.
2. **Does the interactive CLI get a stdin prompt loop for `input_required`**, or is scripted handle-passing the only mode? Decides whether the CLI grows an interactive surface it has so far avoided.
3. **Should the removed `tasks/list` return as an `exarchos_view` domain verb?** A domain verb is facade-neutral by construction; a protocol method never was.
4. **Does `longRunning` alone carry enough signal for server-directed task creation**, or does it need a per-action threshold/TTL now that it is behavioural rather than presentational?
5. **What is the Wave-0 scope of the Tasks audit?** The 14-file surface includes a `RESERVED(#1273 … expires 2027-01-31)` dead stub; the live fraction sets DR-22's true size.
6. **Does the composite tool pattern survive a remote surface?** `Mcp-Name` exposes 4 tool names for 118 verbs — if v3.2 wants per-verb edge policy, this is the blocker, and it may want deciding before Wave 5 rather than after.

### Risks

| Risk | Mitigation |
|---|---|
| **R-1** Program size — 24 DRs across 6 waves | Waves 1–4 independent; each wave exit is a seeded-failure proof (DR-24). Wave 1 ships guards only, so value lands before mechanisms. |
| **R-2** Re-litigating a spec hardened over three review rounds | Absorbed DRs retain their acceptance criteria verbatim with `[T-n]` provenance; plan-review diffs against the superseded doc rather than re-deriving. |
| **R-3** Guards block CI before their subjects are remediated | Observe-then-enforce within the same wave; allowlists carry owner + expiry and may only shrink. |
| **R-4** `Envelope<T>` fourth state is irreversible once wire-exposed | Design it before any MRTR code (D5 sequencing); land in typed schemas first, behind the dual-era window. |
| **R-5** DR-14 changes a trust boundary | Dedicated security review gates the DR; semantics of the three POLA gates are unchanged, only the capability source moves; fails closed on absent declaration. |
| **R-6** Reconciler latency at every boundary | Content-hash short-circuit; per-reconciler TTL; VCS reconciler behind an explicit staleness window. |
| **R-7** `contract/` churn collides with DR-10 | DR-10 lands as an isolated PR (inherited). |
| **R-8** #1473 never lands, stranding two exempted types | Annotated `blockedBy`, ratchet-pinned at 2 so the exemption cannot widen; follow-up issue tracks the flip. |
| **R-9** The superseded spec is **untracked in git** | Commit `2026-08-05-event-taxonomy-v2.md` before this spec lands, so supersession has an ancestor and the `[T-n]` provenance resolves. |
| **R-10** 2026-era test coverage needs child-process `serveStdio` | `InMemoryTransport` is 2025-era only. Budget for flakiness on the already-fragile Windows lane (#1699); prefer shape-based unit tests where the era is not the subject. |
| **R-11** The mechanism ships and nothing calls it | DR-24 — seeded-failure exits against production composition, never "the module exists". |

---

## Decomposition

> Authored by `/plan`. DR-1 … DR-24 above are the decomposition source.
