# Spec: Effect ledger & emission coupling

**Date:** 2026-08-17 · **Feature:** `effect-ledger-coupling` · **Depth:** deep · **Revision:** 3
**Inputs:** epic [#1822](https://github.com/lvlup-sw/exarchos/issues/1822) · anchors [#1765](https://github.com/lvlup-sw/exarchos/issues/1765) (028), [#1773](https://github.com/lvlup-sw/exarchos/issues/1773) (036), [#1776](https://github.com/lvlup-sw/exarchos/issues/1776) (039), [#1826](https://github.com/lvlup-sw/exarchos/issues/1826) (038b) · re-scoped from [#1763](https://github.com/lvlup-sw/exarchos/issues/1763)

> One unified artifact: the requirements below are the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> **DR-N identifiers in this document are local to it.** Sibling specs are referenced by anchor number (028, 036, 039) and issue number only — never by a bare requirement ordinal, which the provenance gate would scrape from this prose as a phantom requirement of this document.
>
> **Revision 3 corrects revision 2's authority.** A three-voter adversarial panel refuted revision 2 unanimously, 16 HIGH gaps. The decisive one: revision 2 aimed the coupling at `EFFECT_PROVIDERS`, which is a composite-tool join table, not the ownership authority. The authority is `EFFECT_OWNERSHIP`, and it already covers the areas revision 2 planned to add. Revision 2 also reproduced revision 1's own defect class — it missed further live mechanisms, one of them in another NUL-byte file. Both corrections are the substance of this revision.

## Design & Rationale

### Problem Statement

An effect can land without the event that records it. The authority-topology census names `effect-event` as the only boundary with **no authority at all**, and the row is still observe-only. Three epics wait behind this.

Measured against the landed tree, the carrier claims hold exactly. `EffectPlan` has no `emits` field and its module references the event store zero times. It is constructed in exactly two places — `mutation-owner.ts:381` and `atomic-promotion.ts:751` — with `runEffect` called at `mutation-owner.ts:487` and `atomic-promotion.ts:775`. A third module, `vcs/worktree-provisioner.ts`, consumes carriers but constructs no plan; it is in scope because a carrier signature change breaks it.

**What the effect sites emit is not in the catalog.** The `vcs.requested` / `vcs.executed` / `vcs.compensated` names are module-level exported constants registered at *runtime* through `registerEventType`, so they carry no tier and no weld. There is no install or promotion event of any kind. That — not a missing provider area, and not a missing bijection — is the defect.

### The corrected baseline

Revision 1 was refuted on measurement. Revision 2 was authored to correct that baseline and **repeated the same failure**: it missed three further live mechanisms, one of them for the identical reason (a file that greps as binary). This section is therefore written to be falsifiable rather than persuasive.

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
| `EVENT_EMISSION_REGISTRY`, derived from the tier axis | The topology's declared authority for the **`event-catalog`** row — a different row from `effect-event` |
| `tests/unit/runbooks/drift.test.ts:197-273` | A **full bijection**, both directions, between `RunbookDefinition.autoEmits` and a set derived from registry actions, with its own non-vacuity denominator test at `:258-272` |
| `src/verbs/gates/check-event-emissions.ts:40-78` | `PHASE_EXPECTED_EVENTS` reconciles against the catalog at module load, throwing on an unregistered name and on a non-`model` source |
| `src/architecture/effect-ledger.ts::EFFECT_OWNERSHIP` | Maps **arbitrary module-path prefixes** to typed effect owners — already including `vcs/` (`vcs-process-owner`), `install/` (`install-identity-fs`, `install-process-owner`) and a finer `install/release/` |
| `tools/conformance/src/authority-census.ts:312-331` | `BOUNDARY_HOP_EVIDENCE['effect-event']` — a **second** authority on the census row, independent of `authority-topology.ts` |

**Counts corrected.** Revision 2 stated three numbers this revision could not reproduce:

| Revision 2 claimed | Measured |
|---|---|
| `RunbookDefinition.autoEmits`: 21 declarations | 18 definitions, 7 non-empty, 20 total entries, 10 distinct events |
| `gate.executed` declared across five registry files | Four: `orchestrate/gates.ts` (17), `verification.ts` (3), `coordination.ts` (2), `review-ops.ts` (2) = 24 edges |
| 74 edges over 44 events ⇒ "roughly 30 multi-declarer events" | Invalid inference — it implies 30 *excess edges*. Exactly **five** events carry ≥2 declaring edges: `gate.executed` (24), `admission.evidence-recorded` (5), `state.patched` (2), `onboard.requested` (2), `onboard.executed` (2) |

### The authority correction

Revision 2's root task declared effect-provider areas for `vcs/` and `install/` in `EFFECT_PROVIDERS`. That table cannot accept them, and should not.

`EFFECT_PROVIDERS` describes itself in its own header as "the (small, governed) **connective tissue**" between two authorities: dispatch's `COMPOSITE_HANDLER_LOADERS` (composite **tool** → module) and the effect ledger's `EFFECT_OWNERSHIP` (module-path **prefix** → typed owner). It is a join table keyed by composite tool, and its tool set is pinned to the dispatch loader set by a stated two-way ratchet (`dispatch-routes.ts:96-118`, which throws) and by an equality assertion (`providers.test.ts:22-28`). There is no `exarchos_vcs` or `exarchos_install` composite tool, and inventing one to satisfy a bijection would put a fake dispatch entry point into the shipped tool surface.

**The ownership authority is `EFFECT_OWNERSHIP`, and it already covers both areas.** It is keyed by module-path prefix precisely so it can govern subsystems that are not dispatch entry points. `vcs/` and `install/` are already declared effect owners there.

So the coupling resolves an event's declared provider against the **effect-ledger owner of the module that appends it**, by path prefix. That is one rule covering both emission styles — action-emitted events under `verbs/`, `workflow/`, `events/`, and carrier-emitted events under `vcs/`, `install/` — where revision 2 needed two incompatible mechanisms and could build neither.

Three consequences follow, and each deletes work rather than adding it:

- **No provider areas are declared.** `EFFECT_PROVIDERS` and its ratchet are untouched.
- **The runbook fold is dropped.** `runbooks/drift.test.ts` already forces `runbook.autoEmits` to equal a set derived from registry actions, so every runbook-declared event is already an action-declared event; folding runbooks into the comparison adds no subject. This also removes the `events → runbooks` import that the layer census (`layer-boundaries-seam.ts:582-593`) forbids. The `events → architecture` import this revision does need is already in that allow set.
- **The `tasks/` gap becomes a one-entry fix.** `EFFECT_OWNERSHIP` contains zero rules matching `tasks/`, which is why `task.claimed` / `task.completed` / `task.failed` had no correct answer on either side. Adding a rule to the table built for exactly that is the legal fix.

### Chosen Approach

Extend what ships; do not rebuild beside it. The boot gate already resolves welds and already fails on an empty denominator, so the provider comparison and the stale-cover tooth are added to *it*, and its `WELD_RESOLUTION_POLICY` table stays the one place the tier axis is decided.

**Observe-only is built first, not retrofitted.** The existing `assertRegistrationWeldsAtStartup` throws on *any* non-empty diagnostic list — it has no severity axis — and runs on the shared boot of both facades. Revision 2 added the new teeth before the observe-only mode that was supposed to protect them, which would have left the tree unbootable for its entire downstream tail. The severity axis therefore lands before the first new diagnostic, and the flip to blocking is the last task in the epic.

The catalog work remains the precondition for the carrier coupling: `emits` has nothing to resolve against until the VCS ledger events and a promotion event are registered. Registering them moves the VCS names off the runtime seam, which is what gives them a tier and a weld.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: The boot gate compares declared provider against effect-ledger owner

The existing boot-time weld gate gains the one comparison it does not make: whether the effect-ledger owner of the module that appends an event matches the event's declared provider. No second boot check is created.

**Acceptance criteria:**
- The comparison lands in the shipped registration-validation module and is reached through the existing startup assertion; no new boot entry point is introduced.
- Provider identity resolves against `EFFECT_OWNERSHIP` by module-path prefix — never against `EFFECT_PROVIDERS`, whose key is a composite tool and whose tool set is pinned to the dispatch loader set.
- For every `capability` event named by at least one live emission edge, the resolved owner equals the event's declared provider, or a diagnostic names both sides.
- The existing weld resolution, drift and empty-denominator diagnostics are preserved unchanged; the tier policy table remains the single place the tier axis is decided.
- **The comparison's own denominator is pinned.** The intersection of declared events and welded events is asserted non-empty and at its measured size by a test that fails when it shrinks. `EMPTY_CAPABILITY_DENOMINATOR` does not discharge this: it counts boot-resolved welds, not the comparison subject, so it stays green while the intersection collapses.
- A test asserts the module is still reached from the shared boot of both facades. The existing boot test already asserts this with a positive control, so the new obligation is to extend it, not to file a second guard beside it.

### DR-2: Stale-cover tooth over the lifecycle-eligible population

A weld covering no live edge is stale cover. The eligible population must exclude events the drift rule makes structurally unnameable, or the tooth fires on conforming code.

**Acceptance criteria:**
- A `capability` event whose lifecycle is `active` and which no live emission edge names fails as stale cover.
- Events with lifecycle `planned` or `retired` are **excluded by the lifecycle axis**, expressed as typed structure, never a per-event list.
- Events appended from a module with an `EFFECT_OWNERSHIP` owner but no registry action are **named by the ledger**, not stale. Carrier-emitted events are covered by their owner, which is what makes DR-3's new events conforming on the day they land.
- The eligible count is reported alongside the verdict, and a run whose eligible population is zero fails rather than passing clean.
- The eligible count is pinned in a named baseline artifact that the guarded run does not regenerate. The baseline is read from disk at test time, not at boot — a sibling JSON is not on disk inside the compiled single-file binary, and `resolveJsonModule` is not enabled.
- The measured break set is **22 active capability events**, not zero, and every one is dispositioned before the tooth can block. Re-derived: 50 capability annotations, 19 named by a live edge, 31 unnamed, of which exactly 9 are `planned`/`retired`.

### DR-3: The VCS and promotion effects become declarable

Both effect sites emit events the declaration system cannot see. Until the catalog contains them, no coupling can be declared.

**Acceptance criteria:**
- The three VCS ledger events are registered as catalog events with data schemas, type-map entries and tier annotations, replacing the runtime registration seam for these three names.
- A promotion event is registered the same way for the atomic tree-promotion site.
- An `EFFECT_OWNERSHIP` rule is added for `tasks/`, resolving the three disagreements that today have no correct answer on either side. No entry is added to `EFFECT_PROVIDERS`.
- Every pinned assertion the four new events move is updated **in the same change**, named explicitly rather than by category: `tests/unit/events/schemas.test.ts:653` and `:4254`, `tests/unit/events/schemas.legacy.test.ts:559` (all `toHaveLength(171)`), `tests/unit/events/event-annotations.test.ts:67`, and `tests/architecture/identifier-stability.test.ts:67-81` with `tools/audit/registered-actions-snapshot.json` — the last being an exact-tuple assertion, not a count.
- Consumer resolution is **explicitly out of scope**. `registration-validate.ts:59-68` records that `consumedBy` is deliberately unresolved at boot and that resolving it wants its own task; a criterion requiring a consumer set to be rejected would have no mechanism and would be satisfied by writing any string.

### DR-4: Emission ownership is declared data, with fan-in modelled as normal

Ownership is declared, never inferred. **Uniqueness is not the property to specify.** One-primary-per-event is falsified on the live tree, and one-primary-per-provider-area is falsified the same way: four of the five multi-declarer events live entirely inside a single area, so a per-area rule would convert ~23 conforming gate actions into scheduled build breaks.

**Acceptance criteria:**
- Each emission edge carries a role of `primary` or `recovery` as declared data on the existing authoring surface; no code path infers a role.
- The authoring surface is `AutoEmission`, but the **edges** live across twelve declaration files. `role` is optional on the type, and a separate totality tooth asserts that every live edge carries one — so the field can land incrementally while the denominator is still pinned.
- **No uniqueness rule is specified.** The property is that every edge resolves to an owner and an event's owner set is non-empty and internally consistent. A multi-declarer event is conforming; a test pins `gate.executed` at its measured 24 edges as the canonical conforming case.
- A recovery edge names a registered event and carries an owner and an ISO expiry; an expired entry fails.

### DR-5: EffectPlan couples as a consumer of the declared vocabulary

The carrier gains an emission declaration and an appender. It resolves against the catalog vocabulary rather than defining its own.

**Acceptance criteria:**
- `EffectPlan` carries its emissions as a **set with conditions**, not a single event: the mutation owner emits an intent before the effect and one of two terminals after, which a singular field cannot express.
- The appender is not a bare caller-supplied thunk — it is a branded or store-derived capability, so passing a no-op cannot yield a committed value.
- The committed value is unreachable without the append. The proof is an exported `Expect<...>` type alias **in a source module**, following the idiom at `registration-validate.ts:390-436`. A `.test.ts` cannot discharge this: `tests/tsconfig.json:86-93` excludes `integration/**` and `unit/**` from the typecheck program, and vitest strips types.
- The dry-run arm is unchanged and still reaches neither the thunk nor the appender.
- The idempotency key includes the **stream** dimension alongside the event type and operation id. The falsifier is that a key built without the stream dimension is rejected at construction — not that two streams fail to collide, which `schema.ts:97-106` already guarantees via `PRIMARY KEY (streamId, idempotencyKey)` and which would pass before and after the change.
- Every live consumer of the carrier migrates in the same change, including `vcs/worktree-provisioner.ts` and the six existing test files that import it.

### DR-6: EmissionVerifier asserts declared emissions landed, lifecycle included

A post-dispatch interceptor asserts that every unconditional contract for the operation landed. A violation is an Exarchos bug, not agent misbehavior.

**Acceptance criteria:**
- The interceptor is **installed in the shipped dispatch chain**, filed under `src/dispatch/core/interceptors/` beside the one existing precedent.
- A test asserts by structure that no result-producing branch bypasses it, **and** seeds a bypassing branch to confirm the assertion reddens. `dispatch.ts` returns results at `:643` and `:657` before the interceptor scope is entered at `:711`, so an assertion scoped to whichever branches happen to reach the seam would pass vacuously.
- It evaluates the operation's unconditional edges; conditional edges are out of subject and must not be counted as satisfied.
- A registration whose lifecycle is `planned` or `retired` but which is nonetheless emitted at runtime **fails**.
- On violation it appends a contract-violation event carrying the action, the full missing set and the operation id.
- Enforcement mode is selected by a **named policy key added to the `.exarchos.yml` schema**, with the discriminator for the telemetry-only arm stated. No such key exists today, so the production arm has no way to be entered until one is added.
- **Indeterminate is distinct from pass** and does not promote; the count of determinate verdicts is reported, and an all-indeterminate run fails rather than reporting clean.
- A seeded handler that skips its declared emission fails the CI suite.

### DR-7: Oracle emission axis observes the append, not the declaration

The oracle gains an emission axis whose evidence is an observed append. It must not become a live store consumer — every existing axis takes injected evidence, and the module declares itself a pure-analysis gate.

**Acceptance criteria:**
- The axis takes its evidence from an **injected append recorder**, mirroring how the effect axis takes an injected effect recorder; the module acquires no store import.
- The recorder is threaded onto the live-subject path through the `DispatchContextFactory` seam, so live subjects can produce a determinate verdict. `fixtures.ts:48-51` records that the composite handlers do not emit through the oracle's effect recorder today — the emission axis must not inherit that gap, or its zero-observation tooth reddens on the live tree.
- A seeded handler declaring an emission it does not perform is caught even when the generated files agree.
- An axis that observed nothing reports the existing not-observed status; a run whose observed-subject count is zero fails rather than passing clean.

### DR-8: Reachability event hop resolves against the weld, with applicability declared

The hop resolves against the capability weld — independent of the compile pass that supplies the denominator.

**Acceptance criteria:**
- The hop list gains `event` only. The `consumer` hop is owned by the sibling re-scope spec, and **this spec carries the task that narrows it there**, rather than assuming the correction in an open question.
- The hop's `HOP_AUTHORITIES` class is stated explicitly. `graph.ts:91` types it as a total `Record<ReachabilityHop, 'runtime' | 'shipped-artifact'>`, and the sibling spec picks `'runtime'` for its hops, so leaving this silent lets the two plans land different values for the same hop.
- The hop's authority is the annotation-side weld, never action `autoEmits`, because the latter rides the same compile pass as the denominator; a comment records why.
- Applicability is declared explicitly, following the mutation-gated precedent, so actions outside the emitting population are `not-applicable` rather than `missing`.
- The live closure baseline stays fully closed, and the regenerated artifact and **the named live closure assertions** move in the same change: `generated.test.ts:19-37` (byte-equality plus `fullyClosed`), `collect.test.ts:59,77-78`, `graph.test.ts:90-92`, `kill-fixtures.test.ts:342-344`.
- The kill-fixture suite gains an event entry that mutates the real upstream through the collector's existing injection seam and drops the census below full closure.
- The prohibition test is strengthened beyond a label check, so labelling a self-derived hop `runtime` no longer passes it.

### DR-9: Boot fails closed, sequenced behind its own disposition

The gate blocks every entry point, so it must not be armed while its own break set is live.

**Acceptance criteria:**
- The observe-only severity axis ships **before the first new diagnostic**, not after. `assertRegistrationWeldsAtStartup` throws on any non-empty diagnostic list today, so a new tooth landing ahead of the severity axis makes the tree unbootable for every task that follows it.
- The flip to blocking is the **last** task in the epic and is gated on the 22-event break set being dispositioned.
- A boot failure reports every violating edge in one pass, naming the action, the event, the declared provider and the observed owner.
- The gate fails closed on an empty or unresolvable population rather than reporting clean.
- The `effect-event` census row moves only when the carrier sites are genuinely coupled, and **both** of the row's authorities move together: `authority-topology.ts` and `authority-census.ts:312-331`'s `BOUNDARY_HOP_EVIDENCE`. Editing only the topology leaves the census still classifying the row as a declared row with no oracle.
- Re-pointing the row at a different representation pair is reclassification and is forbidden. If the carrier coupling does not land, the row stays a recorded known-open row.

## Technical Design

The boot gate is the spine and it already exists. Its weld-resolution policy table is total over the tier axis, so the provider comparison and the stale-cover tooth are added as additional diagnostics on the `capability` arm rather than as a parallel module. That keeps one boot entry point, one policy table, and one place the correspondence is stated.

Provider identity resolves through `EFFECT_OWNERSHIP` by module-path prefix. This is the correction that makes the epic tractable: the same resolution covers action-emitted and carrier-emitted events uniformly, `vcs/` and `install/` are already declared there, and `EFFECT_PROVIDERS` — whose bijection with the dispatch loader map is correct and load-bearing for the router hop — is not touched at all.

The severity axis precedes every new diagnostic. The catalog work is the precondition for the carrier coupling. The carrier then couples as a consumer: conditioned emission set, branded appender, stream-dimensioned idempotency key, with the no-append-no-value property proved by a source-level type alias rather than a runtime test. The verifier and the oracle axis are runtime checks over that vocabulary, wired into the shipped chain. The reachability hop resolves against the annotation half, which no compile pass derives.

## Integration Points

- `src/events/registration-validate.ts` — severity axis, provider comparison, stale-cover tooth.
- `src/architecture/effect-ledger.ts` — the ownership authority the comparison resolves against; gains the `tasks/` rule.
- `src/dispatch/core/context.ts` — the shared boot seam the gate is already reached from; unchanged but asserted.
- `src/events/schemas.ts`, `src/events/event-annotations.ts` — the VCS and promotion registrations, tiers and pinned counts.
- `src/registry/gate-metadata.ts` — `AutoEmission` gains its optional role field; the twelve declaration files under `src/registry/actions/` carry the edges.
- `src/dispatch/core/effect-carrier.ts`, `src/vcs/mutation-owner.ts`, `src/install/atomic-promotion.ts`, `src/vcs/worktree-provisioner.ts` — the carrier coupling and all its live consumers.
- `src/dispatch/core/interceptors/` — where the verifier is filed and installed.
- `src/contract/oracle/oracle-seam.ts`, `src/contract/oracle/fixtures.ts` — the injected append recorder and the emission axis.
- `src/contract/reachability/graph.ts`, `collect.ts` — the event hop and its applicability rule.
- `tools/conformance/src/authority-topology.ts` **and** `authority-census.ts` — the census row's two authorities.

## Exploration

Revision 1 was refuted on baseline. Revision 2 was authored to correct it and was refuted on authority, unanimously, by a three-voter panel — 16 HIGH gaps, five of them found independently by all three voters.

The decisive finding is that revision 2 targeted a join table rather than the ownership authority, which made its wave-1 root task structurally impossible: two shipped guards reject a sixth entry in `EFFECT_PROVIDERS`, and the entire carrier chain sat behind that root. Retargeting to `EFFECT_OWNERSHIP` removes the blocker and simultaneously deletes the runbook fold, the layer-boundary problem, and the "no valid answer" disagreements — the correct authority was already total over the areas in question.

The second finding is procedural and is why this revision names the NUL-byte file set explicitly. Revision 2 existed to correct a miss caused by grep-invisible files, and then missed `authority-census.ts` the same way, along with two ordinary mechanisms that a careful read would have surfaced. A baseline claim of the form "nothing does X" is not admissible in this tree without a direct read of the candidate modules.

Direction 4 survives in outline — the coupling authority is the annotation weld, not the carrier — but the epic is smaller in mechanism and more uniform in shape than either earlier revision stated.

## Alternatives considered

- **Declare `vcs/` and `install/` in `EFFECT_PROVIDERS`.** Revision 2's design. Rejected on measurement: the table is keyed by composite tool and pinned to the dispatch loader set by a throwing ratchet and an equality assertion. The facts it would have added already exist in `EFFECT_OWNERSHIP`.
- **Add real `exarchos_vcs` / `exarchos_install` composite tools** to satisfy the bijection honestly. Rejected: it puts fake dispatch entry points into the shipped tool surface to serve an internal join, and the tool surface is separately budgeted.
- **Redesign `EFFECT_PROVIDERS` so area is independent of the tool key.** Rejected: it weakens a correct, load-bearing invariant to add a concept that already exists one layer down.
- **Keep single-primary-per-event, or per-area.** Both rejected: falsified on the live tree, the second by the same measurement as the first.
- **Fold runbook emissions into the comparison.** Rejected as vacuous: `runbooks/drift.test.ts` already forces runbook `autoEmits` to equal an action-derived set in both directions.
- **Resolve the event hop from action `autoEmits`.** Rejected: it rides the compile pass that supplies the denominator, so it resolves by construction.
- **Ship the new teeth before the observe-only mode.** Rejected: the startup assertion has no severity axis, so this leaves the tree unbootable for the whole downstream tail.

## Open Questions

None load-bearing. Revision 2's four open questions are resolved as follows:

- **Scope of the catalog and area work** — resolved in scope, and cheaper than either revision assumed: no provider areas are declared at all, because the ownership authority already covers both trees.
- **A sixth provider area for the `src/tasks/` disagreements** — resolved: one `EFFECT_OWNERSHIP` rule for `tasks/`, which today has zero matching rules.
- **Where the sibling hop correction happens** — resolved: it is a task in this decomposition, not an assumption about another document.
- **Whether the oracle needs a live recorder seam first** — resolved in scope, threaded through the existing `DispatchContextFactory` seam, because the criterion's own zero-observation tooth reddens otherwise.

## Decomposition

The decomposition maps every task to one or more DR-N from the requirements above.

### Scope

**Target:** Full design — all nine requirements, with provider identity resolved through the effect ledger.
**Excluded:** The `consumer` reachability hop's implementation, owned by the sibling re-scope spec (this spec narrows that spec's task; it does not implement the hop). Consumer-set resolution at boot, which `registration-validate.ts` records as its own future task. Migrating the wider effect surface onto the carrier beyond the existing construction sites. Populating or retiring the empty observation tier.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Boot gate compares declared provider against effect-ledger owner | 003, 004, 005, 006 |
| DR-2 | Stale-cover tooth over the lifecycle-eligible population | 007, 008, 009 |
| DR-3 | The VCS and promotion effects become declarable | 001, 010, 011 |
| DR-4 | Emission ownership is declared data, fan-in normal | 012, 013, 031 |
| DR-5 | EffectPlan couples as a consumer of the declared vocabulary | 014, 015, 016, 017 |
| DR-6 | EmissionVerifier asserts declared emissions landed | 018, 019, 020, 021, 022 |
| DR-7 | Oracle emission axis observes the append | 023, 024 |
| DR-8 | Reachability event hop resolves against the weld | 025, 026, 027, 028 |
| DR-9 | Boot fails closed, sequenced behind its own disposition | 002, 029, 030 |

