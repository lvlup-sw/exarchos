# Implementation Plan: Ship-Gate Methodology (#1592)

**Date:** 2026-06-22
**Design (SoT):** [`docs/designs/2026-06-21-ship-gate-methodology.md`](../designs/2026-06-21-ship-gate-methodology.md)
**Epic:** [#1592](https://github.com/lvlup-sw/exarchos/issues/1592) → #1593–#1598 (+ DR-7, new)
**Feature workflow:** `1592-ship-gate-methodology`
**Milestone:** v2.11.0 (`build:preview.4`)

## Scope & structure

One feature workflow decomposed into **seven independently-mergeable bundles** (one per DR), shipped as a short stack of focused PRs in the overlap-minimizing build order:

**DR-2 → DR-1 → DR-4 → DR-7 → DR-3 → DR-5 → DR-6**

All five original open questions are resolved (design Decision Log); DR-7 added at plan-time per user requirement with **contract-generic + GitHub-complete** scope. Every task is additive on the REVIEW/SYNTHESIZE kinds — no new `PhaseKind`, no workflow-typed branch (INV-6).

## Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks | Bundle |
|----|-------------|-------|--------|
| DR-2 | Document-readiness leg in SYNTHESIZE | 001–003 | A |
| DR-1 | Intent grounding (REVIEW + PR-body) | 004–006 | B |
| DR-4 | Harden single PR owner (lease + structural guard) | 007–009 | C |
| DR-7 | Platform-generic PR-feedback ingestion in `assess_stack` | 010–014 | D |
| DR-3 | Uniform bounded auto-fix + ask-user escalation | 015–019 | E |
| DR-5 | Opt-in pre-push ship-gate hook (no daemon) | 020–021 | F |
| DR-6 | SDK combinator migration contract | 022–023 | G |

---

## Bundle A — DR-2: Document-readiness leg

### Task 001: Extend `SynthesisLeg` with `'document'` + update resolver roster SoT pin
**Implements:** DR-2
**Risk Tier:** high
**Boundary Touching:** true  *(shared resolver contract consumed across the synthesis path)*
**Verification:** medium set + integration suite across the resolver seam; `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/workflow/phase-kind.ts` (`SynthesisLeg` :76, `synthesis-readiness` resolver :215), `servers/exarchos-mcp/src/workflow/phase-kind.test.ts`
**Tests:** `SynthesisReadinessResolver_Roster_PinsDocumentAfterTypecheck`, `ResolveGateSet_Synthesis_EmitsDocumentLegInSequence`
**Dependencies:** None
**Parallelizable:** No (foundation for 002–003)

### Task 002: Evaluate docs-coverage leg in `prepare_synthesis` + emit `gate.executed`
**Implements:** DR-2
**Risk Tier:** medium
**Verification:** scoped tests + `check_test_adequacy` kill-probe (test-after).
**Files:** `servers/exarchos-mcp/src/verbs/team/prepare-synthesis.ts`, `prepare-synthesis.test.ts`
**Tests:** `PrepareSynthesis_DocBearingSurfaceNoDocChange_FailsDocumentLeg`, `PrepareSynthesis_NonDocBearingChange_AutoWaivesDocumentLeg`, `PrepareSynthesis_DocumentLeg_EmitsGateExecutedEvent`
**Dependencies:** 001
**Parallelizable:** No

### Task 003: Config-resolvable docs-leg severity (advisory → blocking)
**Implements:** DR-2
**Risk Tier:** medium
**Boundary Touching:** true  *(config-resolution surface — re-tiered at /plan after a blast-radius discovery, not a re-plan)*
**Verification:** scoped tests + kill-probe + full MCP suite (the `config:true` describe path is snapshot-sensitive).
**Files (config plumbing mirrors the `storage` block precedent):**
- `servers/exarchos-mcp/src/config/exarchos-config-schema.ts` — `SynthesisConfigSchema` (`.strict()` zod, `documentLeg: { severity, surfaceGlobs, docGlobs }`), wired into `ExarchosConfigSchema`.
- `config/yaml-schema.ts` — `synthesis: SynthesisConfigSchema.optional()`.
- `config/resolve.ts` — `ResolvedProjectConfig.synthesis` + DEFAULTS + one-line resolve map.
- `verbs/composite.ts` — **new `adaptWithEventStoreAndConfig` adapter** (mirrors `adaptLadderGate`'s `ctx.projectConfig`→args injection); switch `prepare_synthesis` to it. *Required because `handlePrepareSynthesis` is dispatched via `adaptWithEventStore` and does NOT receive `projectConfig` today.*
- `verbs/team/prepare-synthesis.ts` — read `args.projectConfig`; reuse `architecture/glob-to-regexp.ts` for surface/doc matching.
- Defaults: `severity:'advisory'`, `docGlobs:['docs/**','**/*.md']`, **empty `surfaceGlobs` ⇒ auto-waive** (opt-in per consumer, non-overfit).
**Tests:** `DocumentLeg_SeverityConfig_ResolvesAdvisoryToBlocking`, `DocumentLeg_DefaultSeverity_IsAdvisory`, `PrepareSynthesis_AdapterThreadsProjectConfig`
**Dependencies:** 002
**Parallelizable:** No

---

## Bundle B — DR-1: Intent grounding

### Task 004: `artifacts.intent` state field + diff-derived floor (+ transcript enrichment) written via single state-patch
**Implements:** DR-1
**Risk Tier:** medium
**Boundary Touching:** false
**Verification:** scoped tests + `check_test_adequacy` kill-probe.
**Files:** `servers/exarchos-mcp/src/verbs/team/prepare-synthesis.ts` (or a folded `extract_intent` in `prepare-review.ts`), workflow-state types, co-located test
**Tests:** `ExtractIntent_DiffDerivedFloor_WritesArtifactsIntent`, `ExtractIntent_TranscriptPresent_EnrichesIntent`, `ExtractIntent_WorkflowAgnostic_NoTypeBranch`
**Dependencies:** None
**Parallelizable:** No (foundation for 005–006); ⚠ touches `prepare-synthesis.ts` — sequence after Bundle A

### Task 005: REVIEW dispatch prompt reads `artifacts.intent` (intended-vs-delivered)
**Implements:** DR-1
**Risk Tier:** medium
**Verification:** scoped tests on the prepare_review dispatch shape; kill-probe. Skill-body edit also requires snapshot + batch-baseline update.
**Files:** `servers/exarchos-mcp/src/verbs/team/prepare-review.ts`, `skills-src/spec-review/SKILL.md`, co-located test
**Tests:** `PrepareReview_WithIntent_GroundsSpecReviewChecklist`, `PrepareReview_NoIntent_DegradesToDiffOnly`
**Dependencies:** 004
**Parallelizable:** No

### Task 006: `validate_pr_body` + `create_pr` body generation read `artifacts.intent`
**Implements:** DR-1
**Risk Tier:** medium
**Verification:** scoped tests + kill-probe.
**Files:** `servers/exarchos-mcp/src/verbs/vcs/validate-pr-body.ts`, `vcs/create-pr.ts`, co-located tests
**Tests:** `ValidatePrBody_WithIntent_GroundsBody`, `CreatePr_Body_ReferencesIntent`
**Dependencies:** 004
**Parallelizable:** Yes (with 005)

---

## Bundle C — DR-4: Harden single PR owner

### Task 007: Harden single PR owner — structural no-`create_pr` guard for shepherd context + retain/pin double-create guard
**Implements:** DR-4
**Risk Tier:** high
**Boundary Touching:** true  *(posture/dispatch boundary — INV-11)*
**Verification:** medium set + integration suite; kill-probe. The guard must be by-construction, not prose.
**Files:** `servers/exarchos-mcp/src/verbs/vcs/create-pr.ts` (guard :124–193 retained), dispatch/posture layer, `create-pr.test.ts`
**Tests:** `CreatePr_ShepherdContext_Refused`, `CreatePr_DoubleCreateGuard_RetainedAndPinned`
**Dependencies:** None
**Parallelizable:** No

### Task 008: Explicit-SHA `--force-with-lease` via fresh `git ls-remote` at push time
**Implements:** DR-4
**Risk Tier:** medium
**Verification:** scoped tests asserting the explicit-SHA lease form is emitted; kill-probe.
**Files:** push helper / `commands/shepherd.md` (:83), `commands/synthesize.md` (:73), co-located test
**Tests:** `PushWithLease_EmitsExplicitShaForm`, `PushWithLease_FreshLsRemote_AnchorsToObservedSha`
**Dependencies:** None
**Parallelizable:** Yes (with 007)

### Task 009: Collapse dual skill-vs-handler PR-idempotency layers to one authority
**Implements:** DR-4
**Risk Tier:** medium
**Verification:** scoped tests; kill-probe. Skill edit → snapshot + batch-baseline update.
**Files:** `skills-src/shepherd/SKILL.md` (:177), `vcs/create-pr.ts`, co-located test
**Tests:** `PrIdempotency_SingleAuthority_HandlerGuardOnly`
**Dependencies:** 007
**Parallelizable:** No

---

## Bundle D — DR-7: Platform-generic PR-feedback ingestion

### Task 010: Widen `PrComment` to a platform-neutral, thread-aware shape
**Implements:** DR-7
**Risk Tier:** high
**Boundary Touching:** true  *(cross-cutting provider contract)*
**Verification:** medium set + integration suite across provider consumers; kill-probe. No GitHub field names leak.
**Files:** `servers/exarchos-mcp/src/vcs/provider.ts` (`PrComment` :62), `provider.test.ts`
**Tests:** `PrComment_Shape_CarriesSourceAuthorThreadResolved`, `PrComment_Resolved_AbsentIsUnknownNotFalse`
**Dependencies:** None
**Parallelizable:** No (foundation for 011–013)

### Task 011: `github.getPrComments` aggregates issues + inline-review + review-summary, paginated, threaded, any author
**Implements:** DR-7
**Risk Tier:** high
**Boundary Touching:** true  *(VCS I/O adapter)*
**Verification:** medium set + integration suite; kill-probe. The `addComment` verify path must still find its posted comment in the superset.
**Researched endpoints (live GitHub docs, 2026-06-22 — see design §DR-7 grounding):** aggregate three `gh api --paginate` surfaces — `issues/{n}/comments` (`source:'issue-comment'`), `pulls/{n}/comments` (`source:'review-inline'`, `in_reply_to_id`→`parentId` [one-level only], `path`/`line`), `pulls/{n}/reviews` (`source:'review-summary'`, `body`+`state`). Then a **fail-soft GraphQL `reviewThreads` enrichment** for `resolved` (`databaseId === REST id`; on error/miss leave `resolved` absent — *absent ≠ false*).
**Files:** `servers/exarchos-mcp/src/vcs/github.ts` (`getPrComments` :243, `GhPrCommentEntry` :41), `github.test.ts`
**Tests:** `GetPrComments_AggregatesAllThreeSources`, `GetPrComments_LinksRepliesViaParentId`, `GetPrComments_AnyAuthor_IncludesBots`, `GetPrComments_AddCommentVerifyPath_StillFindsPostedComment`, `GetPrComments_ResolvedStatus_GraphqlEnrichmentFailSoft`
**Dependencies:** 010
**Parallelizable:** No

### Task 012: `assess_stack` consumes the unified feed generically (no provider/workflow branch)
**Implements:** DR-7
**Risk Tier:** high
**Boundary Touching:** true
**Verification:** medium set + integration suite; kill-probe. INV-6 — no workflow-type conditional in the harvest loop.
**Files:** `servers/exarchos-mcp/src/verbs/vcs/assess-stack.ts` (harvest :124–178, mapping :230–256), `assess-stack.test.ts`
**Tests:** `AssessStack_InlineReviewComment_BecomesActionItem`, `AssessStack_ThreadedReply_Surfaced`, `AssessStack_ReviewSummaryBody_Surfaced`, `AssessStack_HarvestLoop_NoWorkflowTypeBranch`
**Dependencies:** 011
**Parallelizable:** No

### Task 013: `gitlab` + `azure-devops` `getPrComments` conform to the widened signature (still throw)
**Implements:** DR-7
**Risk Tier:** low
**Verification:** static analysis (must compile against widened `PrComment`); existing throw-tests updated.
**Files:** `servers/exarchos-mcp/src/vcs/gitlab.ts` (:209), `vcs/azure-devops.ts` (:270), their tests
**Tests:** `GitLab_GetPrComments_ThrowsUnsupported`, `AzureDevOps_GetPrComments_ThrowsUnsupported` (signature-conformance compile-check)
**Dependencies:** 010
**Parallelizable:** Yes (with 011–012)

### Task 014: File GitLab + ADO harvesting follow-up issues (DR-7 deliverable)
**Implements:** DR-7
**Risk Tier:** low
**Verification:** N/A (process deliverable) — two issues created via `gh api POST`, each linked to DR-7/#1592, carrying the platform-neutral `PrComment` contract as the conformance target.
**Files:** none (GitHub issues) — record issue numbers back in the DR-7 PR description
**Dependencies:** 010 (contract must exist to cite as conformance target)
**Parallelizable:** Yes

---

## Bundle E — DR-3: Uniform bounded auto-fix + ask-user escalation

### Task 015: Shared config-resolvable escalation policy (uniform default `5` + per-loop override)
**Implements:** DR-3
**Risk Tier:** high
**Boundary Touching:** true  *(shared policy contract consumed by 3 loops)*
**Verification:** medium set + integration suite; kill-probe.
**Files:** new `servers/exarchos-mcp/src/verbs/review/escalation-policy.ts` (+ test), `src/workflow/hsm-definitions.ts` (`maxFixCycles`)
**Tests:** `EscalationPolicy_DefaultFive_PerLoopOverride`, `EscalationPolicy_MechanicalFinding_AutoFixesWithinBound`, `EscalationPolicy_IntentTouchingFinding_EscalatesImmediately`
**Dependencies:** None
**Parallelizable:** No (foundation for 016–019)

### Task 016: Bound spec-review's unbounded re-dispatch via the shared policy
**Implements:** DR-3
**Risk Tier:** medium
**Verification:** scoped tests; kill-probe. Skill edit → snapshot + batch-baseline update.
**Files:** `skills-src/spec-review/SKILL.md`, the spec-review fix-loop handler, co-located test
**Tests:** `SpecReview_FixLoop_BoundedByPolicy`, `SpecReview_BoundHit_Escalates`
**Dependencies:** 015
**Parallelizable:** Yes (with 017, 019)

### Task 017: Single event-sourced iteration counter (collapse shepherd-state vs `assess_stack`-events dual source)
**Implements:** DR-3
**Risk Tier:** high
**Boundary Touching:** true  *(event-sourced counter authority — INV-1)*
**Verification:** medium set + integration suite; kill-probe.
**Files:** `servers/exarchos-mcp/src/verbs/vcs/assess-stack.ts`, shepherd-status view, co-located test
**Tests:** `IterationCounter_SingleEventSourcedAuthority`, `ShepherdStatus_AndLoop_AgreeOnCount`
**Dependencies:** 015; ⚠ touches `assess-stack.ts` — sequence after Bundle D
**Parallelizable:** No

### Task 018: Bound-hit emits structured escalation surfaced via `shepherd_status`/`ps` (no hang)
**Implements:** DR-3
**Risk Tier:** medium
**Verification:** scoped tests; kill-probe. INV-10 — structured terminal, not a hang.
**Files:** `servers/exarchos-mcp/src/verbs/vcs/assess-stack.ts`, liveness/status view, co-located test
**Tests:** `BoundHit_EmitsStructuredEscalation_NotHang`, `Escalation_SurfacedViaShepherdStatus`
**Dependencies:** 017
**Parallelizable:** No

### Task 019: Apply uniform policy to quality-review (replace ad-hoc `3`+pause)
**Implements:** DR-3
**Risk Tier:** low
**Verification:** static analysis; skill edit → snapshot + batch-baseline update.
**Files:** `skills-src/quality-review/SKILL.md`
**Tests:** snapshot/baseline regeneration only
**Dependencies:** 015
**Parallelizable:** Yes (with 016)

---

## Bundle F — DR-5: Opt-in pre-push ship-gate hook

### Task 020: Opt-in `pre-push` hook invoking ship-path verbs; blocks on a blocking finding
**Implements:** DR-5
**Risk Tier:** medium
**Verification:** scoped tests on the hook script's pass/block decision; kill-probe where scriptable.
**Files:** `hooks/pre-push.ship-gate.sample`, `hooks/pre-push.test.ts`
**Tests:** `PrePushHook_BlockingFinding_BlocksPush`, `PrePushHook_Pass_AllowsPush`
**Dependencies:** None (engine = existing ship-path verbs)
**Parallelizable:** Yes (isolated; can run alongside Bundles A–E once verbs exist)

### Task 021: Document explicit opt-in install (no auto-install) + degrade message when verbs unavailable
**Implements:** DR-5
**Risk Tier:** low
**Verification:** static analysis; INV-4 — git-domain, harness/OS-neutral, no repo-side auto-run.
**Files:** `docs/guides/ship-gate-pre-push-hook.md`
**Tests:** N/A (docs) — degrade-message path covered in 020 if scriptable
**Dependencies:** 020
**Parallelizable:** No

---

## Bundle G — DR-6: SDK combinator migration contract

### Task 022: Migration note — pattern↦combinator table (incl. DR-7 contract-widening) referenced from #1258
**Implements:** DR-6
**Risk Tier:** low
**Verification:** static analysis (docs). Captures as-shipped DR-1..DR-7 → combinator mapping.
**Files:** `docs/designs/2026-06-21-ship-gate-methodology.md` neighborhood / dedicated migration note, cross-link from #1258
**Tests:** N/A (docs)
**Dependencies:** 001–021 (documents final shapes)
**Parallelizable:** No

### Task 023: Divergence guard — lint/test flags interim escalation defaults vs SDK `repeatUntil`/`awaitApproval` semantics
**Implements:** DR-6
**Risk Tier:** medium
**Verification:** scoped tests; kill-probe. The guard fails if interim `maxIterations`/ask-user defaults drift from the documented SDK combinator semantics.
**Files:** new guard test/lint, `escalation-policy.ts`
**Tests:** `DivergenceGuard_EscalationDefaults_MatchSdkRepeatUntilSemantics`
**Dependencies:** 015, 022
**Parallelizable:** No

---

## Parallelization summary

The seven bundles ship as a **stacked-PR sequence** in build order (DR-2 → DR-1 → DR-4 → DR-7 → DR-3 → DR-5 → DR-6) because of two file-overlap chokepoints:
- `prepare-synthesis.ts` — Bundle A (DR-2) and Bundle B (DR-1) both edit it → A before B.
- `assess-stack.ts` — Bundle D (DR-7, task 012/consumption) and Bundle E (DR-3, tasks 017–018) both edit it → D before E.

**Parallel-safe across the stack:**
- **Bundle F (DR-5)** is isolated (git-hook + docs) — can run concurrently once the ship-path verbs exist.
- **Task 013** (gitlab/azure conform) parallel with 011–012 inside Bundle D.
- **Tasks 016 / 019** (spec-review / quality-review skill edits) parallel inside Bundle E.
- **Task 006** parallel with 005 inside Bundle B.

**Risk-tier distribution:** high = 001, 007, 010, 011, 012, 015, 017 (the shared contracts / boundary seams); medium = the consumption/logic tasks; low = signature-conform, skill-policy-application, docs, issue-filing.

## Cross-cutting verification notes (from project memory)
- **MCP-server type/test isolation:** root `npm run typecheck`/`vitest` do **not** cover `servers/exarchos-mcp/`; every task touching MCP TS must run `cd servers/exarchos-mcp && npm run typecheck && npm run test:run`.
- **Skill edits** (005, 009, 016, 019, 021) need the dual baseline update: `vitest -u snapshots.test.ts` **and** `cp` the claude render over `batch-baselines/<name>.md`; `skills:guard` exit-1 pre-commit is expected.
- **Worktree dispatch:** scoped tests in a sub-agent worktree need `cd servers/exarchos-mcp && npm install` first (nested node_modules).
