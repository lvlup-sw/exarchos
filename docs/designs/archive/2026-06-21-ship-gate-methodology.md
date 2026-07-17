# Design: Ship-Gate Methodology (mine `no-mistakes`, interim before the Workflow Builder SDK)

**Date:** 2026-06-21
**Workflow:** `ship-gate-methodology` (discovery)
**Tracking:** issue [#1573](https://github.com/lvlup-sw/exarchos/issues/1573) (milestone 15 — *v2.11.0 Verification & Reliability*); end-state collapses into the Workflow Builder SDK ([#1258](https://github.com/lvlup-sw/exarchos/issues/1258), `docs/designs/2026-05-06-workflow-builder-sdk.md`).
**Discovery inputs:** #1573; `kunchenguid/no-mistakes` (external reference impl); the SDK design; the parallel methodology work (`docs/research/2026-06-21-methodology-drift-audit.md`, `docs/designs/2026-06-21-methodology-reconciliation.md`).
**Format precedent:** `docs/designs/2026-06-21-worktree-lifecycle-manager.md` (mine an external tool's *mechanisms*, reject its *model/substrate*, decompose into epic + issue deltas).
**Frame:** `.exarchos/invariants.md` — INV-6 workload-agnosticism, INV-1 event-sourcing, INV-10 liveness, INV-11 posture, INV-13/14 two-event/recovery, INV-15 single-machine/no-daemon, INV-5a/5d surface, INV-2 parity, INV-4 platform-agnosticity.

---

## Problem Statement

#1573 proposes adopting the **`no-mistakes`** validation-pipeline methodology: an *enforced, fixed-sequence* ship pipeline (intent → rebase → review → test → document → lint → push → PR → CI) that an empirical eval found more effective than Exarchos's à-la-carte `/review` + `/synthesize` + `/shepherd` phases. The mechanism is a `post-receive` hook on a local bare gate repo (`~/.no-mistakes/repos/<id>.git`): `git push no-mistakes <branch>` triggers a **daemon** that runs the pipeline in a disposable worktree, spawns an agent CLI per stage, auto-fixes within per-step limits, escalates blocking/ask-user findings, and stops at `checks-passed` (no auto-merge).

The headline framing — *mine the patterns, do not adopt the tool* — is correct, and for a load-bearing reason: running `no-mistakes` alongside Exarchos creates **two orchestrators** contending for PR creation, worktree ownership, and CI watch. This design grounds #1573's five interim patterns against Exarchos's actual architecture (**phase-kind binding** + the **verification ladder**), corrects two of the issue's premises against the code, and decomposes the work into an epic + issue deltas whose every interim pattern maps to a Workflow Builder SDK combinator so the v3.x consolidation is behavior-preserving.

The grounding surfaced two corrections worth stating up front, because they change scope:

1. **"Single PR owner" is *already mostly true.*** Synthesize is the sole PR creator (`skills-src/synthesis/SKILL.md`), and `create-pr.ts:122-191` already guards against double-creation by querying existing PRs on the `(head, base)` pair before `gh pr create`. Shepherd never creates a PR; it is **not even a phase** (see §Grounding). So pattern #4 narrows from *"make synthesize the sole owner"* (done) to *"harden the residual gaps"*: the `--force-with-lease` pushes carry **no explicit SHA** (`commands/shepherd.md:83`, `commands/synthesize.md:73`), and shepherd's "never re-create" is **convention, not a structural guard**.
2. **The pipeline maps onto two phase-kinds, not three phases.** Shepherd is an iteration loop *inside* the SYNTHESIZE phase (the workflow phase stays `synthesize` throughout — `commands/shepherd.md:16`; no `shepherd` HSM state exists). So `no-mistakes`'s "fixed sequence" lands on exactly **REVIEW → SYNTHESIZE**, and every pattern attaches to one of those two kinds. This is what makes the patterns *additive*, not a re-architecture.

---

## Grounding: `no-mistakes` mapped onto phase-kind + the verification ladder

Exarchos already has the **structural equivalent** of a fixed-sequence pipeline: the **phase-kind obligation layer** (`servers/exarchos-mcp/src/workflow/phase-kind.ts`). Obligations bind to a *kind*, never to a workflow type or phase id (INV-6), via the frozen `KIND_OBLIGATIONS` table:

| PhaseKind | Gate resolver | Resolved gate-set | Posture |
|---|---|---|---|
| IMPLEMENT | `verification-ladder` | tier-scaled: `check_static_analysis` → `+check_test_adequacy` → `+check_integration_suite` (+boundary gates) | `task-isolated` |
| PLAN | `plan-structure` | decompose → coverage → spec-coverage → provenance → traceability | `read-only` |
| REVIEW | `review-contract` | `getRequiredReviews(workflowType, riskTier)` | `read-only` |
| SYNTHESIZE | `synthesis-readiness` | `task-completion` → `tests` → `typecheck` → `stack` | **`shared-mutating`** |
| GATHER | — (`null`) | — | `read-only` |

The verification ladder (`verification-policy.ts`) is the IMPLEMENT-kind resolver: a pure (riskTier, boundaryTouching) → ordered-gate-sequence table. **`no-mistakes` re-runs `test`/`lint` as discrete pipeline *steps*; Exarchos already enforces them as kind-bound *gates*** — per-task at IMPLEMENT (the ladder's `check_static_analysis` = lint+typecheck, `check_test_adequacy`/`check_integration_suite` = tests), and again in aggregate as SYNTHESIZE-kind `synthesis-readiness` legs (`tests`, `typecheck`). We therefore do **not** re-implement test/lint — that is precisely the "everything else is better native" half of the issue. The pipeline's stages map as:

| `no-mistakes` stage | Exarchos home today | Gap |
|---|---|---|
| **intent** | nowhere — `create_pr`/`validate_pr_body` take no intent arg; review receives only a diff | **absent** (pattern #1) |
| rebase | `worktree.baseRef` + merge-orchestrator preflight | covered |
| **review** | REVIEW kind → `review-contract` (spec-review + quality-review) | covered (intent-blind) |
| **test** | IMPLEMENT ladder (`check_test_adequacy`/`integration_suite`) + SYNTHESIZE `tests` leg | covered |
| **document** | — `SynthesisLeg = task-completion\|tests\|typecheck\|stack`; no docs leg anywhere | **absent** (pattern #2) |
| **lint** | IMPLEMENT ladder (`check_static_analysis`); *not* a discrete SYNTHESIZE leg | covered per-task; aggregate optional |
| push / PR | SYNTHESIZE `create_pr` (two-event, idempotent, double-create guarded) | covered; lease unhardened (pattern #4) |
| **CI** | shepherd loop *within* SYNTHESIZE (`assess_stack` polls CI) | covered |
| **(forcing function)** | none — phases are opt-in slash commands | **absent** (pattern #5) |
| **bounded auto-fix + ask-user** | exists but **non-uniform**: shepherd `maxIterations:5`+escalation; quality-review `3`+pause; spec-review **unbounded** re-dispatch | **inconsistent** (pattern #3) |

**Net grounding:** three true gaps (intent, document, forcing-function), one *uniformity* gap (escalation), and one *hardening* gap (lease + structural PR-owner guard). None requires a new PhaseKind or a new workflow type — every change is a new obligation/state/leg on an existing kind, which is exactly the property that lets it later lower into the SDK IR unchanged.

---

## Chosen Approach

**Approach A — Mine the patterns into the REVIEW/SYNTHESIZE kinds; trigger via an inline `pre-push` hook (selected over running the tool, and over waiting for the SDK).**

Each pattern lands as an *additive* obligation on an existing kind, kept workload-agnostic (INV-6) and authored so it maps one-to-one onto an SDK combinator (§Roadmap). The one mechanism mined from `no-mistakes`-the-*tool* — the forcing function — is **re-hosted as an inline git `pre-push` hook**, not its bare-repo `post-receive` daemon: a daemon-backed gate remote is a long-running background service, which **INV-15 rejects** ("no daemon … single-machine"). A `pre-push` hook runs inline in the user's own process, invokes the existing ship-path verbs, and adds no second orchestrator.

```
          ┌──────────────── Ship-Gate (additive obligations on existing kinds) ─────────────────┐
 (new) intent  derive transcript/diff intent ─► artifacts.intent ──┐                              │
               REVIEW kind (review-contract) ◄─────────────────────┘ consumes intent (DR-1)       │
               SYNTHESIZE kind (synthesis-readiness):                                              │
                 task-completion ─► tests ─► typecheck ─► [+ document leg, DR-2] ─► stack          │
                 create_pr (sole owner; idempotent; structural no-recreate guard, DR-4)            │
                 ╰─ shepherd loop (assess_stack/CI) ── uniform maxIterations + ask-user (DR-3)     │
 (new, opt-in) git pre-push hook ──► invokes ship path (NOT a post-receive daemon; INV-15) (DR-5)  │
               every pattern ↦ an SDK combinator (repeatUntil / awaitApproval / Step.*) (DR-6)     │
          ───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Approaches Considered

### Option A — Mine patterns into the existing kinds + inline pre-push trigger (CHOSEN)

**Pros:** additive (no new kind/workflow type — INV-6 clean); each pattern is small and independently shippable in the current v2.11/v2.12 line; every change is authored to lower into an SDK combinator, so the future `ship-gate.workflow.ts` is a behavior-preserving consolidation, not a rewrite; no second orchestrator.
**Cons:** five small surfaces rather than one artifact; the escalation-uniformity work touches three skills; until the SDK lands the "sequence" is enforced by kind obligations + an opt-in hook, not by a single declarative file.
**Best when:** the goal is the methodology *now*, on the current substrate, without pre-paying the SDK. — our case.

### Option B — Run `no-mistakes` alongside Exarchos (vendor/wrap the tool)

**Pros:** the enforced pipeline exists immediately; nothing to build.
**Cons:** **two orchestrators** — `no-mistakes` and Exarchos both create PRs, own worktrees, and watch CI, the exact conflict #1573 calls out; its `post-receive` **daemon** + bare gate repo violate INV-15 (no daemon) and re-introduce a second source of truth outside the event store (INV-1); it spawns its own agent CLI per stage, bypassing the capability/posture layer (INV-11) and the CC-native-isolation seam. Rejected.

### Option C — Wait for the Workflow Builder SDK, express it as `ship-gate.workflow.ts` directly

**Pros:** the cleanest end-state; one declarative file subsumes review + synthesize + shepherd.
**Cons:** the SDK (#1258) is unshipped and its milestone is in flux (design frontmatter says v3.1.0; #1573 says "v3.2.0 Workflow / Remote Agent Layer"; see §Roadmap). Blocking the methodology on it defers the verification-quality win by ≥2 milestones. Deferred — this design *targets* it as the end-state and makes the interim work forward-compatible, rather than waiting.

---

## Requirements

### DR-1: Intent grounding consumed by REVIEW + PR-body
A transcript/diff-derived **intent** is captured as workflow state and consumed by the REVIEW kind and by PR-body generation. Intent is an additive `artifacts.intent` field (or a `*.intent_extracted` event folded into state), never a new PhaseKind and never a workflow-typed branch (INV-6). Maps to the SDK's `Step.handler('extractIntent')` start step.

**Acceptance criteria:**
- An `extract_intent`-style action (or a fold in `prepare_review`/`prepare_synthesis`) derives intent from the session transcript and/or the cumulative diff and writes it to workflow state via a single state-patch event (INV-1; no side file).
- The REVIEW dispatch prompt and `validate_pr_body`/`create_pr` body generation **read** `artifacts.intent`; a review run and a PR body are both demonstrably grounded in it (e.g. the spec-review checklist references intended-vs-delivered).
- Intent capture is workflow-agnostic: the same code path runs for `feature`, `debug`, `refactor`, `oneshot` with no type switch (INV-6 lint clean).

### DR-2: Document-readiness leg in the SYNTHESIZE kind
An explicit documentation step joins the ship path. The cleanest seam is a new `document` leg on the `synthesis-readiness` resolver (extending `SynthesisLeg` in `phase-kind.ts:66` and the `prepare_synthesis` legs), evaluated as a structural coverage check: when the change touches a public/docs-bearing surface, the relevant docs must have changed (or the leg explicitly waived with reason).

**Acceptance criteria:**
- `SynthesisLeg` gains `'document'`; the `synthesis-readiness` resolver emits it in sequence (after `typecheck`, before/at `stack`); the `ResolveGateSet_…` SoT pin is updated in lock-step (the resolver test that pins the leg roster).
- `prepare_synthesis` evaluates the docs leg and emits a `gate.executed` event for it (dimension consistent with the other legs) so the readiness view and the eval flywheel see it.
- A change touching a documented surface with **no** doc update fails the leg with an actionable message; a non-doc-bearing change passes (or auto-waives) without ceremony. The leg's severity is config-resolvable (advisory→blocking) so a consumer repo can tune it.

### DR-3: Uniform bounded auto-fix + ask-user escalation
The review/test/lint/CI fix loops share **one** escalation policy: a bounded `maxIterations` per loop plus an explicit ask-user escalation when the bound is hit or a finding is intent-touching (vs mechanical). Today this is inconsistent — shepherd `maxIterations:5` + structured escalation, quality-review `3` + pause, **spec-review unbounded** re-dispatch, delegate `maxFixCycles:3`. Standardize on a shared policy bound at the kind/resolver layer (INV-6), with a single iteration-count source of truth.

**Acceptance criteria:**
- A shared escalation policy (config-resolvable defaults, mirroring `no-mistakes`' `auto_fix.<step>` + `ask-user` model) is consumed by spec-review, quality-review, and the shepherd loop; spec-review's unbounded re-dispatch gains a bound.
- Mechanical findings are auto-fixed within the bound; intent-touching findings escalate to the user immediately (not after exhausting the bound).
- Iteration count has a single source: the loop reads/writes one event-sourced counter (resolving the current shepherd-state-vs-`assess_stack`-events dual-source noted in grounding), so `ps`/`shepherd_status` and the loop never disagree.
- Hitting the bound emits a structured escalation (not a hang) and surfaces via the existing liveness/`shepherd_status` views (INV-10).

### DR-4: Single PR owner — harden, don't rebuild
Synthesize stays the sole PR creator (already true). Close the two residual gaps: (a) make "shepherd never re-creates a PR" a **structural** guarantee, not prose; (b) every resubmit push uses `--force-with-lease` with an **explicit expected SHA**.

**Acceptance criteria:**
- The shepherd loop has no path to `create_pr` (it can only push/assess); a regression test asserts a shepherd-context `create_pr` is refused, and the existing `create-pr.ts:122-191` double-create guard is retained and unit-pinned.
- All ship-path pushes use `git push --force-with-lease=<ref>:<expected-sha>` with the SHA from a **fresh `git ls-remote` immediately before push** (the tightest TOCTOU window — see Decision Log #5), not the last `assess_stack` observation and not a bare lease; a unit test asserts the explicit-SHA form is emitted.
- The skill-layer PR idempotency check and the handler-layer guard are reconciled to one authority (remove the redundant second layer noted in grounding) so a single rule governs "PR already exists."

### DR-5: (Optional) forcing-function trigger — inline pre-push hook, no daemon
A documented, **opt-in** git `pre-push` hook invokes the ship path so quality is enforced rather than opt-in. It is explicitly **not** `no-mistakes`' bare-repo `post-receive` daemon (INV-15) and is never auto-installed (POLA — no surprise execution on a cloned repo, mirroring the worktree design's user-scope-hooks rule).

**Acceptance criteria:**
- A documented `pre-push` hook (install is an explicit user action, not a repo-side script that runs automatically) calls the existing ship-path verbs and blocks the push on a blocking finding; passing the gate allows the push through.
- No background process, no bare gate repo, no second orchestrator is introduced (INV-15); the hook is a thin trigger, the engine stays Exarchos.
- The hook is harness/OS-neutral (git-domain; INV-4) and degrades to a clear message when the ship-path verbs are unavailable.

### DR-6: SDK migration contract (behavior-preserving consolidation)
Each interim pattern is authored to map onto exactly one Workflow Builder SDK combinator, and the mapping is recorded as a durable contract so the eventual `ship-gate.workflow.ts` (#1258 era) is a behavior-preserving *consolidation*, not a redesign.

**Acceptance criteria:**
- A migration note (in this design's neighborhood and referenced from #1258) tabulates pattern ↦ combinator (DR-1↦`Step.handler` start step; DR-2↦`Step.handler`/`Step.gate` document step; DR-3↦`repeatUntil(…,{maxIterations})` + `awaitApproval(onTimeout/onRejection)`; DR-4↦single `Step.handler('openPR')` owner + `pushWithLease`; DR-5↦git-hook trigger outside the IR).
- The interim escalation policy's parameter names/semantics (`maxIterations`, ask-user) match the SDK's `repeatUntil` options and `awaitApproval` shape, so consolidation re-uses values, not re-derives them.
- A guard (lint/test) flags divergence between the interim escalation defaults and the documented SDK combinator semantics, so the two cannot silently fork before consolidation.

### DR-7: Comprehensive, platform-generic PR-feedback ingestion in `assess_stack`
*(Added at `/plan`, 2026-06-22 — user requirement.)* The shepherd loop's `assess_stack` must harvest **every** comment on a PR — top-level conversation, inline per-line review comments, and review-summary bodies — from **any** author (human, bot like CodeRabbit/Sentry, or the PR owner), preserving **thread nesting** (replies), so the escalation policy (DR-3) and review consumption decide on the complete feedback set. Today `github.getPrComments` deliberately reads **only** the issues-comments endpoint (`repos/{owner}/{repo}/issues/{id}/comments`) to make the `addComment` post-then-verify round-trip work; inline review comments (`/pulls/{id}/comments`), review summaries (`/pulls/{id}/reviews`), and `in_reply_to_id` threading are invisible, and `getReviewStatus` returns only reviewer *states*, not finding text. The fix is a **contract widening, not a GitHub special-case**: generalize `PrComment` to a platform-neutral, thread-aware shape and have `assess_stack` consume it without overfitting to one provider's quirks (INV-6 workload-agnosticism — no workflow-type branch in the harvest; the provider abstraction owns the platform axis).

**Acceptance criteria:**
- `PrComment` (in `vcs/provider.ts`) gains a platform-neutral, thread-aware shape: a `source` discriminator (`issue-comment | review-inline | review-summary`), `author` (any party), an optional `parentId`/`threadId` for nesting, an optional `resolved?` (absent ≠ false — unknown is explicit), retaining `path`/`line`. No GitHub field names leak into the contract.
- `github.getPrComments` aggregates **all three sources** — issues comments + inline review comments + review-summary bodies — paginated (`--paginate`), from every author, with replies linked via `parentId`. The existing `addComment` verify path keeps working (the posted comment is still present in the superset; matching stays id/marker-based, not endpoint-shape-based).
- `assess_stack` consumes the richer feed generically: unresolved-comment and review-address action items are derived from the unified set regardless of source or author; no provider-name or workflow-type conditional in the harvest loop (INV-6). A bot's inline review comment and a human's threaded reply both surface as action items.
- `gitlab`/`azure-devops` `getPrComments` conform to the **new signature** (compile against the widened `PrComment`); they keep throwing `UnsupportedOperationError` (status quo for every comment op on those providers) — full harvesting impls are deferred follow-ups, explicitly out of scope here. **The deferral is tracked, not silent:** filing two follow-up issues (GitLab notes/discussions harvesting; Azure DevOps threads-API harvesting), each linked to DR-7/#1592 and carrying the platform-neutral `PrComment` contract as its conformance target, is itself a deliverable of the DR-7 bundle.
- CLI≡MCP parity + registered `outputSchema` preserved for `get_pr_comments`/`assess_stack` (INV-2); the widened `PrComment` is reflected in any registered shape.

**DR-7 SDK mapping.** No new combinator — DR-7 **widens the data contract** the existing shepherd `repeatUntil(s => s.ci.green, …)` loop and the `assess`/`watchCI` step consume. It is a feedback-model enrichment of `Step.handler('watchCI')`/the assess step, not a new step.

**DR-7 implementation grounding (researched 2026-06-22, live GitHub docs).** The harvest aggregates **three REST surfaces**, all `gh api --paginate` (per_page max 100):
1. `repos/{o}/{r}/issues/{n}/comments` — PR conversation timeline (today's sole source) → `source: 'issue-comment'`.
2. `repos/{o}/{r}/pulls/{n}/comments` — inline per-line review comments → `source: 'review-inline'`; carry `in_reply_to_id` → `parentId` (threading is **one-level only** — GitHub disallows replies-to-replies, so a flat `parentId` is complete), plus `path`/`line`, `pull_request_review_id`.
3. `repos/{o}/{r}/pulls/{n}/reviews` — review verdict bodies → `source: 'review-summary'`; carry `body` + `state` (APPROVED | CHANGES_REQUESTED | COMMENTED). (`getReviewStatus` already reads this for *state*; DR-7 also needs the *body*.)

`author` = `user.login` for every surface (bots included — `user.type === 'Bot'`; the existing `review/registry.ts detectKind` already classifies CodeRabbit/Sentry). **Resolved status** is **GraphQL-only** (REST omits it — the `github.ts:126` comment is right about REST): a best-effort `reviewThreads(first:100){ nodes { isResolved isOutdated comments(first:1){ nodes { databaseId } } } }` pass maps `databaseId === REST id` → `resolved`. This enrichment is **fail-soft** (warn + proceed on GraphQL error; map miss ⇒ leave `resolved` absent — *absent ≠ false*, the contract's unknown-is-explicit rule, independently confirmed by the bun/thunderbird harvesters). The `addComment` verify path stays correct: its posted comment is an issue-comment, still present in surface (1) of the superset; matching stays id/marker-based.

---

## Roadmap & End-State Migration

**Interim ships now** on the current line — milestone 15 (*v2.11.0 Verification & Reliability*, where #1573 already lives), spilling to v2.12 if needed. The patterns are independent and individually mergeable.

**End-state** collapses review + synthesize + shepherd into one `.workflow.ts` once the Workflow Builder SDK lands. The SDK design (`docs/designs/2026-05-06-workflow-builder-sdk.md`) confirms the combinators the interim work targets exist: `Workflow.create`/`startWith`/`then`, `repeatUntil(condition, body, {maxIterations})`, `awaitApproval(approver, …).onTimeout(...).onRejection(...)`, `onFailure`/`compensate`/`finally`, and the `Step.handler`/`Step.delegate`/`Step.gate` factories. The illustrative end-state from #1573:

```ts
// .exarchos/workflows/ship-gate.workflow.ts (illustrative end-state)
Workflow.create<ShipState>('ship-gate')
  .startWith(extractIntent)                                   // ← DR-1
  .then(Step.handler('rebaseOntoBase'), c => c.withRetry({ max: 3 }))
  .then(codeReview)                                           // ← REVIEW kind, intent-grounded
  .repeatUntil(s => s.findings.blocking === 0,                // ← DR-3 (bounded auto-fix)
     b => b.then(Step.delegate('fixer', { goal: 'resolve-findings' }))
           .then(Step.gate('check_review_verdict')), { maxIterations: 3 })
  .then(Step.handler('runTests'))                             // ← ladder / synthesis-readiness
  .then(updateDocs)                                           // ← DR-2 (document leg)
  .then(Step.handler('runLint'), c => c.withRetry({ max: 3 }))
  .then(Step.handler('pushWithLease'))                        // ← DR-4 (explicit-SHA lease)
  .then(Step.handler('openPR'))                               // ← DR-4 (single PR owner)
  .then(Step.handler('watchCI'))                              // ← shepherd loop
  .repeatUntil(s => s.ci.green, b => b.then(Step.delegate('fixer', { goal: 'fix-ci' })), { maxIterations: 3 })
  .onFailure(f => f.compensate(Step.handler('cleanup_worktree')))
  .finally(phronesisReview);
```

The forcing-function trigger (DR-5) stays a git-hook concern **outside** the IR: engine = the Exarchos workflow, trigger = the git gate.

**Version-in-flux note (open decision, not resolved here).** The SDK's milestone is inconsistent across artifacts: the SDK design frontmatter says **v3.1.0**, #1573 says **"v3.2.0 Workflow / Remote Agent Layer,"** and the project roadmap memory places the SDK under **v3.0 Authoring**. This design deliberately does **not** pick a number — it anchors the migration on the *combinator mapping* (DR-6), which is durable regardless of which milestone the SDK ultimately ships under. Reconciling the roadmap label is a separate, out-of-scope task.

---

## Invariant Conformance

| INV | How satisfied | DR |
|---|---|---|
| INV-6 (workload-agnosticism) | every pattern is an additive obligation on an existing kind; no workflow-typed branch; intent/docs/escalation hold across all workflow types | DR-1,2,3 |
| INV-1 (event-sourcing) | intent, docs-leg result, iteration counter are events/state-patches folded into projections; no side file | DR-1,2,3 |
| INV-10 (liveness) | escalation surfaces via `shepherd_status`/`ps` from events; bound-hit emits a structured terminal, never a hang | DR-3 |
| INV-11 (posture) | SYNTHESIZE stays `shared-mutating`; shepherd's no-`create_pr` is by construction, not prose | DR-4 |
| INV-13/14 (two-event / recovery) | `create_pr` retains its `requested`/`executed` split + idempotent precheck; lease hardening preserves the recovery posture | DR-4 |
| INV-15 (single-machine, no daemon) | forcing function is an inline `pre-push` hook, **not** a `post-receive` gate daemon; no second orchestrator | DR-5, Option B rejection |
| INV-5a/5d (surface) | new behavior rides existing actions/legs; no new visible composite tool; counts unchanged | DR-1,2 |
| INV-2 (parity) | any new/changed action keeps CLI≡MCP parity + registered outputSchema | DR-1,2,3 |
| INV-4 (platform-agnosticity) | the `pre-push` hook is git-domain, harness/OS-neutral | DR-5 |

---

## Epic + Issue-delta map

**New epic — "Ship-gate methodology (interim `no-mistakes` adoption)"**, parented by / converting #1573, on milestone 15 (v2.11) with spill to v2.12. (Note: #1573 currently carries auto-triage mislabels — `type:bug` + `status:triage` + guessed scopes; strip on epic creation, per the known auto-triage behavior.)

Sub-issues (one per DR, independently shippable):

1. **feat(review/synthesize): intent grounding** — derive transcript/diff intent into `artifacts.intent`; consume it in REVIEW dispatch + `validate_pr_body`/`create_pr` body generation. *(DR-1; SDK ↦ `Step.handler('extractIntent')`.)*
2. **feat(synthesize): document-readiness leg** — extend `SynthesisLeg` + the `synthesis-readiness` resolver + `prepare_synthesis` with a `document` leg; update the resolver SoT pin and emit `gate.executed`. *(DR-2; SDK ↦ `updateDocs` step.)*
3. **refactor(escalation): uniform bounded auto-fix + ask-user** — one shared, config-resolvable escalation policy across spec-review/quality-review/shepherd; bound spec-review's unbounded loop; single event-sourced iteration counter. *(DR-3; SDK ↦ `repeatUntil({maxIterations})` + `awaitApproval`.)*
4. **fix(synthesize/shepherd): harden single PR owner** — structural no-`create_pr` guard for the shepherd loop + regression test; explicit-SHA `--force-with-lease`; collapse the dual PR-idempotency layers to one authority. *(DR-4; SDK ↦ single `openPR` + `pushWithLease`.)*
5. **feat(trigger, optional): opt-in `pre-push` ship-gate hook** — documented, user-installed, inline; invokes the ship path; explicitly no daemon/bare-repo. *(DR-5; outside the IR.)*
6. **docs(migration): SDK combinator contract** — the pattern↦combinator table + divergence guard, referenced from #1258 so the v3.x `ship-gate.workflow.ts` is a behavior-preserving consolidation. *(DR-6.)*

**Coherence cleanups (fold into the sub-issue that touches the same code):** the redundant skill-vs-handler PR-idempotency layers → sub-issue 4; the shepherd-state-vs-`assess_stack`-events dual iteration source → sub-issue 3.

---

## Non-Goals

- **No vendoring/running of `no-mistakes`-the-tool** — mine the patterns; reject the daemon + bare gate repo (Option B; INV-15/INV-1/INV-11).
- **No auto-merge** — `no-mistakes` itself stops at `checks-passed`; the human merge checkpoint in synthesize is preserved.
- **No new PhaseKind or workflow type** — every pattern is an obligation on REVIEW/SYNTHESIZE (INV-6).
- **No re-implementation of test/lint as discrete steps** — they remain kind-bound gates (the verification ladder at IMPLEMENT + synthesis-readiness legs); the methodology adds intent/document/forcing-function/uniformity, not duplicate verification.
- **No early commitment to the SDK milestone number** — interim is milestone-15-targeted; the SDK version is reconciled elsewhere (§Roadmap).
- **No conflation with the TDD-excision methodology work** — `2026-06-21-methodology-reconciliation.md` (verification-ladder/RGR coherence) is a *sibling* effort; this design depends on neither and only shares the phase-kind/ladder substrate.

---

## Open Questions

1. **Docs leg home (DR-2):** a `synthesis-readiness` *leg* (structural "docs changed when surface changed" — chosen here) vs a REVIEW *dimension* (content-quality judgment of the docs). The leg is lighter and rides existing readiness plumbing; a dimension catches doc *quality* but costs a review pass. Lean: ship the leg now, revisit the dimension if quality (not coverage) proves the gap.
2. **Intent source (DR-1):** transcript-derived (richest, but transcript availability varies across runtimes — INV-4) vs diff-derived (always available, shallower) vs both. Lean: diff-derived as the floor, transcript as an enrichment when present.
3. **Forcing function default (DR-5):** ship opt-in only (chosen), or also document a "run after synthesize" convention? No auto-install regardless (POLA).
4. **Escalation bound defaults (DR-3):** adopt `no-mistakes`' per-step `auto_fix` limits verbatim, or keep Exarchos's current shepherd `5` as the uniform default and let config tune per loop? Lean: uniform default + per-loop config override.
5. **Lease SHA source (DR-4):** the SHA from the loop's last `assess_stack` observation vs a fresh `git ls-remote` immediately before push (tighter TOCTOU window). Lean: fresh `ls-remote` at push time.

---

## Decision Log — `/ideate`, 2026-06-22

Resolved at ideate entry (epic addressed as a unit: #1592 → #1593–#1598). The five "Lean" answers above are **adopted as final**; the open questions are closed:

| # | Decision (CHOSEN) | DR |
|---|---|---|
| 1 | Docs ships as a **`synthesis-readiness` leg** (structural "docs changed when surface changed"); a REVIEW *dimension* is deferred until doc *quality* (not coverage) is shown to be the gap. | DR-2 |
| 2 | Intent is **diff-derived (always-available INV-4 floor) + transcript enrichment when present** — single code path, no per-runtime branch. | DR-1 |
| 3 | Forcing function is **opt-in only, never auto-installed** (POLA); a "run after synthesize" convention may be documented but installs nothing. | DR-5 |
| 4 | Escalation uses a **uniform default (Exarchos's shepherd `5`) + per-loop config override**, not `no-mistakes`' per-step limits verbatim. | DR-3 |
| 5 | Lease SHA comes from a **fresh `git ls-remote` immediately before push** (tightest TOCTOU window), not the last `assess_stack` observation. | DR-4 |

**Build structure.** Drive #1592 as **one feature workflow** (`1592-ship-gate-methodology`) whose plan decomposes into six independently-mergeable task-bundles, shipped as a short stack of focused PRs in an overlap-minimizing order:

**DR-2 → DR-1 → DR-4 → DR-7 → DR-3 → DR-5 → DR-6.** Rationale: DR-2 is the isolated resolver change (establishes the leg pattern first); DR-1 and DR-4 both touch `create-pr.ts`/`prepare-synthesis.ts` so DR-1's intent edits land before DR-4 hardens the same file; **DR-7 widens the `assess_stack` feedback contract and DR-3 consumes it, so DR-7 precedes DR-3** (both are the `assess-stack.ts`-heavy cluster, sequenced after DR-4's lighter create-pr touch); DR-5 is isolated (git-hook); DR-6 documents the final shapes, so it goes last and captures the as-shipped escalation defaults **and the widened `PrComment` contract** for the divergence guard / SDK migration table.

DR-7 was added at `/plan` from a user requirement (comprehensive, platform-generic PR-feedback harvesting) with the **contract-generic + GitHub-complete** scope chosen: generalize `PrComment` + complete GitHub's three comment sources now; GitLab/ADO conform to the signature but stay `UnsupportedOperationError`, with their full harvesting tracked via two filed follow-up issues (a DR-7 deliverable).

**Reference refresh (since design date, post #1515-Phase4 + #1581).** Structure unchanged, line numbers drifted: `SynthesisLeg` now `phase-kind.ts:76` (was `:66`); `synthesis-readiness` resolver roster at `phase-kind.ts:215`; `create-pr.ts` double-create guard at `:124–193` (was `:122-191`). The shared `ResolveGateSetCtx` coordination risk (roadmap #1599 rule 1) is cleared now that both `riskTier` (#1515) and `designDepth` (#1581) have merged — #1592's additive obligations extend the same struct with no live contender.

---

## Sources

**Internal:** #1573; this discovery's gathered evidence (phase-kind.ts, verification-policy.ts, the review/synthesize/shepherd commands + skills, `prepare-synthesis.ts`, `vcs/create-pr.ts`, `assess-stack.ts`, `validate-pr-body.ts`); the SDK design (`docs/designs/2026-05-06-workflow-builder-sdk.md`, #1258); `.exarchos/invariants.md`; the parallel methodology work (`2026-06-21-methodology-drift-audit.md`, `2026-06-21-methodology-reconciliation.md`); the format precedent (`2026-06-21-treehouse-worktree-mining.md`, `2026-06-21-worktree-lifecycle-manager.md`).
**External:** `kunchenguid/no-mistakes` (`internal/git/hook.go`, `internal/pipeline/steps/`, `internal/agent/`); the tooling eval (`claude-bootstrap` → `docs/research/2026-06-21-tooling-eval-memory-axi-family.md`).
