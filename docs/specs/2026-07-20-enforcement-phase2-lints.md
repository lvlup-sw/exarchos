# Spec: Enforcement phase 2 — error-envelope lint + vocabulary-lint registry scope

**Date:** 2026-07-20 · **Feature:** `enforcement-phase2-lints` · **Depth:** standard
**Inputs:** epic #1701 (debloat + structural enforcement), issue #1706 (enforcement phase 2 remainder), `docs/specs/2026-07-17-wave-s-enforcement-substrate-traceability.md` (the filtered-gate convention), `docs/guides/ci-gate-hosting.md` (two-surface hosting rule)

> One unified artifact: `## Requirements` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Load-bearing invariants from `.exarchos/invariants.md`, anchored before the requirements:

- **INV-5b — output-contract** *(always-load)* — the primary anchor. Public actions return the structured `ToolResult` envelope; the error-envelope lint enforces that the *failure* half of that contract (`error.code` + structured fields) survives instead of degrading to `INTERNAL_ERROR` at the dispatch safety net.
- **INV-17 — response-economy** *(reference-only, audit)* — the agent-facing payoff: a real `code` + `suggestedFix`/`unmetGates`/`validTargets` is actionable; a generic `INTERNAL_ERROR` string is not.
- **INV-2 — facade-equivalence** *(always-load, audit)* — both facades (`adapters/cli.ts`, `adapters/mcp.ts`) already normalize throws into an envelope; the lint keeps handler error behavior equivalent *upstream* of the facades so neither has to paper over a lost code.
- **INV-4 — platform-agnosticity** *(reference-only, `mode: check`)* — the sole machine-checked entry today; the precedent for "executable invariant as a blocking gate." Both new lints are new machine checks in that spirit.

The **vocabulary-lint** is the catalog's own enforcement arm (the catalog header names it as a consumer); extending its corpus to `registry.ts` action metadata is meta-enforcement of the whole INV-* vocabulary across one more agent-facing surface.

## Design & Rationale

### Problem Statement

Two documented enforcement disciplines from the §7.5 roadmap are not yet live gates. #1706 is the remainder after Wave S; recon against `main@30831d05` collapsed its scope in two ways:

1. **Error-envelope discipline is unenforced.** Public MCP action handlers are supposed to return a structured `ToolResult` failure (`success:false`, a meaningful `error.code`, and fields like `suggestedFix` / `unmetGates` / `validTargets`). But a handler can also just `throw`, and the dispatch safety net (`core/dispatch.ts:1084-1092`) flattens *any* escaped throw into a generic `{ code: 'INTERNAL_ERROR', message }`. Nothing crashes — but the meaningful code and structured fields are **silently discarded**, so the agent on the other end gets an un-actionable `INTERNAL_ERROR` instead of `MERGE_CONFLICT` + a `suggestedFix`. This is a quality/fidelity gate (INV-5b output-contract, INV-17 response-economy), not a crash-safety gate.

2. **Vocabulary-lint no longer covers every agent-facing normative surface.** Wave S already wired `npm run lint:invariants` onto the **unfiltered** `grep-gates` lane (`ci.yml:848`) over the four `.md` surfaces (`docs/architecture`, `docs/guides`, `skills-src`, `commands`). The "blocked until S decides where a filtered gate lives" premise in #1706 is therefore **stale** — the wiring shipped. What remains is that MCP **action names and descriptions** in `registry.ts` are agent-facing normative text that can cite `INV-*` / `DIM-*` vocabulary, yet the scanner is `.md`-only + line-regex (`vocabulary-lint.ts:133,158`) and never reads them. A stale invariant reference in an action description escapes the gate.

Both convert already-documented discipline into a machine-checked gate that ratchets rather than erodes.

### Chosen Approach

