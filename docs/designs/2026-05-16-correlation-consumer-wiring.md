# Correlation Consumer Wiring (#1448)

**Status:** Draft → in-progress
**Stacked on:** PR #1447 (`feature/correlation-indexed-columns`)
**Closes:** #1448 (items 2-5; item 1 = #1446 separately tracked)
**Branch:** `feature/correlation-consumer-wiring`

## Problem

PR #1447 landed the correlation substrate — indexed columns, backend-aware filter API, 6 view actions accept filter args. The *substrate* is wired. The *consumer side* is not:

- Agents inside a dispatch context must manually thread the correlation tuple into every telemetry call.
- T17 acceptance test synthesizes the second dispatch boundary instead of going through the `next_actions` auto-dispatch handler.
- The filter surface has no narrative documentation and no CLI flags.
- The indexed-path and cache-bypass branches have no telemetry — silent regressions would be invisible.

## Approach

Single bundled PR stacked on #1447 covering all four consumer-side concerns. Items are independently shippable but cluster around one user-facing theme ("filter ergonomics work"); one PR avoids 4× shepherding overhead.

### Item 2 — AsyncLocalStorage default for `current_correlation`

**Behavior:**
- When *none* of `operationId`/`correlationId`/`causationId` are supplied AND a dispatch context is active → default `correlationId` to `getDispatchContext().correlationId`.
- When *any* filter arg is supplied → explicit-wins; no default injection.

**Why `correlationId`, not `operationId` or `causationId`:** correlationId is the chain-stable anchor — the "workflow scope" view. operationId would scope to the current dispatch boundary only (too narrow); causationId is one-hop (irrelevant for scoping).

**Implementation:**
- Extract helper `deriveCorrelationFilters(args): ViewQueryFilters` colocated with `ViewQueryFilters` interface in `views/tools.ts`.
- Replace the 6 inline spread blocks (lines 596-600, 648-652, 749-752, 854-857, 926-929, and `telemetry/tools.ts` 110-113) with a single call to the helper.
- Helper reads `getDispatchContext()` only when *all three* args are undefined.

**Observability:** Helper emits a `logger.debug` line `{ source: 'ctx-default' | 'explicit' | 'none' }` so operators can tell which path the filter came from.

### Item 3 — T17 integration via real `next_actions` handler

