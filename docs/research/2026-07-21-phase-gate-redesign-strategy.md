# Phase Gate Redesign Strategy

**Date:** 2026-07-21  
**Workflow:** `phase-gate-redesign-research`  
**Correlation:** `4c76a189-67e6-446b-902f-7c5da23e8937`  
**Status:** Discovery synthesis for `/ideate`

## Executive conclusion

Exarchos should stop treating phase gates as state predicates attached to HSM edges. The state machine should own topology only: which transitions exist, which event or branch condition selects an edge, and which bounded loops are legal. A separate transition-admission pipeline should decide whether the selected edge may be crossed.

The recommended architecture is:

```text
transition intent
  -> topology condition
  -> frozen requirement set
  -> typed evidence lookup
  -> policy decision
  -> atomic decision + transition append
```

This keeps the useful phase-kind work, but replaces brittle `Record<string, unknown> -> boolean` guards with evidence-backed, explainable decisions. It also gives epic #1258 a declarative contract that can lower into the shared Strategos workflow IR. The existing `GateDeclaration` and `GateClass` contract is the correct identity layer. It needs an additive admission-policy and evidence layer, not another Exarchos-only guard registry.

## Current-system diagnosis

The current gate system has several strong foundations:

- `PhaseKind` and `KIND_OBLIGATIONS` bind obligations by reusable kind rather than by workflow-specific phase pairs.
- gate resolution is centralized and fail-closed.
- `phase.entered` freezes a resolved obligation for replay.
- the SQLite appender supports atomic multi-event decisions.

The remaining transition layer undermines those foundations:

1. **Guards consume untyped mutable state.** `Guard.evaluate` receives `Record<string, unknown>`. Individual guards inspect ad hoc shapes, accept alternate field locations, and mix predicate logic with human messages and mutation suggestions.
2. **Presence is treated as proof.** Several guards accept any non-null artifact, a mutable boolean such as `planReview.approved`, or a free-form status string. `implementationComplete` always passes. `allTasksComplete` passes when no task array exists.
3. **Remediation can forge the condition.** Suggested fixes patch `tasks[].status`, `reviews.*.status`, or `unblocked` directly. They do not require a verifier to produce attributable evidence.
4. **Phase obligation and phase exit are disconnected.** `phase.entered` freezes gates, but `phase.exited.allRequiredGatesPassed` is inferred from whether the edge is a fix cycle. It is not computed from gate evidence.
5. **Risk defaults fail open.** Missing `riskTier` becomes `low`; missing `boundaryTouching` becomes `false`.
6. **Gate evidence is too weak.** `gate.executed` has a string name, boolean verdict, and open-ended details. It has no mandatory subject digest, producer version, policy digest, or evidence digest.
7. **Some evidence writes are best-effort.** Gate event append failures are swallowed in several handlers, so a successful carrier can exist without durable evidence.
8. **Custom guards are shell commands.** `exec(guard.command)` is platform-sensitive, not toolchain-resolved, and returns only pass/error/output.
9. **Affordances ignore present admissibility.** `next_actions` lists outbound HSM edges and guard descriptions without evaluating which evidence is missing or stale.

The result is a system where topology, policy, verification, evidence, severity, operator override, and remediation are coupled in one primitive.

## Architectural constraints

The redesign must preserve the following:

- **INV-1:** facts and decisions are appended events; projections replay the same result without re-running policy or tools.
- **INV-2, issue #1608 reframe:** the CLI is a presentation client over the MCP contract. Gate behavior lives in the shared dispatch core and is equivalent by construction.
- **INV-4, issue #1608 reframe:** emit a standard-conformant artifact where a standard exists, with a thin shim only where it does not.
- **INV-6:** policy concepts use substrate vocabulary such as requirement, evidence, subject, decision, and waiver. Workflow-specific phase names remain in topology.
- **INV-8:** transition attempts and evidence writes are idempotent.
- **INV-9:** the HSM remains the sole authority for legal sequencing.
- **INV-12:** blocked requirements and safe remediation are published through `next_actions`.
- **INV-15:** the decision engine is synchronous and in-process over the local event store. No remote policy service, queue, saga, or supervisor is required.

There is a source conflict around **INV-11**. Issue #1608 says task isolation is launcher-enforced at the process boundary. The later parent issue #1601 narrows the launcher to lifecycle ownership and explicitly retracts filesystem-space enforcement. `docs/system-design.html` still contains both the stronger launcher claim and a note pointing at #1608. This redesign should not depend on the disputed space claim. Its by-construction chokepoint is narrower and defensible: every workflow transition passes through the dispatch/HSM admission boundary.

## Research synthesis

The external systems converge on four patterns.

### 1. Edge conditions are small and deterministic

SCXML and AWS Step Functions use ordered conditions to select a path. They do not make an edge predicate responsible for producing evidence, deciding enforcement severity, or proposing remediation. Temporal adds the replay constraint: workflow logic must not call nondeterministic external systems during replay.

**Implication:** distinguish a topology condition from an admission policy. A condition answers which legal edge is selected. An admission policy answers whether the selected edge has sufficient proof.

### 2. Policy is a structured decision contract

