# Fixer Token Efficiency — Implementation Plan

**Design:** [`docs/designs/2026-04-19-fixer-token-efficiency.md`](../designs/2026-04-19-fixer-token-efficiency.md)
**Workflow:** `feat-fixer-token-efficiency`
**Date:** 2026-04-19
**Iron Law:** No production code without a failing test first.

## Implementation deltas from design

Two facts surfaced when reading the existing code that the design didn't anticipate:

1. **`ActionItem` already exists** in `servers/exarchos-mcp/src/orchestrate/assess-stack.ts:44-49` with `severity: 'critical' | 'major' | 'minor'` (lowercase, fixed taxonomy) and no `file`/`line`/`reviewer`/`raw` fields. Per the design's DIM-3 additive constraint, we **extend the existing `ActionItem`** with new optional fields rather than introducing a parallel type. Severity stays as today during Phase 1; adapters populate a new `normalizedSeverity: 'HIGH' | 'MEDIUM' | 'LOW'` field. Phase 2 promotes `normalizedSeverity` to required.

2. **Comment bodies are truncated to 200 chars** at `assess-stack.ts:68-73` (`COMMENT_BODY_LIMIT`) before they reach any consumer. Adapters need the full body to parse tier markers (CodeRabbit's "Critical" header may live below the truncation point). Phase 1 retains full bodies for adapter input; truncation moves to display-only.

3. **Existing `classifyActionItems` function** at `assess-stack.ts:158-198` is coarse-grained (every comment → "major"). Phase 2's `classify_review_items` action wraps + replaces it.

## Task summary

- **Pre-work (4 tasks):** Domain types, comment-truncation refactor.
- **Phase 1 (12 tasks):** 5 provider adapters, registry, `assess_stack` wiring, event emission, hygiene cleanup.
- **Phase 2 (9 tasks):** Classifier types, file-grouping, recommendation logic, action registration, event emission, shepherd integration, hygiene cleanup, severity promotion.

**Total: 25 tasks.**

---

## Pre-work

### Task 1: Extend `ActionItem` with optional reviewer-context fields

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ActionItem_WithReviewerFields_TypeChecks`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Test constructs an `ActionItem` literal that sets `file`, `line`, `reviewer`, `threadId`, `raw`, `normalizedSeverity`. Compile-time check (assertion via type predicate / `satisfies`).
   - Expected failure: TS error — fields don't exist on `ActionItem`.

2. [GREEN] Add optional fields to `ActionItem` interface:
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.ts:44-49`
   - Append: `readonly file?: string; readonly line?: number; readonly reviewer?: ReviewerKind; readonly threadId?: string; readonly raw?: unknown; readonly normalizedSeverity?: Severity;`

3. [REFACTOR] Move `ActionItem` and its supporting types (`Severity`, `ReviewerKind`) to a new file `servers/exarchos-mcp/src/review/types.ts` and re-export from `assess-stack.ts` for backwards compatibility. Keeps the canonical-type-in-one-place invariant from DIM-6.

**Dependencies:** None
**Parallelizable:** No (foundational)

---

### Task 2: Define `ProviderAdapter` interface

**Phase:** RED → GREEN

1. [RED] Write test: `ProviderAdapter_Interface_RejectsMissingMembers`
   - File: `servers/exarchos-mcp/src/review/types.test.ts`
   - Test asserts the type via `satisfies ProviderAdapter` for a stub object missing `kind` or `parse`.
   - Expected failure: file doesn't exist.

2. [GREEN] Add to `servers/exarchos-mcp/src/review/types.ts`:
   ```typescript
   export interface ProviderAdapter {
     readonly kind: ReviewerKind;
     parse(rawComment: VcsPrComment): ActionItem | null;
   }
   ```

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 3)

---

### Task 3: Define `ReviewAdapterRegistry` interface

**Phase:** RED → GREEN

1. [RED] Write test: `ReviewAdapterRegistry_Interface_HasForReviewerAndList`
   - File: `servers/exarchos-mcp/src/review/types.test.ts`
   - `satisfies ReviewAdapterRegistry` test against stub.
   - Expected failure: interface doesn't exist.

2. [GREEN] Add to `servers/exarchos-mcp/src/review/types.ts`:
   ```typescript
   export interface ReviewAdapterRegistry {
     forReviewer(kind: ReviewerKind): ProviderAdapter | undefined;
     list(): readonly ProviderAdapter[];
   }
   ```

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 2)

---