**Error-envelope lint (DR-1..DR-3):** a `typescript-eslint`-backed AST rule — the tool is already a dependency and there is a `no-restricted-syntax` precedent (`eslint.config.js:42-61`). The boundary the lint enforces (a `throw` that *escapes a public action-handler's own function scope*) has no purely-syntactic marker, so it needs AST scope analysis that a regex gate cannot do cleanly; and adding `ts-morph` would introduce an analysis dependency the repo deliberately avoids. The rule is hosted on the **unfiltered `grep-gates`** lane per the two-surface rule (`ci-gate-hosting.md:19-28`), because its scan surface (`orchestrate/**` ⊂ `mcp`) and its implementation (the eslint config) are not both subsets of one path filter — so `test-root`, where eslint runs today (`ci.yml:114`), would skip-as-passed on the PRs it exists to police.

**Vocabulary-lint registry scope (DR-4..DR-5):** extend the *corpus*, not the file walk. A structured extractor pulls only the `{name, description}` string values from the registry and feeds them through the existing token check, so the `INV-*`/`DIM-*` regex never fires on code or comments. No new CI wiring — it rides the step already at `ci.yml:848`.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: A registered action handler returns `ToolResult.error`, never lets a throw escape its own scope

A public MCP action handler owns its failure contract. A domain failure (invalid input, unmet gate, merge conflict, missing workflow) is returned as a `ToolResult` with `success:false` and a meaningful `error.code` — not raised as an exception that the dispatch safety net flattens to `INTERNAL_ERROR`. The lint enforces this at the handler-function boundary; deep helpers may still throw (the handler is expected to catch and convert them).

**Acceptance criteria:**
- A registered action handler whose body allows a `throw` to reach the function's top level (a throw not caught by an enclosing `try` within that same function) fails the gate, reported as `file:line` + a "return `ToolResult.error`, not a raw throw" message.
- Given a PR that adds a new escaping throw to a handler, When CI runs, Then `grep-gates` fails on that PR.
- The gate does **not** flag the enumerable exemption classes in DR-3 (deep-helper throws, converted local `try/catch`, `AbortError` cancellation, fail-loud `ctx` guards).

### DR-2: Mechanism is a typescript-eslint AST rule on the unfiltered lane, self-tested both directions

The rule reuses the installed `typescript-eslint` toolchain (no new runtime dependency, no `ts-morph`) and identifies handlers by their structural contract (a function resolving to `ToolResult` / `Promise<ToolResult>`) or, failing that, a curated handler-module scope (see Open Questions). It is wired as a step in the **unfiltered** `grep-gates` job so it is covered by `ci-gate.needs` and cannot skip-as-passed.

**Acceptance criteria:**
- The rule adds no new package to `package-lock.json` beyond what `typescript-eslint`/`eslint` already provide.
- A fixture self-test (`.test.sh` or a checked-in fixture pair) asserts **both** directions — a violating handler fails, a compliant handler passes — and runs on the same unfiltered host.
- `scripts/check-enforcer-wiring.mjs` recognizes the new gate as wired (its manifest walk passes), so the gate cannot be silently unwired later.

### DR-3: Existing violations are measured, then fix-clean or bounded-baseline — never assumed zero

The true violation count under DR-1's boundary is unknown until the selector is fixed (recon found ~94 raw throws in `orchestrate/**`, but most are legitimate helpers / re-throws / cancellation / guards). The design must not assume a clean tree, and must not let a baseline mask new debt.

**Acceptance criteria:**
- The real violation set under DR-1 is enumerated before the gate flips blocking.
- If the count is small (heuristic ≤ ~10), the handlers are fixed to return coded envelopes and the gate ships with an **empty allowlist** (fully blocking).
- Otherwise a baseline allowlist (handler- or `file:line`-keyed) ships with a tracked expiry and a **no-growth ratchet** (the `scripts/audit/cycle-baseline.json` no-mask pattern), plus a burn-down follow-up issue. A **new** violation blocks from day one regardless of the baseline.
- Each exemption class (`AbortError`/cancellation, `ctx`/required-context fail-loud guards, throws converted inside a local `try/catch`) is declared in the rule config with a one-line rationale, not left implicit.

### DR-4: Vocabulary-lint scans registry action names + descriptions against the catalog

MCP action `name` and `description` strings are agent-facing normative text on par with `skills-src/` and `commands/`. Any `INV-*` / `DIM-*` token they cite must resolve to a live entry in `.exarchos/invariants.md`, on the same gate that already polices the four markdown surfaces.

**Acceptance criteria:**
- The vocabulary lint scans every registered action's `name` + `description` for `INV-*` / `DIM-*` tokens and flags any absent from the catalog.
- The existing four `.md` surfaces and the `DATED_RECORD_TREES` exclusions (`vocabulary-lint.ts:188`) are unchanged.
- Given an action description citing a non-existent `INV-99`, When `npm run lint:invariants` runs, Then it reports the token with a `registry.ts`/action locator and exits non-zero.
- No new CI wiring is added — the extension runs under the existing unfiltered step (`ci.yml:848`).

### DR-5: The registry corpus is extracted structurally and fails closed

The scanner is `.md`-only and line-based (`vocabulary-lint.ts:133,158`); relaxing the file filter to read `registry.ts` raw would fire the token regex on code, comments, and unrelated string literals. The extension pulls only the action metadata strings.

**Acceptance criteria:**
- The extension enumerates `{name, description}` from the registry structure (importing the exported registry, or AST-extracting those string literals) and feeds **only** those strings through the existing token check — it does **not** relax the `.md` walk for general TS source.
- If the registry cannot be loaded or parsed, the lint **fails closed** (non-zero exit) rather than silently reporting zero findings.
- Findings carry a stable locator (the action `name`, and `registry.ts:line` where resolvable).

## Technical Design

**Handler surface (DR-1/DR-2).** Handlers funnel through `composite.ts` — the `ACTION_HANDLERS` map (`composite.ts:386`, invoked at `:748`) plus six special-cased branches (`describe`/`doctor`/`onboard`/`invariants_scaffold`/`invariants_add`/`runbook`, `:639-715`). None is wrapped in a `try/catch` today; the only catch is the outer `core/dispatch.ts:1084`. The rule's structural marker is the handler contract itself — a function whose resolved return type is `ToolResult` / `Promise<ToolResult>` — which is precise and needs no naming convention, at the cost of type-aware linting (`parserOptions.project`). A `no-restricted-syntax`-style selector then flags a `ThrowStatement` at the function's top level (not enclosed by a local `try`), minus the DR-3 exemptions. The fallback if type-aware cost is unacceptable on the lane: a curated glob of the handler-hosting modules.

**Vocabulary corpus (DR-4/DR-5).** Add `scanRegistryActions()` to `vocabulary-lint.ts`: import the composite registry, flatten `CompositeTool.actions[]` to `{name, description}`, and reuse the existing `scanFileWithKnown` token logic over those strings. `vocabulary-lint-cli.ts` calls it alongside `scanRepoDefaults()`. This keeps one code path for the token/catalog check and one exit-code contract.

## Integration Points

- `eslint.config.js` — new rule block scoped to the handler surface; the "no general ESLint" comment gains a carve-out rationale (a single targeted correctness gate ≠ general style linting).
- `.github/workflows/ci.yml` — a new eslint step (e.g. `lint:envelopes`) on the **unfiltered** `grep-gates` job; the existing filtered `test-root` eslint step (`:114`, Windows-portability rules) is left as-is or the envelope rule is invoked via its own script to keep hosts separate.
- `scripts/check-error-envelope.test.sh` (or fixture pair) — both-direction + fail-closed self-test on the unfiltered host.
- `scripts/enforcer-wiring-manifest.json` + `scripts/check-enforcer-wiring.mjs` — register the new gate so the meta-gate proves it is wired.
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` — `scanRegistryActions()`; `vocabulary-lint-cli.ts` — call it; `vocabulary-lint.test.ts` — co-located coverage.

## Alternatives considered

- **Zero-dep regex script (`scripts/check-*.mjs`) for the error-envelope gate** — matches the entrenched wave-1 pattern, but regex cannot distinguish an escaping handler throw from a deep-helper throw, a converted re-throw, an `AbortError`, or a `ctx` guard, so it would need a lossy allowlist that erodes the signal. Rejected for imprecision.
- **`ts-morph` script** — full AST without ESLint, but adds an analysis dependency the repo deliberately avoids (it shells out to depcruise/knip instead). Rejected on supply-chain/maintenance cost for one gate.
- **A per-handler `withEnvelope` runtime wrapper instead of a lint** — a wrapper cannot invent a meaningful `error.code`, and `dispatch.ts:1084` already prevents crashes, so it adds nothing for *fidelity*. Only the handler returning a coded envelope fixes the problem — which is exactly what the lint drives. Rejected as a non-substitute.
- **Relaxing vocabulary-lint's `.md` gate to scan `registry.ts` raw** — fires the token regex on code and comments (false positives). Rejected in favor of structured extraction.

## Open Questions

- **Handler-surface marker (DR-2):** type-aware return-type selection vs a curated handler-module glob. Resolve during `/plan` with a spike measuring the `parserOptions.project` cost on `grep-gates`; prefer type-aware if the added lane time is acceptable.
- **Existing-violation count (DR-3):** enumerated during implementation once the selector is chosen; drives the fix-clean vs bounded-baseline branch.
- **Scan action `name` as well as `description` (DR-4):** names are short identifiers unlikely to carry INV tokens, but including them is cheap and complete — default to including both unless it produces noise.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above. A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design — both sub-features (error-envelope lint; vocabulary-lint registry scope).
**Excluded:** None. The two Open Questions (handler-surface marker; existing-violation count) are resolved *within* tasks 001/003 rather than deferred — the error-envelope rule is itself the census instrument.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Handler returns `ToolResult.error`, no throw escapes its scope | 001, 003 |
| DR-2 | typescript-eslint AST rule on the unfiltered lane + self-test | 001, 002 |
| DR-3 | Existing violations measured, then fix-clean or bounded baseline | 001, 003 |
| DR-4 | Vocabulary-lint scans registry action names + descriptions | 004, 005 |
| DR-5 | Registry corpus extracted structurally, fails closed | 004 |

### Tasks

Two independent tracks run in parallel worktrees: **A** (error-envelope lint) and **B** (vocabulary-lint scope). Tests are judged test-after by adequacy; the error-envelope rule *is* the violation census, so no separate spike task.

### Task 001: Error-envelope eslint rule + config block

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-2, DR-3
**Files:**
- `eslint.config.js` (new rule block scoped to the handler surface; carve-out rationale on the "no general ESLint" comment)
- `eslint-rules/no-handler-throw.js` (new — a local rule if a `no-restricted-syntax` selector cannot express "throw escapes a `ToolResult`-returning function scope"; otherwise inline the selector and omit this file)
- `eslint-rules/__fixtures__/handler-throw.violating.ts`, `eslint-rules/__fixtures__/handler-throw.compliant.ts` (new fixture pair)
- `eslint-rules/no-handler-throw.test.js` (new)
**Verification:** medium — fixture pair asserts both directions (a handler that lets a throw escape fails; a compliant handler passes); `check_test_adequacy` kill-probe proves the rule test can fail. Resolves the handler-surface Open Question (type-aware return-type selection vs curated glob) and records the enumerated exemption classes (`AbortError`, `ctx` guards, converted local `try/catch`) inline in the rule config. Running the rule yields the DR-3 violation census.
**Dependencies:** None
**Parallelizable:** Yes (Track A head; runs alongside 004)

### Task 002: Wire the rule onto the unfiltered grep-gates lane + self-test

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-2
**Files:**
- `package.json` (new `lint:envelopes` script invoking eslint with the envelope rule)
- `.github/workflows/ci.yml` (new step under the unfiltered `grep-gates` deps-tail — NOT the filtered `test-root` eslint step)
- `scripts/check-error-envelope.test.sh` (new — both-direction + fail-closed self-test on the unfiltered host)
- `scripts/enforcer-wiring-manifest.json` (register the new gate so `check-enforcer-wiring.mjs` proves it is wired)
**Verification:** medium — the self-test drives the real rule (a violating fixture must fail the step, a compliant tree must pass); `check-enforcer-wiring` meta-gate must recognize the wiring. Confirm the step rides `grep-gates` (already in `ci-gate.needs`) so it cannot skip-as-passed.
**Dependencies:** 001
**Parallelizable:** Yes (with 003, 005 — disjoint files)

### Task 003: Disposition existing handler violations (fix-clean or bounded baseline)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-3
**Files:**
- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` (and sibling handler modules the census flags — edited to return coded `ToolResult.error` envelopes)
- `scripts/audit/error-envelope-baseline.json` (new — only if the census exceeds the fix-clean heuristic, ~10; carries an expiry + no-growth ratchet)
- co-located `*.test.ts` for any handler whose error path changes
**Verification:** medium — with the rule from 001 green, the tree is clean (empty allowlist) or the baseline ratchet forbids growth; tests pin the corrected `error.code` for any edited handler. If a baseline ships, a burn-down follow-up issue is filed and the allowlist carries an expiry. New violations block regardless.
**Dependencies:** 001
**Parallelizable:** Yes (with 002, 005 — disjoint files)

### Task 004: scanRegistryActions() structured extractor + fail-closed

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-4, DR-5
**Files:**
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` (new `scanRegistryActions()` — enumerate `{name, description}` from the registry, reuse the existing token check; fail closed if the registry cannot be loaded/parsed)
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.test.ts` (co-located coverage)
**Verification:** medium — unit test asserts an action description citing a bogus `INV-99` is flagged, a valid `INV-1` is not, the four `.md` surfaces + `DATED_RECORD_TREES` exclusions are unchanged, and an unloadable registry exits non-zero; `check_test_adequacy` kill-probe. The `.md` walk gate is NOT relaxed for general TS source.
**Dependencies:** None
**Parallelizable:** Yes (Track B head; runs alongside 001)

### Task 005: Call scanRegistryActions() from the CLI; confirm existing CI coverage

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/src/architecture/vocabulary-lint-cli.ts` (call the new scan alongside `scanRepoDefaults()`, share the exit-code contract)
**Verification:** low — static (typecheck) plus a confirmation that `npm run lint:invariants` now surfaces registry findings and that the existing unfiltered step (`ci.yml:848`) exercises it — no new CI wiring is added.
**Dependencies:** 004
**Parallelizable:** Yes (with 002, 003 — disjoint files)

### Parallelization

- **Critical path:** 001 → 003 (implement the rule, then clean the tree it flags) — depth 2.
- **Wave 1 (parallel):** 001 (Track A), 004 (Track B).
- **Wave 2 (parallel):** 002, 003 (Track A, after 001), 005 (Track B, after 004). All wave-2 tasks touch disjoint files.

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document (no forward-dangling references)
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium-tier tasks carry adequacy-judged tests (test-after); low-tier task (005) leans on static analysis
- [ ] Open questions are resolved within tasks (001 handler marker + census; 003 disposition branch) — none left dangling
- [ ] Ready for `plan-review`