### Tasks

Each task carries a `riskTier` stamp that selects its verification depth. Tests are judged test-after by adequacy. Where a task changes behavior that a live guard already pins, the guard is in the task's own Files list — this decomposition never files a parallel test beside a pin it invalidates.

### Task 001: Add the effect-ownership rule for the tasks tree

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-3

**Files:**
- `src/architecture/effect-ledger.ts`
- `tests/unit/architecture/effect-ledger.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EffectOwnership_TasksTree_ResolvesToOneOwner` and `EffectOwnership_AppendSiteWithNoRule_IsUnowned`. The ledger contains zero rules matching `tasks/` today, which is why three provider disagreements have no correct answer on either side.

**Steps:**
1. Add one ownership rule for `tasks/` with its owner, effect class and idempotency rationale, matching the existing rule shape.
2. Add the tests named above, including the negative case.

**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Give the startup assertion a severity axis

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`
- `tests/unit/events/registration-validate.boot.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the boot seam. Name the behaviors `StartupAssertion_ObserveSeverity_ReportsWithoutThrowing` and `StartupAssertion_BlockingSeverity_ThrowsOnAnyViolation`. This task ships **before** any new diagnostic: the assertion throws on any non-empty diagnostic list today, so a tooth landing first makes the tree unbootable for the whole downstream tail.