### Task 4: Retain full comment bodies through `queryPrComments`

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `QueryPrComments_LongCommentBody_RetainsFullBody`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Mock `provider.getPrComments()` to return a comment whose body is 500 chars. Assert the returned `PrComment.body` is 500 chars (not 200+`...`).
   - Expected failure: `truncateBody` truncates at 200.

2. [GREEN] Modify `PrComment` in `assess-stack.ts:39-42` to add `fullBody: string` field. `queryPrComments` populates `fullBody` with the original; `body` continues to be truncated for display.
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.ts:39-42, 118-132`

3. [REFACTOR] If `body` is no longer read by anyone after later tasks, delete it. (Track for Phase 2 cleanup; do not delete in Pre-work.)

**Dependencies:** None
**Parallelizable:** Yes (with Tasks 2, 3)

---

## Phase 1: Provider adapters + `assess_stack` wiring

### Task 5: CodeRabbit adapter

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/review/providers/coderabbit.test.ts`:
   - `CoderabbitAdapter_CriticalTier_NormalizesToHigh`
   - `CoderabbitAdapter_MajorTier_NormalizesToHigh`
   - `CoderabbitAdapter_MinorTier_NormalizesToLow`
   - `CoderabbitAdapter_NitpickBlock_NormalizesToLow`
   - `CoderabbitAdapter_UnrecognizedTier_DefaultsToMedium`
   - `CoderabbitAdapter_NonCoderabbitAuthor_ReturnsNull`
   - Each test calls `coderabbitAdapter.parse(fixture)` and asserts the resulting `ActionItem.normalizedSeverity` and `ActionItem.reviewer`.
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/providers/coderabbit.ts`. Author check: `comment.author === 'coderabbitai[bot]'` (verify exact string in fixture). Tier extraction: regex on body for `_:warning: Potential issue_`, `_:hammer_and_wrench: Refactor suggestion_`, `_:bulb: Verification agent_`, "Nitpick" block headers. Map: `Potential issue|Critical|Major → HIGH`; `Refactor suggestion → MEDIUM`; `Nitpick|Verification|Minor → LOW`.

3. [REFACTOR] Extract the tier map to a constant in the adapter file.

**Dependencies:** Task 2
**Parallelizable:** Yes (with Tasks 6, 7, 8, 9)

---

### Task 6: Sentry adapter

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/providers/sentry.test.ts`:
   - `SentryAdapter_CriticalTag_NormalizesToHigh`
   - `SentryAdapter_MediumTag_NormalizesToMedium`
   - `SentryAdapter_NoSeverityTag_DefaultsToMedium`
   - `SentryAdapter_NonSentryAuthor_ReturnsNull`
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/providers/sentry.ts`. Author check: `comment.author === 'sentry-io[bot]'` (verify in fixture). Tag extraction: regex for `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` in body. Map: `CRITICAL|HIGH → HIGH`; `MEDIUM → MEDIUM`; `LOW → LOW`; default `MEDIUM` (comments without a tier marker still get a reply task but at a non-blocking severity).

**Dependencies:** Task 2
**Parallelizable:** Yes (with Tasks 5, 7, 8, 9)

---

### Task 7: GitHub-Copilot adapter

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/providers/github-copilot.test.ts`:
   - `GithubCopilotAdapter_AnyComment_DefaultsToMedium`
   - `GithubCopilotAdapter_NonCopilotAuthor_ReturnsNull`
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/providers/github-copilot.ts`. Author check: `comment.author === 'github-copilot[bot]'` or `Copilot`. Always returns `normalizedSeverity: 'MEDIUM'`.

**Dependencies:** Task 2
**Parallelizable:** Yes (with Tasks 5, 6, 8, 9)

---

### Task 8: Human adapter

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/providers/human.test.ts`:
   - `HumanAdapter_AnyComment_DefaultsToMedium`
   - `HumanAdapter_BotAuthor_ReturnsNull`
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/providers/human.ts`. Author check: `!comment.author.endsWith('[bot]') && comment.author !== 'Copilot'`. Always returns `normalizedSeverity: 'MEDIUM'`. Reviewer kind: `'human'`.

**Dependencies:** Task 2
**Parallelizable:** Yes (with Tasks 5, 6, 7, 9)

---

### Task 9: Unknown adapter (fallback)

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/providers/unknown.test.ts`:
   - `UnknownAdapter_AnyAuthor_AlwaysParses`
   - `UnknownAdapter_DefaultsToMedium`
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/providers/unknown.ts`. Always returns an `ActionItem` with `reviewer: 'unknown'`, `normalizedSeverity: 'MEDIUM'`. Adapter is the catch-all when no other adapter claims the author.

**Dependencies:** Task 2
**Parallelizable:** Yes (with Tasks 5, 6, 7, 8)

---

### Task 10: Registry factory

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/review/registry.test.ts`:
   - `CreateReviewAdapterRegistry_ReturnsAllFiveAdapters`
   - `CreateReviewAdapterRegistry_ForReviewerCoderabbit_ReturnsCoderabbitAdapter`
   - `CreateReviewAdapterRegistry_ForReviewerUnknownKind_ReturnsUndefined`
   - `CreateReviewAdapterRegistry_ListIsImmutable` — assert returned array is frozen / mutation throws.
   - Expected failure: file doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/registry.ts`. Export `createReviewAdapterRegistry(): ReviewAdapterRegistry` returning a frozen registry with all five adapters.

3. [REFACTOR] If duplication appears between this factory and `assess_stack`'s adapter usage, extract a `dispatchAdapter(comment, registry)` helper.

**Dependencies:** Tasks 5, 6, 7, 8, 9, 3
**Parallelizable:** No (gates Task 11)

---

### Task 11: Wire registry into `assess_stack` — adapter dispatch per comment

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `QueryPrStatus_CoderabbitComment_PopulatesNormalizedSeverity`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Mock provider returns a CodeRabbit comment with a "Potential issue" body. Assert the resulting `PrStatus.unresolvedComments[0]` (or whichever shape carries it after refactor) has the parsed `ActionItem` attached with `normalizedSeverity: 'HIGH'`, `reviewer: 'coderabbit'`, `file: <fixture>`, `line: <fixture>`.
   - Expected failure: `assess_stack` doesn't dispatch through adapters.

2. [GREEN] Modify `assess-stack.ts`:
   - Add a `registry: ReviewAdapterRegistry` parameter to the handler (constructor-injected). Default to `createReviewAdapterRegistry()` only at the top-level handler entry — never lazy-construct inside.
   - In `queryPrComments`, for each `VcsPrComment`, route to `registry.forReviewer(detectKind(comment.author))?.parse(comment) ?? unknownAdapter.parse(comment)`.
   - Attach the parsed `ActionItem` (or its fields) to whatever shape `queryPrStatus` returns. Likely add `actionItem?: ActionItem` to `PrComment`.

3. [REFACTOR] Extract `detectKind(author: string): ReviewerKind` to `registry.ts`.

**Dependencies:** Task 10, Task 4
**Parallelizable:** No

---

### Task 12: Modify `classifyActionItems` to use adapter output for severity

**Phase:** RED → GREEN

1. [RED] Write test: `ClassifyActionItems_HighSeverityComment_RetainsHighSeverity`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts`
   - Construct a `PrStatus` whose `unresolvedComments[0]` has an attached `ActionItem` with `normalizedSeverity: 'HIGH'`. Assert the resulting `ActionItem` from `classifyActionItems` carries `normalizedSeverity: 'HIGH'` (not the existing default `severity: 'major'`).
   - Expected failure: `classifyActionItems` ignores adapter output.

