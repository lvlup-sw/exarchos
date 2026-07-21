# Spec: Enforcement phase 2 — error-envelope lint + vocabulary-lint registry scope

**Date:** 2026-07-20 · **Feature:** `enforcement-phase2-lints` · **Depth:** standard
**Inputs:** epic #1701 (debloat + structural enforcement), issue #1706 (enforcement phase 2 remainder), `docs/specs/2026-07-17-wave-s-enforcement-substrate-traceability.md` (the filtered-gate convention), `docs/guides/ci-gate-hosting.md` (two-surface hosting rule)

> One unified artifact: `## Requirements` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.
> Revision 1 (2026-07-20): converged after a refuting plan-review — mechanism committed (custom `@typescript-eslint` rule in a dedicated config, hosted via a `lint-*.mjs` wrapper); handler identification pinned to the registration set; extractor made cycle-safe + testable.

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

2. **Vocabulary-lint no longer covers every agent-facing normative surface.** Wave S already wired `npm run lint:invariants` onto the **unfiltered** `grep-gates` lane (`ci.yml:848`) over the four `.md` surfaces (`docs/architecture`, `docs/guides`, `skills-src`, `commands`). The "blocked until S decides where a filtered gate lives" premise in #1706 is therefore **stale** — the wiring shipped. What remains is that MCP **action names and descriptions** across the composite tools (`registry.ts`) are agent-facing normative text that can cite `INV-*` / `DIM-*` vocabulary, yet the scanner is `.md`-only + line-regex (`vocabulary-lint.ts:133,158`) and never reads them. A stale invariant reference in an action description escapes the gate.

Both convert already-documented discipline into a machine-checked gate that ratchets rather than erodes.

### Chosen Approach

