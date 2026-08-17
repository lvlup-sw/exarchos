# Spec: Effect ledger & emission coupling

**Date:** 2026-08-17 · **Feature:** `effect-ledger-coupling` · **Depth:** deep
**Inputs:** epic [#1822](https://github.com/lvlup-sw/exarchos/issues/1822) · anchors [#1765](https://github.com/lvlup-sw/exarchos/issues/1765) (028), [#1773](https://github.com/lvlup-sw/exarchos/issues/1773) (036), [#1776](https://github.com/lvlup-sw/exarchos/issues/1776) (039), [#1826](https://github.com/lvlup-sw/exarchos/issues/1826) (038b) · re-scoped from [#1763](https://github.com/lvlup-sw/exarchos/issues/1763)

> One unified artifact: the requirements below are the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **DR-N identifiers in this document are local to it.** Sibling specs are referenced by anchor number (028, 036, 039) and issue number only — never by a bare requirement ordinal, which the provenance gate would scrape from this prose as a phantom requirement of this document.

## Design & Rationale

### Problem Statement

An effect can land without the event that records it, and nothing prevents it. The authority-topology census names `effect-event` as the only boundary with **no authority at all**, and its declared enforcement wave has passed while the row stays observe-only. Three epics wait behind this.

The census re-derivation for this design, run against the landed tree at `main` @ `2919547d5`, confirms the epic's enumeration and adds three findings that change what the work is.

**The carrier declares nothing.** `EffectPlan` has no `emits` field, and its module references the event store zero times. It is constructed in exactly two places — `mutation-owner.ts:381`, `atomic-promotion.ts:751` — and `runEffect` has exactly two call sites, `mutation-owner.ts:487` and `atomic-promotion.ts:775`. A third module, `vcs/worktree-provisioner.ts`, consumes carriers but constructs no plan.

**The "already coupled" site is not declaratively coupled.** `VcsMutationOwner.planFor()` names no event; the `vcs.requested` / `vcs.executed` / `vcs.compensated` constants are hardcoded inside `mutate()`. The coupling is procedural. A bijection over declared plan→event edges therefore has **zero** subjects today, not one.

**Two other authorities already declare this coupling, and they disagree.** Action-level `autoEmits` covers 53 of 123 actions. The `capability` tier of the event annotations welds 50 events to an effect-provider id. Nothing reconciles them.

### Chosen Approach

Bind the two live authorities to each other and make **that** pair the bijection's subject. The effect carrier becomes a *consumer* of the reconciled authority, not a third rival declaration of the same fact.

Measured, the four candidate denominators are:

| Candidate authority | Population | Verdict |
|---|---|---|
| `EffectPlan` construction sites | **2** | ~1.2% of effect-performing modules; a third rival claim |
| Effect-provider bridge, tool → owner | **5** tools | already live and two-way ratcheted; too coarse to be the subject |
| Action `autoEmits`, compiled contract | **53** actions / 74 edges — 50 `always`, 24 `conditional` / 44 events | **chosen — one half of the pair** |
| Event `capability` weld | **50** events | **chosen — the other half** |
| Static effect-ownership scan | **179** occurrences / 161 modules | classifies by import shape; cannot know which event an occurrence owes |

Anchor 036's acceptance criterion — *every `condition: 'always'` contract landed for the operation* — **is** the `autoEmits` population. That anchor's subject was already sized at 50 `always` edges; it never needed the carrier. Anchor 028's coupling obligation is met in substance by declaring one authority over both halves and enforcing it at boot. The literal reading that `EffectPlan` must *be* the authority is corrected, because satisfying it as written would stand up a third declaration of a fact two live authorities already claim, over a denominator 25× smaller.

The carrier still gains `emits`. It resolves against the reconciled authority rather than defining it, which is what makes the committed-result type meaningful: the type says *this effect's event landed*, and the set of legal events comes from the contract, not from the call site.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: One reconciled emission authority binding both live declarations

The action-level `autoEmits` declaration and the event-level `capability` weld become two projections of one authority, bound so neither can drift from the other. Today each is independently editable and nothing compares them.

**Acceptance criteria:**
- A single module owns the binding and is the only place the correspondence is stated; both existing declaration sites keep their current shape and remain the authoring surface.
- For every action-declared emission edge of action, event and condition, the event's registration resolves and its declared provider agrees with the composite tool that owns the append.
- For every `capability`-tier event, the declaring provider is a live effect-provider entry and at least one live emission edge names it.
- The binding is a **two-way ratchet**, matching the effect-provider and narrow-port censuses: an edge naming a non-existent event, and a declaration covering no live edge, both fail.
- The check runs at **boot**, so it blocks server start and every job that boots the server — not a lint lane.

### DR-2: Non-empty measured denominator, pinned shrink-only

A bijection over an empty or silently-shrinking subject passes while asserting nothing. This is the defect class the programme exists to remove, and the failure mode this requirement owns.

**Acceptance criteria:**
- The census records its denominator explicitly — edge count, action count, event count — and **fails** when any is zero; a run enumerating zero registrations must fail, never pass clean.
- The denominator is derived from the live registries at boot, never from a hand-maintained mirror.
- A seeded run with the subject emptied fails, and a test asserts that.
- The counts are pinned shrink-only: a diff reducing the covered edge count without a recorded disposition fails.
- The census names at least one concrete wrong state it rejects; a check that cannot name one is vacuous and treated at the same severity as a missing one.

### DR-3: The measured disagreements are dispositioned, not absorbed

Reconciliation surfaces a real break set on day one. Turning the check on without dispositioning it would either fail boot immediately or force a blanket waiver that launders the disagreement into a pass.

Measured 2026-08-17: intersection **19**; **25** auto-emitted events are not `capability`-tier; **31** `capability` events appear in no `autoEmits`; **4** provider disagreements — `task.claimed`, `task.completed`, `task.failed` and `admission.evidence-recorded` declare provider `exarchos_workflow` while their only declaring action sits on `exarchos_orchestrate`.

**Acceptance criteria:**
- Every one of the 4 provider disagreements is resolved by correcting whichever side is wrong — not by widening the comparison to accept both.
- The 25 and 31 asymmetries are each classified as legitimate — an action triggering a substrate emission, or a handler-body append outside the dispatch-level auto-emission surface — or as a defect, and the legitimate classes are expressed as **typed structure**, never a per-event allowlist.
- Any residual exception carries an owner, a rationale, a retirement condition and an ISO expiry; an entry covering nothing fails as stale.
- The empty `observation` tier and the effect provider with zero welded events are both recorded as known-empty with a disposition, so an empty tier is not mistaken for a satisfied one.

### DR-4: Emission ownership is declared data with primary and recovery roles

Ownership is never inferred from call position. Recovery producers are exempt from the single-primary rule but not from coupling.

**Acceptance criteria:**
- Each emission edge carries a role of `primary` or `recovery` as declared data; no code path infers a role.
- Every covered event has **exactly one** primary owner; a second primary fails at boot naming both.
- A recovery edge is exempt from single-primary but still must name a registered event, and carries an owner and an ISO expiry.
- An expired recovery entry fails the boot check rather than lapsing into permanent cover.

### DR-5: EffectPlan couples as a consumer of the emission authority

The carrier gains `emits` and an appender, making an uncommitted effect's result type unusable. It reads the legal event set from the reconciled authority rather than defining its own.

**Acceptance criteria:**
- `EffectPlan` gains a required `emits` whose value must resolve in the reconciled authority; a plan naming an unregistered event fails to type-check or fails at boot.
- `runEffect` requires an appender and returns a committed result whose value is unreachable without the append, so a handler that performs an effect without committing its event **fails to compile**.
- The dry-run arm is unchanged and still appends nothing — the structural no-effect guarantee survives.
- The idempotency key is the event type joined to the operation id, reusing the existing idempotency claims table; no new storage.
- `VcsMutationOwner` migrates first: its hardcoded constants become declared edges, and its requested-executed-compensated ordering is preserved.
- The atomic tree-promotion site — the one effect call site not routed through the mutation owner — is migrated in the same change, so the carrier has no uncoupled construction site left.

### DR-6: EmissionVerifier asserts every declared always-contract landed

A post-dispatch interceptor asserts that every unconditional contract for the operation actually landed. A violation is an Exarchos bug, not agent misbehavior — the contract says the *handler* emits, so no agent action would make it land.

**Acceptance criteria:**
- The interceptor sits in the existing dispatch chain and evaluates the operation's unconditional edges — the measured subject of 50 edges across 53 actions.
- On violation it appends `emission.contract-violated` carrying the action, the missing set and the operation id.
- It **fails the response in CI and dev, telemetry-only in production**, selected by policy — not a build flag.
- A seeded handler that skips its declared emission fails the CI suite.
- **Indeterminate is distinct from pass:** a verifier that cannot evaluate, because the store is unavailable or the operation is unresolvable, reports indeterminate and does not promote.
- Conditional edges are out of the unconditional subject and must not be silently counted as satisfied.

### DR-7: Oracle emission axis observes the append, not the declaration

The oracle observes that a declared emission **actually appended**, rather than reading the declaration back. Absent observation must not become positive assurance.

**Acceptance criteria:**
- The oracle seam gains an emission axis whose evidence is the append itself, read from the store — never the declaration.
- A seeded handler declaring an emission it does not perform is caught **even when the generated files agree**.
- An axis that observed nothing reports the existing not-observed status, distinct from a pass.
- The axis names its subject count, and a run over zero observations fails rather than passing clean.

### DR-8: Reachability event hop resolves against the reconciled authority

The hop resolves against a real upstream — not the compile pass that supplies the denominator.

**Acceptance criteria:**
- The reachability hop list gains `event`, giving schema, route, handler, owner, event, consumer, output, artifact, fixture.
- The hop's authority is `runtime` and never `self`; the co-located prohibition test still passes.
- The kill-fixture suite gains an event entry: mutating the **real** upstream authority drops the census below 100%, satisfying the existing ratchet that every counted hop is proven killable.
- The census denominator for this hop is non-empty; a run enumerating zero registrations fails.
- The placeholder note recording this hop's deliberate absence is removed, so the module stops claiming an absence that no longer exists.

### DR-9: Boot fails closed; production degrades to telemetry

The check runs at boot and can therefore break every entry point. Its failure behavior must be explicit rather than emergent.

**Acceptance criteria:**
- A boot-check failure reports every violating edge in one pass — not first-failure-and-exit — naming the action, the event, the declared provider and the observed owner.
- The failure is **fail-closed**: an unreadable or empty registry fails boot rather than resolving to "nothing to check".
- The verifier's production telemetry path must not itself throw; an interceptor failure degrades to a recorded telemetry event and never breaks the response in production.
- Server start, the CLI and the CI boot path share the check — no entry point boots without it.
- The `effect-event` census row moves off observe-only only when the reconciled authority and its non-empty denominator are both green; until then it stays a recorded known-open row and is never reclassified as closed.

## Technical Design

The binding module sits beside the existing bridge it mirrors. The effect-provider map already connects the dispatch loader map to the static ownership ledger as a governed constant validated against the live ledger, with stale-entry detection in both directions. That is the shape this reconciliation takes: a small governed correspondence, validated against both live registries, failing on either an unbacked edge or a declaration covering nothing.

The two halves keep their current authoring surfaces. Auto-emission declarations stay in the action registry, where an action's emissions are declared next to the action. The capability weld stays in the event annotations, where an event's coupling is declared next to the event. Neither moves; the new module states the correspondence and both are checked against it.

The carrier's `emits` is typed against the event set the authority admits, so it cannot name an event the contract does not know. `runEffect` takes an appender and returns a committed result, which is what makes the type-level claim real: the success value is unreachable without the append, so the compiler rejects an effect that lands without its event. The dry-run arm is untouched — it returns the plan and invokes nothing, preserving the structural no-effect proof.

Enforcement is boot-time, so it blocks server start and every job that boots the server. The verifier is a separate, per-operation runtime check in the dispatch chain. The boot bijection proves the *declarations* agree; the verifier proves an individual operation's declared emissions *landed*; the oracle axis proves the observation itself is not vacuous.

## Integration Points

- `src/dispatch/core/effect-carrier.ts` — the `emits` field, appender parameter and committed result; dry-run arm unchanged.
- `src/vcs/mutation-owner.ts` — hardcoded constants become declared edges; ordering preserved.
- `src/install/atomic-promotion.ts` — the uncoupled construction site, migrated in the same change.
- `src/registry/types.ts` — the auto-emission shape gains its role field.
- `src/events/event-annotations.ts` — the 4 provider disagreements corrected; empty tier dispositioned.
- `src/contract/reachability/providers.ts` — precedent and neighbour for the new binding module.
- `src/contract/reachability/graph.ts` — the hop list and hop-authority map gain the event hop.
- `src/contract/oracle/oracle-seam.ts` — the emission axis.
- `src/dispatch/core/dispatch.ts` — the verifier interceptor seam.
- `tools/conformance/src/authority-topology.ts` — the `effect-event` row moves off no-authority.

## Exploration

Four directions were weighed. The epic enumerated three; the fourth emerged from the census re-derivation, which the epic explicitly asked for and flagged its own counts as a prior rather than a settled number.

**Direction 1 — couple the two sites, accept a denominator of two, add an adoption ratchet.** Honest and cheap. Rejected on measurement: 2 of 161 effect-performing modules is ~1.2% coverage, and the resulting bijection would pass while asserting almost nothing. Worse, it stands up a *third* declaration of a fact two live authorities already claim, an authority collision of exactly the kind the topology census exists to detect.

**Direction 2 — drive adoption first, declare the bijection afterwards.** The cleanest end state. Rejected on cost and sequencing: it blocks three downstream epics behind a ~161-module migration with no interim guard, and leaves the census row observe-only for the whole of it.

**Direction 3 — bind the runtime carrier to the static effect scan.** Attractive because the largest denominator lives there, 179 occurrences, and because the effect-provider map is an in-repo precedent for exactly this bridge. Rejected on a capability gap: the static ledger classifies occurrences by module import shape into filesystem, process and network. It cannot know which *event* an occurrence owes, and that mapping is not derivable from import shape — it would have to be invented, which is the fabricated bridge the topology row's own note already warns against.

**Direction 4 — reconcile the two live authorities, chosen.** The measurement that decided it: `emits` is not missing from the system, only from the carrier. It exists at the action level, 53 actions and 74 edges, and at the event level, 50 welded events; the two overlap on 19, and nothing adjudicates between them. That is a real, non-empty, already-typed subject with a measured break set — and it is the subject anchor 036's acceptance criterion already names.

Confirmed with the author before authoring. The opt-in discover bridge was surfaced and **not** escalated: the open questions here were settled by measuring this repository, not by external research, so a discover pass would have added provenance without adding evidence.

## Alternatives considered

- **Direction 1 — carrier-only coupling with an adoption ratchet.** Rejected: ~1.2% coverage, and a third rival declaration of a fact two authorities already claim.
- **Direction 2 — adoption before bijection.** Rejected: blocks three epics behind a 161-module migration with no interim guard.
- **Direction 3 — bind carrier to the static import scan.** Rejected: the scan cannot know which event an occurrence owes; the bridge would be fabricated.
- **Widen the comparison to accept both sides of a provider disagreement.** Rejected: that is the vacuity defect restated — a check that accepts every observed state rejects none.
- **Per-event allowlist for the asymmetries.** Rejected: an allowlist grows silently and rots into a rubber stamp. The legitimate classes must be typed structure with a stale-cover tooth.

## Open Questions

- **Are all 4 provider disagreements defects, or is some delegation legitimate?** Undecidable today because no authority adjudicates — which is the finding, not an obstacle. Resolved during the disposition work by reading each append site; the annotation's own definition, the composite tool whose handler owns the append, is the tiebreaker.
- **Does the unconditional/conditional split survive contact with the primary/recovery role?** They are orthogonal axes — when an emission fires versus who owns it — following the tier and lifecycle precedent already in the event registration union. Confirmed during the role work; if they turn out entangled, the union is shaped as a discriminated variant rather than crossed.
- **Should the empty observation tier be populated or retired?** Deferred past this epic. The disposition requirement asks only that its emptiness be recorded, so it cannot be mistaken for a satisfied tier. Retiring it touches the event-catalog disposition epic #1825, not this one.
- **Does boot-time enforcement measurably slow CLI start?** The check is over roughly 74 edges against in-memory registries. Measured during the boot work; if it exceeds the boot budget it moves behind the same first-boot memoization the other boot-time checks use — never behind a flag that lets a process boot unchecked.

## Decomposition

The decomposition maps every task to one or more DR-N from the requirements above.

### Scope

**Target:** Full design — all nine requirements.
**Excluded:** Populating or retiring the empty observation tier, which belongs to the event-catalog disposition epic. Migrating the wider effect surface onto the carrier beyond the two existing construction sites, which was weighed as Direction 2 and rejected.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | One reconciled emission authority binding both live declarations | 002, 003, 009 |
| DR-2 | Non-empty measured denominator, pinned shrink-only | 004, 005 |
| DR-3 | The measured disagreements are dispositioned, not absorbed | 006, 007, 008 |
| DR-4 | Emission ownership is declared data with primary and recovery roles | 001, 010 |
| DR-5 | EffectPlan couples as a consumer of the emission authority | 011, 012, 013, 014, 015, 016 |
| DR-6 | EmissionVerifier asserts every declared always-contract landed | 017, 018, 019, 020 |
| DR-7 | Oracle emission axis observes the append, not the declaration | 021, 022 |
| DR-8 | Reachability event hop resolves against the reconciled authority | 023, 024, 025 |
| DR-9 | Boot fails closed; production degrades to telemetry | 026, 027, 028 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth. Tests are judged test-after by adequacy — the failing-test-first ordering ceremony is not required.

### Task 001: Emission ownership declared data with primary and recovery roles

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/contract/emission/emission-edge.ts`
- `tests/unit/contract/emission/emission-edge.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the declaration seam. Name the behaviors `emissionEdge_RecoveryRoleWithoutExpiry_FailsToConstruct` and `emissionEdge_DeclaredRole_IsNeverInferredFromCallPosition`. The role must be declared data on the edge shape, with a recovery arm that cannot be constructed without an owner and an expiry timestamp.

**Steps:**
1. Define the emission-edge shape carrying action, event, condition and role.
2. Shape the recovery arm so it cannot exist without an owner and an expiry.
3. Add the tests named above and confirm they exercise the constructed shapes.

**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Reconciled emission authority module binding both live declarations

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/contract/emission/emission-authority.ts`
- `tests/unit/contract/emission/emission-authority.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across both registries. Name the behaviors `emissionAuthority_ActionEdgeAndEventWeld_ResolveToOneCorrespondence` and `emissionAuthority_ProviderDisagreement_FailsNamingBothSides`. The module reads the live action registry and the live event annotations and states the correspondence between them; it must be the only place that correspondence is written.

**Steps:**
1. Read both live declaration populations and project them onto the edge shape.
2. Resolve each action-declared edge against the event's registration and provider.
3. Add the tests named above against the real registries, not fixtures.

**Dependencies:** 001
**Parallelizable:** No

### Task 003: Two-way ratchet rejects unbacked edges and stale declarations

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/contract/emission/emission-authority.ts`
- `tests/unit/contract/emission/emission-ratchet.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionRatchet_EdgeNamingUnknownEvent_FailsAsUnbacked` and `emissionRatchet_DeclarationCoveringNoEdge_FailsAsStaleCover`. Both teeth must bite independently, mirroring the existing provider and narrow-port censuses.

**Steps:**
1. Add the unbacked-edge diagnostic and the stale-cover diagnostic as distinct codes.
2. Plant one violation of each kind against the live population and assert each is named.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** No

### Task 004: Non-empty measured denominator pinned shrink-only

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/contract/emission/emission-census.ts`
- `tests/unit/contract/emission/emission-census.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionCensus_LiveRegistries_ReportsNonZeroDenominator` and `emissionCensus_CoveredEdgeCountShrinks_FailsWithoutDisposition`. The census reports edge, action and event counts collected where the population is visible, so a downstream consumer can never confuse an empty result with a clean one.

**Steps:**
1. Collect and report the three counts at the point the population is walked.
2. Pin the counts shrink-only against the recorded baseline.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** No

### Task 005: Emptied subject fails rather than passing clean

**Risk Tier:** high
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `src/contract/emission/emission-census.ts`
- `tests/unit/contract/emission/emission-vacuity.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionCensus_EmptySubject_FailsRatherThanPassingClean` and `emissionCensus_UnreadableRegistry_FailsClosed`. Seed a run whose registries resolve to nothing and assert the verdict is a failure, then name in the test the one concrete wrong state the census rejects.

**Steps:**
1. Make a zero denominator a hard failure rather than a satisfied loop.
2. Seed the emptied and the unreadable cases separately.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 006: Correct the four measured provider disagreements

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/events/event-annotations.ts`
- `tests/unit/events/event-annotations.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `eventAnnotations_ProviderWeld_MatchesTheToolOwningTheAppend`. Read each of the four append sites and correct whichever side is wrong; do not widen the comparison to accept both. The four subjects are the claimed, completed and failed task events plus the admission evidence record.

**Steps:**
1. Read each of the four append sites and decide which side is wrong.
2. Correct that side only.
3. Add the test named above covering all four subjects.

**Dependencies:** 002
**Parallelizable:** No

### Task 007: Classify the measured asymmetries as typed structure

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/contract/emission/emission-authority.ts`
- `tests/unit/contract/emission/emission-asymmetry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionAsymmetry_SubstrateTriggeredEmission_IsLegitimateByShape` and `emissionAsymmetry_UnclassifiedEvent_FailsRatherThanBeingAllowlisted`. Each of the twenty-five and thirty-one asymmetric events is classified as legitimate or defect, and the legitimate classes are expressed as shapes rather than as an enumerated list of event names.

**Steps:**
1. Classify each asymmetric event by reading its emission path.
2. Express each legitimate class as a structural predicate, never a name list.
3. Add the tests named above.

**Dependencies:** 003, 006
**Parallelizable:** No

### Task 008: Record the empty tier and unwelded provider disposition

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/contract/emission/emission-disposition.ts`
- `tests/unit/contract/emission/emission-disposition.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `emissionDisposition_KnownEmptyTier_IsRecordedNotSatisfied` and `emissionDisposition_EntryCoveringNothing_FailsAsStale`. The observation tier has zero members and one effect provider has zero welded events; both are recorded with an owner, a rationale, a retirement condition and an expiry.

**Steps:**
1. Record the two known-empty subjects with the four required fields.
2. Fail any disposition entry that covers nothing.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** Yes

### Task 009: Boot-time bijection blocks server start

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1

**Files:**
- `src/contract/emission/emission-boot-check.ts`
- `tests/unit/contract/emission/emission-boot-check.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across every boot path. Name the behaviors `emissionBootCheck_ViolatingEdge_BlocksServerStart` and `emissionBootCheck_CleanTree_BootsWithoutError`. The check must run on server start, on the CLI path and on the boot path CI exercises, so no entry point boots unchecked.

**Steps:**
1. Wire the census into the shared boot path all three entry points use.
2. Assert a violating edge prevents start rather than warning.
3. Add the tests named above.

**Dependencies:** 003, 004
**Parallelizable:** No

### Task 010: Single primary owner per event with expiring recovery

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `src/contract/emission/emission-authority.ts`
- `tests/unit/contract/emission/emission-roles.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionRoles_SecondPrimaryOwner_FailsNamingBoth` and `emissionRoles_ExpiredRecoveryEntry_FailsAtBoot`. A recovery edge is exempt from the single-primary rule but still resolves to a registered event, and an expired entry fails rather than lapsing into permanent cover.

**Steps:**
1. Enforce exactly one primary owner per covered event.
2. Exempt recovery edges from that rule while still requiring event resolution.
3. Add the tests named above.

**Dependencies:** 001, 002
**Parallelizable:** No

### Task 011: EffectPlan couples as a consumer of the emission authority

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the carrier seam. Name the behaviors `effectPlan_EmitsNamingUnregisteredEvent_IsRejected` and `effectPlan_EmitsField_ResolvesAgainstTheAuthority`. The plan's emitted-event field is typed against the event set the authority admits, so the carrier cannot name an event the contract does not know.

**Steps:**
1. Add the required emitted-event field to the plan shape.
2. Type it against the authority's admitted set rather than a local list.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** No

### Task 012: Committed result makes an uncommitted effect unusable

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-committed.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `runEffect_WithoutAppender_FailsToCompile` and `runEffect_CommittedValue_IsUnreachableWithoutTheAppend`. The success value must be unreachable until the append lands, so a handler performing an effect without committing its event does not compile.

**Steps:**
1. Require an appender parameter and return a committed carrier.
2. Shape the carrier so the success value cannot be read before the append.
3. Add the tests named above, including a compile-rejection proof.

**Dependencies:** 011
**Parallelizable:** No

### Task 013: Dry-run arm still appends nothing

**Risk Tier:** high
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-dry-run.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `runEffect_DryRunMode_AppendsNothing` and `runEffect_DryRunMode_NeverInvokesTheExecuteThunk`. The structural no-effect guarantee must survive the appender being added — a dry run reaches neither the thunk nor the store.

**Steps:**
1. Keep the dry-run branch ahead of both the thunk and the appender.
2. Assert with a spying appender that no append occurs.
3. Add the tests named above.

**Dependencies:** 012
**Parallelizable:** No

### Task 014: Idempotency key reuses the existing claims table

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-idempotency.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite against the real store. Name the behaviors `effectIdempotency_RetriedEffect_AppendsExactlyOnce` and `effectIdempotency_KeyShape_JoinsEventTypeAndOperationId`. No new storage is introduced; the existing claims table carries the key.

**Steps:**
1. Derive the key from the event type and the operation id.
2. Route it through the existing claims table with no schema change.
3. Add the tests named above against a real store.

**Dependencies:** 012
**Parallelizable:** No

### Task 015: Migrate the mutation owner to declared emission edges

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/vcs/mutation-owner.ts`
- `tests/unit/vcs/mutation-owner.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the mutation seam. Name the behaviors `mutationOwner_PlanFor_NamesItsEventsAsDeclaredEdges` and `mutationOwner_CrashBetweenIntentAndTerminal_StillConverges`. The requested-then-executed-or-compensated ordering must be preserved exactly; only the source of the event names changes from hardcoded constants to declared edges.

**Steps:**
1. Replace the hardcoded constants with edges resolved from the authority.
2. Leave the intent-effect-terminal ordering untouched.
3. Add the tests named above, including the crash-recovery path.

**Dependencies:** 012
**Parallelizable:** No

### Task 016: Migrate the uncoupled tree-promotion construction site

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/install/atomic-promotion.ts`
- `tests/unit/install/atomic-promotion.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `promotionPlan_DeclaresItsEmittedEvent` and `promoteTree_LiveMode_CommitsItsEventBeforeReturning`. This is the one effect call site not routed through the mutation owner, so after this task the carrier has no uncoupled construction site left.

**Steps:**
1. Give the promotion plan a declared emitted event.
2. Thread the appender through the live path, leaving dry-run untouched.
3. Add the tests named above.

**Dependencies:** 012
**Parallelizable:** No

### Task 017: EmissionVerifier asserts every declared always-contract landed

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-verifier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the dispatch chain. Name the behaviors `emissionVerifier_UnconditionalEdgeMissing_FailsTheResponse` and `emissionVerifier_ConditionalEdgeAbsent_IsNotCountedAsSatisfied`. The subject is the unconditional edge set for the operation; conditional edges are out of subject and must not be silently counted as satisfied.

**Steps:**
1. Resolve the operation's unconditional edges from the authority.
2. Compare them against what the operation actually appended.
3. Add the tests named above.

**Dependencies:** 002, 009
**Parallelizable:** No

### Task 018: Contract-violation event carries action, missing set and operation id

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-violation-event.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `emissionViolation_AppendedRecord_CarriesActionMissingSetAndOperationId`. The violation record must name every missing event, not just the first, so the diagnostic is actionable without a re-run.

**Steps:**
1. Register the violation event type with its data schema.
2. Append it carrying the action, the full missing set and the operation id.
3. Add the test named above.

**Dependencies:** 017
**Parallelizable:** No

### Task 019: Policy selects CI and dev failure against production telemetry

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6, DR-9

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-policy.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionPolicy_CiAndDev_FailTheResponse` and `emissionPolicy_Production_RecordsTelemetryWithoutThrowing`. The selection is by policy rather than a build flag, and the production path must never break a response even when the verifier itself errors.

**Steps:**
1. Resolve the mode from policy, not from a compile-time flag.
2. Make the production arm swallow its own failures into telemetry.
3. Add the tests named above.

**Dependencies:** 017
**Parallelizable:** No

### Task 020: Indeterminate verdict is distinct from pass and does not promote

**Risk Tier:** high
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-indeterminate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionVerifier_StoreUnavailable_ReportsIndeterminateNotPass` and `emissionVerifier_IndeterminateVerdict_DoesNotPromote`. A verifier that cannot evaluate must be distinguishable from one that evaluated and found nothing wrong.

**Steps:**
1. Add the indeterminate verdict as a distinct value, not an absent failure.
2. Block promotion on indeterminate as well as on failure.
3. Add the tests named above.

**Dependencies:** 017
**Parallelizable:** No

### Task 021: Oracle emission axis observes the append not the declaration

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7

**Files:**
- `src/contract/oracle/oracle-seam.ts`
- `tests/unit/contract/oracle/oracle-emission-axis.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `oracleEmissionAxis_EvidenceIsTheAppend_NotTheDeclaration` and `oracleEmissionAxis_NothingObserved_ReportsNotObserved`. The axis joins the existing five and reports through the existing three-valued status, so an unobserved run is never a pass.

**Steps:**
1. Add the emission axis to the declared axis list.
2. Source its evidence from the recorded append rather than the contract.
3. Add the tests named above.

**Dependencies:** 017
**Parallelizable:** No

### Task 022: Seeded handler caught even when the generated files agree

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7

**Files:**
- `tests/unit/contract/oracle/oracle-emission-seeded.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `oracleEmissionAxis_SeededSkippedEmission_IsCaughtWhenFilesAgree` and `oracleEmissionAxis_ZeroObservations_FailsRatherThanPassingClean`. A handler that declares an emission it never performs must be caught with every generated artifact in agreement, so absent observation cannot become positive assurance.

**Steps:**
1. Seed a handler that declares an emission and skips it.
2. Leave every generated artifact consistent so only runtime observation can catch it.
3. Add the tests named above.

**Dependencies:** 021
**Parallelizable:** No

### Task 023: Reachability event hop resolves against the reconciled authority

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `src/contract/reachability/graph.ts`
- `src/contract/reachability/collect.ts`
- `tests/unit/contract/reachability/graph.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `reachabilityHops_EventHop_ResolvesAgainstRuntimeAuthority` and `reachabilityHops_EventHop_IsNeverSelfResolved`. The hop takes its place between owner and consumer, and the existing prohibition test that forbids self-resolution must still pass unchanged.

**Steps:**
1. Add the hop to the ordered list and the authority map.
2. Resolve it in the collector against the reconciled authority.
3. Add the tests named above.

**Dependencies:** 009
**Parallelizable:** No

### Task 024: Event kill fixture drops the census below full coverage

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-8

**Files:**
- `tests/unit/contract/reachability/kill-fixtures.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `killFixtures_MutatedEmissionAuthority_DropsTheCensusBelowFull` and `killFixtures_EveryCountedHop_RemainsProvenKillable`. The existing ratchet asserts the killed-hop set equals the counted-hop set, so the new hop must arrive with its kill entry or the ratchet fails.

**Steps:**
1. Mutate the real upstream authority rather than a fixture copy.
2. Assert the census drops below full coverage and names the event hop.
3. Add the tests named above.

**Dependencies:** 023
**Parallelizable:** No

### Task 025: Remove the placeholder note claiming deliberate absence

**Risk Tier:** low
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `src/contract/reachability/index.ts`
- `src/contract/reachability/collect.ts`

**Verification:** static analysis — typecheck and lint. The note recording this hop's deliberate absence describes a state that no longer holds once the hop resolves, so leaving it would make the module claim an absence that is no longer true.

**Steps:**
1. Delete the absence note now that the hop exists.
2. Confirm no remaining prose asserts the hop is deliberately missing.

**Dependencies:** 024
**Parallelizable:** No

### Task 026: Boot fails closed and reports every violating edge

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `src/contract/emission/emission-boot-check.ts`
- `tests/unit/contract/emission/emission-boot-failure.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionBootCheck_MultipleViolations_ReportsAllInOnePass` and `emissionBootCheck_UnreadableRegistry_FailsClosed`. First-failure-and-exit is not acceptable: a maintainer must see the whole break set from one boot attempt.

**Steps:**
1. Collect every violation before reporting rather than throwing on the first.
2. Name the action, event, declared provider and observed owner on each.
3. Add the tests named above.

**Dependencies:** 009
**Parallelizable:** No

### Task 027: Every boot entry point shares the emission check

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9

**Files:**
- `src/contract/emission/emission-boot-check.ts`
- `tests/unit/contract/emission/emission-boot-entrypoints.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across every entry point. Name the behaviors `emissionBootCheck_EveryEntryPoint_RunsTheSameCheck` and `emissionBootCheck_NewEntryPoint_CannotBootUnchecked`. Assert by structure that no boot path bypasses the check, rather than by enumerating the paths that currently call it.

**Steps:**
1. Route every entry point through one shared boot seam.
2. Assert structurally that no result-producing boot branch skips it.
3. Add the tests named above.

**Dependencies:** 026
**Parallelizable:** No

### Task 028: Move the effect-event census row off observe-only

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `tools/conformance/src/authority-topology.ts`
- `tools/conformance/src/authority-census.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `authorityTopology_EffectEventRow_ReportsASingleBoundAuthority`. The row currently records no authority in either direction; it moves only once the reconciled authority and its non-empty denominator are both green, and never by reclassification alone.

**Steps:**
1. Rewrite the row to name the reconciled authority and its two bound representations.
2. Update the pinned census expectation that asserts the row's current shape.
3. Add the test named above.

**Dependencies:** 009, 027
**Parallelizable:** No

### Parallelization

The critical path is 001 → 002 → 003 → 004 → 009, and then three chains fan out from the boot check.

- **Wave 1, parallel:** 001 and 008 have no blocking predecessor beyond the edge shape.
- **Wave 2, sequential spine:** 002 → 003 → 004 → 005, with 006 and 010 branching off 002.
- **Wave 3, after 009:** three independent chains run in parallel worktrees — the carrier chain 011 → 012 → {013, 014, 015, 016}, the verifier chain 017 → {018, 019, 020} → 021 → 022, and the hop chain 023 → 024 → 025.
- **Wave 4, closeout:** 026 → 027 → 028, which joins the boot chain to the topology row.

Tasks 013, 014, 015 and 016 all edit distinct files after 012 lands and are parallel-safe. Tasks 018, 019 and 020 share the verifier module and must serialize.

### Completion checklist

- [ ] Every DR-N maps to at least one task in the matrix
- [ ] Every task implements a DR-N that exists in this document
- [ ] Every task carries a risk-tier stamp
- [ ] Medium and high-tier tasks carry adequacy-judged tests
- [ ] Open questions are resolved or explicitly deferred with rationale
- [ ] Ready for plan-review