2. [GREEN] Modify `classifyActionItems` (assess-stack.ts:158-198): for `comment-reply` items, populate `normalizedSeverity` from the comment's attached `ActionItem.normalizedSeverity` if present, else leave undefined. Existing `severity: 'major'` default unchanged for backward compat.

**Dependencies:** Task 11
**Parallelizable:** Yes (with Task 13)

---

### Task 13: Emit `provider.unknown-tier` events from adapters

**Phase:** RED → GREEN

1. [RED] Write test: `CoderabbitAdapter_UnrecognizedTier_EmitsUnknownTierEvent`
   - File: `servers/exarchos-mcp/src/orchestrate/assess-stack.test.ts` (event emission integration; adapter unit test would couple too tightly to event-store)
   - Mock event store. Mock CodeRabbit comment with body `"_:rocket: Brand new tier_ ..."`. Run `assess_stack`. Assert one event of type `provider.unknown-tier` was emitted with data `{reviewer: 'coderabbit', rawTier: ':rocket: Brand new tier', commentId: <id>}`.
   - Expected failure: adapter doesn't surface unknown tiers and assess_stack doesn't emit the event.

2. [GREEN]
   - Adapter: when tier doesn't match any known pattern, return `ActionItem` with `normalizedSeverity: 'MEDIUM'` AND attach `unknownTier?: string` field to the result.
   - Add `unknownTier?: string` field to `ActionItem` (or to a sibling result type — pick least-coupling option).
   - In `assess_stack`, after dispatching the adapter, emit `provider.unknown-tier` if the result carries an `unknownTier`.
   - Register the new event type in `servers/exarchos-mcp/src/event-store/event-types.ts` (or wherever event types live — confirm during implementation).

