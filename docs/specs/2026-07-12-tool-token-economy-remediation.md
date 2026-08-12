# Spec: Tool-Surface Token-Economy Remediation

**Date:** 2026-07-12 · **Feature:** `tool-token-economy-remediation` · **Depth:** deep
**Inputs:** `docs/research/2026-07-11-tool-surface-token-economy-audit.md` (discovery workflow `tool-token-economy-audit`, PR #1679) · `docs/specs/2026-07-09-refactor-pipeline-view-economy.md` (#1659, patterns P1–P5) · `.exarchos/invariants.md`
**Forward-compat (§05 target):** `docs/system-design.html` §05 "facade-as-MCP-contract codegen" (Z3) · #1604 (2026-07-28 MCP migration, GA imminent) · #1608 (INV-2/INV-4/INV-11 reframe). This feature governs the **output side** of the contract; §05 makes the MCP contract the sole API abstraction with the CLI a generated presentation client. The economy work is designed as the output-side down-payment on that transition — see the Technical Design "outputSchema honesty" and "presentation seam" notes.

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
- A registry-enumeration snapshot test pins every action's effective budget (declared or default) as a golden table — any budget change or new action surfaces as a reviewed snapshot diff, and an invalid (non-finite/non-positive) declared budget fails the test.
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

Default `limit` 20 newest + `page` metadata; unbounded only by explicit request.
The registered schema already carries `limit`/`offset`/`fields` — this is a handler-default change with no registry edit.

**Acceptance criteria:**
- Default query on the audit's 112-event stream fixture returns ≤1,600 tokens (audit measured 1,490 at limit 20; baseline unbounded: 5,755) with `page.hasMore: true`.
- Explicit `limit`/`offset` retains full history access; ordering is deterministic.

### DR-6: Flip slim registration

Set `slimRegistration: true` in production dispatch context; `describe` remains the on-demand detail path.

**Acceptance criteria:**
- Serialized `tools/list` registration measures ≤3,800 tokens/session (baseline: ~7,851).
- Slim descriptions retain the "when NOT to use" clause per tool (INV-5a).
- The eval suite passes unchanged — no prompt-drift regressions from skills that reference action signatures.

### DR-7: Gate-output truncation (counts-not-transcripts)

`check_static_analysis` FAIL detail caps at first N lines + failure count with a steering suffix; `review_diff` returns stat-summary + capped hunks and never embeds the diff twice (today: full diff in `data.diff` **and** re-embedded in `data.report`).
The same counts-not-transcripts shaping applies to the other unbounded gate echoes the audit named (O-3/O-4): `check_pr_comments` (one line per comment, unbounded count) and `check_integration_suite`'s load-failure list.

**Acceptance criteria:**
- A FAIL run with 500+ lines of lint/typecheck output returns the first N (~50) lines, a total count, and a "re-run with…" steering hint.
- `review_diff` response contains at most one copy of any hunk; a large-diff fixture pins the budget.
- Failure-mode fidelity: the capped FAIL detail always includes every distinct failing file (counts per file), so triage never requires the uncapped path for "what failed".
- `check_pr_comments` and `check_integration_suite` failure lists cap at N entries plus total counts, with steering to the uncapped escape hatch.

### DR-8: Generalize the view contract

Apply compact-by-default + `page` + scope perceivability (#1659 P1–P5) to the remaining ~20 views, riding DR-1's backstop; fix the `--compact` no-op (audit B-4).

**Acceptance criteria:**
- Every `exarchos_view` action returns `page` metadata when list-shaped and honors `detail: true`.
- Scoped views report `scope` + `unscopedTotal` (P5 perceivability) so hidden rows are always perceivable.
- `view telemetry --compact` measurably reduces output on a populated store (baseline: no-op at 85 tok).
- Each migrated view carries a DR-2-style token-budget test.

### DR-9: Envelope split (`content` lean, `structuredContent` full) — seam unconditional, rendering verification-gated

Two separable parts. **(a) The presentation seam is unconditional:** extract `content` construction in `toMcpResult` into a single `renderContent(env)` function (byte-identical, characterization-pinned) — the structural split point between the canonical contract (`structuredContent`) and its presentation (`content`), and the first instance of the split §05 generalizes across facades. **(b) The lean rendering is gated:** verify empirically how host clients (Claude Code plugin first, then the other Tier-1 runtimes) inject `content` vs `structuredContent` into model context; fill the seam with a lean rendering only where verified beneficial.

**Acceptance criteria:**
- **Seam (unconditional):** `renderContent(env)` is the sole construction point for `content`; a characterization test pins byte-identical output vs. today's inline `JSON.stringify(env)`. This lands even on a defer verdict — deferring the *rendering* must not defer the *split point*.
- A written verification note (in-repo, linked from this spec's decomposition) records per-runtime injection behavior with reproduction steps.
- **Decision rule (decidable):** fill the seam with a lean rendering only if the primary runtime (Claude Code) demonstrably injects `content` (not `structuredContent`) into model context AND a lean rendering reduces model-visible tokens ≥30% across ≥3 representative actions. Runtimes evidenced to inject `structuredContent` are no-loss by construction; any Tier-1 runtime whose injection behavior cannot be evidenced ⇒ defer (INV-4: the guarantee must exist on every runtime's path).
- If the rendering is implemented: `content` carries a compact rendering via `renderContent`, `structuredContent` the full envelope; both facades produce identical `structuredContent` (INV-2); rendering is presentation-only in adapters (no business logic).
- If verification shows no model-token benefit: the *rendering* is explicitly deferred with the evidence recorded — the task closes with the seam landed but `renderContent` still byte-identical.

### DR-10: Codify INV-17 (response-economy)

Author a dev-catalog entry via the `/exarchos:invariants` wizard verbs (`invariants_scaffold`/`invariants_add`): every action declares a default token budget; unbounded output requires an explicit schema-typed escape hatch; budgets are test-enforced.
Frame the invariant **contract-canonically**: the budget and escape-hatch are properties of the *canonical response contract* — declared in the registry schema/descriptor, enforced in the shared dispatch core, rendered through a presentation seam — never special-cased in one facade. This carries the INV-2 reframe (#1608) and the §05 facade-codegen direction forward to every future action, so the next new action inherits the contract-canonical posture, not the peer-facade one.

**Acceptance criteria:**
- `.exarchos/invariants.md` gains INV-17 with ≥3 citations (Anthropic tool-writing guidance, MCP 2025-06-18, GitHub MCP minimal-types precedent), `cost-of-load` and `applies-to` set.
- The invariant statement is contract-canonical (schema-declared, core-enforced, presentation-rendered) and cross-references the INV-2 reframe (#1608) / §05 target.
- The id is INV-17 — INV-16 (os-portability) is not disturbed; vocabulary-lint passes.
- `check_invariant_conformance` surfaces INV-17 for review-phase audits.

### DR-11: Incidental defect burn-down (B-1, B-2, B-3, B-5, B-6)

Fix the audit's incidental defects; each is a real end-user breakage with its own regression test (B-4 is folded into DR-8).

**Acceptance criteria:**
- B-1: **verified already fixed at HEAD** — `views/tools.ts` filters non-feature streams generically (#1434) and `materializer.sentinel-skip.test.ts` pins the `__migration__` case; the audit's observation is attributed to plugin-deployment lag. No code change; the existing fixture-pinned tests remain the regression guard.
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

**outputSchema honesty (contract-canonical):** actions with a summarizer declare the summary shape in their registered schema; the generic fallback's shape (`{summary, counts, firstPage}`) is a shared schema fragment unioned into every action that carries a typed `data` outputSchema (8 today).
This union is load-bearing, not cosmetic: the registered `outputSchema` **is** the canonical response contract (system-design "one contract, one core"), so a capped response whose shape the schema does not declare violates the contract itself — regardless of which surface renders it.
The MCP adapter's D.5 validator (`adapters/mcp.ts:245`, `validateAgainstActionSchema`) is *where that contract is enforced today* — it replaces a violating envelope with an `INTERNAL_ERROR` envelope; the CLI is a presentation client over the same contract, bound to it by construction (INV-2 reframe, #1608; §05 facade-codegen atop the #1604 2026-07-28 MCP migration).
Framing the union as "MCP has D.5, the CLI has no D.5 pass, so they diverge" is the pre-#1608 peer-facade model and is deliberately **not** the rationale here: that "CLI sails through" asymmetry is a transitional artifact §05 removes (the CLI stops being an independent validation path). The union exists because the contract must honestly describe every shape an action can emit — which is *also* the precondition for §05 output-codegen (you cannot generate a presentation client from a schema that doesn't enumerate the response shapes).
The union is single-owned by a dedicated registry task (022) and must land before enforcement (003) activates; concretely it makes each typed action's schema **total over its emittable shapes** (baseline + capped) — a §05 down-payment, not just a D.5 unblock.
**Budget scope note (audit F-6):** budgets measure `data` only; the ~40–60-token envelope carrier floor is deliberately outside the budget and documented as such.

**Kit relocation:** `views/output-cap.ts` → `dispatch/core/economy.ts` (name illustrative); `pipeline`/`worktrees` become the first consumers of the generalized kit, unchanged in behavior.

**Presentation seam (§05 down-payment):** today `toMcpResult` (`adapters/mcp.ts:173`) builds the `content` block inline as `JSON.stringify(env)` — the same full envelope it also puts in `structuredContent`. This feature extracts that into a single `renderContent(env)` presentation function: the one place `content` is derived from the canonical envelope. The extraction is **byte-identical and unconditional** — it lands regardless of DR-9's go/no-go, because it is the structural split point between *contract* (`structuredContent`, the canonical envelope) and *presentation* (`content`, a rendering of it). DR-9's lean rendering, if verified, simply fills this seam; §05's facade-codegen consumes the same split (the CLI becomes another renderer over the same contract). The input side is already schema-derived (`adapters/schema-to-flags.ts`); this establishes the matching seam on the output side. **Discipline:** capping/economy logic lives in the shared core (`dispatch/core/economy.ts`, `dispatch/core/dispatch.ts`), never in an adapter; adapters only *render*. New response shapes must fall out of the shared envelope + `renderContent`, never a hand-added `cli-format.ts` branch.

**Slim registration** is a one-line context flip plus eval validation; the `describe` action is already the bounded detail path (1–10 actions).

**What this deliberately does not do:** no serialization-format swap (TOON/CSV — *Notation Matters*, accuracy cost, audit O-9); no tool splitting (the flattened-union registration schema is load-bearing, `buildRegistrationSchema` collision throw); no new top-level tools (INV-5d).

## Integration Points

- `servers/exarchos-mcp/src/registry.ts` — `economy` block on the descriptor type; per-action budgets; registry-enumeration budget test.
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts` — enforcement at the measurement seam; `slimRegistration: true`.
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
- **`emitGateExecutedEvents` write amplification** (audit §5.2: one `gate.executed` event per check per PR per shepherd iteration) — explicitly deferred: it is event-store write cost, not response-economy; file a follow-up issue during implementation.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1..DR-12).
**Excluded:** None. Task 017 (DR-9 implementation) is conditional by design — it closes without code if Task 016's verification shows no model-token benefit; that is an explicit DR-9 acceptance path, not a scope exclusion.

### Traceability matrix

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Registry-declared response-economy contract | 001, 002, 003, 022 |
| DR-2 | assess_stack minimal types | 007 |
| DR-3 | get_pr_comments window + projection | 006, 022 |
| DR-4 | prepare_delegation prompt dedupe | 008 |
| DR-5 | event query default limit | 005 |
| DR-6 | Flip slim registration | 015 |
| DR-7 | Gate-output truncation | 011, 012, 023 |
| DR-8 | Generalize the view contract | 013, 014, 022, 024 |
| DR-9 | Envelope split — verification-gated | 016, 017 |
| DR-10 | Codify INV-17 | 018 |
| DR-11 | Incidental defect burn-down | 004, 010, 014, 019, 020 |
| DR-12 | Economy-by-default consumer migration | 021 |

### Tasks

### Task 001: Generalize the output-cap kit out of views/

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-1
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/dispatch/core/economy.ts`
- `servers/exarchos-mcp/src/views/output-cap.ts`
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/orchestrate/worktree/handlers.ts`
- `servers/exarchos-mcp/src/dispatch/core/economy.test.ts`

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

Add `economy?: { budgetTokens?: number; compactByDefault?: boolean; summarize?: (data: unknown) => unknown }` at the action-descriptor level (sibling to `cli`, `gate`, `dispatchHints`); registry-wide default 2,000; explicit higher budgets for verbose-by-design actions (`describe`, `runbook` — event `describe`'s budget accounts for its `emissionGuide` param path, which is a param, not an action); budgets surfaced via `describe`.

**Verification:**
- `registryEconomy_BudgetSnapshot_PinsEffectiveBudgetPerAction`
- `registryEconomy_VerboseByDesignAllowlist_DeclaresExplicitHigherBudget`
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
- `servers/exarchos-mcp/src/dispatch/core/dispatch.ts`
- `servers/exarchos-mcp/src/telemetry/middleware.ts`
- `servers/exarchos-mcp/src/format.ts`
- `servers/exarchos-mcp/src/dispatch/core/economy-enforcement.test.ts`

Post-handler, pre-`injectPerf`: measure `data`; over budget → declared summarizer else generic capped fallback (`{summary, counts, firstPage}` shared schema fragment) + steering `next_actions` entry; stamp `_meta.truncated`; fail-open (`_meta.economyDegraded`) on unresolvable budget or throwing summarizer; `_perf` reports final post-cap size; envelope carrier fields never truncated.

**Verification:**
- `dispatchEconomy_OverBudgetResponse_AppliesSummarizerAndStampsTruncated` — the DR-1 north-star acceptance test, real dispatch path, no mocks
- `dispatchEconomy_BudgetUnresolvable_FailsOpenWithDegradedMarker`
- `dispatchEconomy_SummarizerThrows_ReturnsUncappedWithDegradedMarker`
- `dispatchEconomy_CappedResponse_EnvelopeCarrierIntact` — property test: for arbitrary over-budget payloads, `success`/`next_actions`/`_meta`/`_perf` survive
- `dispatchEconomy_CappedTypedOutputSchemaAction_ConformsToRegisteredSchema` — a capped response for a typed-outputSchema action conforms to its registered `outputSchema` (passes D.5; never INTERNAL_ERROR). This is a **schema-conformance** assertion — the codegen-golden precursor (#1608: "parity harness → codegen golden test"), *not* a runtime two-facade result-diff.
- `check_test_adequacy` kill-probe + integration suite across the **shared** dispatch seam. Enforcement lives in the core, so both surfaces inherit the cap by construction (INV-2 by construction, per #1608) — assert the cap once at the core seam, not by diffing MCP-vs-CLI outputs.

**Dependencies:** 001, 002, 022
**Parallelizable:** No

### Task 004: B-2 — fix `check_ci` against current gh CLI

**Risk Tier:** medium
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-11
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/vcs/github.ts`
- `servers/exarchos-mcp/src/orchestrate/vcs/check-ci.ts`
- co-located test

Replace the removed `conclusion` JSON field with `state` at the true seam — `vcs/github.ts` (`mapConclusion` and the gh `--json` field list); the registered handler `orchestrate/vcs/check-ci.ts` is a thin pass-through. Pin the parse against a recorded current-gh output fixture. **Wave-1 priority — blocks shepherd CI checks today.**

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

Default `limit` 20 newest with `page:{total,offset,limit,hasMore}`; deterministic ordering; explicit `limit`/`offset` retains full access. Handler-only change — the registered schema already carries `limit`/`offset`/`fields`.

**Verification:**
- `eventQuery_NoLimit_Returns20NewestWithPageMetadata`
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
- `servers/exarchos-mcp/src/vcs/github.ts`
- `servers/exarchos-mcp/src/vcs/provider.ts`
- `servers/exarchos-mcp/src/orchestrate/vcs/get-pr-comments.ts`
- `servers/exarchos-mcp/src/orchestrate/vcs/list-prs.ts`
- co-located test

Default limit ~20 newest + `page` metadata + `fields` projection; truncation notice steers to narrower calls. The window/projection lands in `vcs/github.ts` and the `VcsProvider` interface (the orchestrate files are thin shims); GitLab/ADO partial providers keep their throw-behavior. `list_prs` gains a default window in the same pass (its handler is `orchestrate/vcs/list-prs.ts`). Schema params ride Task 022.

**Verification:**
- `getPrComments_DefaultLimit_ReturnsPageWithHasMore`
- `getPrComments_FieldsProjection_ReturnsOnlyRequestedKeys`
- `getPrComments_ExplicitOffset_PagesDeterministically`
- `listPrs_NoLimit_ReturnsDefaultWindow`
- `check_test_adequacy` kill-probe

**Dependencies:** 004, 022
**Parallelizable:** No

### Task 007: DR-2 — `assess_stack` minimal types

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-2
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/assess-stack.ts`
- co-located test

Delete dead `fullBody`; collapse `actionItems[].raw` to a reference into `unresolvedComments`; cap comments per PR with `page` metadata; `checks[]` → counts + failing detail. Schema params ride Task 022; `list_prs` windowing moved to Task 006 (its handler lives in `orchestrate/vcs/`).
**Deadness precondition:** the code comment at the `fullBody` field claims a review-provider-adapter consumer — the audit found adapters consume raw comments upstream; verify before deleting and fix the stale comment narrative.

**Verification:**
- `assessStack_CommentHeavyStack_StaysUnderBudget` — comment-heavy fixture (≥25 unresolved on one PR), pins the data-dependent case
- `assessStack_UnresolvedComments_EachCommentSerializedOnce`
- `assessStack_PagedComments_EveryActionableReferenceReachable`
- `assessStack_AdapterConsumption_UnaffectedByFullBodyRemoval` — characterization proving provider adapters parse comments upstream of the result build (the deadness precondition)
- `check_test_adequacy` kill-probe + integration suite (shepherd-loop consumer contract)

**Dependencies:** 022
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

### Task 010: B-3 — `prNumbers` CSV coercion

**Risk Tier:** medium
**Test Layer:** unit
**Implements:** DR-11
**Testing Strategy:** propertyTests: true, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/coerce.ts`
- `servers/exarchos-mcp/src/coerce.test.ts`

Accept CSV (`1660,1671,1659`) for int-array flags through the coercion layer, consistent with the Zod-v4 `coerceFlags` object-classification design (JSON array input keeps working). A CSV-tolerant coerced int-array helper is new in `coerce.ts`; the `prNumbers` schema swap rides Task 022.

**Verification:**
- `coerceFlags_PrNumbersCsv_ParsesToIntArray`
- `coerceFlags_JsonArrayInput_StillParses` (characterization)
- `coerceFlags_CsvRoundTrip_EquivalentToJsonArray` — property test over int arrays
- `check_test_adequacy` kill-probe

**Dependencies:** 022
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

### Task 013: Generalize the view contract: inventory views batch

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/tools.test.ts`

First half of the view migration — the list/inventory-shaped views (`tasks`, `stack_status`, `workflow_status`, `delegation_timeline`, `team_performance`, …): `page` metadata, `detail: true`, `scope`/`unscopedTotal` perceivability, and a DR-2-style token-budget test per migrated view; rides Task 003's backstop. View schema params ride Task 022. Analytic views are Task 024.

**Verification:**
- `viewsContract_ListShaped_ReturnPageMetadataAndHonorDetail`
- `viewsContract_MigratedView_StaysUnderEffectiveBudget`
- `viewsContract_ScopedView_ReportsUnscopedTotal`
- `check_test_adequacy` kill-probe + integration suite (migrated views over a populated fixture store)

**Dependencies:** 003, 022
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

**Dependencies:** 024
**Parallelizable:** No

### Task 015: DR-6 — flip slim registration + eval validation

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-6
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/index.ts`
- `servers/exarchos-mcp/src/adapters/mcp.ts`
- co-located test

Set `slimRegistration: true` where the production `DispatchContext` is constructed (`src/index.ts` — `adapters/mcp.ts` only reads the flag); slim descriptions keep the "when NOT to use" clause per tool (INV-5a); run the eval suite for prompt-drift.

**Verification:**
- `toolsList_SlimRegistration_MeasuresUnder3800Tokens`
- `toolsList_SlimDescriptions_RetainWhenNotToUseClause`
- Eval suite run recorded green (no shape/prompt-drift regressions)
- `check_test_adequacy` kill-probe

**Dependencies:** 002, 019
**Parallelizable:** No

### Task 016: DR-9 — client-injection verification note

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-9
**Testing Strategy:** propertyTests: false, characterizationRequired: false

**Files:**
- `docs/research/2026-07-DR9-content-injection-verification.md`

Empirically record how host clients (Claude Code plugin first, then Tier-1 runtimes) inject `content` vs `structuredContent` into model context, with reproduction steps and a go/no-go recommendation for Task 017.

The note: [`docs/research/2026-07-DR9-content-injection-verification.md`](../research/2026-07-DR9-content-injection-verification.md).

**Verification:**
- Static analysis only; the deliverable is the in-repo note with reproducible evidence

**Dependencies:** None
**Parallelizable:** Yes

### Task 017: DR-9 — `renderContent` presentation seam (unconditional) + lean rendering (gated on Task 016)

**Risk Tier:** high
**Boundary Touching:** true
**Test Layer:** integration
**Implements:** DR-9
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/adapters/mcp.ts`
- co-located test

**Unconditional (always lands):** extract the inline `content` construction in `toMcpResult` (`adapters/mcp.ts:173`) into a single `renderContent(env)` function — byte-identical to today's `JSON.stringify(env)`, characterization-pinned. This is the §05 presentation/contract split point and lands regardless of the decision rule.
**Gated on 016:** if 016's decision rule verifies benefit, `renderContent` returns a compact rendering while `structuredContent` keeps the full envelope; identical `structuredContent` across facades (INV-2); rendering stays presentation-only (no business logic). If the rule says defer: `renderContent` stays byte-identical and the deferral evidence is cited — the seam is still established. High tier — the gated rendering changes what every tool response injects into model context on the primary runtime.

**Verification:**
- `toMcpResult_RenderContentSeam_BytesIdenticalToInline` — characterization pinning the unconditional extraction (holds on both defer and implement paths)
- `toMcpResult_LeanContent_StructuredContentCarriesFullEnvelope` — gated path only
- `toMcpResult_BothFacades_IdenticalStructuredContent`
- `check_test_adequacy` kill-probe + integration suite across the adapter seam — or the recorded deferral evidence (with the seam characterization still green)

**Dependencies:** 015, 016
**Parallelizable:** No

### Task 018: Codify INV-17 response-economy via the invariants wizard

**Risk Tier:** low
**Test Layer:** unit
**Implements:** DR-10
**Testing Strategy:** propertyTests: false, characterizationRequired: false

**Files:**
- `.exarchos/invariants.md`

Author the response-economy entry through `invariants_scaffold`/`invariants_add` (never hand-written YAML): every action declares a default token budget; unbounded output requires a schema-typed escape hatch; budgets are test-enforced. Frame it contract-canonically (schema-declared, core-enforced, presentation-rendered — never facade-special-cased), cross-referencing the INV-2 reframe (#1608) and the §05 facade-codegen target so future actions inherit the posture. Id INV-17 (INV-16 = os-portability); ≥3 citations; vocabulary-lint green.

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
- `servers/exarchos-mcp/src/orchestrate/doctor/checks/store-path-divergence.ts` — new
- `servers/exarchos-mcp/src/index.ts` — CLI store-path resolution
- `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
- co-located tests

CLI and plugin resolve the same default store path or a documented precedence; a new `doctor` check detects and reports divergent store paths. In-scope floor is detection + documented precedence; a store migration spins off as its own issue if it grows.

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

**Dependencies:** 022
**Parallelizable:** No

### Task 021: Economy-by-default consumer migration: regenerate fixtures, snapshots, skills prose, full-suite validation

**Risk Tier:** high
**Test Layer:** acceptance
**Implements:** DR-12
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/tests/fixtures/load-bearing/rehydrate-demo.expected-document.json`
- `servers/exarchos-mcp/src/orchestrate/` parity baselines
- `skills-src/` prose + regenerated `skills/` tree

Regenerate golden fixtures and parity snapshots; update `skills-src/` prose citing fields removed by DR-2/DR-4/DR-7 and re-render (`npm run build:skills`, `skills:guard`); full `vitest run` at root and `servers/exarchos-mcp`; eval suite shows no shape-change regression. No dual-shape shims.

**Verification:**
- `parityTests_RegeneratedBaselines_Pass`
- `skillsGuard_RegeneratedSkillsTree_NoDrift`
- Full `vitest run` green in both packages, including the frozen parity suite
- Eval suite comparison recorded
- Integration suite is the gate — this task is the cumulative-regression backstop

**Dependencies:** 003, 004, 005, 006, 007, 008, 010, 011, 012, 013, 014, 015, 017, 018, 019, 020, 022, 023, 024
**Parallelizable:** No

### Task 022: Registry schema batch: economy params and capped-shape outputSchema unions

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-1, DR-3, DR-8
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/registry.ts`
- `servers/exarchos-mcp/src/registry.test.ts`

Single owner of every `registry.ts` schema edit the economy work needs, so handler tasks never touch the file: new input params (`limit`/`offset`/`fields` for `get_pr_comments`; paging for `assess_stack`; the CSV-tolerant coerced int-array for `prNumbers`; `detail`/paging for view schemas) and the `{summary, counts, firstPage}` capped-shape union into every action with a typed `data` outputSchema (8 today), so the registered contract is **total over every emittable shape** (baseline + capped). D.5 enforces that totality today; §05 output-codegen *requires* it — this task is the output-side codegen down-payment. All new params are schema-declared (never facade special-cased), so they auto-emit to CLI flags via `schema-to-flags` today and are codegen-ready tomorrow.

**Verification:**
- `registrySchemas_EconomyParams_ValidateAndCoerce`
- `registrySchemas_TypedOutputActions_AcceptCappedShape`
- `registrySchemas_TypedOutputActions_SchemaTotalOverEmittableShapes` — every typed-output action's `outputSchema` admits both its baseline and capped shapes (schema totality — the §05 output-codegen precondition)
- `check_test_adequacy` kill-probe + integration suite (registration schema is a shared contract surface)

**Dependencies:** 002
**Parallelizable:** No

### Task 023: Gate-output truncation for check_pr_comments and integration-suite load failures

**Risk Tier:** medium
**Test Layer:** integration
**Implements:** DR-7
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/orchestrate/check-pr-comments.ts`
- `servers/exarchos-mcp/src/orchestrate/check-integration-suite.ts`
- co-located tests

Counts-not-transcripts for the remaining unbounded gate echoes (audit O-3/O-4): `check_pr_comments` caps per-comment lines at N + total count; `check_integration_suite` caps its load-failure list at N + count; both steer to the uncapped escape hatch. Fixed caps — no new schema params.

**Verification:**
- `checkPrComments_ManyComments_CapsWithCountAndSteering`
- `checkIntegrationSuite_LoadFailureCascade_CapsListWithCount`
- `check_test_adequacy` kill-probe

**Dependencies:** None
**Parallelizable:** Yes

### Task 024: Generalize the view contract: analytic views batch

**Risk Tier:** high
**Test Layer:** integration
**Implements:** DR-8
**Testing Strategy:** propertyTests: false, characterizationRequired: true

**Files:**
- `servers/exarchos-mcp/src/views/tools.ts`
- `servers/exarchos-mcp/src/views/tools.test.ts`

Second half of the view migration — the analytic/correlation views (`telemetry`, `code_quality`, `eval_results`, `quality_correlation`, `quality_attribution`, `convergence`, …) onto the same compact/`page`/`scope` contract with per-view budget tests. Serialized after Task 013 (same file).

**Verification:**
- `viewsContract_AnalyticViews_ReturnPageAndScopeMetadata`
- `viewsContract_AnalyticView_StaysUnderEffectiveBudget`
- `check_test_adequacy` kill-probe + integration suite

**Dependencies:** 013
**Parallelizable:** No

### Parallelization

**Critical path:** 002 → 022 → 003 → 013 → 024 → 014 → 021.

- **Wave 1 (parallel worktrees):** 001, 002, 004 (priority — unblocks shepherd CI), 005, 008, 011, 012, 016, 019, 023.
- **Wave 2:** 022 (after 002 — sole owner of `registry.ts` schema edits), 015 (after 002+019 — shared `src/index.ts`), 017 (after 015+016).
- **Wave 3 (after 022):** 003 (after 001+002+022 — enforcement activates only once the capped-shape unions exist), 006 (also after 004 — shared `vcs/github.ts`), 007, 010, 020.
- **Wave 3b (after 003):** 013 (also after 022), 018.
- **Wave 4:** 024 (after 013 — same file), then 014 (after 024 — same file).
- **Wave 5:** 021 (blockedBy every implementation task) — the integration closeout.

File-collision chains, each strictly serialized via task dependencies: `registry.ts` (002 → 022 → 020's parity test), `views/tools.ts` (013 → 024 → 014), `vcs/github.ts` (004 → 006), `adapters/mcp.ts` (015 → 017), `src/index.ts` (019 → 015). Handler tasks never edit `registry.ts` — Task 022 is its single owner for this feature.

### Completion checklist

- [x] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [x] Every task `Implements:` a DR-N that exists in this document
- [x] Every task carries a `riskTier` stamp
- [x] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [x] Open questions resolved or explicitly deferred with rationale (DR-9 gate, budget tuning, B-5 floor)
- [x] Ready for `plan-review`
