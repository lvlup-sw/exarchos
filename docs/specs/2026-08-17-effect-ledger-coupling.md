# Spec: Effect ledger & emission coupling

**Date:** 2026-08-17 · **Feature:** `effect-ledger-coupling` · **Depth:** deep · **Revision:** 2
**Inputs:** epic [#1822](https://github.com/lvlup-sw/exarchos/issues/1822) · anchors [#1765](https://github.com/lvlup-sw/exarchos/issues/1765) (028), [#1773](https://github.com/lvlup-sw/exarchos/issues/1773) (036), [#1776](https://github.com/lvlup-sw/exarchos/issues/1776) (039), [#1826](https://github.com/lvlup-sw/exarchos/issues/1826) (038b) · re-scoped from [#1763](https://github.com/lvlup-sw/exarchos/issues/1763)

> One unified artifact: the requirements below are the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **DR-N identifiers in this document are local to it.** Sibling specs are referenced by anchor number (028, 036, 039) and issue number only — never by a bare requirement ordinal, which the provenance gate would scrape from this prose as a phantom requirement of this document.
>
> **Revision 2 corrects revision 1's baseline.** A three-voter adversarial pass refuted revision 1 on measurement: it claimed "nothing reconciles" the two emission authorities when several live mechanisms already do. Rev 1's counts were all confirmed correct; its *baseline* was not. The corrected baseline is stated below and is the substance of this revision.

## Design & Rationale

### Problem Statement

An effect can land without the event that records it. The authority-topology census names `effect-event` as the only boundary with **no authority at all**, and its declared enforcement wave has passed while the row stays observe-only. Three epics wait behind this.

Measured against the landed tree at `main` @ `2919547d5`, the carrier claims hold exactly. `EffectPlan` has no `emits` field and its module references the event store zero times. It is constructed in exactly two places — `mutation-owner.ts:381` and `atomic-promotion.ts:751` — with `runEffect` called at `mutation-owner.ts:487` and `atomic-promotion.ts:775`. A third module, `vcs/worktree-provisioner.ts`, consumes carriers but constructs no plan.

**What the effect sites emit is not in the catalog at all.** The `vcs.requested` / `vcs.executed` / `vcs.compensated` names are module-level exported constants registered at *runtime* through `registerEventType`, so they carry no tier, no weld and no provider. There is no install or promotion event of any kind. And no effect-provider area covers `vcs/` or `install/` — the five declared areas are `events/`, `verbs/`, `sync/`, `projections/views/` and `workflow/`. So both effect sites emit events the declaration system cannot see.

**That — not a missing bijection — is the real defect.** The coupling cannot be declared because the events and the provider areas do not exist.

### The corrected baseline

Three live mechanisms already do work revision 1 proposed to build. Naming them is load-bearing: building beside them would create the authority collision this spec rejects Direction 1 for.

| Already live | What it already guarantees |
|---|---|
| `events/registration-validate.ts`, called first in `initializeContext` | Resolves every `capability` weld against the ledger-backed provider set **at boot**, on the shared boot of both facades, with `PROVIDER_REGISTRY_DRIFT`, `EMPTY_CAPABILITY_DENOMINATOR` and `EMPTY_PROVIDER_REGISTRY` teeth |
| `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` | Every action-declared emission names a registered event whose source is `auto`, with a non-vacuity guard |
| `EVENT_EMISSION_REGISTRY`, derived from the tier axis | The topology's declared authority for the **`event-catalog`** row — a different row from `effect-event` |

Two consequences. The 25 auto-emitted events that are not `capability`-tier are all `substrate` with a **closed** rationale vocabulary — already typed structure, not an unadjudicated asymmetry. And of the 31 `capability` events named by no action, at least 9 are `lifecycle: planned` or `retired`, which the drift rule makes **structurally incapable** of appearing in any emission edge.

So the genuinely new surface is much narrower than revision 1 claimed: the **provider comparison** (does a declaring action's tool match the event's declared provider), the **stale-cover tooth**, and the **catalog and provider-area work** that lets the two effect sites be declared at all.

There is also a **third** action-side declaration revision 1 omitted: `RunbookDefinition.autoEmits`, 21 declarations carrying a bare event list with no condition axis.

### Chosen Approach

Extend what ships; do not rebuild beside it. The boot gate already resolves welds and already fails on an empty denominator — the provider comparison and the stale-cover tooth are added to *it*, and its `WELD_RESOLUTION_POLICY` table stays the one place the tier axis is decided.

Then make the two effect sites declarable: register the VCS ledger events and a promotion event into the catalog, and declare provider areas for `vcs/` and `install/`. Only then does `EffectPlan.emits` have anything to resolve against. This is the ordering revision 1 inverted — it specified the coupling before the vocabulary existed.

**Assumption taken, and it is the one to challenge first.** Anchor 028 is read as *coupling the effect sites*, so the catalog and provider-area work is in scope rather than deferred. The narrower reading — ship only the provider comparison and stale-cover tooth over the existing 50-event population, and leave both carrier sites uncoupled — is a coherent alternative that halves the epic and leaves the anchor's headline claim unmet. See Open Questions.

The bijection's subject is therefore the **capability weld population**, which is independent of the contract compile pass. Action `autoEmits` cannot be the authority for a reachability hop: it rides through the compiler as `policy.evidence.autoEmits`, and the reachability denominator *is* that same compile, so a hop resolved from it resolves by construction — the self-derivation the collector forbids.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Extend the shipped boot gate with the provider comparison

The existing boot-time weld gate gains the one comparison it does not make: whether a declaring action's composite tool matches the event's declared provider. No second boot check is created.

**Acceptance criteria:**
- The comparison lands in the shipped registration-validation module and is reached through the existing startup assertion; no new boot entry point is introduced.
- For every `capability` event named by at least one live emission edge, the declaring action's tool equals the event's declared provider, or a diagnostic names both sides.
- The existing weld resolution, drift and empty-denominator diagnostics are preserved unchanged; the tier policy table remains the single place the tier axis is decided.
- Runbook-declared emissions are folded into the same comparison, so a third declaration surface cannot state the correspondence independently.
- A test asserts the module is still reached from the shared boot of both facades, so the comparison cannot become unreachable.

### DR-2: Stale-cover tooth over the lifecycle-eligible population

A weld covering no live edge is stale cover. The eligible population must exclude events the drift rule makes structurally unnameable, or the tooth fires on conforming code.

**Acceptance criteria:**
- A `capability` event whose lifecycle is `active` and which no live emission edge names fails as stale cover.
- Events with lifecycle `planned` or `retired` are **excluded by the lifecycle axis**, expressed as typed structure, never a per-event list.
- The eligible count is reported alongside the verdict, and a run whose eligible population is zero fails rather than passing clean.
- The eligible count is pinned in a named baseline artifact that the guarded run does not regenerate; the pin's file and its regeneration rule are stated.
- The check names at least one concrete wrong state it rejects.

### DR-3: The VCS and promotion effects become declarable

Both effect sites emit events the declaration system cannot see. Until the catalog and the provider areas exist, no coupling can be declared.

**Acceptance criteria:**
- The three VCS ledger events are registered as catalog events with data schemas, type-map entries and tier annotations, replacing the runtime registration seam for these three names.
- A promotion event is registered the same way for the atomic tree-promotion site.
- Effect-provider areas are declared for `vcs/` and `install/`, each backed by exactly one live ownership rule, so the existing provider validation accepts them.
- Each new event's annotation carries a non-empty consumer set, or is annotated at a tier whose weld it can satisfy — a capability weld consumed by nobody must not be minted to pass the gate.
- The pinned catalog-count assertions are updated in the same change, so the catalog and its tests cannot disagree.

### DR-4: Emission ownership is declared data with fan-in modelled

Ownership is declared, never inferred. Single-primary-per-event is falsified on the live tree and must not be specified as though it held.

Measured: 74 edges over 44 distinct events, so roughly 30 events carry two or more declaring edges; `gate.executed` alone is declared across five registry files.

**Acceptance criteria:**
- Each emission edge carries a role of `primary` or `recovery` as declared data on the existing authoring surface; no code path infers a role.
- The uniqueness rule is **one primary per event per provider area**, not one per event; a second primary within the same area fails naming both.
- A multi-declarer event spanning one area is conforming and must not fail — a test pins one such live event.
- A recovery edge is exempt from uniqueness but still names a registered event and carries an owner and an ISO expiry; an expired entry fails.

### DR-5: EffectPlan couples as a consumer of the declared vocabulary

The carrier gains an emission declaration and an appender. It resolves against the catalog vocabulary rather than defining its own.

**Acceptance criteria:**
- `EffectPlan` carries its emissions as a **set with conditions**, not a single event: the mutation owner emits an intent before the effect and one of two terminals after, which a singular field cannot express.
- The appender is not a bare caller-supplied thunk — it is a branded or store-derived capability, so passing a no-op cannot yield a committed value.
- The committed value is unreachable without the append, so a handler performing an effect without committing its event fails to compile.
- The dry-run arm is unchanged and still reaches neither the thunk nor the appender.
- The idempotency key includes the **stream** dimension alongside the event type and operation id, matching the claims table's composite key.
- The mutation owner's intent-then-terminal ordering is preserved exactly; its exported event constants remain its public surface for existing consumers.

### DR-6: EmissionVerifier asserts declared emissions landed, lifecycle included

A post-dispatch interceptor asserts that every unconditional contract for the operation landed. A violation is an Exarchos bug, not agent misbehavior.

**Acceptance criteria:**
- The interceptor is **installed in the shipped dispatch chain**, and a test asserts by structure that no result-producing branch bypasses it.
- It evaluates the operation's unconditional edges; conditional edges are out of subject and must not be counted as satisfied.
- A registration whose lifecycle is `planned` or `retired` but which is nonetheless emitted at runtime **fails** — the lifecycle axis is enforced, not decorative.
- On violation it appends a contract-violation event carrying the action, the full missing set and the operation id.
- It fails the response in CI and dev and is telemetry-only in production, selected by policy, and the production arm never throws.
- **Indeterminate is distinct from pass** and does not promote; the count of determinate verdicts is reported, and an all-indeterminate run fails rather than reporting clean.
- A seeded handler that skips its declared emission fails the CI suite.

### DR-7: Oracle emission axis observes the append, not the declaration

The oracle gains an emission axis whose evidence is an observed append. It must not become a live store consumer — every existing axis takes injected evidence, and the module declares itself a pure-analysis gate.

**Acceptance criteria:**
- The axis takes its evidence from an **injected append recorder**, mirroring how the effect axis takes an injected effect recorder; the module acquires no store import.
- The recorder is threaded onto the live-subject path, not only onto seeded fixtures, so live subjects can produce a determinate verdict.
- A seeded handler declaring an emission it does not perform is caught even when the generated files agree.
- An axis that observed nothing reports the existing not-observed status; a run whose observed-subject count is zero fails rather than passing clean.

### DR-8: Reachability event hop resolves against the weld, with applicability declared

The hop resolves against the capability weld — independent of the compile pass that supplies the denominator. Its applicability must be declared or it turns the census red for every non-declaring action.

**Acceptance criteria:**
- The hop list gains `event` only. The `consumer` hop is **out of scope here** and is owned by the sibling re-scope spec; that spec's task adding both hops is corrected to add `consumer` alone.
- The hop's authority is the annotation-side weld, never action `autoEmits`, because the latter rides the same compile pass as the denominator; a comment records why.
- Applicability is declared explicitly, following the mutation-gated precedent, so actions outside the emitting population are `not-applicable` rather than `missing`.
- The live closure baseline stays fully closed, and the regenerated reachability artifact and the closure assertions are updated in the same change.
- The kill-fixture suite gains an event entry that mutates the real upstream through the collector's existing injection seam and drops the census below full closure.
- The prohibition test is strengthened beyond a label check, so labelling a self-derived hop `runtime` no longer passes it.

### DR-9: Boot fails closed, sequenced behind its own disposition

The gate blocks every entry point, so it must not be armed while its own break set is live.

**Acceptance criteria:**
- The provider comparison and stale-cover tooth ship **observe-only first**, and are flipped to blocking only after the measured break set is dispositioned.
- A boot failure reports every violating edge in one pass, naming the action, the event, the declared provider and the observed owner.
- The gate fails closed on an empty or unresolvable population rather than reporting clean.
- The `effect-event` census row moves only when the carrier sites are genuinely coupled — the row's own two representations are the carrier and the append site, so re-pointing it at a different pair is reclassification and is forbidden.
- If the carrier coupling does not land, the row stays a recorded known-open row.

## Technical Design

The boot gate is the spine and it already exists. Its weld-resolution policy table is total over the tier axis, so the provider comparison and the stale-cover tooth are added as additional diagnostics on the `capability` arm rather than as a parallel module. That keeps one boot entry point, one policy table, and one place the correspondence is stated — which is what makes the extension safe where a sibling module would be an authority collision.

The catalog work is the precondition everything else waits on. The two effect sites emit names the declaration system cannot see, so `emits` has nothing to resolve against until the VCS ledger events and a promotion event are registered and the `vcs/` and `install/` provider areas are declared. Registering them also moves the VCS names off the runtime registration seam, which is what gives them a tier and a weld.

The carrier then couples as a consumer. Its emissions are a conditioned set because the mutation owner appends an intent before the effect and one of two terminals after; the appender is branded so a no-op cannot satisfy it; and the idempotency key carries the stream dimension the claims table actually keys on.

The verifier and the oracle axis are runtime checks over that vocabulary, and they are wired into the shipped chain rather than left as free functions. The reachability hop resolves against the annotation half, which no compile pass derives.

## Integration Points

- `src/events/registration-validate.ts` — the provider comparison and stale-cover tooth join the existing weld gate.
- `src/dispatch/core/context.ts` — the shared boot seam the gate is already reached from; unchanged but asserted.
- `src/events/schemas.ts` and `src/events/event-annotations.ts` — the VCS and promotion event registrations, tiers and pinned counts.
- `src/contract/reachability/providers.ts` — the `vcs/` and `install/` provider areas.
- `src/architecture/effect-ledger.ts` — the ownership rules backing those two areas.
- `src/registry/gate-metadata.ts` — the auto-emission shape gains its role field.
- `src/runbooks/types.ts` — the third declaration surface folded into the comparison.
- `src/dispatch/core/effect-carrier.ts`, `src/vcs/mutation-owner.ts`, `src/install/atomic-promotion.ts` — the carrier coupling.
- `src/dispatch/core/dispatch.ts` — where the verifier interceptor is installed.
- `src/contract/oracle/oracle-seam.ts` — the injected append recorder and the emission axis.
- `src/contract/reachability/graph.ts` and `collect.ts` — the event hop and its applicability rule.

## Exploration

Revision 1 weighed four directions and chose to reconcile the two live authorities. A three-voter adversarial pass then refuted that plan, and the refutation is the substance of this revision.

All of revision 1's **counts** were independently confirmed: 74 edges over 53 actions and 44 events, 50 capability welds, intersection 19, asymmetries 25 and 31, four provider disagreements, an empty `observation` tier and one unwelded provider. What failed was the **baseline** those counts sat on. Three live mechanisms already performed work revision 1 specified as new, and the census that found the counts missed them — in one case because the module contains literal NUL bytes and is invisible to text search, a known trap in this tree.

The correction changes the shape of the work in three ways. Most of the reconciliation revision 1 proposed already ships, so DR-1 and DR-2 shrink to a genuine delta. The real blocker turns out to be that the two effect sites emit events the catalog does not contain and that no provider area covers, which inverts the ordering: vocabulary first, coupling second. And the reachability hop cannot resolve against action `autoEmits` at all, because that declaration rides the same compile pass that supplies the census denominator.

Direction 4 therefore survives in outline — the coupling authority is the annotation weld, not the carrier — but the epic is smaller in its guard work and larger in its catalog work than revision 1 stated.

The opt-in discover bridge was surfaced and not escalated: every open question here was settled by measuring this repository.

## Alternatives considered

- **Build a new binding module beside the shipped boot gate.** Revision 1's design. Rejected on measurement: it would be the second boot-time correspondence check over the same population — the authority collision this spec rejects Direction 1 for.
- **Keep single-primary-per-event.** Rejected: falsified by ~30 multi-declarer events on the live tree.
- **Resolve the event hop from action `autoEmits`.** Rejected: it rides the compile pass that supplies the denominator, so it resolves by construction.
- **Per-event allowlist for the unnameable welds.** Rejected: the lifecycle axis already expresses that class as typed structure.
- **Couple the carrier before registering its events.** Rejected: `emits` would have nothing to resolve against.

## Open Questions

- **Is the catalog and provider-area work in scope for anchor 028, or a separate anchor?** This spec assumes in scope, because coupling the effect sites is the anchor's headline claim and it cannot be met otherwise. The narrower reading ships only the provider comparison and stale-cover tooth and leaves both carrier sites uncoupled, halving the epic. **This is the first thing to challenge at review.**
- **Do the three no-valid-answer provider disagreements need a sixth provider area?** `task.claimed`, `task.completed` and `task.failed` are appended in `src/tasks/`, which no provider area covers, so neither the declared provider nor the declaring action's tool is correct. Either a `tasks/` area is declared or the appends relocate. Resolved during the disposition work.
- **Does the sibling re-scope spec get corrected here or there?** Its task still adds both hops over the same files. This spec assumes that task is narrowed to `consumer` alone, in that spec, before either lands.
- **Does anchor 039's axis need a live recorder seam to exist first?** The oracle takes injected evidence by design; threading a recorder onto the live-subject path may be its own anchor rather than a task here.

## Decomposition

The decomposition maps every task to one or more DR-N from the requirements above.

### Scope

**Target:** Full design — all nine requirements, under the stated assumption that catalog and provider-area work is in scope.
**Excluded:** The `consumer` reachability hop, owned by the sibling re-scope spec. Migrating the wider effect surface onto the carrier beyond the two existing construction sites. Populating or retiring the empty observation tier.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Extend the shipped boot gate with the provider comparison | 004, 005, 006 |
| DR-2 | Stale-cover tooth over the lifecycle-eligible population | 007, 008 |
| DR-3 | The VCS and promotion effects become declarable | 001, 002, 003 |
| DR-4 | Emission ownership is declared data with fan-in modelled | 009, 010 |
| DR-5 | EffectPlan couples as a consumer of the declared vocabulary | 011, 012, 013, 014 |
| DR-6 | EmissionVerifier asserts declared emissions landed, lifecycle included | 015, 016, 017, 018 |
| DR-7 | Oracle emission axis observes the append, not the declaration | 019, 020 |
| DR-8 | Reachability event hop resolves against the weld, with applicability declared | 021, 022, 023 |
| DR-9 | Boot fails closed, sequenced behind its own disposition | 024, 025, 026 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth. Tests are judged test-after by adequacy.

### Task 001: Declare effect-provider areas for the vcs and install trees

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/contract/reachability/providers.ts`
- `src/architecture/effect-ledger.ts`
- `tests/integration/contract/reachability/providers.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the provider seam. Name the behaviors `effectProviders_VcsAndInstallAreas_AreBackedByOneLiveRule` and `effectProviders_AreaWithNoBackingRule_FailsAsStale`. Each new area must be backed by exactly one live ownership rule so the existing provider validation accepts it.

**Steps:**
1. Add the two areas with their owner and effect class.
2. Ensure one ownership rule backs each.
3. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Register the vcs ledger events into the catalog

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/events/schemas.ts`
- `src/events/event-annotations.ts`
- `tests/integration/events/event-annotations.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `vcsLedgerEvents_Registered_CarryTierAndLifecycle` and `vcsLedgerEvents_RuntimeSeam_IsNoLongerUsed`. The three names move off runtime registration and gain data schemas, type-map entries and annotations; the pinned catalog count moves in the same change.

**Steps:**
1. Register the three names with data schemas and type-map entries.
2. Annotate each with a tier whose weld it can satisfy.
3. Update the pinned catalog count and add the tests named above.

**Dependencies:** 001
**Parallelizable:** No

### Task 003: Register a promotion event for the tree-promotion site

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3

**Files:**
- `src/events/schemas.ts`
- `src/events/event-annotations.ts`
- `tests/integration/events/promotion-event.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `promotionEvent_IsRegisteredWithAResolvableWeld` and `promotionEvent_CapabilityWeldWithNoConsumer_IsRejected`. A capability weld consumed by nobody must not be minted merely to pass the gate.

**Steps:**
1. Register the event with its data schema and type-map entry.
2. Annotate it at a tier whose weld it can satisfy.
3. Add the tests named above.

**Dependencies:** 001
**Parallelizable:** No

### Task 004: Extend the shipped boot gate with the provider comparison

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/integration/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the boot seam. Name the behaviors `registrationWelds_ProviderDisagreement_ReportsBothSides` and `registrationWelds_ExistingDiagnostics_ArePreserved`. The comparison joins the existing gate; no second boot entry point appears.

**Steps:**
1. Add the comparison as a diagnostic on the capability arm.
2. Preserve every existing diagnostic and the tier policy table.
3. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 005: Fold runbook-declared emissions into the comparison

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `src/runbooks/types.ts`
- `tests/integration/events/runbook-emission-fold.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `runbookEmissions_AreComparedAgainstTheSameWeld` and `runbookEmissions_ThirdDeclarationSurface_CannotDriftIndependently`. Runbooks declare a bare event list with no condition axis, so the fold must not fabricate one.

**Steps:**
1. Project runbook declarations onto the comparison input.
2. Keep the missing condition axis explicit rather than defaulted.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 006: Assert the boot gate stays reachable from both facades

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-1

**Files:**
- `tests/acceptance/emission-boot-reachability.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across every boot path. Name the behaviors `bootGate_IsReachedFromTheSharedFacadeBoot` and `bootGate_UnreachableFromANewEntryPoint_FailsTheAssertion`. Assert by structure rather than by enumerating the callers that exist today.

**Steps:**
1. Assert structurally that the shared boot seam invokes the gate.
2. Seed an entry point that bypasses it and confirm the assertion fails.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 007: Stale-cover tooth excludes lifecycle-ineligible welds

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/events/registration-validate.ts`
- `tests/integration/events/stale-cover-tooth.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `staleCover_ActiveWeldNamedByNoEdge_Fails` and `staleCover_PlannedOrRetiredWeld_IsExcludedByLifecycle`. The exclusion must be the lifecycle axis expressed as typed structure, never a list of event names.

**Steps:**
1. Compute the eligible population from the lifecycle axis.
2. Fail an active weld that no live edge names.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 008: Pin the eligible count in a non-self-regenerating baseline

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2

**Files:**
- `src/events/emission-eligible-baseline.json`
- `tests/integration/events/eligible-baseline.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `eligibleBaseline_ShrinkWithoutDisposition_Fails` and `eligibleBaseline_ZeroEligible_FailsRatherThanPassingClean`. The guarded run must not regenerate the artifact it is checked against.

**Steps:**
1. Record the eligible count in a checked-in artifact.
2. Fail a shrink with no recorded disposition, and fail a zero count.
3. Add the tests named above.

**Dependencies:** 007
**Parallelizable:** No

### Task 009: Emission role becomes declared data on the authoring surface

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `src/registry/gate-metadata.ts`
- `src/registry/actions/orchestrate/gates.ts`
- `tests/integration/registry/emission-role.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionRole_IsDeclaredOnTheAuthoringSurface` and `emissionRole_RecoveryWithoutOwnerOrExpiry_IsRejected`. The role lands on the existing shape so no third mirror is created.

**Steps:**
1. Add the role to the auto-emission shape.
2. Shape the recovery arm to require an owner and an expiry.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 010: Uniqueness is one primary per event per provider area

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-4

**Files:**
- `src/events/registration-validate.ts`
- `tests/integration/events/emission-fan-in.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionUniqueness_SecondPrimaryInOneArea_FailsNamingBoth` and `emissionUniqueness_MultiDeclarerEventInOneArea_IsConforming`. Roughly thirty live events carry multiple declaring edges, so a per-event uniqueness rule would fail conforming code.

**Steps:**
1. Key uniqueness on event and provider area together.
2. Pin one live multi-declarer event as conforming.
3. Add the tests named above.

**Dependencies:** 009
**Parallelizable:** No

### Task 011: EffectPlan carries a conditioned emission set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/integration/dispatch/effect-carrier-emits.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `effectPlan_CarriesIntentAndTerminalEmissions` and `effectPlan_EmissionNamingUnregisteredEvent_IsRejected`. A single event field cannot express an intent before the effect and one of two terminals after it.

**Steps:**
1. Model emissions as a conditioned set on the plan.
2. Type each against the catalog vocabulary.
3. Add the tests named above.

**Dependencies:** 002, 003
**Parallelizable:** No

### Task 012: Branded appender makes a no-op incapable of committing

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/integration/dispatch/effect-committed.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `runEffect_NoOpAppender_CannotProduceACommittedValue` and `runEffect_DryRunMode_ReachesNeitherThunkNorAppender`. A caller-supplied bare thunk would let the committed type prove only that a parameter was passed.

**Steps:**
1. Brand or store-derive the appender capability.
2. Keep the dry-run branch ahead of both the thunk and the appender.
3. Add the tests named above.

**Dependencies:** 011
**Parallelizable:** No

### Task 013: Idempotency key carries the stream dimension

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/integration/dispatch/effect-idempotency.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite against a real store. Name the behaviors `effectIdempotency_RetriedEffect_AppendsExactlyOnce` and `effectIdempotency_SameKeyDifferentStreams_DoNotCollide`. The claims table keys on stream and key together, so omitting the stream would assert the wrong property.

**Steps:**
1. Include the stream dimension in the key.
2. Assert exactly-once against a real store rather than checking the key's string shape.
3. Add the tests named above.

**Dependencies:** 012
**Parallelizable:** No

### Task 014: Migrate both effect sites onto the declared vocabulary

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-5

**Files:**
- `src/vcs/mutation-owner.ts`
- `src/install/atomic-promotion.ts`
- `tests/integration/vcs/mutation-owner.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across both seams. Name the behaviors `mutationOwner_IntentThenTerminalOrdering_IsPreserved` and `promoteTree_LiveMode_CommitsItsEventBeforeReturning`. The exported event constants stay the module's public surface because another module consumes them.

**Steps:**
1. Resolve both sites' emissions from the declared vocabulary.
2. Leave the intent-effect-terminal ordering and the exported constants intact.
3. Add the tests named above.

**Dependencies:** 013
**Parallelizable:** No

### Task 015: Install the EmissionVerifier in the shipped dispatch chain

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/dispatch.ts`
- `src/dispatch/core/emission-verifier.ts`
- `tests/integration/dispatch/emission-verifier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the dispatch chain. Name the behaviors `emissionVerifier_IsReachedByEveryResultProducingBranch` and `emissionVerifier_ConditionalEdge_IsNotCountedAsSatisfied`. A verifier the chain never calls would be green while measuring nothing.

**Steps:**
1. Install the interceptor in the shipped chain.
2. Assert structurally that no result-producing branch bypasses it.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 016: Verifier enforces the lifecycle axis

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/integration/dispatch/emission-lifecycle.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionLifecycle_RetiredEventEmittedAtRuntime_Fails` and `emissionLifecycle_PlannedEventEmittedAtRuntime_Fails`. The lifecycle axis is enforced, not decorative.

**Steps:**
1. Read the emitted event's lifecycle at verification time.
2. Fail an emission of a planned or retired registration.
3. Add the tests named above.

**Dependencies:** 015
**Parallelizable:** No

### Task 017: Determinate-verdict count is reported and non-zero

**Risk Tier:** high
**Boundary Touching:** false
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/integration/dispatch/emission-indeterminate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionVerifier_AllIndeterminateRun_FailsRatherThanReportingClean` and `emissionVerifier_IndeterminateVerdict_DoesNotPromote`. A verifier returning indeterminate everywhere would otherwise satisfy every other criterion while measuring nothing.

**Steps:**
1. Report the determinate count alongside the verdict.
2. Fail a run whose determinate count is zero, and block promotion on indeterminate.
3. Add the tests named above.

**Dependencies:** 015
**Parallelizable:** No

### Task 018: Seeded skipped emission fails CI under policy selection

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-6

**Files:**
- `src/dispatch/core/emission-verifier.ts`
- `tests/acceptance/emission-seeded-handler.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionPolicy_SeededSkippedEmission_FailsTheCiSuite` and `emissionPolicy_Production_RecordsTelemetryWithoutThrowing`. Mode selection is by policy, not a build flag, and the production arm never breaks a response.

**Steps:**
1. Resolve the mode from policy.
2. Seed a handler that skips its declared emission and confirm CI reddens.
3. Add the tests named above.

**Dependencies:** 016, 017
**Parallelizable:** No

### Task 019: Oracle gains an injected append recorder

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7

**Files:**
- `src/contract/oracle/oracle-seam.ts`
- `src/contract/oracle/fixtures.ts`
- `tests/integration/contract/oracle/oracle-emission-axis.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `oracleAxis_InjectedRecorder_SuppliesAppendEvidence` and `oracleSeam_EmissionAxis_AcquiresNoStoreImport`. Every existing axis takes injected evidence; the module must stay a pure-analysis gate.

**Steps:**
1. Add an append recorder mirroring the effect recorder.
2. Add the emission axis reading only that recorder.
3. Add the tests named above.

**Dependencies:** 015
**Parallelizable:** No

### Task 020: Recorder is threaded onto the live-subject path

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-7

**Files:**
- `src/contract/oracle/fixtures.ts`
- `tests/acceptance/oracle-emission-live-subjects.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `oracleEmissionAxis_LiveSubjects_ProduceDeterminateVerdicts` and `oracleEmissionAxis_ZeroObservedSubjects_FailsRatherThanPassingClean`. Without the live path only seeded fixtures could ever observe, so the zero-observation tooth would never trip.

**Steps:**
1. Thread the recorder onto live subjects, not only seeded ones.
2. Fail a run whose observed-subject count is zero.
3. Add the tests named above.

**Dependencies:** 019
**Parallelizable:** No

### Task 021: Event hop resolves against the weld with declared applicability

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `src/contract/reachability/graph.ts`
- `src/contract/reachability/collect.ts`
- `tests/integration/contract/reachability/graph.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `reachabilityEventHop_ResolvesAgainstTheAnnotationWeld` and `reachabilityEventHop_NonEmittingAction_IsNotApplicableNotMissing`. Resolving from action auto-emissions would ride the same compile pass that supplies the denominator.

**Steps:**
1. Add the hop and declare its applicability rule.
2. Resolve it against the annotation weld and record why not the action side.
3. Add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 022: Closure baseline and regenerated artifact move together

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-8

**Files:**
- `src/contract/reachability/generated/reachability-graph.json`
- `tests/integration/contract/reachability/collect.test.ts`
- `tests/integration/contract/reachability/generated.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `reachabilityClosure_StaysFullyClosedAfterTheEventHop` and `reachabilityArtifact_HopsAndDigest_MatchTheLiveGraph`. The shipped artifact's hop list and digest both change when a hop is added.

**Steps:**
1. Regenerate the shipped artifact.
2. Update the closure assertions in the same change.
3. Add the tests named above.

**Dependencies:** 021
**Parallelizable:** No

### Task 023: Event kill fixture and a strengthened prohibition test

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-8

**Files:**
- `tests/acceptance/reachability-event-kill.test.ts`
- `tests/integration/contract/reachability/kill-fixtures.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `killFixture_MutatedWeldUpstream_DropsCensusBelowClosure` and `prohibitionTest_SelfDerivedHopLabelledRuntime_IsRejected`. A label check alone would pass a self-derived hop that merely calls itself runtime.

**Steps:**
1. Mutate the real upstream through the collector's injection seam.
2. Strengthen the prohibition test past a label comparison.
3. Add the tests named above.

**Dependencies:** 022
**Parallelizable:** No

### Task 024: Ship the new teeth observe-only

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/integration/events/emission-observe-mode.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `emissionTeeth_ObserveMode_ReportsWithoutBlockingBoot`. Arming a blocking gate while its own break set is live would make the tree unbootable for the whole of the downstream work.

**Steps:**
1. Add the observe-only mode for the two new diagnostics only.
2. Leave every existing diagnostic blocking as it is today.
3. Add the test named above.

**Dependencies:** 004, 007
**Parallelizable:** No

### Task 025: Disposition the measured break set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `src/events/event-annotations.ts`
- `tests/integration/events/provider-disposition.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `providerDisposition_EveryDisagreementIsResolvedOrOwned` and `providerDisposition_EntryCoveringNothing_FailsAsStale`. Three of the four disagreements are appended in a tree no provider area covers, so they need an area or a relocation rather than a one-sided edit.

**Steps:**
1. Resolve each disagreement, declaring a new area where neither side is correct.
2. Record any residual exception with an owner, rationale, retirement condition and expiry.
3. Add the tests named above.

**Dependencies:** 024
**Parallelizable:** No

### Task 026: Flip the teeth to blocking and close the census row

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** acceptance
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tools/conformance/src/authority-topology.ts`
- `tests/acceptance/emission-boot-blocking.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `emissionTeeth_BlockingMode_HaltsBootOnAViolation` and `authorityTopology_EffectEventRow_BindsTheCarrierToTheAppendSite`. The row's own representations are the carrier and the append site, so it closes only because the carrier coupling landed.

**Steps:**
1. Flip the two diagnostics to blocking once the break set is clean.
2. Rewrite the row only on the strength of the carrier coupling.
3. Add the tests named above.

**Dependencies:** 014, 025
**Parallelizable:** No

### Parallelization

Two roots start immediately: task 001 opens the catalog chain and task 004 opens the gate chain. They touch different trees and run in parallel worktrees.

- **Wave 1, parallel:** 001 and 004.
- **Wave 2:** the catalog chain 002 and 003 run in parallel after 001; the gate chain fans out from 004 into 005, 006, 007, 009, 015 and 021, which touch distinct files except that 005, 007 and 010 all edit the registration-validation module and must serialize with each other.
- **Wave 3:** the carrier chain 011 through 014 runs after both 002 and 003; the verifier chain 016 through 018 after 015; the oracle chain 019 and 020 after 015; the hop chain 022 and 023 after 021.
- **Wave 4, closeout:** 024, then 025, then 026, which joins the carrier and disposition chains.

Tasks 005, 007, 010, 024 and 026 all edit the registration-validation module and are strictly sequential. Task 026 is the only task that may not begin until both the carrier coupling and the disposition have landed.

### Completion checklist

- [ ] Every DR-N maps to at least one task in the matrix
- [ ] Every task implements a DR-N that exists in this document
- [ ] Every task carries a risk-tier stamp
- [ ] Medium and high-tier tasks carry adequacy-judged tests
- [ ] Open questions are resolved or explicitly deferred with rationale
- [ ] Ready for plan-review
