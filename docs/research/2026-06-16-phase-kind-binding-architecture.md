# Phase-Kind Binding: a compositional model for gates, phases, and workflows

- **Status:** discovery spike (research) — recommendation, not an approved design
- **Date:** 2026-06-16
- **Workflow:** `phase-kind-binding-spike` (discovery)
- **Related:** epic #1515 (risk-proportional verification ladder), #1258 (Workflow SDK, v3.0), INV-6 / INV-1 / INV-15 / INV-11 / INV-4 / INV-12
- **Supersedes the framing of:** #1537, #1543, #1544, #1536 — these are symptoms of the structural gap this spike addresses, not independent bugs

## Thesis

Exarchos already has one genuinely compositional verification primitive — `resolveVerificationSequence(riskTier, boundaryTouching)`, a pure function over a frozen policy table with per-cell config override. The problem is that this primitive is wired into **2 of ~5 code-bearing implementation phases**, because phases and gates bind by hand-written `(workflowType:phase)` string pairs rather than by a reusable *kind*. The fix is to introduce a **phase-kind** layer: classify every phase by a small closed set of kinds (`IMPLEMENT | PLAN | REVIEW | SYNTHESIZE | …`), attach gate obligations and capabilities to *kinds*, and resolve them at every phase boundary through a single non-optional call. The verification ladder then composes across all workflow types by construction, and the milestone's headline thesis ("replace mandatory red-green-refactor everywhere") becomes structurally true instead of true-in-two-places.

This is the convergent recommendation of four independent research lanes (statecharts, durable-orchestration engines, policy-as-data, type-driven design). All four arrive at the same shape: **a named, kind-keyed registry of obligations, resolved by reference at a boundary, with the binding expressed as data and the implementation as typed code.**

## 1. The problem, from the code

The phase/gate system has two layers with mismatched compositionality.

**Compositional (good):** the verification ladder. `workflow/verification-policy.ts` is a frozen `Record<RiskTier, GateName[]>` table; `resolveVerificationSequence(riskTier, boundaryTouching)` is a pure resolver; `verification-policy-resolver.ts` layers per-cell config override on top. This is policy-as-data done well.

**Snowflake (the gap):** phases and their gate bindings.

- Each workflow type hand-rolls its own HSM states in `workflow/hsm-definitions.ts`. There are **five different names for "write the code"**: `delegate` (feature), `debug-implement` / `hotfix-implement` (debug), `polish-implement` / `overhaul-delegate` (refactor), `implementing` (oneshot).
- Gates bind to phases through `PhasePlaybook` registrations keyed `${workflowType}:${phase}` (`workflow/playbooks.ts:86`). There are ~28 registered gate/check actions in `registry.ts`; which subset a phase advertises is decided per playbook, by hand.
- The ladder is woven into only two of those playbooks. The helper signature is the proof: `delegatePhaseEvents(phase: 'delegate' | 'overhaul-delegate')`. The other implement phases hardcode prose — `debug-implement` literally instructs *"Follow TDD — write failing test first, then implement fix… Anti-pattern: fixing without a failing test"* (`playbooks.ts:712`), the exact mandatory red-green-refactor epic #1515 set out to retire.
- The only cross-workflow reuse today is the **guard library** (`guards.implementationComplete`, `allReviewsPassed`, `synthesizeRetryable`, `prUrlExists` are shared across HSMs). Reuse exists at the guard level, never at the phase level.
- `topology/phase-contract.ts` — the only artifact named "phase contract" — is solely a pruner *staleness* contract (`expectedMaxDwellMinutes`, staleness signals). There is no phase-kind taxonomy.

Net: the ladder is a compositional island bolted onto a snowflake system. Patching #1537/#1543/#1544 individually accretes more bespoke playbooks and leaves the asymmetry intact.

## 2. Method

Four parallel research agents, each owning a lane and a source mix, each instructed to filter every pattern through **INV-15** (Exarchos is single-machine, event-sourced, cooperative — no saga / 2PC / Scheduler-Agent-Supervisor / leader election / distributed locks; compensation is local event-log rewind):