**Investigation required:** locate the `next_actions` auto-dispatch executor. Candidates from grep: `next-actions-from-result.ts` (computes, doesn't dispatch), `views/composite.ts` (envelope wrap), `cli-commands/checkpoint.ts`. The actual auto-dispatch path may be in the CLI or test driver rather than a production handler.

**Two outcomes:**
1. If a production auto-dispatch handler exists → rewrite T17 to drive through it.
2. If not (auto-dispatch is caller-driven) → write the test against the *minimal* caller path that callers in production use, and document that the orchestration loop is the integration surface.

### Item 4 — Docs runbook + CLI flag wiring

**New runbook:** `docs/runbooks/correlation-filters.md`
- Three IDs: operation (dispatch boundary), correlation (chain anchor), causation (one-hop upstream)
- Filter selection rule: workflow scoping vs cross-workflow rollups
- MCP call example: `exarchos_view telemetry { correlationId: 'cor-x' }`
- CLI call example: `exarchos view telemetry --correlation-id cor-x`
- Note on AsyncLocalStorage default (Item 2)

**CLI flags:** Wire `--operation-id`, `--correlation-id`, `--causation-id` to the 6 telemetry view subcommands in `adapters/cli.ts`. Flag names are kebab-case of the arg keys (INV-5d).

**README:** One paragraph in the observability section linking to the runbook.

### Item 5 — Observability for indexed-path + cache-bypass

**Indexed-path hit counter:** Add `correlationFilteredQueries` counter to `SqliteBackend`. Increment at both filter-clause sites (`queryEvents` L1258-1268 and `queryEventsByType` L1353-1363). Expose via a getter for telemetry/test inspection.

**Cache-bypass counter:** Add `cacheBypasses` counter to `ViewMaterializer` (alongside `cacheHits`/`cacheMisses` at L75-76). Increment from `materializeFiltered` in `views/tools.ts` via a new `materializer.recordBypass()` method. Include `bypasses` in the existing stats getter at L269-274 (so the thrashing-detection payload surfaces it).

## Design invariants check (`/design-invariants`)

| Invariant | Status | Note |
|-----------|--------|------|
| **INV-1** event-sourcing integrity | ✓ | All changes are read-side or in-memory measurement. Counters are NOT events; they are aggregates with a getter. No payload mutation. |
| **INV-2** facade equivalence | ✓ | CLI facade (Item 4) gets the same defaulting behavior because flag-parsed args flow through the same `deriveCorrelationFilters` helper. |
| **INV-3** basileus-forward | n/a | No cross-tier mediation introduced. AsyncLocalStorage is local-process. |
| **INV-4** platform-agnosticity | ✓ | Item 4 covers MCP and CLI surfaces symmetrically. Runbook documents both. |
| **INV-5a** input ergonomics | ✓ | Item 2 IS the input-ergonomics improvement. Explicit-wins preserves caller intent. |
| **INV-5b** spec-aligned output | ✓ | `exarchos_view describe` already surfaces the three filter fields; Item 2 default is documented in field description. |
| **INV-5c** Aspire-inspired verbs | n/a | No new verbs introduced. |
| **INV-5d** action discriminator | ✓ | CLI flags are kebab-case of arg keys (no new discriminator surface). |
| **INV-6** workflow-agnosticism | ✓ | Skills/playbooks unchanged. |

## Axiom design constraints (`/axiom:design`)

| Dimension | Application |
|-----------|-------------|
| **DIM-1** correctness | Item 2 explicit-args-win rule, test-pinned (3 paths: none-supplied-no-ctx, none-supplied-with-ctx, any-supplied-with-ctx). |
| **DIM-2** observability | Item 5 IS the DIM-2 fix. Both counters exposed via stats getters; debug logs on the ctx-default branch. |
| **DIM-3** context economy | Single `deriveCorrelationFilters` helper replaces 6 inline spread blocks. Runbook is skimmable (what/when/how structure, not narrative). |
| **DIM-4** operational resilience | Counters are simple integers, no overflow concern at production rates. AsyncLocalStorage failure mode = no default (degrades gracefully). |
| **DIM-5** dependency direction | Helper colocated with `ViewQueryFilters`; no new cross-module edges. |
| **DIM-6** SOLID compliance | Single responsibility for `deriveCorrelationFilters`; open for extension (additional default sources) without modifying handlers. |
| **DIM-7** reproducibility / determinism | Runbook examples must be runnable verbatim. CLI flags deterministic from arg names. |
| **DIM-8** test integrity | Item 3 closes the T17 substrate-only hole. Per-item unit tests cover the explicit-wins rule and the bypass-counter assertion. |

## Acceptance criteria

- [ ] **Item 2:** Calling any of the 6 filter-aware view actions inside `runWithDispatchContext(ctx, ...)` with no filter args returns events scoped to `ctx.correlationId`. Passing any explicit filter arg disables the default.
- [ ] **Item 3:** T17 either drives through a production auto-dispatch handler OR documents (with a code reference) why such a handler does not exist; in the latter case, T17's inline TODO is updated with a permanent justification.
- [ ] **Item 4:** `docs/runbooks/correlation-filters.md` exists with the four required sections. `exarchos view telemetry --correlation-id cor-x` filters telemetry correctly end-to-end. README has a link to the runbook.
- [ ] **Item 5:** `SqliteBackend.getStats()` exposes `correlationFilteredQueries`. `ViewMaterializer.getStats()` returns `cacheBypasses`. Counters increment in the integration paths.

## Out of scope

- #1446 (10 other view actions in `TOOL_REGISTRY`) — separately tracked.
- Cross-tier correlation propagation (basileus / remote MCP) — INV-3 deferred.
- Filter-aware materializer cache keying (rejected in #1447 design for INV-1 reasons).
- SSE / push subscriptions for filtered streams (#1440 Opp 5).