**Error-envelope lint (DR-1..DR-3):** a **custom `@typescript-eslint` rule** (`eslint-rules/no-handler-throw.js`). The toolchain is already a dependency, but the enforced boundary needs *type-aware scope analysis* a `no-restricted-syntax` selector cannot express, and `ts-morph` would add an analysis dependency the repo avoids. The rule identifies handlers **by the registration set** — the functions referenced by the `ACTION_HANDLERS` map plus the six special-cased branch functions in `composite.ts` — *not* by a "returns `ToolResult`" heuristic, which would over-select the exempt deep helpers that also return `ToolResult` and are permitted to throw. It lives in a **dedicated `eslint.envelopes.config.js`** invoked *only* through `scripts/lint-envelopes.mjs`; it is never added to the shared `eslint.config.js`, so the filtered `test-root` `lint:windows` step (`ci.yml:114`) can neither load the rule nor be silently converted into a type-checked run. The wrapper runs on the **unfiltered `grep-gates`** lane (two-surface rule, `ci-gate-hosting.md:19-28`), scoped to `orchestrate/**` so the type-aware cost stays bounded (avoiding the #1721 whole-tree OOM class).

**Vocabulary-lint registry scope (DR-4..DR-5):** extend the *corpus*, not the file walk. A structured extractor enumerates the `{name, description}` strings from every exported composite tool and feeds them through a factored-out text-scan core, so the `INV-*`/`DIM-*` regex never fires on code or comments. No new CI wiring — it rides the step already at `ci.yml:848`.

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: A registered action handler returns `ToolResult.error`, never lets a throw abnormally complete it

A public MCP action handler owns its failure contract. A domain failure (invalid input, unmet gate, merge conflict, missing workflow) is returned as a `ToolResult` with `success:false` and a meaningful `error.code` — not raised as an exception that the dispatch safety net flattens to `INTERNAL_ERROR`. The rule enforces this only on the **registration set** (the `ACTION_HANDLERS` values + the six `composite.ts` branch functions); deep helpers may still throw (the handler is expected to catch and convert them).

**Acceptance criteria:**
- A registered handler that can **abnormally complete via a `throw`** fails the gate — where "abnormally complete" means a `throw` at the function's top level **or** a `throw` inside a `catch` clause that is not itself re-caught, and **excludes** a `throw` whose enclosing `try` has a `catch` that returns a `ToolResult`. Reported as `file:line` + a "return `ToolResult.error`, not a raw throw" message.
- Given a PR that adds a new abnormally-completing throw to a registered handler, When CI runs, Then `grep-gates` fails on that PR.
- The gate does **not** flag the enumerable exemption classes in DR-3 (throws in non-handler helper functions; a `try` whose `catch` returns a `ToolResult`; `AbortError`/cancellation; fail-loud precondition guards).

### DR-2: A custom `@typescript-eslint` rule in a dedicated config, hosted via a `lint-*.mjs` wrapper on the unfiltered lane

The rule is a custom `@typescript-eslint` rule (no new runtime dependency) resolving the handler set from the registration references — precise, not a return-type heuristic. It lives in `eslint.envelopes.config.js` and is invoked only by `scripts/lint-envelopes.mjs`, wired as a step in the **unfiltered** `grep-gates` job so it is covered by `ci-gate.needs`, cannot skip-as-passed, and never loads into the filtered `test-root` run.

**Acceptance criteria:**
- Adds no new package to `package-lock.json` beyond what `typescript-eslint`/`eslint` already provide.
- The rule lives in **`eslint.envelopes.config.js`** (NOT the shared `eslint.config.js`) and is applied only via `--config` from `scripts/lint-envelopes.mjs`; a test confirms `lint:windows` (test-root) neither loads the rule nor is converted to a type-aware run.
- The gate is hosted as a **`scripts/lint-envelopes.mjs` primary** (the shape `scripts/check-enforcer-wiring.mjs`'s manifest walker recognizes) plus a `scripts/lint-envelopes.test.sh` self-test asserting **both** directions (a violating fixture fails, a compliant tree passes) on the unfiltered host; the enforcer-wiring manifest entry keys on that primary so the gate cannot be silently unwired.
- The step rides `grep-gates` (already in `ci-gate.needs`); a `parserOptions.project` scoped to `orchestrate/**` keeps the type-aware run bounded.

### DR-3: The handler-scoped violation set is measured, then fix-clean or bounded-baseline — never assumed zero

The rule *is* the census, but only over the **registration set** — not the raw ~94 throws in `orchestrate/**` (most of which are exempt deep helpers, `throw err` re-throws, cancellation, and guards; e.g. all 8 throws in `execute-merge.ts` are helper re-throws and are **not** counted). The design must not assume a clean tree, and must not let a baseline mask new debt.

**Acceptance criteria:**
- The violation set is the rule's output over the registration set (deep-helper throws are exempt and uncounted), enumerated before the gate flips blocking.
- If the count is small (heuristic ≤ ~10), the flagged handlers are fixed to return coded envelopes and the gate ships with an **empty allowlist** (fully blocking).
- Otherwise a baseline allowlist (handler- or `file:line`-keyed) ships with a tracked expiry and a **no-growth ratchet** (the `scripts/audit/cycle-baseline.json` no-mask pattern), plus a burn-down follow-up issue. A **new** violation blocks from day one regardless of the baseline.
- Each exemption class (`AbortError`/cancellation, fail-loud precondition guards, a `try` whose `catch` returns a `ToolResult`) is declared in the rule with a one-line rationale, not left implicit.

### DR-4: Vocabulary-lint scans every composite tool's action names + descriptions against the catalog

MCP action `name` and `description` strings are agent-facing normative text on par with `skills-src/` and `commands/`. Any `INV-*` / `DIM-*` token they cite must resolve to a live entry in `.exarchos/invariants.md`, on the same gate that already polices the four markdown surfaces.

**Acceptance criteria:**
- The vocabulary lint scans the `name` + `description` of every action across **all exported composite tools** (`exarchos_workflow` / `_event` / `_orchestrate` / `_view`) for `INV-*` / `DIM-*` tokens and flags any absent from the catalog.
- The existing four `.md` surfaces and the `DATED_RECORD_TREES` exclusions (`vocabulary-lint.ts:188`) are unchanged.
- Given an action description citing a non-existent `INV-99`, When `npm run lint:invariants` runs, Then it reports the token with a `registry.ts`/action locator and exits non-zero.
- No new CI wiring is added — the extension runs under the existing unfiltered step (`ci.yml:848`).

### DR-5: The registry corpus is extracted cycle-safely, fails closed, and is unit-testable

The scanner is `.md`-only and line-based (`vocabulary-lint.ts:133,158`); relaxing the file filter to read `registry.ts` raw would fire the token regex on code and comments. The extension pulls only the action metadata strings, and does so without adding a static import edge or an untestable failure path.

**Acceptance criteria:**
- The extractor reads `{name, description}` via an **injectable loader seam** (default = a lazy `import()` of the registry; tests inject a throwing/malformed loader) — so the fail-closed path is unit-testable and the registry is parsed only at lint-time, not at `vocabulary-lint` module-load. (Acyclicity holds independently: `registry.ts` has no import path back to `vocabulary-lint.ts`, so no cycle forms either way — the seam is for testability + lazy load, **not** cycle avoidance; the cruiser counts dynamic `import()` the same as static.)
- It feeds only those strings through a **factored-out `scanText(text, locator, knownIds)` core** (extracted from the file-IO-bound, unexported `scanFileWithKnown`); the `.md` walk is **not** relaxed for general TS source, and the file-path scanners keep their behavior.
- If the loader throws or the registry is malformed, the lint **fails closed** (non-zero exit), asserted by a unit test.
- Findings carry a stable locator (the action `name`; `registry.ts` where resolvable).

## Technical Design

**Handler surface + rule (DR-1/DR-2/DR-3).** Handlers funnel through `composite.ts` — the `ACTION_HANDLERS` map (`composite.ts:386`, invoked at `:748`) plus six special-cased branches (`describe`/`doctor`/`onboard`/`invariants_scaffold`/`invariants_add`/`runbook`, `:639-715`). None is wrapped in a `try/catch`; the only catch is the outer `core/dispatch.ts:1084`. The custom rule resolves the handler set from those registration references (the map's value identifiers + the branch call targets) — a closed, precise set that a return-type selector would blow past (adapters, `envelopeWrap`, and the deep helpers that also return `ToolResult` and are *allowed* to throw). For each handler function it walks the body and flags a `throw` that can abnormally complete it (top-level, or a `catch`-clause throw not re-caught), minus the DR-3 exemptions; a `try` whose `catch` returns a `ToolResult` is compliant. Type resolution uses `parserOptions.project` scoped to `orchestrate/**` only, bounding cost. The rule ships in `eslint.envelopes.config.js`, applied via `scripts/lint-envelopes.mjs` (`node` wrapper that spawns `eslint --config eslint.envelopes.config.js "servers/exarchos-mcp/src/orchestrate/**/*.ts"`) — the `lint-*.mjs` shape the enforcer-wiring walker models — never the shared `eslint.config.js`.

**Vocabulary corpus (DR-4/DR-5).** Factor the token loop of `scanFileWithKnown` (`vocabulary-lint.ts:83-112`) into `scanText(text, locator, knownIds)`; the existing file scanners call it with file contents, and a new `scanRegistryActions(loader = () => import(registry))` calls it with each action's `name`/`description`. `scanRegistryActions` enumerates every exported `CompositeTool.actions[]`, uses a lazy `import()` behind an injectable loader (fail-closed + unit-testable; the registry is parsed only at lint-time, not at library module-load), and returns findings tagged to the action. `vocabulary-lint-cli.ts` calls it alongside `scanRepoDefaults()`, sharing the exit-code contract.

## Integration Points

- `eslint.envelopes.config.js` (new, dedicated) + `eslint-rules/no-handler-throw.js` (new custom rule) — the shared `eslint.config.js` is left untouched (only a carve-out comment noting the separate envelope config).
- `scripts/lint-envelopes.mjs` (new wrapper primary) + `scripts/lint-envelopes.test.sh` (new self-test) + `package.json` (`lint:envelopes` → `node scripts/lint-envelopes.mjs`).
- `.github/workflows/ci.yml` — new step on the unfiltered `grep-gates` deps-tail running `node scripts/lint-envelopes.mjs`.
- `scripts/enforcer-wiring-manifest.json` — register the `scripts/lint-envelopes.mjs` primary so `check-enforcer-wiring.mjs` proves it is wired.
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` — factor `scanText()`, add `scanRegistryActions()`; `vocabulary-lint-cli.ts` — call it; `vocabulary-lint.test.ts` — co-located coverage.

## Alternatives considered

- **Zero-dep regex script for the error-envelope gate** — regex cannot distinguish an abnormally-completing handler throw from a deep-helper throw, a converted re-throw, an `AbortError`, or a guard, so it would need a lossy allowlist that erodes the signal. Rejected for imprecision.
- **A rule block in the shared `eslint.config.js` (return-type-scoped)** — flat-config applies any matching block regardless of invoker, so `lint:windows` in the filtered `test-root` would also evaluate it (and, if type-aware, be silently converted to a type-checked run hitting the #1721 OOM class); and "returns `ToolResult`" over-selects the exempt deep helpers. Rejected — hence the dedicated config + registration-set identification.
- **`ts-morph` script** — full AST without ESLint, but adds an analysis dependency the repo deliberately avoids. Rejected on supply-chain/maintenance cost for one gate.
- **A per-handler `withEnvelope` runtime wrapper instead of a lint** — a wrapper cannot invent a meaningful `error.code`, and `dispatch.ts:1084` already prevents crashes, so it adds nothing for *fidelity*. Rejected as a non-substitute.
- **Relaxing vocabulary-lint's `.md` gate to scan `registry.ts` raw** — fires the token regex on code and comments. Rejected in favor of structured extraction.
- **A static top-level `import` of the registry into `vocabulary-lint.ts`** — would parse the ~4,159-line registry at `vocabulary-lint` module-load (paid by every importer) and makes the fail-closed path untestable. Rejected for a lazy `import()` behind an injectable loader seam. (This is a load-time + testability choice, **not** a cycle-gate one — the repo's cruiser counts dynamic `import()` the same as static; acyclicity holds here regardless because `registry.ts` never imports `vocabulary-lint.ts`.)

## Open Questions

- **Existing-violation count (DR-3):** the handler-scoped census is unknown until the rule runs in Task 001; it drives the fix-clean vs bounded-baseline branch in Task 003 (resolved within implementation, not deferred).
- **Scan action `name` as well as `description` (DR-4):** names are short identifiers unlikely to carry INV tokens, but including them is cheap and complete — default to including both unless it produces noise.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above. A task with no DR-N is a coverage gap; a DR-N with no task is unimplemented — both are flagged by `check_plan_coverage`.

### Scope

**Target:** Full design — both sub-features (error-envelope lint; vocabulary-lint registry scope).
**Excluded:** None. The one remaining Open Question (handler-scoped violation count) is resolved *within* tasks 001/003 — the rule is its own census instrument.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Handler returns `ToolResult.error`, no throw abnormally completes it | 001, 003 |
| DR-2 | Custom rule in a dedicated config, `lint-*.mjs` wrapper on the unfiltered lane | 001, 002 |
| DR-3 | Handler-scoped violation set measured, then fix-clean or bounded baseline | 001, 003 |
| DR-4 | Vocabulary-lint scans every composite tool's action names + descriptions | 004, 005 |
| DR-5 | Registry corpus extracted cycle-safely, fails closed, unit-testable | 004 |

### Tasks

Two independent tracks run in parallel worktrees: **A** (error-envelope lint) and **B** (vocabulary-lint scope). Tests are judged test-after by adequacy; the error-envelope rule *is* the violation census, so no separate spike task.

### Task 001: Custom no-handler-throw rule + dedicated envelope config

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-2, DR-3
**Files:**
- `eslint-rules/no-handler-throw.js` (new — custom `@typescript-eslint` rule: resolve the `ACTION_HANDLERS` + branch-function handler set, flag abnormally-completing throws, encode the exemption classes)
- `eslint.envelopes.config.js` (new — dedicated config applying the rule to `orchestrate/**` with a scoped `parserOptions.project`)
- `eslint-rules/__fixtures__/handler-throw.violating.ts`, `eslint-rules/__fixtures__/handler-throw.compliant.ts` (new fixture pair, incl. a catch-clause re-throw case and an exempt-helper case)
- `eslint-rules/no-handler-throw.test.js` (new)
**Verification:** medium — fixture pair asserts both directions (an abnormally-completing handler throw fails; a compliant handler and an exempt helper pass); `check_test_adequacy` kill-probe proves the rule test can fail. Running the rule yields the DR-3 handler-scoped census. The rule must NOT be added to the shared `eslint.config.js`.
**Dependencies:** None
**Parallelizable:** Yes (Track A head; runs alongside 004)

### Task 002: lint-envelopes.mjs wrapper + grep-gates wiring + enforcer-wiring manifest + self-test

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-2
**Files:**
- `scripts/lint-envelopes.mjs` (new — node wrapper spawning `eslint --config eslint.envelopes.config.js` over the handler surface)
- `package.json` (`lint:envelopes` → `node scripts/lint-envelopes.mjs`)
- `.github/workflows/ci.yml` (new step under the unfiltered `grep-gates` deps-tail — NOT the filtered `test-root` eslint step)
- `scripts/lint-envelopes.test.sh` (new — both-direction + fail-closed self-test on the unfiltered host)
- `scripts/enforcer-wiring-manifest.json` (register the `lint-envelopes.mjs` primary)
**Verification:** medium — the self-test drives the real wrapper (a violating fixture fails the step, a compliant tree passes); `check-enforcer-wiring` recognizes the `lint-*.mjs` primary; a check confirms `lint:windows`/`test-root` does not load the envelope rule. Confirm the step rides `grep-gates` (already in `ci-gate.needs`).
**Dependencies:** 001
**Parallelizable:** Yes (with 003, 005 — disjoint files)

### Task 003: Disposition the handler-scoped violations (fix-clean or bounded baseline)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-3
**Files:**
- the registered-handler modules flagged by Task 001's census (determined at run time — deep helpers such as `execute-merge.ts` are exempt and out of scope) — edited to return coded `ToolResult.error` envelopes
- `scripts/audit/error-envelope-baseline.json` (new — only if the census exceeds the fix-clean heuristic, ~10; carries an expiry + no-growth ratchet)
- co-located `*.test.ts` for any handler whose error path changes
**Verification:** medium — with the rule from 001 green, the tree is clean (empty allowlist) or the baseline ratchet forbids growth; tests pin the corrected `error.code` for any edited handler. If a baseline ships, a burn-down follow-up issue is filed and the allowlist carries an expiry. New violations block regardless.
**Dependencies:** 001
**Parallelizable:** Yes (with 002, 005 — disjoint files)

### Task 004: scanText() core + scanRegistryActions() cycle-safe extractor

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-4, DR-5
**Files:**
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` (factor `scanText(text, locator, knownIds)` from `scanFileWithKnown`; add `scanRegistryActions(loader)` — enumerate every exported `CompositeTool.actions[]` via a dynamic `import()` behind an injectable loader; fail closed on loader throw / malformed registry)
- `servers/exarchos-mcp/src/architecture/vocabulary-lint.test.ts` (co-located coverage)
**Verification:** medium — unit tests: an action description citing a bogus `INV-99` is flagged; a valid `INV-1` is not; the four `.md` surfaces + `DATED_RECORD_TREES` exclusions and the file-path scanners are unchanged; an injected throwing/malformed loader exits non-zero (fail-closed). `check_test_adequacy` kill-probe. The `.md` walk gate is NOT relaxed for general TS source; no static registry import edge is added.
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
- [ ] Open questions are resolved within tasks (001 census; 003 disposition branch) — none left dangling
- [ ] Ready for `plan-review`