**Steps:**
1. Give each diagnostic a severity and have the startup assertion throw only on blocking ones.
2. Default every existing diagnostic to blocking so current behavior is byte-identical.
3. Extend the two live test files above with the observe-mode cases; do not file a new parallel suite.

**Dependencies:** None
**Parallelizable:** Yes

### Task 003: Resolve an append site to its effect-ledger owner

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `OwnerResolution_ModulePrefix_SelectsTheLongestMatchingRule` and `OwnerResolution_PathWithNoRule_IsUnownedNotDefaulted`. Resolution is against `EFFECT_OWNERSHIP` by module-path prefix; the `events → architecture` import this needs is already in the layer census allow set.

**Steps:**
1. Add prefix resolution over the live ownership rules, longest match wins.
2. Return an explicit unowned result rather than a default owner.
3. Add the tests named above.

**Dependencies:** 002
**Parallelizable:** No

### Task 004: Compare declared provider against resolved owner

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `ProviderComparison_DeclaredProviderMatchesOwner_IsConforming` and `ProviderComparison_Disagreement_NamesBothSides`. The diagnostic ships at observe severity. Note that `registration-validate.test.ts:88` asserts `verdict.ok === true` against the live catalog and will go false on the measured disagreements — that assertion is updated here, not shadowed.