**Dependencies:** Task 11
**Parallelizable:** Yes (with Task 12)

---

### Task 14: Hygiene — prune redundant prose from `fix-strategies.md`

**Phase:** REFACTOR-only (no test required; documentation change)

1. Delete or convert the Sentry guidance block at `skills-src/shepherd/references/fix-strategies.md:157-176` to a one-liner pointer.
2. Delete or convert the CodeRabbit guidance block at `skills-src/shepherd/references/fix-strategies.md:178-194` to a one-liner pointer.
3. Delete or convert the Human Reviewer guidance block at `skills-src/shepherd/references/fix-strategies.md:196-202` to a one-liner pointer.
4. Run `npm run build:skills` and commit regenerated `skills/` per CLAUDE.md convention.
5. **Verify:** No production code references the deleted blocks. Skill rendering still works (no broken `@references/` includes).

**Dependencies:** Tasks 5, 6, 8 (adapters that own the moved logic must exist first)
**Parallelizable:** Yes (with Tasks 11, 12, 13 — different file)

---

## Phase 2: `classify_review_items` action + shepherd integration

### Task 15: Define `ClassificationGroup` output type

**Phase:** RED → GREEN

1. [RED] Write test: `ClassificationGroup_Type_HasFileItemsSeverityRecommendation`
   - File: `servers/exarchos-mcp/src/review/classifier.test.ts`
   - `satisfies ClassificationGroup` test against stub.
   - Expected failure: file doesn't exist.

2. [GREEN] Add to `servers/exarchos-mcp/src/review/types.ts`:
   ```typescript
   export type DispatchRecommendation = 'direct' | 'delegate-fixer' | 'delegate-scaffolder';
   export interface ClassificationGroup {
     readonly file: string | null;
     readonly items: readonly ActionItem[];
     readonly severity: Severity;            // max severity in group
     readonly recommendation: DispatchRecommendation;
     readonly rationale: string;
   }
   export interface ClassificationResult {
     readonly groups: readonly ClassificationGroup[];
     readonly summary: { totalItems: number; directCount: number; delegateCount: number };
   }
   ```

**Dependencies:** Task 1, Task 11 (so `ActionItem.normalizedSeverity` is in place)
**Parallelizable:** Yes (with Task 16)

---

