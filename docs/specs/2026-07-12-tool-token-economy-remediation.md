# Spec: Tool-Surface Token-Economy Remediation

**Date:** 2026-07-12 · **Feature:** `tool-token-economy-remediation` · **Depth:** deep
**Inputs:** `docs/research/2026-07-11-tool-surface-token-economy-audit.md` (discovery workflow `tool-token-economy-audit`, PR #1679) · `docs/specs/2026-07-09-refactor-pipeline-view-economy.md` (#1659, patterns P1–P5) · `.exarchos/invariants.md`

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

The 2026-07-11 audit measured the full MCP tool surface and found the #1659 pipeline-view fix repaired one view, not the contract.
The shared orchestrate serializer (`format.ts`) applies no cap, truncation, or paging; `views/output-cap.ts` covers 2 of 22 views and 0 of 69 orchestrate actions.
Measured consequences: `assess_stack` returns **153,844 tokens** on a 3-PR stack (dead `fullBody`, the same comment text serialized up to 4×); `get_pr_comments` 37,613 tok/PR unbounded; `prepare_delegation` ~12,500 tok of ~95%-duplicated prompt boilerplate per 8-task wave; `event query` has no default limit; registration costs ~7,851 tok/session while a fully-implemented slim path sits dead.
The only surface-wide backstop is the 25,600-token catastrophic-overflow summary — demonstrably ineffective as an economy mechanism.
Cost compounds per shepherd iteration and per delegation wave; every new action ships unbounded by default because nothing structural prevents it.

### Chosen Approach

Adopt a **registry-declared response-economy contract** (Exploration, Approach B): every action descriptor carries an `economy` block — an effective token budget plus an optional per-action summarizer — enforced once at the dispatch-core measurement seam that already computes response bytes/tokens.
Hand-shaped minimal types for the measured offenders (audit O-1/O-2/O-3) become per-action summarizers and shape fixes riding that contract.
Posture is **economy-by-default** (breaking): compact defaults surface-wide with schema-typed escape hatches (`detail`, `limit`, `fields`), and all in-repo consumers (golden fixtures, parity snapshots, skills prose, eval suite) are updated in the same stack — the #1659 house precedent, generalized.
The contract is codified as a new dev-catalog invariant (**INV-17** — the audit's "candidate INV-16" name is taken by os-portability) so the next new action cannot ship unbounded.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Registry-declared response-economy contract

Each action descriptor gains an `economy` block: `{ budgetTokens?: number; compactByDefault?: boolean; summarize?: (data) => unknown }`, resolving declared value > registry-wide default (2,000 tokens).
Enforcement lives in the dispatch core, co-located with the existing telemetry measurement seam, shared by both facades (INV-2).
On overflow: apply the declared summarizer if present, else a generic capped fallback (counts + first page), always with a `narrowAffordance`-style steering entry on `next_actions` (INV-12).
The `output-cap.ts` kit (`estimateOutputTokens`, `narrowAffordance`, summary fallback) generalizes out of `views/` into the shared core; `narrowAffordance`'s verb type widens from `'pipeline' | 'worktrees'` to any action name.

**Acceptance criteria:**
- A registry-enumeration test asserts every registered action resolves an effective budget (declared or default); adding an action with no resolvable budget fails CI.
- Enforcement caps only `data`; envelope carrier fields (`success`, `next_actions`, `_meta`, `_perf`) are never truncated, and `_meta.truncated: true` marks capped responses (INV-5b intact).
- Summary shapes are declared in the action's registered `outputSchema` (union or `_meta`-flagged capped shape) — no response can violate its own schema.
- **Fail-open on presentation:** a budget that resolves non-finite/non-positive, or a summarizer that throws, degrades to the uncapped payload with a `_meta.economyDegraded` marker — never an error, never a silent drop (#1659 DR-3 precedent).
- `_perf` reports the final post-cap size.
- Budgets are surfaced per-action via `describe`.

### DR-2: `assess_stack` minimal types

Delete the dead `fullBody` field (adapters consume raw comments before result build; `classifyActionItems` reads only `body.slice` + `actionItem` — nothing downstream reads it).
Collapse `actionItems[].raw` to a reference into `unresolvedComments`; cap comments per PR with `page` metadata; reduce `checks[]` to counts plus failing-check detail.

**Acceptance criteria:**
- Re-measurement on a comment-heavy stack (≥25 unresolved comments on one PR) returns ≤5,000 tokens total (audit baseline: 153,844).
- No comment text is serialized more than once per response.
- A token-budget test pins the default response under the action's budget with a comment-heavy fixture (data-dependent volume, not just the quiet-PR case).
- Shepherd-loop consumers (`assess_stack` → fix → iterate) still receive every unresolved actionable comment reference across pages.

### DR-3: `get_pr_comments` window + projection

Default `limit` (~20 newest) + `page:{total,offset,limit,hasMore}` metadata + `fields` projection; the truncation notice steers to narrower calls.

**Acceptance criteria:**
- Default call on the audit's measured PR (85 comments) returns ≤4,000 tokens (baseline: 37,613).
- Explicit `limit`/`offset` pages through the full set deterministically.
- `fields` projection returns only requested per-comment keys.

### DR-4: `prepare_delegation` prompt dedupe

Return the rendered implementer prompt once per response (or behind `outputFormat: 'prompt-only'` / `detail: true`), with per-task deltas `{riskTier, boundaryTouching, verificationNote}` replacing the ~1,563-token per-task duplicate.

**Acceptance criteria:**
- An 8-task wave response measures ≤2,500 tokens (baseline: ~12,500).
- The orchestrator can still reconstruct the exact per-task prompt (shared template + per-task deltas are lossless vs. today's output).
- Tier stamps threaded per #1636 remain intact end-to-end.

### DR-5: `event query` default limit

Default `limit` 25 newest + `page` metadata; unbounded only by explicit request.

**Acceptance criteria:**
- Default query on a 112-event stream returns ≤1,800 tokens (baseline: 5,755) with `page.hasMore: true`.
- Explicit `limit`/`offset` retains full history access; ordering is deterministic.

### DR-6: Flip slim registration

Set `slimRegistration: true` in production dispatch context; `describe` remains the on-demand detail path.

**Acceptance criteria:**
- Serialized `tools/list` registration measures ≤3,800 tokens/session (baseline: ~7,851).
- Slim descriptions retain the "when NOT to use" clause per tool (INV-5a).
- The eval suite passes unchanged — no prompt-drift regressions from skills that reference action signatures.

### DR-7: Gate-output truncation (counts-not-transcripts)

`check_static_analysis` FAIL detail caps at first N lines + failure count with a steering suffix; `review_diff` returns stat-summary + capped hunks and never embeds the diff twice (today: full diff in `data.diff` **and** re-embedded in `data.report`).

**Acceptance criteria:**
- A FAIL run with 500+ lines of lint/typecheck output returns the first N (~50) lines, a total count, and a "re-run with…" steering hint.
- `review_diff` response contains at most one copy of any hunk; a large-diff fixture pins the budget.
- Failure-mode fidelity: the capped FAIL detail always includes every distinct failing file (counts per file), so triage never requires the uncapped path for "what failed".

### DR-8: Generalize the view contract

Apply compact-by-default + `page` + scope perceivability (#1659 P1–P5) to the remaining ~20 views, riding DR-1's backstop; fix the `--compact` no-op (audit B-4).

**Acceptance criteria:**
- Every `exarchos_view` action returns `page` metadata when list-shaped and honors `detail: true`.
- `view telemetry --compact` measurably reduces output on a populated store (baseline: no-op at 85 tok).
- Each migrated view carries a DR-2-style token-budget test.

### DR-9: Envelope split (`content` lean, `structuredContent` full) — verification-gated

Verify empirically how host clients (Claude Code plugin first, then the other Tier-1 runtimes) inject `content` vs `structuredContent` into model context; implement the lean-`content` rendering only where verified beneficial.

**Acceptance criteria:**
- A written verification note (in-repo, linked from this spec's decomposition) records per-runtime injection behavior with reproduction steps.
- If implemented: `content` carries a compact rendering, `structuredContent` the full envelope; both facades produce identical `structuredContent` (INV-2); rendering is presentation-only in adapters.
- If verification shows no model-token benefit: explicitly deferred with the evidence recorded — the task closes without code.

### DR-10: Codify INV-17 (response-economy)

Author a dev-catalog entry via the `/exarchos:invariants` wizard verbs (`invariants_scaffold`/`invariants_add`): every action declares a default token budget; unbounded output requires an explicit schema-typed escape hatch; budgets are test-enforced.

**Acceptance criteria:**
- `.exarchos/invariants.md` gains INV-17 with ≥3 citations (Anthropic tool-writing guidance, MCP 2025-06-18, GitHub MCP minimal-types precedent), `cost-of-load` and `applies-to` set.
- The id is INV-17 — INV-16 (os-portability) is not disturbed; vocabulary-lint passes.
- `check_invariant_conformance` surfaces INV-17 for review-phase audits.

### DR-11: Incidental defect burn-down (B-1, B-2, B-3, B-5, B-6)

Fix the audit's incidental defects; each is a real end-user breakage with its own regression test (B-4 is folded into DR-8).

**Acceptance criteria:**
- B-1: `view pipeline` no longer throws `VIEW_ERROR` on a store containing a legacy `__migration__` stream row (fixture-pinned regression test).
- B-2: `check_ci` works against current `gh` (`conclusion` → `state` rename); **wave-1 priority — blocks shepherd CI checks today.**
- B-3: `prNumbers` accepts CSV input (`1660,1671,1659`) through the flag-coercion layer, consistent with Zod-v4 `coerceFlags` object-classification.
- B-5: CLI and plugin MCP server resolve the same default store path (or a documented precedence), and `doctor` detects and reports divergent store paths.
- B-6: registration/build drift closed — `rehydrate`/`deliveryPath`, `worktrees`/`ps`/`invariants_effective` either exist in the CLI build or are no longer advertised; a parity test pins plugin registration against the CLI action list.

### DR-12: Economy-by-default consumer migration

All in-repo consumers of response shapes are updated in the same stack — no dual-shape shims, no legacy flags.

**Acceptance criteria:**
- Golden fixtures regenerated (`rehydrate-demo.expected-document.json` and peers); parity snapshots updated (`vitest -u` + claude-render baseline copies where skills changed).
- Full `vitest run` (root + `servers/exarchos-mcp`) green, including the frozen `orchestrate/*.parity.test.ts` suite.
- `skills-src/` prose that cites response fields removed by DR-2/DR-4/DR-7 is updated and re-rendered (`npm run build:skills`, `skills:guard` green).
- The eval suite shows no regression attributable to shape changes.

## Technical Design

**The `economy` block** lives at the action-descriptor level — sibling to `cli`, `gate`, `autoEmits`, `dispatchHints` — because budgets are action-behavior metadata shared by both facades (INV-2), exactly the placement rationale documented on `DispatchHints`.
Resolution: `descriptor.economy.budgetTokens` > registry default (2,000).
A small set of verbose-by-design actions (`describe`, `runbook` detail, `emissionGuide`) declare explicit higher budgets rather than exemptions — everything resolves a number.

**Enforcement seam:** dispatch core, post-handler, immediately before the telemetry middleware's `injectPerf` — the same place response bytes/tokens are already measured, so the guard and `_perf` agree by construction.
Order: handler → economy check (measure `data`; if over budget → summarizer or generic fallback; stamp `_meta.truncated`) → `injectPerf` (final size).

**outputSchema honesty:** actions with a summarizer declare the summary shape in their registered schema; the generic fallback's shape (`{summary, counts, firstPage}`) is a shared schema fragment unioned where used.

**Kit relocation:** `views/output-cap.ts` → `core/economy.ts` (name illustrative); `pipeline`/`worktrees` become the first consumers of the generalized kit, unchanged in behavior.

**Slim registration** is a one-line context flip plus eval validation; the `describe` action is already the bounded detail path (1–10 actions).

**What this deliberately does not do:** no serialization-format swap (TOON/CSV — *Notation Matters*, accuracy cost, audit O-9); no tool splitting (the flattened-union registration schema is load-bearing, `buildRegistrationSchema` collision throw); no new top-level tools (INV-5d).

## Integration Points

- `servers/exarchos-mcp/src/registry.ts` — `economy` block on the descriptor type; per-action budgets; registry-enumeration budget test.
- `servers/exarchos-mcp/src/core/dispatch.ts` — enforcement at the measurement seam; `slimRegistration: true`.
- `servers/exarchos-mcp/src/telemetry/middleware.ts` — ordering with `injectPerf`; final-size reporting.
- `servers/exarchos-mcp/src/views/output-cap.ts` → shared core module — kit generalization.
- `servers/exarchos-mcp/src/format.ts` — `_meta.truncated` / `economyDegraded` envelope conventions.
- `servers/exarchos-mcp/src/orchestrate/assess-stack.ts` — DR-2 minimal types (also `list_prs` window).
- `servers/exarchos-mcp/src/orchestrate/vcs/get-pr-comments.ts` — DR-3.
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts` — DR-4.
- `servers/exarchos-mcp/src/event-store/tools.ts` — DR-5.
- `servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts`, `orchestrate/review-diff.ts` — DR-7.
- `servers/exarchos-mcp/src/views/tools.ts` — DR-8 (~20 views).
- `servers/exarchos-mcp/src/adapters/mcp.ts` — DR-6 flip site; DR-9 (if verified).
- `.exarchos/invariants.md` — DR-10 (INV-17, via wizard).
- `servers/exarchos-mcp/src/orchestrate/` (check-ci, coerce, store-path resolution), `views/tools.ts` — DR-11.
- Golden fixtures, parity snapshots, `skills-src/` — DR-12.

## Exploration

Discovery ran as the prior workflow `tool-token-economy-audit` (report: `docs/research/2026-07-11-tool-surface-token-economy-audit.md`, PR #1679) — this feature's research pass; the deep-rung discover bridge was surfaced and declined as redundant.

Three architectures were explored for where the response-economy contract lives:

- **A — Serializer-level backstop** (`format.ts` owns it): smallest diff, single choke point; rejected as primary because `wrap()` is generic over `T` — central truncation can only be generic, fighting registered outputSchemas (INV-5b), and `wrap()` coverage across all response paths is unproven.
- **B — Registry-declared budgets, dispatch-core enforcement** (chosen): budgets as enumerable descriptor metadata make INV-17 testable by construction; per-action summarizers keep schemas honest; the runtime backstop catches data-dependent blowups; INV-2-clean.
- **C — Hand-shaped minimal types + CI tests only**: zero runtime risk, and ~95% of measured savings do come from hand-shaped fixes; rejected as primary because golden-size tests cannot pin data-dependent volume — the audit's central failure mode (`assess_stack`: 126 B quiet PR vs 343 KB comment-heavy PR).

Convergence (author-confirmed, 2026-07-12): depth `deep`; scope R-1..R-10 + B-1..B-6 in one workflow; posture economy-by-default; architecture B consuming A's kit as substrate with C's hand-shaped types as the per-offender work.

## Alternatives considered

- **Approach A (serializer-only)** — see Exploration; retained as substrate (kit generalization), rejected as the contract's home.
- **Approach C (convention-only)** — see Exploration; retained as the per-offender technique, rejected as the enforcement mechanism.
- **Serialization-format swap (TOON/TRON/CSV)** — 18–27% savings with measured accuracy regressions and multi-turn parsing failures (*Notation Matters*, arXiv:2605.29676); rejected; revisit only behind a flag after the structural fixes land (audit O-9).
- **Splitting `exarchos_orchestrate` into smaller tools** — violates INV-5d's 4-composite design and re-inflates per-tool registration overhead; schema shrink comes from descriptions and field consolidation instead.

## Open Questions

- **DR-9 client injection behavior** — unknown by design; resolves via the verification task before any implementation, with explicit evidence-recorded deferral as a first-class outcome.
- **Default budget value (2,000)** — initial value from the audit; relationship to the existing `qualityHints` `output_tokens` threshold (25,600 catastrophic backstop) is: DR-1 budgets are per-action economy ceilings, the qualityHints threshold remains the last-resort overflow guard; tune after dogfooding measurements.
- **B-5 scope containment** — if unifying the CLI/plugin store path grows beyond a bounded fix (migration concerns for existing stores), it spins off as its own issue; the in-scope floor is `doctor` detection + documented precedence.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1..DR-12).
**Excluded:** None. Task 017 (DR-9 implementation) is conditional by design — it closes without code if Task 016's verification shows no model-token benefit; that is an explicit DR-9 acceptance path, not a scope exclusion.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Registry-declared response-economy contract | 001, 002, 003 |
| DR-2 | assess_stack minimal types | 007 |
| DR-3 | get_pr_comments window + projection | 006 |
| DR-4 | prepare_delegation prompt dedupe | 008 |
| DR-5 | event query default limit | 005 |
| DR-6 | Flip slim registration | 015 |
| DR-7 | Gate-output truncation | 011, 012 |
| DR-8 | Generalize the view contract | 013, 014 |
| DR-9 | Envelope split — verification-gated | 016, 017 |
| DR-10 | Codify INV-17 | 018 |
| DR-11 | Incidental defect burn-down | 004, 009, 010, 019, 020 |
| DR-12 | Economy-by-default consumer migration | 021 |

### Tasks

### Task 001: Generalize the output-cap kit out of views/

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-1
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/core/economy.ts`
- `servers/exarchos-mcp/src/views/output-cap.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts`
- `servers/exarchos-mcp/src/core/economy.test.ts`

Relocate `estimateOutputTokens`, `narrowAffordance`, `countBy`, threshold resolution into a shared core module; widen `narrowAffordance`'s verb type from `'pipeline' | 'worktrees'` to any action name; `pipeline`/`worktrees` consume the generalized kit with byte-identical behavior.

**Verification:**
- `estimateOutputTokens_AnyPayload_MatchesTelemetryMiddlewareFormula` — property test over arbitrary JSON payloads
- `narrowAffordance_AnyVerb_ValidatesAgainstNextActionSchema`
- Existing pipeline/worktrees cap tests stay green unchanged (characterization)

**Dependencies:** None
**Parallelizable:** Yes

### Task 002: Add the economy block to the action descriptor with registry-wide default budgets

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-1
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/registry.test.ts`

Add `economy?: { budgetTokens?: number; compactByDefault?: boolean; summarize?: (data: unknown) => unknown }` at the action-descriptor level (sibling to `cli`, `gate`, `dispatchHints`); registry-wide default 2,000; explicit higher budgets for verbose-by-design actions (`describe`, `runbook`, `emissionGuide` path); budgets surfaced via `describe`.

**Verification:**
- `registryEconomy_EveryRegisteredAction_ResolvesEffectiveBudget`
- `registryEconomy_VerboseByDesignAction_DeclaresExplicitHigherBudget`
- `describeAction_WithBudget_SurfacesBudgetTokens`
- Typecheck across `servers/exarchos-mcp` — the descriptor type change is a shared contract surface

**Dependencies:** None
**Parallelizable:** Yes

### Task 003: Registry-declared response-economy contract enforcement at the dispatch-core seam

**Risk Tier:** high
**Test Layer:** acceptance
**Implements:** DR-1
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/core/dispatch.ts`
- `servers/exarchos-mcp/src/telemetry/middleware.ts`
- `servers/exarchos-mcp/src/format.ts`
- `servers/exarchos-mcp/src/core/economy-enforcement.test.ts`

Post-handler, pre-`injectPerf`: measure `data`; over budget → declared summarizer else generic capped fallback (`{summary, counts, firstPage}` shared schema fragment) + steering `next_actions` entry; stamp `_meta.truncated`; fail-open (`_meta.economyDegraded`) on unresolvable budget or throwing summarizer; `_perf` reports final post-cap size; envelope carrier fields never truncated.

**Verification:**
- `dispatchEconomy_OverBudgetResponse_AppliesSummarizerAndStampsTruncated` — the DR-1 north-star acceptance test, real dispatch path, no mocks
- `dispatchEconomy_BudgetUnresolvable_FailsOpenWithDegradedMarker`
- `dispatchEconomy_SummarizerThrows_ReturnsUncappedWithDegradedMarker`
- `dispatchEconomy_CappedResponse_EnvelopeCarrierIntact` — property test: for arbitrary over-budget payloads, `success`/`next_actions`/`_meta`/`_perf` survive
- `check_test_adequacy` kill-probe + integration suite across the dispatch seam (both facades, INV-2 parity)

**Dependencies:** 001, 002
**Parallelizable:** No

### Task 004: B-2 — fix `check_ci` against current gh CLI

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/check-ci.ts`
- co-located test

Replace the removed `conclusion` JSON field with `state`; pin the parse against a recorded current-gh output fixture. **Wave-1 priority — blocks shepherd CI checks today.**

**Verification:**
- `checkCi_CurrentGhStateField_ParsesRunStatus`
- `checkCi_RecordedGhOutput_ClassifiesPassAndFail`
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 005: DR-5 — `event query` default limit + page metadata

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-5
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/event-store/tools.ts`
- co-located test

Default `limit` 25 newest with `page:{total,offset,limit,hasMore}`; deterministic ordering; explicit `limit`/`offset` retains full access.

**Verification:**
- `eventQuery_NoLimit_Returns25NewestWithPageMetadata`
- `eventQuery_OffsetPaging_CoversFullStreamDeterministically` — property test: paging partitions the stream, no gaps/duplicates
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 006: DR-3 — `get_pr_comments` window, page, fields projection

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-3
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/vcs/get-pr-comments.ts`
- co-located test

Default limit ~20 newest + `page` metadata + `fields` projection; truncation notice steers to narrower calls.

**Verification:**
- `getPrComments_DefaultLimit_ReturnsPageWithHasMore`
- `getPrComments_FieldsProjection_ReturnsOnlyRequestedKeys`
- `getPrComments_ExplicitOffset_PagesDeterministically`
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 007: DR-2 — `assess_stack` minimal types

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`
- co-located test

Delete dead `fullBody`; collapse `actionItems[].raw` to a reference into `unresolvedComments`; cap comments per PR with `page` metadata; `checks[]` → counts + failing detail; give `list_prs` (same module) a default window.

**Verification:**
- `assessStack_CommentHeavyStack_StaysUnderBudget` — comment-heavy fixture (≥25 unresolved on one PR), pins the data-dependent case
- `assessStack_UnresolvedComments_EachCommentSerializedOnce`
- `assessStack_PagedComments_EveryActionableReferenceReachable`
- `listPrs_NoLimit_ReturnsDefaultWindow`
- `check_test_adequacy` kill-probe + integration suite (shepherd-loop consumer contract)

**Dependencies:** None
**Parallelizable:** Yes

### Task 008: DR-4 — `prepare_delegation` prompt dedupe

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-4
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
- co-located test

Rendered implementer prompt returned once per response (or via `outputFormat: 'prompt-only'` / `detail: true`); per-task deltas `{riskTier, boundaryTouching, verificationNote}`; #1636 tier-stamp threading unchanged.

**Verification:**
- `prepareDelegation_EightTaskWave_ReturnsPromptTemplateOnce`
- `prepareDelegation_PerTaskDeltas_ReconstructExactPerTaskPrompt` — lossless-reconstruction contract vs. today's output
- `prepareDelegation_TierStamps_ThreadedEndToEnd` (characterization of #1636 behavior)
- `check_test_adequacy` kill-probe + integration suite (delegation pipeline consumer)

**Dependencies:** None
**Parallelizable:** Yes

### Task 009: B-1 — `view pipeline` tolerates legacy `__migration__` stream row

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- co-located test

Exclude (don't throw on) stream rows failing the `^[a-z0-9-]+$` featureId regex; the view renders the remaining rows.

**Verification:**
- `pipelineView_LegacyMigrationStreamRow_ExcludedNotThrown` — fixture store with a `__migration__` row
- `check_test_adequacy` kill-probe

**Dependencies:** 001
**Parallelizable:** No

### Task 010: B-3 — `prNumbers` CSV coercion

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-11
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/coerce.ts`
- `servers/exarchos-mcp/src/coerce.test.ts`

Accept CSV (`1660,1671,1659`) for int-array flags through the coercion layer, consistent with the Zod-v4 `coerceFlags` object-classification design (JSON array input keeps working).

**Verification:**
- `coerceFlags_PrNumbersCsv_ParsesToIntArray`
- `coerceFlags_JsonArrayInput_StillParses` (characterization)
- `coerceFlags_CsvRoundTrip_EquivalentToJsonArray` — property test over int arrays
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 011: DR-7a — `check_static_analysis` FAIL-output truncation

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts`
- co-located test

FAIL detail caps at first ~50 lines + total count + steering suffix; capped detail always names every distinct failing file with per-file counts.

**Verification:**
- `checkStaticAnalysis_FailWith500Lines_TruncatesWithCountAndSteering`
- `checkStaticAnalysis_CappedFailDetail_IncludesEveryFailingFile`
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 012: DR-7b — `review_diff` single-copy diff + capped hunks

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/review-diff.ts`
- co-located test

Stat-summary + capped hunks; the diff is never embedded twice (today: `data.diff` and again inside `data.report`).

**Verification:**
- `reviewDiff_LargeDiff_EmbedsEachHunkAtMostOnce`
- `reviewDiff_LargeDiffFixture_StaysUnderBudget`
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 013: Generalize the view contract across the remaining twenty views

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/tools.test.ts`

Every list-shaped `exarchos_view` action returns `page` metadata and honors `detail: true`; each migrated view gains a DR-2-style token-budget test; rides Task 003's backstop.

**Verification:**
- `viewsContract_ListShaped_ReturnPageMetadataAndHonorDetail`
- `viewsContract_MigratedView_StaysUnderEffectiveBudget`
- `check_test_adequacy` kill-probe + integration suite (all views over a populated fixture store)

**Dependencies:** 003 (and lands after 009 — same file)
**Parallelizable:** No

### Task 014: DR-8 — fix `view telemetry --compact` no-op (B-4)

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-8, DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- co-located test

`compact: true` measurably reduces telemetry output on a populated store (baseline: no-op at 85 tok).

**Verification:**
- `viewTelemetry_CompactFlag_ReducesMeasuredOutput`
- `check_test_adequacy` kill-probe

**Dependencies:** 013 (same file — serialize)
**Parallelizable:** No

### Task 015: DR-6 — flip slim registration + eval validation

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/adapters/mcp.ts`
- co-located test

Set `slimRegistration: true` in production dispatch context; slim descriptions keep the "when NOT to use" clause per tool (INV-5a); run the eval suite for prompt-drift.

**Verification:**
- `toolsList_SlimRegistration_MeasuresUnder3800Tokens`
- `toolsList_SlimDescriptions_RetainWhenNotToUseClause`
- Eval suite run recorded green (no shape/prompt-drift regressions)
- `check_test_adequacy` kill-probe

**Dependencies:** 002 (registry descriptor churn lands first)
**Parallelizable:** Yes

### Task 016: DR-9 — client-injection verification note

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-9
**Testing Strategy:** propertyTests: false, characterizationRequired: false

**Files:**
- `docs/research/2026-07-DR9-content-injection-verification.md`

Empirically record how host clients (Claude Code plugin first, then Tier-1 runtimes) inject `content` vs `structuredContent` into model context, with reproduction steps and a go/no-go recommendation for Task 017.

**Verification:**
- Static analysis only; the deliverable is the in-repo note with reproducible evidence

**Dependencies:** None
**Parallelizable:** Yes

### Task 017: DR-9 — lean `content` rendering (conditional on Task 016)

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/adapters/mcp.ts`
- co-located test

If 016 verifies benefit: `content` carries a compact rendering, `structuredContent` the full envelope; identical `structuredContent` across facades (INV-2); rendering stays presentation-only. If 016 shows no benefit: close without code, citing the note.

**Verification:**
- `toMcpResult_LeanContent_StructuredContentCarriesFullEnvelope`
- `toMcpResult_BothFacades_IdenticalStructuredContent`
- `check_test_adequacy` kill-probe — or the recorded deferral evidence

**Dependencies:** 015, 016
**Parallelizable:** No

### Task 018: Codify INV-17 response-economy via the invariants wizard

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-10
**Testing Strategy:** propertyTests: false, characterizationRequired: false

**Files:**
- `.exarchos/invariants.md`

Author the response-economy entry through `invariants_scaffold`/`invariants_add` (never hand-written YAML): every action declares a default token budget; unbounded output requires a schema-typed escape hatch; budgets are test-enforced. Id INV-17 (INV-16 = os-portability); ≥3 citations; vocabulary-lint green.

**Verification:**
- `npm run lint:invariants` green; `check_invariant_conformance` surfaces INV-17

**Dependencies:** 003 (codifies the shipped contract shape)
**Parallelizable:** Yes

### Task 019: Incidental defect burn-down B-5: unify CLI/plugin store-path resolution with doctor detection

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/config/store-path.ts`
- `servers/exarchos-mcp/src/orchestrate/doctor.ts`
- co-located tests

CLI and plugin resolve the same default store path or a documented precedence; `doctor` detects and reports divergent store paths. In-scope floor is detection + documented precedence; a store migration spins off as its own issue if it grows.

**Verification:**
- `storePathResolution_CliAndPlugin_ResolveSameDefault`
- `doctor_DivergentStorePaths_DetectedAndReported`
- `check_test_adequacy` kill-probe + integration suite (event-store bootstrap seam)

**Dependencies:** None
**Parallelizable:** Yes

### Task 020: B-6 — plugin-registration ↔ CLI action parity test + drift fix

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- new parity test file

`rehydrate`/`deliveryPath`, `worktrees`/`ps`/`invariants_effective` either exist in the CLI build or stop being advertised; a parity test pins plugin registration against the CLI action list so drift fails CI.

**Verification:**
- `registration_PluginVsCliActionList_NoDrift`
- `check_test_adequacy` kill-probe

**Dependencies:** 002
**Parallelizable:** No

### Task 021: Economy-by-default consumer migration: regenerate fixtures, snapshots, skills prose, full-suite validation

**Risk Tier:** high
**Test Layer:** acceptance
**Implements:** DR-12
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/rehydration/rehydrate-demo.expected-document.json`
- `servers/exarchos-mcp/src/orchestrate/` parity baselines
- `skills-src/` prose + regenerated `skills/` tree

Regenerate golden fixtures and parity snapshots; update `skills-src/` prose citing fields removed by DR-2/DR-4/DR-7 and re-render (`npm run build:skills`, `skills:guard`); full `vitest run` at root and `servers/exarchos-mcp`; eval suite shows no shape-change regression. No dual-shape shims.

**Verification:**
- `parityTests_RegeneratedBaselines_Pass`
- `skillsGuard_RegeneratedSkillsTree_NoDrift`
- Full `vitest run` green in both packages, including the frozen parity suite
- Eval suite comparison recorded
- Integration suite is the gate — this task is the cumulative-regression backstop

**Dependencies:** 003, 005, 006, 007, 008, 011, 012, 013, 014, 015
**Parallelizable:** No

### Parallelization

**Critical path:** 001/002 → 003 → 013 → 014 → 021.

- **Wave 1 (parallel worktrees):** 001, 002, 004 (priority — unblocks shepherd CI), 005, 006, 007, 008, 010, 011, 012, 016, 019.
- **Wave 2:** 003 (after 001+002), 009 (after 001), 015 + 020 (after 002), 017 (after 015+016).
- **Wave 3:** 013 + 018 (after 003; 013 also serialized after 009 — same file).
- **Wave 4:** 014 (after 013 — same file).
- **Wave 5:** 021 (after all shape-changing tasks) — the integration closeout.

File-collision notes: 001/009/013/014 all touch `views/tools.ts` and 002/020 touch `registry.ts` — both chains strictly serialized via task dependencies. 015/017 touch `adapters/mcp.ts` — serialized via the 017→015 dependency.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions resolved or explicitly deferred with rationale (DR-9 gate, budget tuning, B-5 floor)
- [x] Ready for `plan-review`