**Steps:**
1. Add the comparison as an additional diagnostic on the capability arm, at observe severity.
2. Report the action, the event, the declared provider and the observed owner in one pass.
3. Update the live `verdict.ok` assertion and add the tests named above.

**Dependencies:** 002, 003
**Parallelizable:** No

### Task 005: Pin the comparison denominator

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `ComparisonDenominator_LiveIntersection_IsNonEmptyAtMeasuredSize` and `ComparisonDenominator_Shrinks_FailsRatherThanPassingClean`. The intersection of declared and welded events is pinned by nothing today: the annotation side is pinned by identifier-stability, but the snapshot shape carries no `autoEmits`, so the edge side's only floor is a single "any populated" assertion.

**Steps:**
1. Report the intersection size alongside the verdict.
2. Assert it is non-empty and at its measured size, failing on shrinkage.
3. Add the tests named above, including the seeded-shrink case.

**Dependencies:** 004
**Parallelizable:** No

### Task 006: Extend the boot-reachability guard rather than duplicating it

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-1

**Files:**
- `tests/unit/events/registration-validate.boot.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `BootGate_Comparison_IsReachedFromBothFacades`. The existing file already drives the real unmocked gate through `initializeContext` with a positive control and states its own kill probe; this task extends that guard to cover the new diagnostics. It does not file a second guard in another tier for the same property.

**Steps:**
1. Extend the existing boot test so the new diagnostics are exercised through the real seam.
2. Confirm the file's stated kill probe still reddens the suite.

**Dependencies:** 004
**Parallelizable:** No

### Task 007: Stale-cover tooth over the lifecycle-eligible population

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `StaleCover_ActiveWeldNamedByNoEdge_FailsAsStale`, `StaleCover_PlannedOrRetired_IsExcludedByLifecycle` and `StaleCover_LedgerOwnedAppendSite_IsNamedNotStale`. The third behavior is what makes carrier-emitted events conforming: an event appended from a module with an ownership rule is named by the ledger even with no registry action. Ships at observe severity.

**Steps:**
1. Add the tooth on the capability arm at observe severity.
2. Exclude `planned`/`retired` by the lifecycle axis as typed structure, never a list.
3. Treat a ledger-owned append site as a naming edge.
4. Add the three tests named above.

**Dependencies:** 002, 003
**Parallelizable:** No

### Task 008: Pin the eligible count in a non-self-regenerating baseline

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `tools/audit/emission-eligible-baseline.json`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EligibleBaseline_PinnedCount_MatchesTheLiveCount` and `EligibleBaseline_ShrinksWithNoDisposition_Fails`. The baseline is read from disk at test time, not at boot: `resolveJsonModule` is not enabled and a sibling JSON is not on disk inside the compiled single-file binary. It is filed under `tools/audit/` beside the other pinned baselines rather than under `src/`.