OPA separates the policy decision point from the enforcement point and can return structured results, decision IDs, explanations, and policy revisions. Cedar demonstrates the importance of default deny and explicit diagnostics, while also showing why Exarchos needs a first-class `indeterminate` outcome rather than silently skipping errored rules.

**Implication:** decisions are `allow | deny | indeterminate`, not booleans. The transition boundary denies `indeterminate`.

### 3. Evidence is immutable and subject-bound

in-toto binds typed predicates to digest-identified subjects. SLSA verification summaries record verifier identity, policy identity and digest, input attestation digests, and the final result.

**Implication:** a mutable state flag is not evidence. Gate output must identify what was checked, by which producer/version, under which policy, and against which commit, diff, artifact, task, or wave.

### 4. Risk tailors assurance but does not erase it

NIST SSDF is outcome-based and risk-tailored. Sigstore policy-controller and Tekton Chains demonstrate a practical pairing: one component produces signed or attributable evidence, and a chokepoint enforces policy over it.

**Implication:** `riskTier`, boundary status, policy mode, severity, and applicability remain independent axes. Higher risk must monotonically add obligations. Weakening requires an explicit waiver event.

## Recommended architecture

### A. Separate four typed contracts

**Edge condition**

A pure, declarative selector over projected facts or event types. It has no I/O, policy reads, severity, or remediation.

**Requirement set**

Resolved when a phase is entered and frozen as an event. It includes:

- requirement IDs and versions
- gate declaration references
- subject scope
- applicability
- enforcement mode and severity
- freshness rules
- risk and boundary inputs
- policy ID, version, and digest
- waiver rules

**Evidence statement**

An in-toto-inspired record:

```ts
interface EvidenceStatement {
  id: string;
  predicateType: string;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  producer: { id: string; version: string };
  invocationId: string;
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  measurements: Record<string, number | string | boolean>;
  policy: { id: string; version: string; digest: string };
  contentDigest: string;
  createdAt: string;
}
```

Large reports remain content-addressed artifacts referenced by digest.

**Transition decision**

```ts
interface TransitionDecision {
  outcome: 'allow' | 'deny' | 'indeterminate';
  code: string;
  reasons: DecisionReason[];
  satisfied: RequirementResult[];
  unsatisfied: RequirementResult[];
  evidenceRefs: string[];
  remediation: ActionDescriptor[];
  policy: { id: string; version: string; digest: string };
  inputDigest: string;
}
```

Remediation actions run gates, collect evidence, classify unknown risk, request approval, or request a scoped waiver. They never patch a passing status into workflow state.

### B. Make transition admission the sole enforcement point

For every transition attempt:

1. fold the stream at an expected version;
2. validate that the HSM edge exists;
3. evaluate the edge condition;
4. load the current phase's frozen requirements;
5. resolve referenced evidence from events and the content store;
6. evaluate the policy;
7. atomically append either a denied decision, or the decision plus `phase.exited`, `workflow.transition`, and the target `phase.entered`.

`AtomicAppender.decide` is the natural substrate. This also fixes the current partial sibling-event append risk.

### C. Integrate risk and gate reliability

The resolver should use:

- `riskTier`
- `boundaryTouching`
- workflow/phase kind
- project policy
- gate-class reliability from planned issue #1646

Unknown risk is `unknown`, not `low`. The minimum rules are:

```text
requirements(low) subset requirements(medium) subset requirements(high)
requirements(tier, boundary=true) superset requirements(tier, boundary=false)
```

Reliability should add corroboration or human review when a gate has a high measured false-positive rate. It must not silently waive an obligation. Gate reliability is telemetry-produced and provenance-bearing, matching the Strategos `GateReliability` contract.

### D. Derive `next_actions` from the decision

Return two distinct concepts:

- **legal transitions:** edges present in topology;
- **currently actionable moves:** missing evidence, stale evidence, failed requirements, and safe remediation.

An agent should see `run_gate`, `collect_evidence`, `request_approval`, `request_waiver`, or `retry_transition` with structured arguments.

## Epic #1258 and shared IR lowering

Epic #1258 plans to delete `hsm-definitions.ts` and `playbooks.ts` and compile all workflows to `WorkflowDefinitionV1`. The phase-gate redesign should land as a prerequisite or coordinated contract revision, not as an interim registry that the SDK later deletes.

The current Strategos contract already provides:

- `GateClass`, a closed cross-runtime gate taxonomy;
- `GateDeclaration { class, id, reliability? }`;
- `GateStep.gateId`, a reference to a declaration;
- a declarative-only wire contract that rejects executable conditions on import.

The missing pieces are additive:

```text
WorkflowDefinitionV1.admissionPolicies[]
TransitionDefinition.admissionPolicyId?
AdmissionPolicyDefinition.requirements[]
EvidenceRequirement
WaiverPolicy
DecisionEffect
```

The TypeScript builder can remain ergonomic, but every admission rule must lower to declarative IR. Arbitrary closures over workflow state cannot be the wire contract. Use named predicate/provider references resolved through the same registry and capability path as steps and gates.