### Task 16: File-grouping function

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/classifier.test.ts`:
   - `GroupItemsByFile_TwoItemsSameFile_ReturnsOneGroup`
   - `GroupItemsByFile_ItemsAcrossFiles_ReturnsOneGroupPerFile`
   - `GroupItemsByFile_ItemsWithoutFile_GroupedUnderNullFile`
   - Expected failure: function doesn't exist.

2. [GREEN] Create `servers/exarchos-mcp/src/review/classifier.ts` with `groupItemsByFile(items: readonly ActionItem[]): Map<string | null, ActionItem[]>`.

**Dependencies:** Task 1
**Parallelizable:** Yes (with Task 15)

---

### Task 17: Recommendation logic — direct vs delegate-fixer

**Phase:** RED → GREEN

1. [RED] Write tests in `servers/exarchos-mcp/src/review/classifier.test.ts`:
   - `RecommendForGroup_SingleItemNonHighSeverity_RecommendsDirect`
   - `RecommendForGroup_MultipleItemsSameFile_RecommendsDelegateFixer`
   - `RecommendForGroup_AnyHighSeverity_RecommendsDelegateFixer`
   - `RecommendForGroup_PopulatesRationale`
   - Expected failure: function doesn't exist.

2. [GREEN] Add `recommendForGroup(items: readonly ActionItem[]): {recommendation: DispatchRecommendation; rationale: string; severity: Severity}` to `classifier.ts`.

**Dependencies:** Tasks 15, 16
**Parallelizable:** Yes (with Task 18)

---

### Task 18: Doc-nit routing to scaffolder

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `servers/exarchos-mcp/src/review/classifier.test.ts`:
   - `RecommendForGroup_AllLowSeverityWithDocNitKeyword_RecommendsScaffolder`
   - `RecommendForGroup_LowSeverityNoKeyword_RecommendsDirect`
   - Expected failure: scaffolder branch doesn't exist.

2. [GREEN] Extend `recommendForGroup`: if all items have `normalizedSeverity: 'LOW'` AND any item title matches `DOC_NIT_KEYWORDS = ['<remarks>', 'sealed', 'OrderBy', 'format', 'XML doc']`, recommend `delegate-scaffolder`.

3. [REFACTOR] If `DOC_NIT_KEYWORDS` overlaps `SCAFFOLDING_KEYWORDS` from `prepare-delegation.ts:91`, extract a shared constant in a new `servers/exarchos-mcp/src/orchestrate/scaffolding-keywords.ts` and re-export from both consumers. Resolves design Q-P5.

**Dependencies:** Task 17
**Parallelizable:** No

---

### Task 19: Top-level `classifyReviewItems()` entry point

**Phase:** RED → GREEN

1. [RED] Write test: `ClassifyReviewItems_MixedItems_ProducesGroupsAndSummary`
   - File: `servers/exarchos-mcp/src/review/classifier.test.ts`
   - Property-style test: given a randomly generated `ActionItem[]`, all items appear in exactly one group's `items` (partition invariant from design test strategy).
   - Plus a concrete fixture test that constructs 5 items across 3 files with mixed severities and asserts the full `ClassificationResult` shape.
   - Expected failure: function doesn't exist.

2. [GREEN] Add `classifyReviewItems(items: readonly ActionItem[]): ClassificationResult` to `classifier.ts`. Composes `groupItemsByFile` + `recommendForGroup` per group + summary aggregation.

**Dependencies:** Tasks 16, 17, 18
**Parallelizable:** No (gates Task 20)

---

### Task 20: Register `classify_review_items` orchestrate action

**Phase:** RED → GREEN

1. [RED] Write test: `OrchestrateClassifyReviewItems_GivenItems_ReturnsClassificationResult`
   - File: `servers/exarchos-mcp/src/orchestrate/classify-review-items.test.ts`
   - Calls the handler with sample input; asserts result shape.
   - Expected failure: handler + registry entry don't exist.

2. [GREEN]
   - Create `servers/exarchos-mcp/src/orchestrate/classify-review-items.ts` exporting `handleClassifyReviewItems(args: {actionItems: ActionItem[]}): ToolResult` that wraps `classifyReviewItems()`.
   - Add registry entry in `servers/exarchos-mcp/src/registry.ts`: name `classify_review_items`, schema `z.object({ actionItems: z.array(...) })`, phases `REVIEW_PHASES`, roles `ROLE_LEAD`.
   - Wire dispatch in the orchestrate handler dispatcher.

**Dependencies:** Task 19
**Parallelizable:** No

---

### Task 21: Emit `dispatch.classified` event

**Phase:** RED → GREEN

1. [RED] Write test: `OrchestrateClassifyReviewItems_OnInvocation_EmitsDispatchClassifiedEvent`
   - File: `servers/exarchos-mcp/src/orchestrate/classify-review-items.test.ts`
   - Mock event store. Run handler with 4 items (1 HIGH/1 MEDIUM/2 LOW across 2 files). Assert one `dispatch.classified` event was emitted with data `{groupCount: 2, directCount, delegateCount, severityDistribution: {high: 1, medium: 1, low: 2}}`.
   - Expected failure: handler doesn't emit.

2. [GREEN]
   - Register event type `dispatch.classified` in event types module.
   - Emit from `handleClassifyReviewItems` after computing the result.

**Dependencies:** Task 20
**Parallelizable:** Yes (with Task 22)

---

### Task 22: Promote `normalizedSeverity` to required in `ActionItem`

**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ActionItem_WithoutNormalizedSeverity_TypeError`
   - File: `servers/exarchos-mcp/src/review/types.test.ts`
   - `// @ts-expect-error` test that a literal missing `normalizedSeverity` fails to type-check.
   - Expected failure: field is currently optional.

2. [GREEN] Change `normalizedSeverity?: Severity` to `normalizedSeverity: Severity` in `types.ts`. Run `npm run typecheck`. Fix every callsite that constructs `ActionItem` without populating it. Adapters already populate it (Phase 1). Existing `classifyActionItems` populates it from comment adapter output; unattached items (CI-fix, review-address) need an explicit default — set to `'HIGH'` for `ci-fix`, `'HIGH'` for `review-address` to mirror existing `severity: 'critical'`/`'major'` mappings.

