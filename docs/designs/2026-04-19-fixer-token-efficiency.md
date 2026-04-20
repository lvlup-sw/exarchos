# Fixer Token Efficiency — Design

**Tracking issue:** [#1159](https://github.com/lvlup-sw/exarchos/issues/1159)
**Discovery report:** [`docs/research/fixer-token-efficiency.md`](../research/fixer-token-efficiency.md)
**Workflow:** `feat-fixer-token-efficiency`
**Date:** 2026-04-19
**Scope:** Phases 1 + 2 (canonical types + provider adapters + classifier). Phase 3 (file-batched dispatch with context prefetch) deferred to a follow-up issue.

## 1. Context

The discovery report ranked four optimizations from #1159 (P1–P4) against the current code. The ideate session corrected two assumptions in that ranking:

1. **The pipeline is platform-agnostic.** Exarchos's CLI is reviewer-agnostic and must remain so. Any severity-routing or batching logic has to work for CodeRabbit, Sentry, GitHub-Copilot, human reviewers, and future providers.
2. **The actual fixer-dispatch path is shepherd, not `extract_fix_tasks`.** The shepherd skill polls PR comments via `assess_stack`, then chooses direct-fix or delegated-fix per item using a prose heuristic in `references/fix-strategies.md`. The basileus #159 cost numbers measure the `/exarchos:delegate --fixes` path invoked by shepherd's "cross-cutting" branch.

An axiom backend-quality review of the corrected proposals surfaced one HIGH-severity constraint (provider adapter registry must be a single source of truth, constructor-injected) and one HIGH-severity contract constraint (changes to `actionItem` shape must be additive). Both are folded into the design below.

## 2. Out of scope (for this design)

- Per-fix sub-event observability for batched dispatch (folded into Phase 3).
- Modifying the `agents/fixer.md` template, `{{contextSnippet}}` prefetch, file-grouped dispatch construction.
- AC #4 benchmark from #1159 (≥40% token reduction). Phase 3 territory.
- The `extract_fix_tasks` / `state.reviews[].findings[]` internal-review pipeline. Stays as-is; Phase 1+2 work alongside it, not replacing it.

## 3. Pre-work: canonical domain types

Before any handler is touched, land the canonical types in a new file `servers/exarchos-mcp/src/review/types.ts`:

```typescript
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
export type ReviewerKind = 'coderabbit' | 'sentry' | 'human' | 'github-copilot' | 'unknown';

export interface ActionItem {
  readonly id: string;                  // stable per-comment ID from the source
  readonly reviewer: ReviewerKind;      // which adapter produced this
  readonly file?: string;               // optional: not all comments are file-bound
  readonly line?: number;
  readonly severity?: Severity;         // optional in Phase 1; required after soak
  readonly title: string;               // short, human-readable
  readonly body: string;                // full comment body
  readonly threadId?: string;           // for reply tracking
  readonly raw: unknown;                // provider-original payload, for debugging
}

export interface ProviderAdapter {
  readonly kind: ReviewerKind;
  parse(rawComment: unknown): ActionItem | null;
}

export interface ReviewAdapterRegistry {
  forReviewer(kind: ReviewerKind): ProviderAdapter | undefined;
  list(): readonly ProviderAdapter[];
}
```

The `ActionItem` shape is **additive** to whatever `assess_stack` returns today: existing consumers that read `actionItem.context` keep working; new fields populate where adapters can fill them. Severity stays optional in Phase 1 and is promoted to required at the start of Phase 2 (one minor version of soak).

The registry interface enforces the DIM-1 constraint: there is one factory (`createReviewAdapterRegistry()`), one place adapters are instantiated, and consumers receive the registry via constructor injection. No lazy fallback; missing registry is a startup error.

## 4. Phase 1: Provider adapters + `assess_stack` wiring

### 4.1 Adapter implementations

Create `servers/exarchos-mcp/src/review/providers/` containing one file per reviewer:

- `coderabbit.ts` — parses CodeRabbit comment bodies. Extracts severity from the tier markers documented in `fix-strategies.md:178-194`: `Critical → HIGH`, `Major → HIGH`, `Minor → LOW`. Refactor-suggestion or nitpick blocks → `LOW`. Bug/security blocks → `HIGH`.
- `sentry.ts` — extracts the `CRITICAL`/`MEDIUM`/etc. tags Sentry attaches; maps `CRITICAL → HIGH`, `MEDIUM → MEDIUM`, anything else → `LOW`.
- `github-copilot.ts` — Copilot review comments don't carry severity; default `MEDIUM`.
- `human.ts` — fallback adapter. No severity tag; defaults to `MEDIUM`. (We don't try to infer severity from prose — too unreliable.)
- `unknown.ts` — catch-all for unrecognized authors. Emits the comment as `severity: 'MEDIUM'` and emits a `provider.unknown_tier` event with the literal author string seen, satisfying the DIM-7 resilience constraint.

Each adapter's `parse()` is pure — given a raw comment from the GitHub API, return an `ActionItem` or `null` (informational comments like `github-actions[bot]` gate summaries return `null`).

### 4.2 Registry

`createReviewAdapterRegistry()` in `servers/exarchos-mcp/src/review/registry.ts` returns a frozen registry containing the five adapters. The registry exposes `forReviewer(kind)` and `list()`. No mutation; no late-binding.

### 4.3 `assess_stack` wiring

Modify `assess_stack` to accept a `ReviewAdapterRegistry` via constructor injection (or a factory parameter — the existing handler shape will dictate). For each fetched PR comment, route by author to the appropriate adapter, call `adapter.parse(comment)`, and attach the resulting `ActionItem` fields to the existing `actionItem.context` payload. Existing fields stay; new fields populate where adapters succeed.

### 4.4 Observability

Emit one new event per adapter dispatch decision:

- `provider.unknown_tier` — when an adapter encounters a tier string it doesn't recognize. Data: `{reviewer, rawTier, commentId}`. Tells us when reviewers ship new tiers we need to handle.

No other new events in Phase 1; existing `gate.executed` and `ci.status` events continue as today.

### 4.5 Hygiene obligation

After Phase 1 ships, prose blocks at `skills-src/shepherd/references/fix-strategies.md:159-194` (Sentry, CodeRabbit, Human reviewer guidance) become redundant — the adapters now own that logic. Either delete the duplicated content or convert each block to a one-line pointer ("see `review/providers/coderabbit.ts`"). DIM-5 enforces single source of truth.

## 5. Phase 2: `classify_action_items` action

### 5.1 New action surface

Add `classify_action_items` to `exarchos_orchestrate`. Input: `{actionItems: ActionItem[]}`. Output:

```typescript
{
  groups: Array<{
    file: string | null;             // null = file-less group (e.g. PR-level comments)
    items: ActionItem[];
    severity: Severity;              // max severity in the group
    recommendation: 'direct' | 'delegate-fixer' | 'delegate-scaffolder';
    rationale: string;               // human-readable, for logging/debugging
  }>;
  summary: { totalItems: number; directCount: number; delegateCount: number };
}
```

The handler groups action items by `file` (items without `file` go in a single "global" group). Per-group recommendation:

- All items `severity: 'LOW'` AND title matches doc-nit keywords (`<remarks>`, `sealed`, `OrderBy`, `format`) → `delegate-scaffolder`. Mirrors the existing `SCAFFOLDING_KEYWORDS` heuristic in `prepare-delegation.ts:91`.
- Group has 1 item AND `severity !== 'HIGH'` AND fits the existing direct-fix heuristic (≤20 lines, single file) → `direct`. Mirrors `fix-strategies.md:9-14`.
- Otherwise → `delegate-fixer`.

The recommendation is advisory; shepherd reads it and acts. We do not yet *execute* the dispatch from this action — that's Phase 3.

### 5.2 Promoting `actionItem.severity` to required

At the start of Phase 2, promote `severity` from optional to required in `ActionItem`. Adapters already populate it; the soak window in Phase 1 confirms no consumer relied on its absence. This is a contract tightening, not a breaking change for anyone who watched the optional field.

### 5.3 Observability

Emit one new event per classification call:

- `dispatch.classified` — emitted once per `classify_action_items` invocation. Data: `{groupCount, directCount, delegateCount, severityDistribution: {high, medium, low}}`. Lets us measure (a) how often the heuristic recommends delegate vs direct and (b) the severity distribution of real PR comments — which is the data we need to validate Phase 3's design and to check the discovery's DIM-3 finding empirically.

### 5.4 Shepherd integration

Update `skills-src/shepherd/SKILL.md` Step 2 to call `classify_action_items` on the `actionItems` returned by `assess_stack`, then route per group's `recommendation`. Replace the prose heuristic at `fix-strategies.md:9-14` with a one-line pointer. DIM-5 cleanup obligation.

### 5.5 Hygiene obligation

After Phase 2 ships, the direct-vs-delegate table in `fix-strategies.md:9-14` is owned by `classify_action_items`. Delete the table or convert to "see `classify_action_items` runbook".

## 6. Test strategy

| Phase | Layer | Test approach |
|---|---|---|
| Pre-work | `ActionItem` / `ProviderAdapter` types | Type-only — compile-time validation |
| 1 | Per-provider adapter | Unit tests against fixture comments. Capture 5–10 real comments per provider from basileus #159 (CodeRabbit, Sentry) and exarchos PRs (human, GitHub-Copilot). Each adapter test asserts the parsed `ActionItem` shape. |
| 1 | Registry | Unit test: registry construction is deterministic; missing reviewer returns undefined; no mutation possible. |
| 1 | `assess_stack` integration | Existing tests must continue to pass. Add one new test that asserts `actionItem.severity` is populated when adapters succeed. |
| 2 | `classify_action_items` | Unit tests for each branch of the recommendation logic. Property-based test: given any `ActionItem[]`, output `groups` partition the input (no item lost, no item duplicated). |
| 2 | Shepherd integration | One smoke test that runs the loop against a mocked PR with mixed-severity comments and asserts the recommendations match expectation. |

## 7. Phased rollout

| Phase | Ships | Token impact | Phase entry condition |
|---|---|---|---|
| Pre-work | Canonical types, no handlers | 0% | (none) |
| 1 | Adapters + registry + `assess_stack` wiring + Phase 1 hygiene cleanup | 0% — foundation only | Pre-work merged |
| 2 | `classify_action_items` + shepherd integration + Phase 2 hygiene cleanup + severity promoted to required | ~10% routing win + ~30% wall-clock parallelism (per #1159 P3) | Phase 1 has soaked through one minor version |
| 3 (separate ideate) | File-batched dispatch + context prefetch + AC #4 benchmark | ~40-55% per #1159 P1+P2 estimates | Phase 2 measurements in hand |

## 8. Open questions for plan

These are intentionally left for `/exarchos:plan` to resolve, since they're implementation-detail decisions:

- **Q-P1: How many fixture comments per provider?** Phase 1 tests need real comments. 5–10 per provider is a guess. Plan should pick a number and source.
- **Q-P2: Where do GitHub-Copilot review comments come from in the API response?** They appear under specific bot author names; need to confirm the exact name(s) so the adapter dispatcher routes correctly.
- **Q-P3: Soak window length.** "One minor version of soak" before promoting severity to required — pick concrete: one release? one week? Tie to a clear gate.
- **Q-P4: Backwards compatibility for existing `actionItem.context` consumers.** Phase 1 keeps `context` intact and adds new fields alongside. Plan should grep for `actionItem.context` consumers and confirm none break.
- **Q-P5: Scaffolder routing test.** The Phase 2 doc-nit heuristic mirrors `SCAFFOLDING_KEYWORDS` in `prepare-delegation.ts:91`. Should the keyword list be shared between the two heuristics, or duplicated for now? (DRY pull versus coupling tradeoff.)

## 9. Why this scope and not more

Phase 3 is where the bulk of #1159's claimed token savings live. We're explicitly *not* shipping it in this ideate because:

- Phase 3's design needs a partial-failure observability decision (the discovery's DIM-2 HIGH) that benefits from seeing real classifier output first.
- Phase 3 changes the `agents/fixer.md` template, which has wider blast radius than handler additions.
- Phase 3's AC #4 benchmark is meaningful only after Phases 1+2 normalize the data — measuring against today's pre-adapter state would confound provider-shape variance with optimization wins.

Splitting at the Phase 2/3 boundary lets Phase 3 ship a smaller, sharper change with a measurable benchmark, against a known classifier baseline.