1. **Statecharts & state-machine composition** — exa (Harel, compositional semantics, modular refinement, SCXML, aspect weaving) + context7 (XState v5).
2. **Durable / orchestration engines** — microsoft-learn (Durable Functions / DTF) + exa/web (Temporal, Step Functions, Conductor, Cadence).
3. **Policy-as-data & gate composition** — web/exa (OPA/Rego, GitHub Actions reusable workflows & composite actions, GitLab CI, Tekton/Argo, Kyverno/Gatekeeper).
4. **Type-driven design** — exa/web (make-illegal-states-unrepresentable, parse-don't-validate, POLA/ocaps, algebraic effects, branded types, table-driven dispatch, discriminated-union exhaustiveness).

## 3. The convergent finding

Every lane independently named the same core move, in its own vocabulary:

| Lane | Name for "bind a reusable obligation to a kind, by reference" |
|---|---|
| Statecharts | **Mode-with-a-contract** (assume/guarantee) + **aspect pointcut on `kind == X`** + XState `setup()` named-unit registry |
| Orchestration | **Activity registry invoked by name** + **interceptor chain bound to a type** + Conductor's Definition/Configuration/Execution split |
| Policy-as-data | **PDP/PEP split** + **ConstraintTemplate→Constraint** (define-once / bind-many) + resolve-then-freeze |
| Type-driven | **Discriminated union + frozen `Record<PhaseKind, …>` table + branded smart constructor** + exhaustive dispatch |

Three properties recur in all four:

1. **Bind by reference to a kind, never by enumerated pairs.** The reusable unit is registered once and invoked by a stable name/tag. Gate-set bound to `(workflowType:phase)` is the anti-pattern; gate-set bound to `PhaseKind` is the fix. Statechart theory frames it sharply: the `(workflowType:phase)` keying is *non-compositional* — behavior is inferred from the whole, not the part (dl.acm.org/10.1145/355045.355062).
2. **The decision is non-optional at the boundary.** Policy-as-data names Exarchos's exact bug: the resolver is a PDP, the phases are PEPs, and 3/5 PEPs never query the PDP. The cure is structural — the phase boundary *always* calls the resolver, the way an admission webhook fires on every admitted object, so a phase cannot hardcode prose instead.
3. **Binding is data; implementation is typed code; evolution is a new version.** Conductor/Uber's field lesson ("declarative JSON is declarative only in narrow domains") plus event-sourcing's immutability point the same way: the KIND→gate-set *binding* is reviewable data, each *gate* is typed TS, and a behavior change is a new versioned binding (an event), not an in-place mutation.

Critically, **none of the borrowed patterns require distribution.** The distribution machinery (task queues, polling workers, ARNs, admission webhooks, CRDs) is incidental to the modeling idea. In every case the INV-15 analog is a **synchronous in-process resolver over a frozen table, with results appended to the SQLite event store**.

## 4. Recommended architecture: phase-kind binding

### 4.1 `PhaseKind` — the invariant layer (one closed union)

```ts
// The closed set of phase kinds. Substrate-level; workflow-agnostic.
export type PhaseKind =
  | 'IMPLEMENT'   // produces code changes — runs the verification ladder
  | 'PLAN'        // produces a plan artifact — runs plan-structure gates
  | 'REVIEW'      // read-only assessment — runs review-contract gates
  | 'SYNTHESIZE'  // produces/merges a PR — runs synthesis-readiness gates
  | 'GATHER';     // research/discovery — no code gates (discovery, triage, investigate)
```

The union is the **invariant layer**: it carries only what holds for *every* workflow type. This is INV-6 ("substrate guarantees hold for every workflow type; workflow-specifics live in topology and playbooks") made type-level.

### 4.2 `KIND_OBLIGATIONS` — the frozen kind→obligation table

```ts
interface PhaseObligations {
  /** How this kind resolves its gate-set. null = no code gates (GATHER). */
  readonly gates: GateObligation | null;
  /** Capability posture, carried as a bundle the kind hands over (INV-11). */
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
}

// Single grant point. `satisfies Record<PhaseKind, …>` makes a missing kind a COMPILE ERROR.
export const KIND_OBLIGATIONS = {
  IMPLEMENT:  { gates: { resolver: 'verification-ladder' }, posture: 'task-isolated' },
  PLAN:       { gates: { resolver: 'plan-structure' },      posture: 'read-only' },
  REVIEW:     { gates: { resolver: 'review-contract' },     posture: 'read-only' },
  SYNTHESIZE: { gates: { resolver: 'synthesis-readiness' }, posture: 'shared-mutating' },
  GATHER:     { gates: null,                                posture: 'read-only' },
} as const satisfies Record<PhaseKind, PhaseObligations>;
```

The table holds **only kind-universal obligations** — never workflow names, phase ordering, or transitions. The existing verification-ladder table (`resolveVerificationSequence`) becomes the resolver *behind* `IMPLEMENT.gates`; the plan gates (`check_task_decomposition` / `check_plan_coverage` / `check_provenance_chain`) become the `PLAN` resolver; the synthesis-readiness checks become `SYNTHESIZE`. The five implement-snowflakes all map to `kind: 'IMPLEMENT'` and inherit the ladder automatically.

### 4.3 Parse phases at the edge; carry `kind` as a tagged field

Each HSM phase gains a `kind` tag. This is the **parse-don't-validate** step (Alexis King): the topology/playbook entry is `unknown` until resolved once, at ingestion, into a proof-carrying value. Workflow-specific data (the state name `debug-implement`, its transitions) stays in `hsm-definitions.ts`; only the `kind` tag crosses into the obligation layer.

```ts
// hsm-definitions.ts — phases tagged by kind; names/transitions stay bespoke (INV-6 variation layer)
delegate:        { id: 'delegate',        type: 'atomic', parent: 'implementation', kind: 'IMPLEMENT' },
'debug-implement':  { id: 'debug-implement',  type: 'atomic', parent: 'thorough-track', kind: 'IMPLEMENT' },
'hotfix-implement': { id: 'hotfix-implement', type: 'atomic', parent: 'hotfix-track',   kind: 'IMPLEMENT' },
'polish-implement': { id: 'polish-implement', type: 'atomic', parent: 'polish-track',   kind: 'IMPLEMENT' },
```

### 4.4 One resolver, called non-optionally at every phase boundary (the PDP)

```ts
// Generalizes resolveVerificationSequence by adding phaseKind to the key space.
// Called at EVERY phase transition — no phase can opt out.
export function resolveGateSet(
  phaseKind: PhaseKind,
  ctx: { riskTier: RiskTier; boundaryTouching: boolean; /* … */ },
): readonly ResolvedGate[] {
  const ob = KIND_OBLIGATIONS[phaseKind];           // exhaustive; unknown kind impossible
  if (ob.gates === null) return [];                  // GATHER: no code gates
  return GATE_RESOLVERS[ob.gates.resolver](ctx);     // verification-ladder | plan-structure | …
}
```

The structural guarantee that closes the bug: the phase-transition handler in the HSM runner calls `resolveGateSet(phase.kind, ctx)` unconditionally. There is no code path where a phase "forgets" to query the resolver, because the playbook prose is no longer where verification lives.

### 4.5 Resolve-then-freeze (event-sourced, INV-1)

Borrowed from Argo's `storedWorkflowSpec` and Tekton's reference-then-resolve: resolve the gate-set **at phase-entry** and append it as an event. A later edit to the policy table cannot retroactively change what an in-flight or completed phase was held to. This is a left-fold over events (INV-1), and the HSM and the rehydration projection observe the *same* `phase.kind` trigger — satisfying the "live and replayed state observe the same trigger" rule already enforced for `merge-pending` (#1208).

```
phase.entered  { phase, kind, resolvedGates: [...], policySource: 'builtin'|'config', mode }
gate.executed  { gate, verdict, … }
phase.exited   { phase, allRequiredGatesPassed: bool }
```

### 4.6 Capabilities as a POLA bundle (INV-11 by construction)

The `posture` field is not an advisory flag; it is the grant point for an object-capability bundle (Mark Miller, POLA). A `REVIEW` phase receives a read-only capability set with no `MutateWorktree` token reachable — mutation is *unrepresentable*, not merely disallowed. This composes with, rather than duplicates, the existing INV-11 posture typing: the kind table is the single place authority is wired, once, for all workflows.

### 4.7 Audit → enforce graduation (fail-closed default)

From Kyverno/Gatekeeper's audit-vs-enforce mode: a newly-added gate (e.g. mutation-adequacy, the SIV boundary gates) can be bound to a kind in **audit** mode — it emits findings as events without blocking — and graduate to **enforce** later. Resolution errors fail **closed** (append `phase.blocked`, never silently proceed), which is the single-machine analog of an admission webhook's `failurePolicy: Fail`. This directly answers the #1537 / #1536 class of "gate fails closed or phantom-blocks": fail-closed becomes a *declared* per-binding property with a visible skip reason, not an accident of a parser that died.

## 5. Worked example: the asymmetry dissolves

| Today (`playbooks.ts`) | Under phase-kind binding |
|---|---|
| `feature:delegate` → `delegatePhaseEvents('delegate')` sources the ladder | `kind: IMPLEMENT` → `resolveGateSet('IMPLEMENT', ctx)` |
| `refactor:overhaul-delegate` → `delegatePhaseEvents('overhaul-delegate')` | `kind: IMPLEMENT` → same resolver |
| `debug:debug-implement` → hardcoded "write failing test first" prose | `kind: IMPLEMENT` → **same resolver, inherited** |
| `debug:hotfix-implement` → hardcoded TDD prose | `kind: IMPLEMENT` → **same resolver, inherited** |
| `refactor:polish-implement` → "implement directly", no gates | `kind: IMPLEMENT` → **same resolver, inherited** |
| `oneshot:implementing` → no playbook at all | `kind: IMPLEMENT` (ladder advisory per oneshot severity) |

Adding a sixth workflow type later: its implement phase is tagged `IMPLEMENT` and inherits the ladder with zero new playbook code. That is aspect quantification — the obligation applies wherever the pointcut (`kind == IMPLEMENT`) matches, including future phases not yet written.

## 6. Invariant-conformance analysis

| Invariant | Effect of the design | Verdict |
|---|---|---|
| **INV-1** event-sourcing | Resolved gate-set is an appended `phase.entered` event; HSM and projection fold the same `kind` trigger; resolve-then-freeze is a left-fold. | Strengthened |
| **INV-6** workload-agnosticism | The kind table *is* INV-6 made type-level: substrate obligations hold for every workflow type; names/transitions stay in topology. | **Central win** |
| **INV-15** single-machine | Every borrowed pattern's distribution machinery dropped; resolver is a synchronous in-process function; no queue/worker/webhook/saga. | Held |
| **INV-4** resolve-don't-bake | Gate-set resolves at runtime per phase; nothing baked into shipped artifacts; reuses the layered toolchain resolver for gate *commands*. | Held |
| **INV-11** posture | `posture` is a POLA capability bundle the kind hands over; read-only phase cannot hold a mutate token. | Strengthened |
| **INV-12** next-actions affordance | The next required gate / `phase.blocked` is surfaced through `next_actions`, derivable from (state, kind, topology). | Held |
| **INV-5a / INV-5d** tool ceiling | Internal architecture; adds **no** visible tools. Gate resolution stays inside `exarchos_orchestrate` / `exarchos_workflow`. | Held — *must not add a 5th composite tool or a new top-level verb* |
| **INV-2** facade-equivalence | Resolver lives in the shared dispatch core; CLI and MCP both observe identical resolved gate-sets. | Held |

The one invariant to actively guard during implementation is **INV-5a/5d**: a phase-kind registry is tempting to expose as its own tool. It must not be — it is an internal resolution detail under the existing four composite tools.

## 7. Named patterns catalog (what to steal, INV-15-filtered)

| # | Pattern | Source | Steal | INV-15 |
|---|---|---|---|---|
| P1 | Compositional statechart semantics | dl.acm.org/10.1145/355045.355062; Harel 1987 | Theoretical license: obligations must not depend on the embedding workflow | In-frame |
| P2 | Mode-with-a-contract (assume/guarantee) | 10.1145/973097.973101 | The ladder = IMPLEMENT's exit-*guarantee*; variants are refinements preserving it | In-frame |
| P3 | Aspect pointcut/advice weaving | d-nb.info/1253014213/34 | Bind gate-set via pointcut `kind == X`, not enumerated pairs; quantifies over future kinds | In-frame |
| P4 | XState `setup()` named-unit registry + factories | stately.ai/docs/setup | Register gate-sets by name keyed by kind; KINDs as parameterized configs | In-frame (local actors only) |
| P5 | Single entry/exit connector | whiterose 001_Simons.pdf §8 | Boundary-only phase communication so gates can't be bypassed | In-frame |
| P6 | Activity registry invoked by name | learn.microsoft.com/azure/durable-task | `Map<GateName, GateImpl>`; strengthen runtime-name → compile-time typed binding | In-frame (drop task queue) |
| P7 | Interceptor / middleware chain | docs.temporal.io interceptors | "Verify before advancing" = gate chain wrapped around the phase-advance append | In-frame |
| P8 | Definition / Configuration / Execution split | Netflix Conductor | Gate-definition (policy) vs KIND-binding (data) vs gate-run (event) | In-frame |
| P9 | PDP/PEP split + non-optional query | openpolicyagent.org/docs/philosophy | The resolver exists; make every phase boundary query it | In-frame (embed, not remote) |
| P10 | ConstraintTemplate → Constraint | Kyverno/Gatekeeper | Define gate once, bind per kind with params; audit→enforce mode | Drop webhook/CRD |
| P11 | Resolve-then-freeze | Argo `storedWorkflowSpec`; Tekton resolver | Persist the resolved gate-set as an event at phase-entry | In-frame |
| P12 | Union + frozen `Record<Kind>` table + brand | King; Wlaschin; dataorienteddesign.com | The TS spine: union + `satisfies Record<PhaseKind>` + branded `resolvePhase` | In-frame |
| P13 | Exhaustive `assertNever` dispatch | basarat; fullstory | Adding a kind breaks every dispatch site until handled | In-frame |
| P14 | POLA capability bundle | Miller SRL2003-03 | Posture as non-ambient capability handed over by the kind | In-frame |

Explicitly **out-of-frame** (extract modeling, discard mechanism): Temporal/Cadence task queues + polling workers; Step Functions `.sync` ARN polling + EventBridge; Kyverno/Tekton/Argo Kubernetes control plane (CRDs, admission webhooks, namespaces). Each maps to a synchronous in-process resolver over the event store; phase-kind scope replaces namespace/cluster scope.

## 8. Migration path (no big bang)

The patterns support an additive, audit-first rollout — each step ships independently and is reversible.

1. **Tag, don't change behavior.** Add a `kind` field to every HSM phase (the parse step). Pure classification over existing states; no gate behavior changes. Characterize current gate outputs first (Feathers-style), per the epic's own test plan.
2. **Stand up the resolver.** Build `KIND_OBLIGATIONS` + `resolveGateSet(kind, ctx)` with the verification-ladder resolver behind `IMPLEMENT`. Wire it into the phase boundary as the non-optional PDP call. Run newly-covered phases (`debug-implement`, `hotfix-implement`, `polish-implement`, `implementing`) in **audit** mode — they emit gate findings as events without blocking.
3. **Migrate bindings off playbooks.** Move plan/synthesis gate selection into `PLAN` / `SYNTHESIZE` resolvers; delete the hardcoded TDD prose from the implement playbooks (its obligation now lives in the table). Graduate audit → enforce per the epic's severity rules (advisory for oneshot, blocking for feature/debug/refactor).
4. **Capabilities + freeze.** Replace ad-hoc posture handling with the POLA bundle (INV-11), and add resolve-then-freeze events. This step retires #1537 (integration-suite resolves via the toolchain resolver behind `IMPLEMENT`/`high`-tier) and the #1536 / #1543 / #1544 class (gate selection and fail-closed semantics become declared, not accidental).

## 9. Relationship to #1258 (Workflow SDK) and #1515 (verification ladder)

- **#1515 (verification ladder).** This design *delivers the epic's thesis*. Binding the ladder to `IMPLEMENT` makes "replace mandatory red-green-refactor" true on every implement phase, not two. The SIV boundary-tier gates bind to the same `IMPLEMENT` obligation (boundary-touching branch). No new epic — this is the missing wiring under the one already in flight.
- **#1258 (Workflow SDK, v3.0).** The phase-kind table is the natural substrate the SDK compiles *to*. A `.workflow.ts` IR that says "this workflow walks PLAN → IMPLEMENT → REVIEW" needs exactly a kind vocabulary with obligations attached. Doing the kind layer now in v2.11/v2.12 is a down-payment on #1258, not a competitor: the SDK becomes "author the topology; kinds supply the obligations." Recommend capturing this as a dependency note on #1258.

## 10. Risks and open questions

- **Kind granularity.** Four-to-five kinds is a guess. `PLAN` covers feature plan-review *and* debug `rca`/`design`; `GATHER` covers discovery `gathering`, debug `triage`/`investigate`, refactor `explore`. If variants need materially different obligations, the union grows — watch for combinatorial pressure (the signal to factor kind-obligations from workflow-specifics harder, not to add kinds).
- **Posture vs kind coupling.** `IMPLEMENT` is assumed `task-isolated`, but is every implement phase isolated? Verify against the worktree-isolation work (#1512) before fixing posture in the table.
- **The brand cast discipline.** `resolvePhase` is the only place allowed to mint a resolved phase; a leaked `as` cast collapses the guarantee. Needs a lint rule confining the cast to one module.
- **INV-5a/5d temptation.** Do not expose the registry as a tool. Internal only.
- **Validation against the eval suite.** The epic gates acceptance on a token-reduction demonstration (#1525 telemetry). The kind layer should be measured the same way — does inheriting the ladder on debug/polish change token cost at equal-or-better correctness?

## 11. Recommendation

Take **(B) the structural fix** as a real design, scoped as additive migration steps 1–4 above, landing inside epic #1515 (it completes the epic rather than opening a new front). Fold #1537 into step 4 and reframe #1543/#1544/#1536 as gate-selection/fail-closed semantics the new resolver makes declarative. Capture the #1258 dependency. Do **not** take on a general "generic workflow IR" — that is #1258's job; this spike deliberately stops at a closed kind vocabulary with table-driven obligations.

**Next step:** `/exarchos:ideate` scoped to "phase-kind obligation layer (steps 1–2)", referencing this report as design input.

## Sources

**Statecharts:** compositional statechart semantics (dl.acm.org/doi/10.1145/355045.355062); Harel, *Statecharts* 1987 (state-machine.com/doc/Harel87.pdf); modular refinement of hierarchic reactive machines (dl.acm.org/doi/10.1145/973097.973101); SCXML invoke/param, W3C REC 2015 (w3.org/TR/2015/REC-scxml-20150901/); aspect-oriented FSM weaving (d-nb.info/1253014213/34; link.springer.com/article/10.1007/s11390-009-9269-5); UML composite-state encapsulation (eprints.whiterose.ac.uk/id/eprint/200744); XState v5 setup/createStateConfig (stately.ai/docs/setup; stately.ai/docs/machines.mdx); generic-params discussion (github.com/statelyai/xstate/discussions/4574); orthogonal regions (statecharts.online/chapters/05-orthogonal-states.html).

**Orchestration:** Durable Functions / DTF programming model + sub-orchestrations (learn.microsoft.com/azure/durable-task/common/programming-model-overview; …/durable-task-sub-orchestrations); Temporal interceptors (docs.temporal.io/develop/python/interceptors) + task queues (docs.temporal.io/task-queue); AWS Step Functions nested workflows (docs.aws.amazon.com/step-functions/latest/dg/connect-stepfunctions.html); Netflix Conductor tasks (conductor-oss.github.io/conductor/devguide/concepts/tasks.html); Cadence activities (cadenceworkflow.io/docs/go-client/activities).

**Policy-as-data:** OPA philosophy + partial evaluation (openpolicyagent.org/docs/philosophy; …/policy-performance); GitHub Actions reusable workflows (docs.github.com/en/actions/sharing-automations/reusing-workflows); GitLab CI optimization/rules (docs.gitlab.com/ci/yaml/yaml_optimization/; docs.gitlab.com/ci/jobs/job_rules/); Tekton taskRef + Argo storedWorkflowSpec (tekton.dev/docs/pipelines/taskruns/; redhat.com migration-to-resolvers); Kyverno vs Gatekeeper (policyascode.dev/blog/opa-gatekeeper-vs-kyverno/).

**Type-driven:** make-illegal-states-unrepresentable (fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/; buttondown.com/hillelwayne — constructive vs predicative); parse-don't-validate (lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/; cekrem.github.io parse-dont-validate-typescript); POLA / ocaps (srl.cs.jhu.edu/pubs/SRL2003-03.pdf; usenix.org hotsec07 miller); algebraic effects (sciencedirect.com S1571066115000705; homepages.inf.ed.ac.uk/gdp handling-algebraic-effects); branded types (nanamanu.com/posts/branded-types-typescript/; dev.to opaque-types); table-driven / data-oriented design (dataorienteddesign.com/dodmain/node7.html, node16.html); discriminated-union exhaustiveness (basarat.gitbook.io; fullstory.com/blog/discriminated-unions-and-exhaustiveness-checking-in-typescript/; rows: dl.acm.org/doi/10.1145/3290325).