**Steps:**
1. Record the measured eligible count and the disposition schema in the baseline file.
2. Read it with fs at test time and compare against the live count.
3. Add the tests named above.

**Dependencies:** 007, 010, 011
**Parallelizable:** No

### Task 009: Disposition the measured break set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-2

**Files:**
- `src/events/event-annotations.ts`
- `src/architecture/effect-ledger.ts`
- `tests/unit/events/registration-validate.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `BreakSet_EveryActiveUnnamedWeld_IsDispositioned` and `BreakSet_UndispositionedEntry_Fails`. The set is **22 active capability events**, including `ci.status`, `tool.completed`, `turn.completed`, `subagent.tokens_used`, `launch.executed`, `prune.executed`, `worktree.orphan_detected` and `benchmark.completed`. Each is resolved by an ownership rule covering its append site, a lifecycle correction, or a recorded disposition — not by relabelling.

**Steps:**
1. Enumerate the 22 and record each one's append site.
2. Resolve each by ownership rule, lifecycle correction or recorded disposition.
3. Add the tests named above.

**Dependencies:** 001, 007
**Parallelizable:** No

### Task 010: Register the vcs ledger events into the catalog

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

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `VcsLedgerEvents_Registered_CarryTierAndLifecycle` and `VcsLedgerEvents_RuntimeSeam_IsNoLongerUsed`. The three `toHaveLength(171)` pins at `schemas.test.ts:653`, `:4254` and `schemas.legacy.test.ts:559` move here, as does the exact-tuple assertion at `identifier-stability.test.ts:67-81` with its snapshot.

**Steps:**
1. Register the three names with data schemas and type-map entries.
2. Annotate each with a tier whose weld it can satisfy.
3. Update all four pinned assertions and the snapshot in this same change.
4. Add the tests named above.

**Dependencies:** None
**Parallelizable:** No

### Task 011: Register a promotion event for the tree-promotion site

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

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `PromotionEvent_Registered_CarriesTierAndLifecycle` and `PromotionEvent_AppendSite_ResolvesToInstallOwner`. Strictly sequenced after task 010: both tasks edit the same two source files and move the same catalog-count pins.

**Steps:**
1. Register the promotion event with its data schema and type-map entry.
2. Annotate it at a tier whose weld it can satisfy.
3. Move the same pinned assertions forward by one.
4. Add the tests named above.

**Dependencies:** 010
**Parallelizable:** No

### Task 012: Emission role becomes declared data on the authoring surface

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/registry/gate-metadata.ts`
- `tests/unit/registry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `AutoEmission_DeclaredRole_IsNotInferred` and `AutoEmission_RecoveryEdgeWithExpiredOwner_Fails`. `role` is **optional** on the type so the twelve declaration files can adopt it incrementally without a compile break; task 013 supplies the denominator tooth that stops it staying empty.

**Steps:**
1. Add the optional role field with its owner and ISO expiry for recovery edges.
2. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 013: Roles on the single-declarer edge files

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/registry/actions/workflow.ts`
- `src/registry/actions/orchestrate/invariants.ts`
- `src/registry/actions/orchestrate/lifecycle-ops.ts`
- `src/registry/actions/orchestrate/vcs.ts`
- `src/registry/actions/orchestrate/cutover.ts`
- `src/registry/actions/orchestrate/worktree.ts`
- `src/registry/actions/orchestrate/merge.ts`
- `src/registry/actions/orchestrate/onboarding.ts`
- `tests/unit/registry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionRoles_DeclaredEdge_CarriesAnExplicitRole` and `EmissionRoles_InferredRole_IsRejected`. Split from task 031 along the fan-in axis: these eight files hold only single-declarer edges, so they can adopt the optional role field without touching the `gate.executed` fan-in case. Totality is not asserted here — task 031 owns it, and until 031 lands the field is legitimately partial.

