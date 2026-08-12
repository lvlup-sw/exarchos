# Ship-gate → Workflow SDK migration contract (DR-6)

**Date:** 2026-06-23
**Epic:** [#1592](https://github.com/lvlup-sw/exarchos/issues/1592) (ship-gate methodology)
**Parent design:** [`2026-06-21-ship-gate-methodology.md`](2026-06-21-ship-gate-methodology.md)
**SDK target:** [#1258](https://github.com/lvlup-sw/exarchos/issues/1258) — Workflow Builder SDK — design [`2026-05-06-workflow-builder-sdk.md`](2026-05-06-workflow-builder-sdk.md)

## Purpose

The ship-gate methodology (DR-1…DR-7) shipped as small, additive patterns on the existing REVIEW/SYNTHESIZE kinds — deliberately, so the eventual `ship-gate.workflow.ts` is a **behavior-preserving consolidation, not a redesign** (DR-6).
This note records the durable contract: each as-shipped pattern ↦ the exact Workflow Builder SDK combinator it lowers into, with the **real symbol names and parameter values** so the consolidation re-uses values rather than re-deriving them.

When the SDK (#1258) lands, this table is the checklist for collapsing review + synthesize + shepherd into one declarative IR. The divergence guard (DR-6 task 023, in `escalation-policy.ts`) enforces that the interim escalation defaults cannot silently fork from the semantics recorded here before that consolidation.

## Pattern ↦ combinator map (as shipped)

| DR | Pattern (as shipped) | Key symbols / values | SDK combinator |
|----|----------------------|----------------------|----------------|
| **DR-1** | Intent grounding — `artifacts.intent` derived once, consumed by REVIEW + PR-body | `verbs/tasks/extract-intent.ts`: `deriveIntent` / `persistIntent` (single `state.patched`); read by `prepare_review` grounding + `validate_pr_body`/`create_pr` (`readIntent`/`groundBodyInIntent`) | **`Step.handler('extractIntent')`** — the workflow's start step (`startWith(extractIntent)`) |
| **DR-2** | Document-readiness leg in SYNTHESIZE | `prepare-synthesis.ts`: `evaluateDocumentLeg` / `documentLegBlocks`; config `synthesis.documentLeg.{severity,surfaceGlobs,docGlobs}` (advisory→blocking) | **`Step.handler('updateDocs')`** / **`Step.gate`** document step in the readiness sequence |
| **DR-3** | Uniform bounded auto-fix + ask-user escalation | `verbs/review/escalation-policy.ts`: `resolveEscalationPolicy({ maxIterations })` (default **5**, config `escalation.maxIterations`, per-loop override), `decideEscalation` (mechanical → auto-fix to bound; intent-touching → escalate now), `countShepherdIterations` (single counter), `shepherd.escalated` event surfaced via `shepherd_status` | **`repeatUntil(cond, body, { maxIterations })`** (the bounded auto-fix) **+ `awaitApproval(approver).onTimeout(...).onRejection(...)`** (the ask-user escalation) |
| **DR-4** | Single PR owner + explicit-SHA lease | `vcs/create-pr.ts`: `PR_ALREADY_OWNED` structural guard + retained double-create guard; `vcs/push-with-lease.ts`: `buildForceWithLeaseArgs` / `resolveExpectedSha` (explicit `--force-with-lease=<ref>:<sha>`) | single **`Step.handler('openPR')`** owner + **`Step.handler('pushWithLease')`** |
| **DR-5** | Opt-in pre-push ship-gate hook | `hooks/pre-push.ship-gate.sample` (thin trigger, blocks on a blocking finding, degrades open) | **outside the IR** — git-domain trigger; engine = the workflow, trigger = the git gate |
| **DR-7** | Platform-generic PR-feedback ingestion | `vcs/provider.ts` widened `PrComment` (`source`/`parentId`/tri-state `resolved`); `vcs/github.ts` `getPrComments` 3-surface aggregation + fail-soft GraphQL `resolved`; `assess_stack` generic consumption | **no new combinator** — a data-contract widening of the feed the shepherd `repeatUntil(s => s.ci.green, …)` / `Step.handler('watchCI')` step already consumes |

## SDK-contract values (the durable anchor)

The interim escalation policy is authored to map onto the SDK's `repeatUntil` / `awaitApproval` combinators **by value**, so consolidation is a rename of the call site, not a re-derivation of the semantics:

- **`repeatUntil` option name:** the bound is named **`maxIterations`** — identical to the SDK's `repeatUntil(condition, body, { maxIterations })` option. The interim `EscalationPolicy.maxIterations` and `resolveEscalationPolicy({ maxIterations })` re-use that exact name.
- **Default bound:** **5** (`DEFAULT_MAX_ITERATIONS`). Config-resolvable via `escalation.maxIterations`; per-loop override supported. This is the value the `repeatUntil({ maxIterations })` body inherits on consolidation.
- **Approval semantics (`awaitApproval`):** the ask-user escalation fires when **either** the bound is reached **or** a finding is **intent-touching** (escalate immediately, regardless of remaining budget). `decideEscalation` returns `escalate` in exactly those two cases — the same shape as `awaitApproval(...).onTimeout(/* bound */)` + an immediate approval gate for intent-touching findings. Mechanical findings auto-fix within the bound (the `repeatUntil` body).
- **Single iteration source:** `countShepherdIterations(events)` (count of `shepherd.iteration` events) is the one counter both the loop and the `shepherd-status` view read — the SDK's `repeatUntil` iteration count maps onto it 1:1.

These values are mirrored as a machine-checkable constant (`SDK_MIGRATION_CONTRACT`) in `escalation-policy.ts`; the DR-6 divergence guard test asserts the live policy conforms to them, so the interim defaults and the documented SDK semantics cannot drift apart before #1258 consolidates them.

## What stays outside the consolidation

- **DR-5 pre-push hook** — a git-domain trigger, never part of the IR (INV-15: no daemon; the workflow is the engine).
- **Provider/platform axis (DR-7)** — owned by the `VcsProvider` abstraction, not the workflow; the IR consumes the platform-neutral `PrComment` feed.

## Roadmap caveat

The SDK's milestone is inconsistent across artifacts (SDK design says v3.1.0; #1573 says v3.2.0; roadmap memory places it under v3.0). This contract is anchored on the **combinator mapping**, which is durable regardless of which milestone the SDK ships under. Reconciling the milestone label is a separate, out-of-scope task.