The #1258 built-in migration gate should also change. Bit-identical `(states, transitions, guards)` parity would preserve the brittle model. Capture golden transition-decision fixtures instead: given topology, state facts, frozen requirements, and evidence, the migrated IR must produce the intended decision. Then delete the legacy guard registry.

## Options

### Option 1: Harden the current guard registry

Replace `Record<string, unknown>` with typed state slices, remove obvious always-pass guards, and improve error messages.

**Benefit:** smallest near-term change.  
**Limit:** keeps evidence, policy, and topology coupled; does not lower cleanly into #1258; custom shell guards remain a portability problem.

### Option 2: Model every gate as an explicit workflow step

Require workflows to place `GateStep` nodes before transitions.

**Benefit:** visible graph and direct reuse of the shared gate taxonomy.  
**Limit:** a gate step produces evidence but does not define how several pieces of evidence combine, how risk changes the requirement set, or how stale/contradictory evidence is handled. A direct edge can still bypass the intended proof unless admission is independently enforced.

### Option 3: Evidence-backed transition admission

Keep gate steps as evidence producers and introduce a declarative admission policy evaluated at the canonical transition boundary.

**Benefit:** strict separation of topology, verification, evidence, policy, and remediation; shared-IR compatible; risk-aware; explainable; replay-stable; platform and workload agnostic.  
**Cost:** requires an additive TypeSpec contract and a staged migration of legacy guards.

**Recommendation:** Option 3.

## Migration strategy

1. **Characterize:** build a corpus of transition attempts across all built-in workflows, including current bypasses and false passes.
2. **Strengthen evidence:** introduce typed gate classes, subjects, producer/version, policy digest, and content digests. Make gate-runner emission durable and non-optional.
3. **Shadow decisions:** evaluate the new admission engine in audit mode beside legacy guards and record disagreements.
4. **Extend the shared IR:** add admission-policy and evidence-requirement definitions to Strategos.Contracts; generate Exarchos Zod from the same schema.
5. **Migrate built-ins:** lower each legacy guard into an edge condition, an evidence requirement, or an explicit human approval/waiver. No catch-all custom predicate.
6. **Enforce:** switch transition admission to the new decision engine, use atomic multi-event append, and derive `next_actions` from decisions.
7. **Delete:** remove `workflow/guards.ts`, custom shell guards, mutable pass-state suggestions, and guard-parity acceptance from #1258.

## Open design questions

1. Should admission-policy definitions be added directly to shared `WorkflowDefinitionV1`, or versioned as `WorkflowDefinitionV1.1` while keeping schema version `1.0` additive semantics?
2. Which named predicate vocabulary is the minimum needed for edge selection without reintroducing a string expression language?
3. What subject scopes are required initially: workflow, phase, wave, task, commit, diff, and artifact?
4. Which approvals are ordinary required evidence, and which are explicit waivers that weaken policy?
5. How should contradictory evidence trigger the diagnostic fork mechanism already present in the Strategos IR?

## Primary sources

- [W3C SCXML](https://www.w3.org/TR/scxml/)
- [Temporal workflow determinism and replay](https://docs.temporal.io/workflow-definition)
- [AWS Step Functions Choice state](https://docs.aws.amazon.com/step-functions/latest/dg/state-choice.html)
- [OPA integration](https://www.openpolicyagent.org/docs/integration)
- [OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs)
- [Cedar authorization semantics](https://docs.cedarpolicy.com/auth/authorization.html)
- [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
- [SLSA Verification Summary Attestation v1.2](https://slsa.dev/spec/v1.2/verification_summary)
- [NIST Secure Software Development Framework](https://csrc.nist.gov/Projects/ssdf)
- [Open Workflow Specification](https://github.com/open-workflow-specification/specification)
- [CDEvents](https://github.com/cdevents/spec/blob/main/spec.md)
- [Tekton Chains](https://tekton.dev/docs/chains/)
- [Sigstore policy-controller](https://docs.sigstore.dev/policy-controller/overview/)

## Repository and roadmap sources

- `docs/system-design.html`
- `.exarchos/invariants.md`
- `docs/research/2026-06-16-phase-kind-binding-architecture.md`
- `docs/research/2026-06-02-verification-pipeline-recommendations.md`
- `servers/exarchos-mcp/src/workflow/{guards,state-machine,phase-kind,hsm-transition-guard}.ts`
- `servers/exarchos-mcp/src/verbs/gates/gate-utils.ts`
- `servers/exarchos-mcp/src/event-store/{schemas,atomic-appender}.ts`
- [Exarchos issue #1608](https://github.com/lvlup-sw/exarchos/issues/1608)
- [Exarchos epic #1258](https://github.com/lvlup-sw/exarchos/issues/1258)
- [Exarchos issue #1247](https://github.com/lvlup-sw/exarchos/issues/1247)
- [Exarchos issue #1646](https://github.com/lvlup-sw/exarchos/issues/1646)
- [Strategos issue #100](https://github.com/lvlup-sw/strategos/issues/100)
- [Strategos issue #150](https://github.com/lvlup-sw/strategos/issues/150)
- [Strategos issue #151](https://github.com/lvlup-sw/strategos/issues/151)