**Steps:**
1. Add a role to every edge in these eight declaration files.
2. Add the tests named above, including the rejection of an inferred role.

**Dependencies:** 012
**Parallelizable:** No

### Task 031: Fan-in files carry roles and totality is asserted

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-4

**Files:**
- `src/registry/actions/orchestrate/gates.ts`
- `src/registry/actions/orchestrate/verification.ts`
- `src/registry/actions/orchestrate/coordination.ts`
- `src/registry/actions/orchestrate/review-ops.ts`
- `tests/unit/registry.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the registry seam. Name the behaviors `EmissionRoles_EveryLiveEdge_CarriesARole` and `EmissionRoles_MultiDeclarerEvent_IsConforming`. The second pins `gate.executed` at its measured 24 edges across these four files as the canonical conforming case. **No uniqueness rule is asserted** — one-primary-per-area is falsified precisely because all 24 of those edges live inside the single `verbs/` area.

**Steps:**
1. Add a role to the 24 `gate.executed` edges and the other fan-in edges in these four files.
2. Assert totality over the live edge set, so the denominator cannot be near-empty.
3. Pin the multi-declarer case and add the tests named above.

**Dependencies:** 013
**Parallelizable:** No

### Task 014: EffectPlan carries a conditioned emission set

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EffectPlan_Emits_IsAConditionedSet` and `EffectPlan_DryRunArm_ReachesNeitherThunkNorAppender`. A singular `emits` cannot express the mutation owner's intent-then-one-of-two-terminals shape.

**Steps:**
1. Add the conditioned emission set to the carrier type.
2. Leave the dry-run arm unchanged and assert it.
3. Add the tests named above.

**Dependencies:** 010, 011
**Parallelizable:** No

### Task 015: Branded appender makes a no-op incapable of committing

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-5