3. [REFACTOR] If the existing lowercase `severity` field becomes redundant (every consumer reads `normalizedSeverity`), mark it deprecated with a JSDoc `@deprecated` comment. Do not delete in this task; deletion is out of scope.

**Dependencies:** Task 11 (adapters in place), Task 12 (severity threading complete)
**Parallelizable:** Yes (with Task 21)

---

### Task 23: Update shepherd skill to call `classify_review_items`

**Phase:** REFACTOR-only (skill prose change)

1. Update `skills-src/shepherd/SKILL.md` Step 2 (lines 94-138):
   - Insert a step before the action-item iteration: "Call `exarchos_orchestrate({action: 'classify_review_items', actionItems: <from assess_stack>})` and route per group's `recommendation`."
   - Update the action-item types table to reference `recommendation` instead of `type`.
2. Run `npm run build:skills`; commit regenerated `skills/`.
3. **Verify:** Existing event emission protocol (`remediation.attempted` / `remediation.succeeded`) still wraps each fix attempt.

**Dependencies:** Task 20
**Parallelizable:** Yes (with Tasks 21, 22, 24)

---

### Task 24: Hygiene — delete `fix-strategies.md` direct-vs-delegate table

**Phase:** REFACTOR-only

1. Delete the table at `skills-src/shepherd/references/fix-strategies.md:9-14` and the surrounding "Decision: Fix Directly vs. Delegate" section.
2. Replace with: "See `classify_review_items` orchestrate action — it owns this decision."
3. Run `npm run build:skills`; commit regenerated `skills/`.
4. **Verify:** No skill prose still references the deleted heuristic.

**Dependencies:** Task 23 (shepherd skill updated to use classifier first)
**Parallelizable:** Yes (with Tasks 21, 22)

---

### Task 25: Smoke test — shepherd integration with classifier

**Phase:** RED → GREEN

1. [RED] Write test: `ShepherdIteration_MixedSeverityComments_RoutesPerClassifier`
   - File: `servers/exarchos-mcp/src/__tests__/shepherd-classifier-integration.test.ts`
   - Mock VCS provider returning a PR with a CodeRabbit Critical comment, a Sentry Medium comment, and a human nit. Run `assess_stack` → `classify_review_items`. Assert the classifier output contains 3 groups with expected recommendations (`delegate-fixer` / `direct` / `direct`).
   - Expected failure: integration not wired.

2. [GREEN] Confirm wiring works end-to-end. May require fixture work, not new code if Tasks 11+20 are correct.

**Dependencies:** Tasks 20, 11
**Parallelizable:** No (final integration check)

---

## Parallelization plan

```text
Pre-work
├── Task 1 (foundational) ─┬─→ Task 2 ─┐
                           ├─→ Task 3 ─┤
                           └─→ Task 4 ─┴─→ Phase 1

Phase 1
├── Tasks 5, 6, 7, 8, 9 (5 adapters in parallel) ──→ Task 10 ──→ Task 11 ──┬─→ Task 12
                                                                          └─→ Task 13
└── Task 14 (hygiene, parallel with 11/12/13)

Phase 2
├── Tasks 15, 16 (parallel) ──→ Task 17 ──→ Task 18 ──→ Task 19 ──→ Task 20 ──┬─→ Task 21
                                                                              ├─→ Task 22
                                                                              ├─→ Task 23 ──→ Task 24
                                                                              └─→ Task 25 (final)
```

**Worktree sizing recommendation:** 5 worktrees for the adapter wave (Tasks 5–9). Otherwise sequential — most later tasks are gated.

## Open questions resolved during planning

- **Q-P1 (fixture count):** Plan says 4–6 representative comments per provider, sourced from basileus #159 thread + recent exarchos PRs. Implementer can adjust during Task 5–9 RED phase.
- **Q-P2 (Copilot author name):** Plan defers to implementer to confirm the exact author string in fixture data during Task 7.
- **Q-P3 (soak window):** Plan promotes severity to required as Task 22, executed within the same PR sequence — no version-soak gate. The "soak" was a design hedge; in practice all callsites are in this same change-set and can be updated together.
- **Q-P4 (back-compat for existing `actionItem.context`):** Pre-work Task 1 keeps existing fields untouched; new fields are additive. No grep needed because we're adding, not replacing, in Phase 1.
- **Q-P5 (shared keyword constant):** Resolved in Task 18 REFACTOR — extract `SCAFFOLDING_KEYWORDS` to a shared module.

## Open questions for plan-review

None expected — all design Q-P# items are resolved above.
