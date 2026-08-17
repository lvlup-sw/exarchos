# Spec: Effect ledger & emission coupling

**Date:** 2026-08-17 · **Feature:** `effect-ledger-coupling` · **Depth:** deep · **Revision:** 4
**Inputs:** epic [#1822](https://github.com/lvlup-sw/exarchos/issues/1822) · anchors [#1765](https://github.com/lvlup-sw/exarchos/issues/1765) (028), [#1773](https://github.com/lvlup-sw/exarchos/issues/1773) (036), [#1776](https://github.com/lvlup-sw/exarchos/issues/1776) (039), [#1826](https://github.com/lvlup-sw/exarchos/issues/1826) (038b) · re-scoped from [#1763](https://github.com/lvlup-sw/exarchos/issues/1763)

> One unified artifact: the requirements below are the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **DR-N identifiers in this document are local to it.** Sibling specs are referenced by anchor number (028, 036, 039) and issue number only — never by a bare requirement ordinal, which the provenance gate would scrape from this prose as a phantom requirement of this document.
>
> **Revision 4 restores revision 2's comparison and settles the tier question.** Revision 3 retargeted provider identity at `EFFECT_OWNERSHIP`; a three-voter panel refuted that unanimously, and correctly. Revision 4 puts the comparison back where revision 2 had it — the declaring action's composite tool against the event's declared provider, tool against tool — and registers the four carrier events at the tier the type system already designed for them. Three revision-3 inventions are deleted rather than repaired.

## Design & Rationale

### Problem Statement

An effect can land without the event that records it. The authority-topology census names `effect-event` as the only boundary with **no authority at all**, and the row is still observe-only. Three epics wait behind this.

Measured against the landed tree, the carrier claims hold exactly. `EffectPlan` has no `emits` field and its module references the event store zero times. It is constructed in exactly two places — `mutation-owner.ts:381` and `atomic-promotion.ts:751` — with `runEffect` called at `mutation-owner.ts:487` and `atomic-promotion.ts:775`. A third module, `vcs/worktree-provisioner.ts`, consumes carriers but constructs no plan; it is in scope because a carrier signature change breaks it.

**The three VCS names are not in the catalog.** `vcs.requested` / `vcs.executed` / `vcs.compensated` are module-level exported constants registered at *runtime* through `registerEventType`, so they carry no data schema, no type-map entry and no tier. Nothing records the tree-promotion site at `atomic-promotion.ts` at all. (`admission.cutover-ready` is a registered cutover-readiness export record, not the promotion effect — it is one of the 22 events in DR-2's break set, not a substitute for this work.)

### The corrected baseline

Revision 1 was refuted on measurement, revision 2 on the same class of miss, and revision 3 on authority. This section is written to be falsifiable rather than persuasive.

**The NUL-byte trap, named once and for all.** Exactly five `.ts` files in this repository contain literal NUL bytes and are silently skipped by a default `grep`. Any census of this tree must read them directly:

- `src/events/registration-validate.ts` (missed by revision 1)
- `tools/conformance/src/authority-census.ts` (missed by revision 2)
- `src/workflow/feedback.ts`
- `tests/evals/native-baseline/harness.ts`
- `tests/unit/contract/relocation-proof.test.ts`

**Live mechanisms that already do work earlier revisions proposed to build:**

| Already live | What it already guarantees |
|---|---|
| `events/registration-validate.ts`, called first in `initializeContext` | Resolves every `capability` weld against the ledger-backed provider set **at boot**, on the shared boot of both facades, with `PROVIDER_REGISTRY_DRIFT`, `EMPTY_CAPABILITY_DENOMINATOR` and `EMPTY_PROVIDER_REGISTRY` teeth |
| `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` | Every action-declared emission names a registered event whose source is `auto`, with a non-vacuity guard |
| `tests/unit/runbooks/drift.test.ts:221-273` | A **full bijection**, both directions, between `RunbookDefinition.autoEmits` and a set derived from registry actions, with its own non-vacuity denominator test at `:258-272` |
| `src/verbs/gates/check-event-emissions.ts:40-78` | `PHASE_EXPECTED_EVENTS` reconciles against the catalog at module load, throwing on an unregistered name and on a non-`model` source |
| `src/contract/compiler/runtime-authority.ts:496-498` | Audits `policy.evidence.autoEmits` against the shipped runtime surface — a differential between two **independent** projections, per its own header, not a self-comparison |
| `src/storage/sqlite/schema.ts:97-106` | `PRIMARY KEY (streamId, idempotencyKey)` — same key in different streams already cannot collide |
| `tools/conformance/src/authority-census.ts:312-331` | `BOUNDARY_HOP_EVIDENCE['effect-event']` — a **second** authority on the census row, independent of `authority-topology.ts` |

**The tier question is already answered by the type system.** `SubstrateRationale` (`src/events/event-registration.ts:139-186`) is a closed union, and its `'operation-record'` member exists for exactly this shape: *"the durable record a handler writes of the non-idempotent operation it is performing, appended INSIDE the operation rather than by a caller — the INV-13 intent/result split (`*.requested` before the effect, `*.executed` after it)."* Its doc block further records that `capability` **cannot** hold this class, because `consumedBy` is a non-empty tuple on purpose and these records have no consumer fold; 66 of the 170 existing registrations are already in this category. `WELD_RESOLUTION_POLICY.substrate` is `resolvedAt: 'compile'`, and the whole obligation is that the rationale is a member of the closed union.

So the four carrier events are `substrate` / `operation-record`, and they are **correctly outside** the boot-resolved weld population. That is not a compromise and not a gap: the boot weld gate governs events that have a provider and consumers, and an operation record has neither.

**Counts corrected.** Three numbers from earlier revisions could not be reproduced:

| Earlier claim | Measured |
|---|---|
| `RunbookDefinition.autoEmits`: 21 declarations | 18 definitions, 7 non-empty, 20 total entries, 10 distinct events |
| `gate.executed` declared across five registry files | Four: `orchestrate/gates.ts` (17), `verification.ts` (3), `coordination.ts` (2), `review-ops.ts` (2) = 24 edges |
| 74 edges over 44 events ⇒ "roughly 30 multi-declarer events" | Invalid inference — it implies 30 *excess edges*. Exactly **five** events carry ≥2 declaring edges: `gate.executed` (24), `admission.evidence-recorded` (5), `state.patched` (2), `onboard.requested` (2), `onboard.executed` (2) |

### What revision 3 got wrong, and why the comparison goes back

Revision 3 resolved provider identity against `EFFECT_OWNERSHIP` by module-path prefix. That is refuted on three independent measurements:

- **The vocabularies are disjoint.** `CapabilityRegistration.provider` is `EffectProviderId = EffectProvider['tool']` — a composite tool id; the 50 live values are `exarchos_orchestrate` (27), `exarchos_workflow` (14), `exarchos_event` (6), `exarchos_view` (3). `EFFECT_OWNERSHIP.owner` values are owner names. Equality is false for all 50, and re-pointing `provider` at the owner vocabulary would falsify two shipped compile-time proofs in the module being edited (`registration-validate.ts:403-405`, `:412-414`).
- **There is no event-to-module map to resolve from.** `AutoEmission` is `{ event, condition, description? }`; `ToolAction` carries no module path. The ledger's only path input is an async filesystem walk of `src/`, which does not exist inside the compiled single-file binary and cannot run at boot.
- **The ledger is scoped to effect occurrences, not appends.** Ten top-level `src/` directories carry no rule at any depth (`cli/`, `describe/`, `mcp/`, `ndjson/`, `pruner/`, `registry/`, `review/`, `runbooks/`, `stack/`, `tasks/`) and cannot legally receive one — a rule claiming no occurrence is `STALE_OWNERSHIP`. Meanwhile its ~37 existing rules cover the trees most break-set events append from, so a "ledger-owned is named" criterion is simultaneously too narrow to help and too broad to measure anything.

The comparison therefore returns to revision 2's formulation: **the declaring action's composite tool against the event's declared provider.** Both sides are tool ids, both are available from registry data alone, and no module scan is involved. `EFFECT_PROVIDERS` stays exactly as it is — a tool-keyed join whose bijection with the dispatch loader map is correct and load-bearing — and nothing is added to it.

Three revision-3 inventions are deleted rather than repaired: the `EFFECT_OWNERSHIP` retarget, the `tasks/` ownership rule, and the criterion that a ledger-owned append site counts as a naming edge.

### Chosen Approach

Extend what ships; do not rebuild beside it. The boot gate already resolves welds and already fails on an empty denominator, so the provider comparison and the stale-cover tooth are added to *it*, and its `WELD_RESOLUTION_POLICY` table stays the one place the tier axis is decided.

**Observe-only is built first, not retrofitted.** `assertRegistrationWeldsAtStartup` throws on *any* non-empty diagnostic list — it has no severity axis — and runs on the shared boot of both facades. The severity axis therefore lands before the first new diagnostic, and the flip to blocking is gated on **both** new diagnostics having their break sets dispositioned, not just one.

The catalog work is independent of the boot gate under the substrate tier, so it does not wait on the severity axis. The carrier then couples as a consumer of the registered vocabulary. Enforcement for carrier-emitted events comes from the type system and the dispatch verifier — per-operation, and stronger than a boot-time registration name check.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: The boot gate compares declaring tool against declared provider

The existing boot-time weld gate gains the one comparison it does not make: whether the composite tool of the action that declares an emission matches the event's declared provider.

**Acceptance criteria:**
- The comparison lands in the shipped registration-validation module and is reached through the existing startup assertion; no new boot entry point is introduced.
- Both sides of the comparison are composite tool ids. The declaring side comes from the registry (the action's owning tool); the declared side is `CapabilityRegistration.provider`. No module-path resolution and no filesystem scan is involved.
- For every `capability` event named by at least one live emission edge, the two agree, or a diagnostic names both sides.
- The existing weld resolution, drift and empty-denominator diagnostics are preserved unchanged; the tier policy table remains the single place the tier axis is decided.
- **The comparison's own denominator is pinned.** The intersection of declared events and welded events is asserted non-empty and at its measured size by a test that fails when it shrinks. `EMPTY_CAPABILITY_DENOMINATOR` does not discharge this: it counts boot-resolved welds, not the comparison subject.
- The existing boot-reachability guard is **extended** to exercise the new diagnostics through the real seam. No second guard is filed for a property that guard already holds.

### DR-2: Stale-cover tooth over the lifecycle-eligible population

A weld covering no live emission edge is stale cover. The eligible population must exclude events the drift rule makes structurally unnameable, or the tooth fires on conforming code.

**Acceptance criteria:**
- A `capability` event whose lifecycle is `active` and which no live emission edge names fails as stale cover.
- Events with lifecycle `planned` or `retired` are **excluded by the lifecycle axis**, expressed as typed structure, never a per-event list.
- The eligible count is reported alongside the verdict, and a run whose eligible population is zero fails rather than passing clean.
- The eligible count is pinned in a named baseline artifact that the guarded run does not regenerate, read from disk at test time. It is filed under `tests/support/`, which has no own-level file count to renegotiate — `tools/audit` is at its pinned exemption ceiling of 52 and `tools/audit/gates` holds 40 own-level files.
- The measured break set is **22 active capability events**, not zero, and every one is dispositioned before the tooth can block. Re-derived: 50 capability annotations, 19 named by a live edge, 31 unnamed, of which exactly 9 are `planned`/`retired`.
- The four events DR-3 registers are `substrate` tier and are therefore **not** in this population. No criterion claims they are covered by it.

### DR-3: The VCS and promotion effects become declarable

Both effect sites emit names the declaration system cannot see. Until the catalog contains them, `emits` has nothing to resolve against.

**Acceptance criteria:**
- The three VCS ledger events are registered with data schemas, type-map entries and annotations at **`substrate` tier with `rationale: 'operation-record'`**, replacing the runtime registration seam for these three names. That rationale's doc block names the INV-13 intent/result split these events are; `capability` is unavailable to them because they have no consumer fold.
- A promotion event is registered the same way for the atomic tree-promotion site.
- **Nothing is added to `EFFECT_PROVIDERS`, and no `EFFECT_OWNERSHIP` rule is added.** No provider area is declared for `vcs/` or `install/`.
- Every pinned assertion the four new events move is updated in the same change, named explicitly: `tests/unit/events/schemas.test.ts:653` and `:4254`, `tests/unit/events/schemas.legacy.test.ts:559` (all `toHaveLength(171)`), the test **name** at `tests/unit/events/event-annotations.test.ts:60` (the assertion at `:67` is a relative cardinality comparison and does not move), the exact-tuple assertion at `tests/architecture/identifier-stability.test.ts:79`, `tools/audit/registered-actions-snapshot.json` including its `counts.eventTypes` field, and the second snapshot test at `identifier-stability.test.ts:329`.
- `tools/audit/gates/measured-premises-derive.ts:72` derives `event-types-total` from `EventTypes.length`. The premise document that consumes it is created by the sibling re-scope spec, which also makes that gate fail closed. This plan declares that coupling explicitly and records the value it must carry after the catalog grows.
- Consumer resolution at boot is **out of scope**: `registration-validate.ts:59-68` records that `consumedBy` is deliberately unresolved and wants its own task.

### DR-4: Emission ownership is declared data, with fan-in modelled as normal

Ownership is declared, never inferred. **Uniqueness is not the property to specify.** One-primary-per-event is falsified on the live tree, and one-primary-per-provider-area is falsified the same way: four of the five multi-declarer events live entirely inside a single area.

**Acceptance criteria:**
- Each emission edge carries a role of `primary` or `recovery` as declared data on the existing authoring surface; no code path infers a role.
- **Every edge carries an owner**, not only the recovery arm. A recovery edge additionally carries an ISO expiry, and an expired entry fails.
- The authoring surface is `AutoEmission`, but the edges live across twelve declaration files. `role` and `owner` are optional on the type so the field can land in one change without a compile break, and a totality tooth asserts that every live edge carries both.
- **No uniqueness rule is specified.** The property is that every edge resolves to an owner and an event's owner set is *internally consistent* — defined as: all edges for one event name the same owner, or each names a distinct owner and at most one is `primary`. A multi-declarer event is conforming; tests pin `gate.executed` (24 edges, one area) and `state.patched` (2 edges, two areas) as the two canonical conforming shapes.

### DR-5: EffectPlan couples as a consumer of the declared vocabulary

The carrier gains an emission declaration and an appender. It resolves against the catalog vocabulary rather than defining its own.

**Acceptance criteria:**
- `EffectPlan` carries its emissions as a **set with conditions**, not a single event: the mutation owner emits an intent before the effect and one of two terminals after.
- The appender is not a bare caller-supplied thunk — it is a branded or store-derived capability, so passing a no-op cannot yield a committed value.
- The committed value is unreachable without the append. The proof is an exported `Expect<...>` type alias **in a source module**, following the idiom at `registration-validate.ts:390-436`. A `.test.ts` cannot discharge this: `tests/tsconfig.json:86-93` excludes the unit and integration tiers from the typecheck program, and vitest strips types.
- The dry-run arm is unchanged and still reaches neither the thunk nor the appender.
- The idempotency key includes the **stream** dimension. The falsifier is that a key built without it is rejected at construction — not that two streams fail to collide, which the claims table's composite primary key already guarantees and which would pass identically before and after.
- **The three existing owner and class vocabularies are reconciled or explicitly separated.** `effect-carrier.ts:27-33` declares its own six-member `EffectClass` (`filesystem | process | vcs | install | network | compensation`) distinct from the ledger's three-member one, and `EffectPlan.owner` already carries a third vocabulary (`'vcs-mutation-owner'`, `'install/atomic-promotion'`). The spec states which axis governs which claim rather than adding `emits` beside them silently.
- Every live consumer of the carrier migrates in the same change, including `vcs/worktree-provisioner.ts` and all six existing test importers.

### DR-6: EmissionVerifier asserts declared emissions landed, lifecycle included

A post-dispatch interceptor asserts that every unconditional contract for the operation landed. A violation is an Exarchos bug, not agent misbehavior.

**Acceptance criteria:**
- The interceptor is **installed in the shipped dispatch chain**, filed under `src/dispatch/core/interceptors/` beside the one existing precedent.
- **Applicability is declared**, following DR-8's precedent: a branch that returns before a handler runs has no emission contract to verify and is `not-applicable`, not a violation. Without this the structural assertion is either permanently red or silently narrowed to whatever passes.
- A test asserts by structure that no *handler-completing* branch bypasses the interceptor, **and** seeds a bypassing branch to confirm the assertion reddens. The measured bypass set is: `dispatch.ts:643` and `:657` (outside the async-local scope, which opens at `:714`), `:721`, `:732`, `:805`, `:931`, `:945`, `:966` (inside the scope but above the interceptor call at `:989`), and the entire custom-tool path — a `registeredTool` with custom handlers but absent from `COMPOSITE_HANDLERS` has `isBuiltIn === false`, falls to `coreHandler` at `:1025-1027` and returns at `:1146`/`:1148`.
- It evaluates the operation's unconditional edges; conditional edges are out of subject and must not be counted as satisfied.
- A registration whose lifecycle is `planned` or `retired` but which is nonetheless emitted at runtime **fails**.
- On violation it appends an emission-violation event carrying the action, the full missing set and the operation id. No such event exists in the catalog, so registering it is owned work and moves the same pinned assertions DR-3 names, a third time.
- Enforcement mode is selected by a named policy key added to the `.exarchos.yml` schema. **The no-config path is specified:** `initializeContext` returns without `projectConfig` when no `projectRoot` is supplied (CLI cold start and most tests), so the interceptor's behavior on that path is stated rather than left to a resolved default that never applies.
- **Indeterminate is distinct from pass** and does not promote; the count of determinate verdicts is reported, and an all-indeterminate run fails rather than reporting clean.
- A seeded handler that skips its declared emission fails the CI suite.

### DR-7: Oracle emission axis observes the append, not the declaration

The oracle gains an emission axis whose evidence is an observed append. It must not become a live store consumer — every existing axis takes injected evidence, and the module declares itself a pure-analysis gate.

**Acceptance criteria:**
- The axis's recorder is created the way the effect recorders already are — minted inside `oracle-seam.ts` and injected into the observed handler as part of the observation context. There is no caller-supplied recorder parameter today and none is added; the module acquires no store import.
- **The reason real handlers report not-observed is named correctly:** `compositeHandlerAdapter` (`fixtures.ts:471-492`) invokes `handler(args, dispatchCtx)` and never reads the observation context's recorders. The emission axis is threaded through that adapter so live subjects can produce a determinate verdict.
- A seeded handler declaring an emission it does not perform is caught even when the generated files agree.
- **The zero-observation tooth is scoped to the emission axis only.** `runOracleSuite` computes `ok` from `status === 'fail'`, so a suite-wide not-observed failure would redden the three existing all-not-observed axes, which are actively pinned at `tests/unit/contract/oracle/fixtures.test.ts:219-221` and `:376-381`.

### DR-8: Reachability event hop resolves against the weld, with applicability declared

The hop resolves against the capability weld — independent of the compile pass that supplies the denominator.

**Acceptance criteria:**
- The hop list gains `event` only. The `consumer` hop is implemented by the sibling re-scope spec.
- The hop's `HOP_AUTHORITIES` class is **`'runtime'`**, matching the value the sibling spec sets for its hops, so the two plans cannot land different values for the same axis.
- The hop's authority is the annotation-side weld, never action `autoEmits` **as the compiled contract projects it**. The rejection is scoped: `runtime-authority.ts:496-498` already reads `autoEmits` through an independent runtime projection, so `autoEmits` per se is not disqualified — deriving the hop from the same compile pass that supplies the denominator is.
- Applicability is declared explicitly, following the mutation-gated precedent, so actions outside the emitting population are `not-applicable` rather than `missing`.
- **The hop addition and every assertion it invalidates land in one change**, because widening `ReachabilityHop` is a type change with fan-out: the byte-equality and `fullyClosed` pins in `tests/unit/contract/reachability/generated.test.ts` and the checked-in artifact, the closure assertions in `collect.test.ts`, the total `Record<ReachabilityHop, …>` counts literal at `graph.ts:227-235`, and the hand-authored `ReachabilityInputs` literals at `tools/conformance/src/authority-census.test.ts:290-301` and `:505-515` — the last being a `tsc --noEmit -p tools/conformance` failure inside a required check.
- The kill-fixture suite gains an event entry that mutates the real upstream through the collector's existing injection seam.
- **The real anti-tautology target is named:** `kill-fixtures.test.ts:337` asserts `KILLED_HOPS` equals `REACHABILITY_HOPS`. The label check at `graph.test.ts:90-92` cannot be strengthened by adding a class, because `'self'` is not a member of the `HOP_AUTHORITIES` value type and no well-typed entry can fail it.

### DR-9: Boot fails closed, sequenced behind both of its disposition sets

The gate blocks every entry point, so it must not be armed while either of its break sets is live.

**Acceptance criteria:**
- The observe-only severity axis ships **before the first new diagnostic**.
- **Both** new diagnostics have a measured, enumerated and dispositioned break set before the flip. The stale-cover set is the 22 active capability events. The provider-comparison set is measured and dispositioned by its own task; revision 3 armed it with nothing gating it.
- A boot failure reports every violating edge in one pass, naming the action, the event, the declared provider and the declaring tool.
- The gate fails closed on an empty or unresolvable population rather than reporting clean.
- The flip task owns `tests/unit/events/registration-validate.boot.test.ts`, whose `InitializeContext_LiveCatalog_BootsClean` positive control is the assertion a premature flip breaks.
- The `effect-event` census row moves only when the carrier sites are genuinely coupled, and **all** of the row's authorities move together: `authority-topology.ts`, `authority-census.ts:312-331`'s `BOUNDARY_HOP_EVIDENCE`, and `tools/audit/core/authority-live-proof.ts`, which `authority-census.test.ts:609` requires a live cell's `oracle.module` to name.
- Re-pointing the row at a different representation pair is reclassification and is forbidden. If the carrier coupling does not land, the row stays a recorded known-open row.

## Technical Design

The boot gate is the spine and it already exists. Its weld-resolution policy table is total over the tier axis, so the provider comparison and the stale-cover tooth are added as additional diagnostics on the `capability` arm rather than as a parallel module.

Provider identity is a composite tool id on both sides of the comparison. The declaring side comes from the registry, which knows which action declares which emission and which tool owns each action; the declared side is the annotation's `provider`. This is why no module-path resolution appears anywhere in this revision.

The four carrier events are `substrate` / `operation-record` and sit outside the boot-resolved population by design. Their enforcement is the type system — the committed value is unreachable without the append — plus the dispatch verifier, which checks per operation rather than per registration.

The severity axis precedes every new diagnostic and the flip is gated on both break sets. The reachability hop resolves against the annotation half, and its type widening lands with all its fan-out in one change.

## Integration Points

- `src/events/registration-validate.ts` — severity axis, provider comparison, stale-cover tooth.
- `src/registry/` — the declaring side of the comparison (action → owning tool) and the `AutoEmission` role and owner fields.
- `src/dispatch/core/context.ts` — the shared boot seam the gate is already reached from; unchanged but asserted.
- `src/events/schemas.ts`, `src/events/event-annotations.ts` — the four substrate registrations, the emission-violation event, and the pinned counts.
- `src/dispatch/core/effect-carrier.ts`, `src/vcs/mutation-owner.ts`, `src/install/atomic-promotion.ts`, `src/vcs/worktree-provisioner.ts` — the carrier coupling and all its live consumers.
- `src/dispatch/core/interceptors/` — where the verifier is filed and installed.
- `src/contract/oracle/oracle-seam.ts`, `src/contract/oracle/fixtures.ts` — the emission axis and the adapter that must read it.
- `src/contract/reachability/graph.ts`, `collect.ts` — the event hop and its applicability rule.
- `tools/conformance/src/authority-topology.ts`, `authority-census.ts`, and `tools/audit/core/authority-live-proof.ts` — the census row's three authorities.

## Exploration

Four revisions, three adversarial panels. Revision 1 was refuted on baseline, revision 2 on the same class of miss, revision 3 on authority. The through-line is that this tree's authorities do not compose the way a reading of their names suggests, and every claim of the form "nothing does X" has been wrong at least once.

Revision 3's specific error is instructive: it treated the boot weld gate as the thing that must see carrier-emitted events, and engineered a new authority to make that possible. The type system had already answered the question — `SubstrateRationale.operation-record` exists, its doc block describes the exact intent/result split these events are, and it records that `capability` cannot hold consumer-less handler records. The ambition that one rule should span both emission styles was added in revision 3 and was wrong on the merits, not merely unachievable.

What survives from every revision: the coupling authority is the annotation weld, not the carrier. What is smaller than any revision claimed: the guard work. What is unchanged since revision 1: the counts.

## Alternatives considered

- **Declare `vcs/` and `install/` in `EFFECT_PROVIDERS`.** Revision 2's design. Rejected: the table is keyed by composite tool and pinned to the dispatch loader set by a throwing ratchet and an equality assertion.
- **Add real `exarchos_vcs` / `exarchos_install` composite tools.** Rejected on structure rather than budget. The VCS actions' handlers live in `verbs/vcs/`, so the declared area would be `verbs/vcs/` while the append site sits in `vcs/` — they still would not coincide. And the same treatment would be needed for `install/`, `tasks/`, `stack/` and `review/`, at which point the provider vocabulary mirrors the directory tree and `EffectProviderId` has stopped meaning "dispatch key". The cost is also concrete: `registry.test.ts:601` pins `TOOL_REGISTRY` at 5, `:628` pins visible at 4, `:630` pins the exact name list.
- **Resolve provider identity against `EFFECT_OWNERSHIP`.** Revision 3's design. Rejected on three measurements: disjoint vocabularies, no event-to-module map, and a ledger scoped to effect occurrences rather than appends.
- **Annotate the four carrier events at `capability` tier.** Rejected: `consumedBy` is a non-empty tuple on purpose and these records have no consumer fold, so the type forbids it before any gate runs.
- **Keep single-primary-per-event, or per-area.** Both rejected: falsified on the live tree by the same measurement.
- **Fold runbook emissions into the comparison.** Rejected as vacuous: `runbooks/drift.test.ts` already forces runbook `autoEmits` to equal an action-derived set in both directions.
- **Add an `EFFECT_OWNERSHIP` rule for `tasks/`.** Rejected: `src/tasks/` has zero effect occurrences, so the rule is `STALE_OWNERSHIP` and reddens two live exit proofs. It also could not resolve the disagreement it was introduced for.
- **Un-ignore `docs/specs/`.** Rejected: `.gitignore:86-119` records that these entries are mount points, that a committed symlink hard-codes one machine's layout, and that this mistake was already shipped once.

## Open Questions

None load-bearing.

- **Tier for the carrier events** — resolved by the type system: `substrate` / `operation-record`.
- **Provider areas for `vcs/` and `install/`** — resolved: none are declared, and none are needed.
- **The `src/tasks/` provider disagreements** — carried as a recorded disposition in DR-2's break-set task, not repaired by a ledger rule. They are a vocabulary mismatch between an annotation and a declaring tool, and the comparison names both sides, which is the intended outcome for a genuine disagreement.
- **The sibling hop task** — a declared orchestration precondition on the DR-8 chain, stated as a human/orchestrator check rather than a guard, because no mechanical check can enforce an assumption about another document.

## Decomposition

The decomposition maps every task to one or more DR-N from the requirements above.

### Scope

**Target:** Full design — all nine requirements.
**Excluded:** The `consumer` reachability hop's implementation, owned by the sibling re-scope spec. Consumer-set resolution at boot. Migrating the wider effect surface onto the carrier beyond the existing construction sites. Populating or retiring the empty observation tier.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Boot gate compares declaring tool against declared provider | 005, 006, 011 |
| DR-2 | Stale-cover tooth over the lifecycle-eligible population | 008, 009, 010 |
| DR-3 | The VCS and promotion effects become declarable | 001, 002, 003 |
| DR-4 | Emission ownership is declared data, fan-in normal | 012, 013 |
| DR-5 | EffectPlan couples as a consumer of the declared vocabulary | 014, 015, 016, 017 |
| DR-6 | EmissionVerifier asserts declared emissions landed | 018, 019, 020, 021, 022 |
| DR-7 | Oracle emission axis observes the append | 023, 024 |
| DR-8 | Reachability event hop resolves against the weld | 025, 026 |
| DR-9 | Boot fails closed, sequenced behind both disposition sets | 004, 007, 027, 028 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth. Tests are judged test-after by adequacy. Where a task changes behavior a live guard pins, that guard is in the task's own Files list.

### Task 001: Register the vcs ledger events at substrate tier

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/events/schemas.ts`
- `src/events/event-annotations.ts`
- `tests/unit/events/schemas.test.ts`
- `tests/unit/events/schemas.legacy.test.ts`
- `tests/unit/events/event-annotations.test.ts`
- `tests/architecture/identifier-stability.test.ts`
- `tools/audit/registered-actions-snapshot.json`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `VcsLedgerEvents_SubstrateTier_CarryOperationRecordRationale` and `VcsLedgerEvents_RuntimeSeam_IsNoLongerUsed`. The tier is `substrate` with `rationale: 'operation-record'`, whose doc block names the INV-13 intent/result split these three events are. Three `toHaveLength(171)` pins move here, as does the exact-tuple assertion at `identifier-stability.test.ts:79`, the snapshot's `counts.eventTypes`, and the stale test name at `event-annotations.test.ts:60`.

**Steps:**
1. Register the three names with data schemas and type-map entries.
2. Annotate each at substrate tier with the operation-record rationale.
3. Update every pinned assertion and the snapshot in this same change.
4. Add the tests named above.

**Dependencies:** None
**Parallelizable:** No

### Task 002: Register a promotion event for the tree-promotion site

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/events/schemas.ts`
- `src/events/event-annotations.ts`
- `tests/unit/events/schemas.test.ts`
- `tests/unit/events/schemas.legacy.test.ts`
- `tests/unit/events/event-annotations.test.ts`
- `tests/architecture/identifier-stability.test.ts`
- `tools/audit/registered-actions-snapshot.json`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `PromotionEvent_SubstrateTier_CarriesOperationRecordRationale` and `PromotionEvent_AtomicPromotionSite_HasARegisteredName`. Strictly sequenced after task 001: both edit the same two source files and move the same pinned counts. This event is distinct from `admission.cutover-ready`, which records cutover readiness rather than the promotion effect.

**Steps:**
1. Register the promotion event with its data schema and type-map entry.
2. Annotate it at substrate tier with the operation-record rationale.
3. Move the same pinned assertions forward by one.
4. Add the tests named above.

**Dependencies:** 001
**Parallelizable:** No

### Task 003: Record the measured-premise coupling for the catalog count

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `tools/audit/gates/measured-premises-derive.ts`
- `tests/unit/scripts/measured-premises.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `MeasuredPremises_EventTypesTotal_MatchesTheLiveCatalog` and `MeasuredPremises_StaleTotal_FailsClosed`. `measured-premises-derive.ts:72` derives `event-types-total` from `EventTypes.length`. The premise document that consumes it is created by the sibling re-scope spec, which also makes the gate fail closed — so this task records the coupling and the post-catalog value rather than assuming the document exists.

**Steps:**
1. Assert the derived total matches the live catalog after the four registrations.
2. Record the coupling to the sibling spec's premise document and the value it must carry.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** No

### Task 004: Give the startup assertion a severity axis

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`
- `tests/unit/events/registration-validate.boot.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the boot seam. Name the behaviors `StartupAssertion_ObserveSeverity_ReportsWithoutThrowing` and `StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation`. This ships before any new diagnostic: the assertion throws on any non-empty diagnostic list today, so a tooth landing first makes the tree unbootable for the whole downstream tail.

**Steps:**
1. Give each diagnostic a severity and have the startup assertion throw only on blocking ones.
2. Default every existing diagnostic to blocking so current behavior is byte-identical.
3. Extend the two live test files with the observe-mode cases.

**Dependencies:** None
**Parallelizable:** No

### Task 005: Compare declaring tool against declared provider

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `ProviderComparison_DeclaringToolMatchesProvider_IsConforming` and `ProviderComparison_Disagreement_NamesBothSides`. Both sides are composite tool ids: the declaring side comes from the registry's action-to-tool mapping, the declared side from the annotation. No module path is resolved. The diagnostic ships at observe severity. `registration-validate.test.ts:88` asserts `verdict.ok === true` against the live catalog and goes false on the measured disagreements — that assertion is updated here, not shadowed.

**Steps:**
1. Add the comparison as an additional diagnostic on the capability arm, at observe severity.
2. Report the action, the event, the declared provider and the declaring tool in one pass.
3. Update the live `verdict.ok` assertion and add the tests named above.

**Dependencies:** 004
**Parallelizable:** No

### Task 006: Pin the comparison denominator

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `ComparisonDenominator_LiveIntersection_IsNonEmptyAtMeasuredSize` and `ComparisonDenominator_SeededShrink_FailsRatherThanPassingClean`. The intersection is pinned by nothing today: the annotation side is pinned by identifier-stability, but the snapshot shape carries no `autoEmits`, so the edge side's only floor is a single any-populated assertion.

**Steps:**
1. Report the intersection size alongside the verdict.
2. Assert it is non-empty and at its measured size, failing on shrinkage.
3. Add the tests named above, including the seeded-shrink case.

**Dependencies:** 005
**Parallelizable:** No

### Task 007: Measure and disposition the provider-comparison break set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `ProviderBreakSet_EveryDisagreementIsDispositioned` and `ProviderBreakSet_UndispositionedEntry_Fails`. Revision 3 armed this diagnostic with nothing gating it. The set is enumerated here with a recorded disposition per entry; the `task.claimed` / `task.completed` / `task.failed` disagreements are genuine and are recorded as such rather than repaired, because the comparison naming both sides is the intended outcome for a real mismatch.

**Steps:**
1. Enumerate every disagreement the comparison reports on the live catalog.
2. Record a disposition per entry, distinguishing genuine mismatches from annotation errors.
3. Add the tests named above.

**Dependencies:** 006
**Parallelizable:** No

### Task 008: Stale-cover tooth over the lifecycle-eligible population

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `src/events/registration-validate.ts`
- `src/events/event-annotations.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `StaleCover_ActiveWeldNamedByNoEdge_FailsAsStale` and `StaleCover_PlannedOrRetired_IsExcludedByLifecycle`. Ships at observe severity. The four substrate events from tasks 001 and 002 are not in this population and no criterion claims they are.

**Steps:**
1. Add the tooth on the capability arm at observe severity.
2. Exclude `planned`/`retired` by the lifecycle axis as typed structure, never a list.
3. Report the eligible count and fail a zero-eligible run.
4. Add the tests named above.

**Dependencies:** 003, 007
**Parallelizable:** No

### Task 009: Pin the eligible count in a non-self-regenerating baseline

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `tests/support/emission-eligible-baseline.json`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EligibleBaseline_PinnedCount_MatchesTheLiveCount` and `EligibleBaseline_ShrinkWithNoDisposition_Fails`. Read from disk at test time, not at boot: `resolveJsonModule` is not enabled and a sibling JSON is not on disk inside the compiled single-file binary. Filed under `tests/support/`, which has no own-level files — `tools/audit` sits at its pinned exemption ceiling of 52 and `tools/audit/gates` holds 40.

**Steps:**
1. Record the measured eligible count and the disposition schema in the baseline file.
2. Read it with fs at test time and compare against the live count.
3. Add the tests named above.

**Dependencies:** 008
**Parallelizable:** No

### Task 010: Disposition the stale-cover break set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `src/events/registration-validate.ts`
- `src/events/event-annotations.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `StaleCoverBreakSet_EveryActiveUnnamedWeld_IsDispositioned` and `StaleCoverBreakSet_UndispositionedEntry_Fails`. The set is 22 active capability events, including `ci.status`, `tool.completed`, `turn.completed`, `subagent.tokens_used`, `launch.executed`, `prune.executed`, `worktree.orphan_detected`, `benchmark.completed` and `admission.cutover-ready`. Each is resolved by a lifecycle correction or a recorded disposition — never by relabelling, and never by a ledger rule.

**Steps:**
1. Enumerate the 22 and record each one's append site.
2. Resolve each by lifecycle correction or recorded disposition.
3. Add the tests named above.

**Dependencies:** 009
**Parallelizable:** No

### Task 011: Extend the boot-reachability guard

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `tests/unit/events/registration-validate.boot.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `BootGate_NewDiagnostics_AreReachedThroughTheRealSeam`. The existing file already drives the unmocked gate through `initializeContext` with a positive control and states its own kill probe; this task extends that guard rather than filing a second one. Note that the file makes a single `initializeContext` call and cannot discriminate one facade from the other — the shared-seam property is argued in its header, and this task does not claim a facade-distinguishing assertion it cannot write.

**Steps:**
1. Extend the existing boot test so the new diagnostics are exercised through the real seam.
2. Confirm the file's stated kill probe still reddens the suite.

**Dependencies:** 005
**Parallelizable:** No

### Task 012: AutoEmission gains role and owner as declared data

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/registry/gate-metadata.ts`
- `tests/unit/registry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `AutoEmission_DeclaredRole_IsNotInferred` and `AutoEmission_RecoveryEdgeWithExpiredOwner_Fails`. Both `role` and `owner` are optional on the type so the twelve declaration files can be populated in one following change without a compile break; task 013 supplies the totality tooth that stops the fields staying empty.

**Steps:**
1. Add the optional role and owner fields, with an ISO expiry on the recovery arm.
2. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 013: Populate roles and owners on every live edge

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/registry/actions/workflow.ts`
- `src/registry/actions/orchestrate/invariants.ts`
- `src/registry/actions/orchestrate/lifecycle-ops.ts`
- `src/registry/actions/orchestrate/verification.ts`
- `src/registry/actions/orchestrate/vcs.ts`
- `src/registry/actions/orchestrate/cutover.ts`
- `src/registry/actions/orchestrate/review-ops.ts`
- `src/registry/actions/orchestrate/worktree.ts`
- `src/registry/actions/orchestrate/merge.ts`
- `src/registry/actions/orchestrate/onboarding.ts`
- `src/registry/actions/orchestrate/coordination.ts`
- `src/registry/actions/orchestrate/gates.ts`
- `tests/unit/registry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the registry seam. Name the behaviors `EmissionRoles_EveryLiveEdge_CarriesRoleAndOwner` and `EmissionRoles_MultiDeclarerEvent_IsConforming`. **This task is deliberately twelve source files and is not split.** Every candidate split cuts through a fan-in event: `state.patched` spans `workflow.ts` and `orchestrate/review-ops.ts`, and both `onboard.requested` and `onboard.executed` edges span `orchestrate/lifecycle-ops.ts` and `orchestrate/onboarding.ts`. A split would author one event's owner set in two tasks with nothing asserting cross-file consistency, which is the property DR-4 exists to state. The second behavior pins `gate.executed` (24 edges, one area) and `state.patched` (2 edges, two areas) as the two canonical conforming shapes. **No uniqueness rule is asserted.**

**Steps:**
1. Add a role and an owner to every live edge across the twelve declaration files.
2. Assert totality over the live edge set, so the denominator cannot be near-empty.
3. Assert internal consistency as DR-4 defines it, and pin both conforming shapes.

**Dependencies:** 012
**Parallelizable:** No

### Task 014: EffectPlan carries a conditioned emission set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EffectPlan_Emits_IsAConditionedSet` and `EffectPlan_DryRunArm_ReachesNeitherThunkNorAppender`. This task also states which axis governs which claim across the three existing vocabularies: the carrier's own six-member `EffectClass` at `:27-33`, the ledger's three-member one, and `EffectPlan.owner`'s free-form values at both construction sites.

**Steps:**
1. Add the conditioned emission set to the carrier type.
2. Record which axis governs which claim, or separate them explicitly.
3. Leave the dry-run arm unchanged and assert it.

**Dependencies:** 001, 002
**Parallelizable:** No

### Task 015: Branded appender makes a no-op incapable of committing

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `EffectCarrier_NoOpAppender_CannotYieldACommittedValue`. The compile-time half is an exported `Expect<...>` alias in the source module, following the existing idiom — a `.test.ts` cannot discharge it, because the tests program excludes the unit and integration tiers and vitest strips types.

**Steps:**
1. Make the appender a branded or store-derived capability.
2. Add the exported type-level proof alias in the source module.
3. Add the runtime test named above.

**Dependencies:** 014
**Parallelizable:** No

### Task 016: Idempotency key carries the stream dimension

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `EffectIdempotency_KeyBuiltWithoutStream_IsRejectedAtConstruction`. The falsifier is construction-time rejection, not two streams failing to collide — the claims table already declares `PRIMARY KEY (streamId, idempotencyKey)`, so a collision test passes identically before and after and would measure nothing.

**Steps:**
1. Include the stream dimension in the key and reject a key built without it.
2. Add the test named above.

**Dependencies:** 015
**Parallelizable:** No

### Task 017: Migrate every live carrier consumer

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/vcs/mutation-owner.ts`
- `src/install/atomic-promotion.ts`
- `src/vcs/worktree-provisioner.ts`
- `tests/unit/vcs/mutation-owner.test.ts`
- `tests/unit/vcs/worktree-provisioner.test.ts`
- `tests/unit/install/atomic-promotion.test.ts`
- `tests/unit/install/atomic-promotion.orphan.test.ts`
- `tests/unit/verbs/team/setup-worktree.integration.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across both effect seams. Name the behaviors `MutationOwner_IntentThenTerminalOrdering_IsPreserved` and `PromoteTree_LiveMode_CommitsItsEventBeforeReturning`. Six test files import the carrier; the sixth, `tests/unit/dispatch/core/effect-carrier.test.ts`, is owned by tasks 014 to 016. **This task is deliberately atomic** despite spanning five modules: the carrier signature change breaks `worktree-provisioner.ts` the moment it lands, so splitting the consumer migration would open a window in which the tree does not compile.

**Steps:**
1. Migrate both construction sites onto the declared vocabulary.
2. Update the third consumer for the new signature.
3. Update the five live test files listed here.

**Dependencies:** 016
**Parallelizable:** No

### Task 018: Register the emission-violation event

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/events/schemas.ts`
- `src/events/event-annotations.ts`
- `tests/unit/events/schemas.test.ts`
- `tests/unit/events/schemas.legacy.test.ts`
- `tests/unit/events/event-annotations.test.ts`
- `tests/architecture/identifier-stability.test.ts`
- `tools/audit/registered-actions-snapshot.json`
- `tools/audit/gates/measured-premises-derive.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionViolation_Registered_CarriesActionAndMissingSet` and `EmissionViolation_SubstrateTier_CarriesOperationRecordRationale`. No contract-violation or emission-violation event exists in the catalog today, so this is owned work rather than a citation. It moves the same pinned assertions as tasks 001 and 002, a third time, and shifts the derived `event-types-total` again.

**Steps:**
1. Register the event with a data schema carrying the action, the missing set and the operation id.
2. Annotate it at substrate tier with the operation-record rationale.
3. Move every pinned assertion and the derived premise value.

**Dependencies:** 003, 010
**Parallelizable:** No

### Task 019: Install the EmissionVerifier with declared applicability

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `src/dispatch/core/dispatch.ts`
- `tests/unit/dispatch/core/dispatch.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EmissionVerifier_EveryHandlerCompletingBranch_ReachesIt` and `EmissionVerifier_SeededBypassingBranch_FailsTheAssertion`. Applicability is declared first: a branch returning before a handler runs has no emission contract and is not-applicable. The measured bypass set is `:643`, `:657` (outside the async-local scope, which opens at `:714`), `:721`, `:732`, `:805`, `:931`, `:945`, `:966` (inside the scope, above the interceptor call at `:989`), and the whole custom-tool path via `coreHandler` at `:1025-1027` returning at `:1146`/`:1148`.

**Steps:**
1. File the interceptor beside the existing one and install it in the chain.
2. Declare the applicability rule for pre-handler returns.
3. Assert structurally over handler-completing branches, then seed a bypass and confirm it reddens.

**Dependencies:** 004, 018
**Parallelizable:** No

### Task 020: Verifier enforces the lifecycle axis

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-verifier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionVerifier_PlannedOrRetiredEmittedAtRuntime_Fails` and `EmissionVerifier_ConditionalEdge_IsNotCountedSatisfied`.

**Steps:**
1. Evaluate unconditional edges only; hold conditional edges out of subject.
2. Fail a runtime emission of a planned or retired registration.
3. Add the tests named above.

**Dependencies:** 019
**Parallelizable:** No

### Task 021: Enforcement-mode policy key and the no-config path

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/config/yaml-schema.ts`
- `src/config/resolve.ts`
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `tests/unit/config/resolve.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionEnforcement_CiAndDev_DefaultToFailing` and `EmissionEnforcement_NoProjectConfig_UsesTheStatedFallback`. `initializeContext` returns without `projectConfig` when no `projectRoot` is supplied — the CLI cold start and most tests — so the resolved default never applies there. This task states the behavior on that path rather than leaving it to a default that cannot be reached.

**Steps:**
1. Add the key to the YAML schema with its resolved default.
2. State and implement the behavior when no project config is present.
3. Add the tests named above.

**Dependencies:** 020
**Parallelizable:** No

### Task 022: Determinate count reported and a seeded skip fails CI

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `tests/integration/emission-verifier-policy.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EmissionVerifier_AllIndeterminateRun_FailsRatherThanReportingClean` and `EmissionPolicy_SeededSkippedEmission_FailsTheSuite`. Filed at the top level of `tests/integration/`, which holds only `__goldens__/` and `__snapshots__/` as subdirectories — no new subpath is created.

**Steps:**
1. Keep indeterminate distinct from pass and report the determinate count.
2. Seed a handler that skips its declared emission and confirm the suite fails.
3. Add the tests named above.

**Dependencies:** 021
**Parallelizable:** No

### Task 023: Oracle gains the emission axis

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `src/contract/oracle/oracle-seam.ts`
- `tests/unit/contract/oracle/oracle-seam.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `OracleEmission_Recorder_IsMintedAndInjectedLikeTheEffectRecorder` and `OracleEmission_DeclaredButNotPerformed_IsCaught`. The recorder is minted inside the seam and injected into the observation context, exactly as the effect recorders are at `:489`, `:502` and `:517`. No caller-supplied recorder parameter exists today and none is added; the module acquires no store import.

**Steps:**
1. Add the emission axis with a recorder minted in the seam.
2. Catch a seeded handler that declares an emission it does not perform.
3. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 024: Thread the recorder through the handler adapter

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `src/contract/oracle/fixtures.ts`
- `tests/unit/contract/oracle/fixtures.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `OracleEmission_LiveSubject_ProducesADeterminateVerdict` and `OracleEmission_ZeroObservedSubjects_FailsForThisAxisOnly`. The reason real handlers report not-observed is that `compositeHandlerAdapter` at `:471-492` invokes the handler without reading the observation context's recorders. The zero-observation tooth is scoped to the emission axis: `runOracleSuite` computes `ok` from `status === 'fail'`, so a suite-wide rule would redden the three existing all-not-observed axes pinned at `fixtures.test.ts:219-221` and `:376-381`.

**Steps:**
1. Thread the emission recorder through the handler adapter.
2. Scope the zero-observation failure to the emission axis only.
3. Update the live pinned expectations in `fixtures.test.ts` and add the behaviors named above.

**Dependencies:** 023
**Parallelizable:** No

### Task 025: Event hop, its applicability, and every assertion it moves

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `src/contract/reachability/graph.ts`
- `src/contract/reachability/collect.ts`
- `src/contract/reachability/generated/reachability-graph.json`
- `tests/unit/contract/reachability/graph.test.ts`
- `tests/unit/contract/reachability/collect.test.ts`
- `tests/unit/contract/reachability/generated.test.ts`
- `tools/conformance/src/authority-census.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EventHop_Authority_IsTheAnnotationWeld` and `EventHop_NonEmittingAction_IsNotApplicableNotMissing`. `HOP_AUTHORITIES` is set to `'runtime'`, matching the sibling spec. **Widening `ReachabilityHop` is one atomic change** because its fan-out is a type change: the byte-equality and `fullyClosed` pins in `generated.test.ts`, the closure assertions in `collect.test.ts`, the total `Record<ReachabilityHop, …>` counts literal at `graph.ts:227-235`, and the hand-authored `ReachabilityInputs` literals at `authority-census.test.ts:290-301` and `:505-515`, which are a `tsc --noEmit -p tools/conformance` failure inside a required check. Splitting these leaves a knowingly red window.

**Orchestration precondition (not a dependency edge):** the sibling re-scope spec's hop task must have landed or been narrowed to `consumer` alone before dispatch. This is a human or orchestrator check against `git log`, stated as such — no mechanical guard can enforce an assumption about another document, and this plan does not claim one.

**Steps:**
1. Add the `event` hop with authority `'runtime'` and a comment recording why not the compiled-contract projection of `autoEmits`.
2. Declare applicability following the mutation-gated precedent.
3. Regenerate the artifact and update every assertion listed above in this same change.

**Dependencies:** None
**Parallelizable:** No

### Task 026: Event kill fixture and the real anti-tautology ratchet

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `tests/unit/contract/reachability/kill-fixtures.test.ts`
- `tests/unit/contract/reachability/graph.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `KillFixture_EventHop_DropsCensusBelowFullClosure` and `KillFixtures_HopCoverage_StaysTotalOverTheHopAxis`. The real anti-tautology evidence is `kill-fixtures.test.ts:337`, which asserts `KILLED_HOPS` equals `REACHABILITY_HOPS`; that is the assertion a new hop must satisfy. The label check at `graph.test.ts:90-92` is not strengthened by this work, because `'self'` is not a member of the `HOP_AUTHORITIES` value type and no well-typed entry can fail it.

**Steps:**
1. Add the event kill fixture through the collector's existing injection seam.
2. Satisfy the hop-coverage ratchet at `:337`.
3. Add the behaviors named above.

**Dependencies:** 025
**Parallelizable:** No

### Task 027: Flip both diagnostics to blocking

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`
- `tests/unit/events/registration-validate.boot.test.ts`
- `tests/integration/emission-boot-blocking.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the boot seam. Name the behaviors `EmissionTeeth_BlockingMode_HaltsBootOnAViolation` and `EmissionTeeth_ConformingTree_BootsClean`. Gated on **both** break sets: the provider-comparison set from task 007 and the stale-cover set from task 010. `registration-validate.boot.test.ts` is in this Files list because its `InitializeContext_LiveCatalog_BootsClean` positive control is the assertion a premature flip breaks.

**Steps:**
1. Move the provider comparison and stale-cover diagnostics to blocking severity.
2. Confirm the conforming tree still boots through the real seam.
3. Add the behaviors named above.

**Dependencies:** 007, 010, 011, 017, 022
**Parallelizable:** No

### Task 028: Close the census row at all three of its authorities

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-9

**Files:**
- `tools/conformance/src/authority-topology.ts`
- `tools/conformance/src/authority-census.ts`
- `tools/audit/core/authority-live-proof.ts`
- `tools/conformance/src/authority-topology.test.ts`
- `tools/conformance/src/authority-census.test.ts`
- `tools/conformance/src/authority-live-proof.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the conformance suite. Name the behaviors `AuthorityTopology_EffectEventRow_RecordsTheCarrierCoupling`, `AuthorityCensus_EffectEventRow_NoLongerADeclaredRow` and `AuthorityLiveProof_EffectEventRow_NamesItsOracleModule`. **Three authorities move together.** `authority-census.ts:312-331` holds `BOUNDARY_HOP_EVIDENCE['effect-event']` independently of the topology, and `authority-census.test.ts:609` requires a live cell's `oracle.module` to name `tools/audit/core/authority-live-proof.ts` — so that module is owned here. Further live pins in this Files list that move: `authority-topology.test.ts:312-331` and `:333-363`, `authority-census.test.ts:582-620` and `:849` (per-wave blocking counts), and `authority-live-proof.test.ts:636`. These tests run in the `conformance` vitest project and its separate typecheck program, not the `core` project.

**Steps:**
1. Move the topology row on the strength of the landed carrier coupling.
2. Move the census hop evidence and add the live-proof oracle module.
3. Update all six pinned assertions listed above.

**Dependencies:** 026, 027
**Parallelizable:** No

### Parallelization

Dependency edges are the authority. No ordering is asserted in prose that the graph does not encode.

**Wave 1 — no blockers, and no two share a file:** 001 (catalog), 004 (severity axis), 012 (role field), 023 (oracle seam), 025 (event hop).

**Single-writer chains.** Every file with more than one writer is a strict chain in `blockedBy`:

- `registration-validate.ts` and its unit test: 004 → 005 → 006 → 007 → 008 → 010 → 027.
- `registration-validate.boot.test.ts`: 004 → 005 → 011 → 027.
- `schemas.ts`, `event-annotations.ts` and the catalog pins: 001 → 002 → 003 → 010 → 018.
- `effect-carrier.ts` and its test: 014 → 015 → 016 → 017.
- `interceptors/emission-verifier.ts`: 019 → 020 → 021 → 022.
- `graph.test.ts` and the reachability tree: 025 → 026.
- `authority-census.test.ts`: 025 → 026 → 027 → 028.

Task 018 declares both 003 and 010 as blockers so the catalog chain stays single-writer across the DR-3 and DR-6 registrations.

**Three tasks are deliberately wide**, each because splitting produces a worse state than breadth:

- **013** — twelve declaration files. Every candidate split cuts through a fan-in event's owner set, which is the property DR-4 exists to assert.
- **017** — five modules. The carrier signature change breaks its consumers the moment it lands, so a follow-up task would open a non-compiling window.
- **018** — five modules. Registering a catalog event moves its data schema, its annotation, three count pins, an exact-tuple snapshot assertion and a derived premise; those must move in one change or the tree lands red on its own pins.

Tasks 001 and 002 carry the same breadth for the same reason and are chained rather than split.

### Completion checklist

- [ ] Every DR-N has at least one task that discharges it, and every task names a DR-N.
- [ ] No task's acceptance criterion is already true in the tree today.
- [ ] Every live pinned assertion invalidated by this work appears in the Files list of the task that invalidates it, in the same change.
- [ ] No new test shadows an existing guard for the same property.
- [ ] The severity axis lands before the first new diagnostic; the flip is gated on both break sets.
- [ ] No task pair without a dependency path between them writes the same file.
- [ ] Open questions are resolved or explicitly deferred with rationale.