**Files:**
- `src/dispatch/core/effect-carrier.ts`
- `tests/unit/dispatch/core/effect-carrier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `EffectCarrier_NoOpAppender_CannotYieldACommittedValue`. The compile-time half is an exported `Expect<...>` alias **in the source module**, following the existing idiom — a `.test.ts` cannot discharge it, because the tests program excludes the unit and integration tiers and vitest strips types.

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

**Verification:** scoped tests plus the adequacy kill-probe. Name the behavior `EffectIdempotency_KeyBuiltWithoutStream_IsRejectedAtConstruction`. The falsifier is construction-time rejection, **not** two streams failing to collide — the claims table already declares `PRIMARY KEY (streamId, idempotencyKey)`, so a collision test passes identically before and after the change and would measure nothing.

**Steps:**
1. Include the stream dimension in the key and reject a key built without it.
2. Add the test named above.

**Dependencies:** 015
**Parallelizable:** No

### Task 017: Migrate every live carrier consumer

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
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

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across both effect seams. Name the behaviors `MutationOwner_IntentThenTerminalOrdering_IsPreserved` and `PromoteTree_LiveMode_CommitsItsEventBeforeReturning`. `worktree-provisioner.ts` consumes carriers without constructing a plan, so the signature change breaks it; all six live test files that import the carrier are updated here rather than left to fail.

**Steps:**
1. Migrate both construction sites onto the declared vocabulary.
2. Update the third consumer for the new signature.
3. Update all five live test files and add the behaviors named above.

**Dependencies:** 016
**Parallelizable:** No

### Task 018: Install the EmissionVerifier in the shipped dispatch chain

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `src/dispatch/core/dispatch.ts`
- `tests/unit/dispatch/core/dispatch.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EmissionVerifier_EveryResultProducingBranch_ReachesIt` and `EmissionVerifier_SeededBypassingBranch_FailsTheAssertion`. The second behavior is the falsifier: `dispatch.ts` returns results at `:643` and `:657` before the interceptor scope opens at `:711`, so a structural assertion scoped to whichever branches happen to reach the seam would pass vacuously. Filed under `interceptors/` beside the one existing precedent.

**Steps:**
1. Add the interceptor beside the existing one and install it in the chain.
2. Assert structurally that no result-producing branch bypasses it.
3. Seed a bypassing branch and confirm the assertion reddens.

**Dependencies:** 002
**Parallelizable:** No

### Task 019: Verifier enforces the lifecycle axis

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

**Dependencies:** 018
**Parallelizable:** No

### Task 020: Determinate-verdict count is reported and non-zero

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `tests/unit/dispatch/core/emission-verifier.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionVerifier_Indeterminate_DoesNotPromoteToPass` and `EmissionVerifier_AllIndeterminateRun_FailsRatherThanReportingClean`.

**Steps:**
1. Keep indeterminate distinct from pass and report the determinate count.
2. Fail an all-indeterminate run.
3. Add the tests named above.

**Dependencies:** 018
**Parallelizable:** No

### Task 021: Add the enforcement-mode policy key

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-6

**Files:**
- `src/config/yaml-schema.ts`
- `src/config/resolve.ts`
- `tests/unit/config/resolve.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `EmissionEnforcement_CiAndDev_DefaultToFailing` and `EmissionEnforcement_TelemetryOnlyArm_NeverThrows`. No enforcement-mode key exists in the schema today, so the production arm has no way to be entered and the criterion is untestable until this lands.

**Steps:**
1. Add the key to the YAML schema with its resolved default.
2. State the discriminator that selects the telemetry-only arm.
3. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 022: Seeded skipped emission fails CI under policy selection

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-6

**Files:**
- `src/dispatch/core/interceptors/emission-verifier.ts`
- `tests/integration/emission-verifier-policy.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EmissionPolicy_SeededSkippedEmission_FailsTheSuite` and `EmissionPolicy_TelemetryArm_RecordsWithoutThrowing`. Filed in `tests/integration/`, which is a flat directory — no subpath is created.

**Steps:**
1. Wire mode selection to the resolved policy key.
2. Seed a handler that skips its declared emission and confirm the suite fails.
3. Add the tests named above.

**Dependencies:** 019, 020, 021
**Parallelizable:** No

### Task 023: Oracle gains an injected append recorder

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-7

**Files:**
- `src/contract/oracle/oracle-seam.ts`
- `tests/unit/contract/oracle/oracle-seam.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `OracleEmission_Evidence_IsAnInjectedRecorder` and `OracleEmission_DeclaredButNotPerformed_IsCaught`. The module must acquire no store import — every existing axis takes injected evidence.

**Steps:**
1. Add the emission axis taking an injected append recorder.
2. Catch a seeded handler that declares an emission it does not perform.
3. Add the tests named above.

**Dependencies:** None
**Parallelizable:** Yes

### Task 024: Recorder is threaded onto the live-subject path

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-7

**Files:**
- `src/contract/oracle/fixtures.ts`
- `tests/integration/oracle-emission-live-subject.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `OracleEmission_LiveSubject_ProducesADeterminateVerdict` and `OracleEmission_ZeroObservedSubjects_FailsRatherThanPassingClean`. The recorder is threaded through the existing `DispatchContextFactory` seam. `fixtures.ts:48-51` records that composite handlers do not emit through the oracle's effect recorder today — if the emission axis inherits that gap, the second behavior reddens on the live tree, which is why this task is in scope rather than deferred.

**Steps:**
1. Thread the recorder onto the live-subject path through the context factory.
2. Confirm a live subject yields a determinate verdict.
3. Add the tests named above.

**Dependencies:** 023
**Parallelizable:** No

### Task 025: Narrow the sibling spec's hop task to consumer alone

**Risk Tier:** medium
**Boundary Touching:** false
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `docs/specs/2026-08-17-imo-anchor-rescope.md`
- `.gitignore`

**Verification:** manual review plus the doc-link check. The sibling spec's task still adds **both** hops over `graph.ts` and `collect.ts`, stamped parallelizable, and both plans regenerate the same byte-pinned artifact. Compounding the risk, `docs/specs` is gitignored, so no implementer on another branch and no CI check can read the assumption. This task performs the correction rather than assuming it, and tracks the specs directory so the reconciliation is visible to both plans.

**Steps:**
1. Narrow the sibling task to the `consumer` hop alone and record why.
2. Align the `HOP_AUTHORITIES` class between the two specs.
3. Stop ignoring `docs/specs/` so both artifacts are tracked.

**Dependencies:** None
**Parallelizable:** Yes

### Task 026: Event hop resolves against the weld with declared applicability

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `src/contract/reachability/graph.ts`
- `src/contract/reachability/collect.ts`
- `tests/unit/contract/reachability/graph.test.ts`
- `tests/unit/contract/reachability/collect.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `EventHop_Authority_IsTheAnnotationWeld` and `EventHop_NonEmittingAction_IsNotApplicableNotMissing`. The hop's `HOP_AUTHORITIES` class is stated explicitly — the type is total over the hop axis, and the sibling spec picks `'runtime'`, so silence lets the two plans diverge on the same hop.

**Steps:**
1. Add the `event` hop with its explicit authority class and a comment recording why not the action side.
2. Declare applicability following the mutation-gated precedent.
3. Update the two live test files and add the behaviors named above.

**Dependencies:** 025
**Parallelizable:** No

### Task 027: Closure baseline and regenerated artifact move together

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `src/contract/reachability/generated/reachability-graph.json`
- `tests/unit/contract/reachability/generated.test.ts`
- `tests/unit/contract/reachability/collect.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite. Name the behaviors `Reachability_RegeneratedArtifact_StaysFullyClosed` and `Reachability_StaleBaseline_FailsByteEquality`. The live closure pins are `generated.test.ts:19-37`, `collect.test.ts:59,77-78` — they are edited here, not shadowed by a parallel suite.

**Steps:**
1. Regenerate the shipped artifact.
2. Update the byte-equality and closure assertions in the same change.
3. Add the behaviors named above.

**Dependencies:** 026
**Parallelizable:** No

### Task 028: Event kill fixture and a strengthened prohibition test

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-8

**Files:**
- `tests/unit/contract/reachability/kill-fixtures.test.ts`
- `tests/unit/contract/reachability/graph.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe. Name the behaviors `KillFixture_EventHop_DropsCensusBelowFullClosure` and `Prohibition_SelfDerivedHopLabelledRuntime_StillFails`. The self-prohibition assertions live at `graph.test.ts:90-92` and `kill-fixtures.test.ts:342-344`; both are strengthened beyond a label check here.

**Steps:**
1. Add the event kill fixture through the collector's existing injection seam.
2. Strengthen both prohibition assertions past a label comparison.
3. Add the behaviors named above.

**Dependencies:** 027
**Parallelizable:** No

### Task 029: Flip the teeth to blocking

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9

**Files:**
- `src/events/registration-validate.ts`
- `tests/unit/events/registration-validate.test.ts`
- `tests/integration/emission-boot-blocking.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the integration suite across the boot seam. Name the behaviors `EmissionTeeth_BlockingMode_HaltsBootOnAViolation` and `EmissionTeeth_ConformingTree_BootsClean`. This is the last enforcement task in the epic and is gated on the 22-event break set being dispositioned; the severity axis it flips landed in task 002.

**Steps:**
1. Move the provider comparison and stale-cover diagnostics to blocking severity.
2. Confirm the conforming tree still boots.
3. Add the behaviors named above.

**Dependencies:** 009, 017, 022
**Parallelizable:** No

### Task 030: Close the census row at both of its authorities

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** unit
**Implements:** DR-9

**Files:**
- `tools/conformance/src/authority-topology.ts`
- `tools/conformance/src/authority-census.ts`
- `tools/conformance/src/authority-topology.test.ts`
- `tools/conformance/src/authority-census.test.ts`

**Verification:** scoped tests plus the adequacy kill-probe and the conformance suite. Name the behaviors `AuthorityTopology_EffectEventRow_RecordsTheCarrierCoupling` and `AuthorityCensus_EffectEventRow_NoLongerADeclaredRowWithNoOracle`. **Both** authorities move together: `authority-census.ts:312-331` holds `BOUNDARY_HOP_EVIDENCE['effect-event']` independently of the topology, so editing only the topology leaves the census verdict unmoved. The live pins are `authority-topology.test.ts:393` and `authority-census.test.ts:783-823` (an exact tuple including `openBoundaries` length) — both are in this task's Files list. `authority-census.ts` contains literal NUL bytes; read it directly rather than by grep.

**Steps:**
1. Move the topology row on the strength of the landed carrier coupling.
2. Move the census hop evidence in the same change.
3. Update both live pinned assertions and add the behaviors named above.

**Dependencies:** 029
**Parallelizable:** No

### Parallelization

Dependency edges below are the authority; the prose never asserts an ordering the graph does not encode.

**Wave 1 — no blockers, and no two share a file:** 001 (effect ledger), 002 (severity axis), 010 (vcs catalog), 012 (role field), 021 (policy key), 023 (oracle seam), 025 (sibling narrowing).

Every file collision in this decomposition is encoded as a dependency edge, not asserted in prose. Task 003 edits `registration-validate.ts` and so declares 002 as its blocker rather than sitting beside it in wave 1; 011 declares 010 for the same reason on the catalog files.

**Serialization on `registration-validate.ts`:** tasks 002, 003, 004, 005, 007, 009 and 029 all edit it. The chains 002 → 003 → 004 → 005 and 002 → 003 → 007 → 009 → 029 are encoded in `blockedBy`, so no two of them are ever runnable at once.

**Task 017 is deliberately atomic** despite spanning five modules. The carrier signature change breaks `worktree-provisioner.ts` the moment it lands, so splitting the consumer migration into a follow-up task would open a window in which the tree does not compile. Breadth here is the correct trade against a knowingly red intermediate state.

**Serialization on the reachability tree:** 025 → 026 → 027 → 028 is a strict chain; all three of the latter touch the generated artifact or its pins.

**Carrier chain:** 014 → 015 → 016 → 017, strictly sequential on `effect-carrier.ts`.

### Completion checklist

- [ ] Every DR-N has at least one task that discharges it, and every task names a DR-N.
- [ ] No task's acceptance criterion is already true in the tree today.
- [ ] Every live pinned assertion invalidated by this work appears in the Files list of the task that invalidates it.
- [ ] No new test shadows an existing guard for the same property.
- [ ] The severity axis lands before the first new diagnostic; the flip to blocking lands last.
- [ ] The 22-event break set is dispositioned before task 029.
- [ ] Open questions are resolved or explicitly deferred with rationale.
