# Spec: Coverage-gated test-mass consolidation (debloat wave 3b)

**Date:** 2026-07-18 · **Feature:** `test-mass-consolidation` · **Depth:** deep
**Inputs:** epic #1701 (debloat + structural enforcement) · issue #1705 (wave 3b) · parent spec `docs/specs/2026-07-15-debloat-wave1-structural-enforcement.md` · coverage/mutation substrate PR #1719 (`c78450c7`, on `origin/main`)

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Design & Rationale

### Problem Statement

The exarchos-debloat audit named wave 3b "the largest LoC lever": seven units are tested from **two locations** — a legacy `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/<subject>.test.ts` copy and a co-located `src/<area>/<subject>.test.ts` copy — and proposed consolidating the duplication away.

Reconnaissance against the live tree (HEAD `2f4c0e23`) corrects the premise. All seven pairs still exist, but **they are not duplicates — they have diverged**, and the larger side flips per subject:

| Subject | legacy `__tests__/` | co-located | larger |
|---|---|---|---|
| state-machine | 3338 | 876 | legacy 4× |
| tools | 3387 | 817 (+9 split files) | legacy |
| state-store | 1544 | 1213 | legacy |
| compensation | 1166 | 1663 | co-located |
| guards | 762 | 1247 | co-located |
| views/handlers | 793 | 1979 | co-located 2.5× |
| event-store schemas | 1006 | 4702 | co-located |

There is therefore **no blanket "delete the legacy copy" rule** — each suite asserts behaviors the other does not. The reducible mass is only the *provably-identical* subset, not the raw ~9K lines these legacy files hold. The durable defect is **structural**: the same unit tested in two places that drift apart, so a fix to one silently leaves the other stale. That two-location divergence is the bug class to remove; LoC reduction is a bounded secondary outcome, promised honestly rather than to the audit's optimistic figure.

Because two suites can cover the *same source lines* while asserting *different behaviors*, coverage non-regression alone cannot prove a consolidation is safe — delete one copy, coverage stays green, and an invariant's sole assertion backstop vanishes unseen. Choosing an oracle strong enough to see assertion loss is the crux of this design.

### Chosen Approach

**Union-preserving consolidation to a single canonical (co-located) location, proven safe by construction and confirmed by two oracles.** For each of the seven pairs: parse both suites into a case inventory, merge every legacy case into the co-located file as additive `describe` blocks, and delete a legacy case **only** when it is normalized-AST identical to a case already present. Nothing is dropped by human judgment. The blocking coverage ratchet from #1719 is the CI safety net (a regression means a real assertion was lost, not a baseline to lower); a source-targeted StrykerJS spot-check per pair is the advisory oracle that actually sees assertion loss on overlapping lines. Keep-classes (parity, race, property, characterization, acceptance) are out of scope and protected — they are the mechanical backstops for INV-2 and INV-7. The structural win is then ratcheted with a lightweight CI guard so the two-location pattern cannot re-appear.

### Requirements (DR-N)

The DR-N identifiers below are the single source the decomposition traces against.

#### DR-1: Single canonical location per subject

Each of the seven subjects is tested from exactly one canonical location — the co-located `src/<area>/<subject>.test.ts` — and its legacy `src/__tests__/{workflow,views,event-store}/<subject>.test.ts` twin is retired. This eliminates the two-location divergence hazard by construction and matches the repo's co-located-tests convention (CLAUDE.md).

**Acceptance criteria:**
- After the campaign, no subject among the seven has both a `src/__tests__/…` file and a co-located file; `git ls-files 'servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/*.test.ts'` for the seven subjects returns empty.
- The rest of `src/__tests__/` (`integration/`, `benchmarks/`, `skills/`, `stack/`, `sync/`, `tasks/`, `utils/`) is **untouched** — out of scope for this campaign.
- The full server suite (`npm run test:run` in `servers/exarchos-mcp`) is green after each pair's consolidation.

#### DR-2: Union preservation by construction (no silent assertion loss)

Every `it()`/`test()` case in a retired legacy suite is either present in the canonical suite after the merge, or removed **only** because it is provably identical (normalized-AST equal, same effective inputs and assertions) to a case already there. No case is dropped by eyeball judgment.

**Acceptance criteria:**
- Each pair produces a machine-checkable **case manifest** mapping every legacy case → `merged` | `dedup-identical(<matching case ref>)`.
- A `dedup-identical` entry must pass a normalized-AST equality check against its named match (whitespace/comment/quote-style-insensitive; import-path rewrites excluded from the body hash).
- Cases that differ only in `describe`/`it` title but assert differently are classified `merged`, never `dedup-identical` (edge case: title collision ≠ behavior equality).
- The reviewer signs off on the manifest, not the raw line diff.

#### DR-3: Coverage non-regression floor (blocking CI net)

The blocking coverage ratchet on `origin/main` (#1719 — lines 91.6 / statements 91.6 / functions 96.24 / branches 85.38, epsilon floored at 0.1pp, fail-closed) stays green across every consolidation merge. Consolidation is coverage-neutral by design; a regression is treated as a lost sole-exerciser test to restore, **never** as a baseline to lower.

**Acceptance criteria:**
- Each per-pair merge passes `scripts/check-coverage-ratchet.mjs` (blocking, no `--observe`) against the committed `coverage-baseline.json`.
- `coverage-baseline.json` is **not** re-lowered by this campaign; if a metric regresses, coverage is restored before merge.
- Fail-closed behavior is preserved: a missing/unparseable `coverage-summary.json` or baseline still exits 2.

#### DR-4: Advisory mutation spot-check per pair (assertion-loss oracle)

Because coverage is line-level and blind to assertion loss when two suites overlap on the same lines, each consolidated pair is spot-checked with a **source-targeted** StrykerJS run over the module(s) the pair exercises, comparing the merged suite's mutant kill-set against a pre-consolidation capture. Advisory (non-blocking), per the chosen posture and the #1720 constraint.

**Acceptance criteria:**
- For each pair, capture the kill-set of (legacy ∪ co-located) over the covered source module(s) **before** consolidation, and of the merged suite **after**; any newly-surviving mutant is triaged (restore a test, or record why acceptable) and reported in that pair's PR body.
- The spot-check invokes `stryker-adapter.mjs` with an explicit `--mutate <source-module globs>` — **not** the diff-scoped CI mutation gate, which sees zero changed `src/**` files on a test-only diff and would silently skip.
- Runs are scoped per source module to sidestep the #1720 full-suite dry-run breakage; if a module's Stryker run cannot complete, the pair falls back to a documented manual assertion-parity review (advisory gate degrades, does not block).

#### DR-5: Keep-classes are out of scope and protected

Parity (26 files), race (5), property (4 named / 46 fast-check), characterization (6), and acceptance (9) suites are not consolidation targets and must remain untouched — they are the mechanical backstops for INV-2 (facade equivalence), INV-7 (substrate serialization), and behavioral characterization.

**Acceptance criteria:**
- The campaign's total changed-file set intersected with the keep-class globs is empty.
- Co-located keep-class files adjacent to targets (`state-machine.property.test.ts`, `tools.update.race.test.ts`, `state-store` acceptance suites, the shared `src/__tests__/parity-harness.ts`) are explicitly listed in a pre-flight protected-file inventory and are neither moved nor deleted.
- If any retired legacy file imports the shared `parity-harness.ts`, the harness is retained and importers re-pointed (edge case: harness deletion would break out-of-scope parity suites).

#### DR-6: Substrate-backstop preservation (invariant tie-through)

For pairs whose suites are the sole or primary mechanical backstop of a substrate invariant, the consolidated suite must retain the specific asserting cases: **INV-1** (state-store, event-store schemas — reducer/projection purity and schema validation) and **INV-8** (compensation, guards — the `withSession({operationId})` idempotent-retry cases, which INV-8 declares its *only* deterministic backstop). These pairs are stamped high risk-tier and the DR-4 mutation spot-check is **mandatory**, not advisory-optional, for them.

**Acceptance criteria:**
- The INV-8 idempotency/retry cases and the INV-1 reducer/projection/schema-validation cases appear in the merged suite and are listed as `retained` in that pair's DR-4 kill-set comparison.
- A pair touching an INV-1/INV-8 backstop cannot merge without a completed (non-skipped) mutation spot-check on the covered module.

#### DR-7: Per-pair isolation with serialized coverage verification

Each pair is an independent unit of work (one worktree, per the audit's "one worktree per suite pair"), but integration merges are **single-writer serialized** so the blocking coverage ratchet runs against a coherent cumulative state — parallel merges could each pass in isolation yet mask a combined regression.

**Acceptance criteria:**
- Pairs consolidate concurrently in isolated worktrees; merges into the integration branch go through the single-writer merge lease (`serialize_merge`), never parallel.
- The coverage ratchet runs **per merge**, not once at campaign end.

#### DR-8: Base-dependency guard (fail before dispatch on a stale base)

The campaign requires the #1719 coverage substrate on its base. Dispatching on a base that lacks it (e.g., the current local `main` at `2f4c0e23`, one commit behind `origin/main`) would silently run the entire campaign with the safety net absent.

**Acceptance criteria:**
- A pre-dispatch check asserts `servers/exarchos-mcp/coverage-baseline.json` and `scripts/check-coverage-ratchet.mjs` exist on the base ref (base ≥ `c78450c7` / `origin/main`); it aborts with a clear message otherwise.
- Delegation worktrees base on `origin/main` (or a later integration branch that includes #1719), not local HEAD.

### Technical Design

**Case-inventory tool (ts-morph).** A campaign-scoped script parses a suite file into an inventory of cases: `{ describePath, title, normalizedBodyHash, sourceRange }`. Normalization strips comments/whitespace/quote-style and canonicalizes import specifiers so a case moved from `__tests__/workflow/x.test.ts` (imports `../../workflow/x`) to co-located `src/workflow/x.test.ts` (imports `./x`) hashes equal when its body is otherwise unchanged. The identical-set is the intersection of `(title, normalizedBodyHash)`; everything else is `merged`. ts-morph is already the repo's chosen AST tool (referenced by #1706's error-envelope lint).

**Merge mechanics.** The move is mostly mechanical: append the legacy file's non-identical `describe` blocks into the co-located file, rewrite import paths, reconcile shared setup/fixtures (hoist duplicated `beforeEach` into one). Where both suites define the same fixture differently, keep both under distinct names rather than picking one (union, not choice).

**Oracles.** Coverage: `npm run test:coverage` (server) emits `coverage/coverage-summary.json` (json-summary reporter, added by #1719) → `check-coverage-ratchet.mjs` vs committed baseline. Mutation: `stryker-adapter.mjs --mutate servers/exarchos-mcp/src/<area>/<subject>.ts` per pair, kill-set captured before/after.

**Ratchet the win.** Add a `grep-gates`-class CI check (no `npm ci` needed) that fails if a `src/__tests__/{workflow,views,event-store}/<subject>.test.ts` re-appears for a consolidated subject — so the structural gain cannot silently erode, consistent with the epic's enforcement-ratchet posture.

### Integration Points

- `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/*.test.ts` (the 7 legacy twins) — **retired**.
- `servers/exarchos-mcp/src/{workflow,views,event-store}/*.test.ts` (7 canonical targets) — **receive** merged cases.
- `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared harness; verify importers before touching, retain.
- `servers/exarchos-mcp/coverage-baseline.json`, `scripts/check-coverage-ratchet.mjs` — the blocking floor (enforced, unchanged).
- `servers/exarchos-mcp/scripts/stryker-adapter.mjs`, `servers/exarchos-mcp/stryker.conf.mjs` — invoked with explicit per-module globs for the spot-check.
- `servers/exarchos-mcp/vitest.config.ts` — coverage `exclude` already lists `src/__tests__/**`; retiring those files needs no config change.
- `.github/workflows/ci.yml` (`grep-gates` job) — new duplicate-location guard.
- New: `scripts/audit/consolidate-suite.mjs` (or similar) — the ts-morph case-inventory + manifest generator.

### Exploration

Three approaches were weighed against the divergence finding and the coverage-blindness problem (the divergent loop; no `/exarchos:discover` pass was needed — the design is grounded by in-repo reconnaissance rather than external research):

- **Option A — coverage-gated deletion** (the audit's literal framing): merge unique cases by eye, delete the legacy copy, rely on the blocking coverage ratchet plus a reviewer pass. Largest LoC reduction, fastest. **Rejected as primary:** coverage is line-level; two diverged suites routinely cover the *same* source lines while asserting different things, so a dropped assertion leaves coverage green — the exact silent-backstop-loss failure the Constraints warn against.
- **Option B — mutation-anchored gate**: make "merged kill-set ≥ union of both originals' kill-sets" a hard per-pair gate. Strongest oracle. **Rejected as the gate, retained as DR-4's advisory spot-check:** the mutation gate is observe-mode and #1720 (full-suite Stryker dry-run failure) is open; worse, the diff-scoped CI gate mutates *source*, so a test-only consolidation diff changes no `src/**` file and the gate skips entirely. Mutation must be run manually, source-targeted, per module — which is powerful confirmation but cannot serve as an automated blocking gate today.
- **Option C — union-by-construction + coverage floor + mutation spot-check** (**chosen**): never silently drop a case; delete only AST-provable duplicates; coverage ratchet as the blocking CI net; source-targeted mutation as the advisory per-pair oracle. Bounded/honest LoC, lowest risk, and it removes the divergence *class* (with a CI guard so it stays removed) rather than chasing a line count. Selected via the `deep`-rung decision points (scope + oracle).

### Alternatives considered

- **Keep both locations (status quo):** rejected — that *is* the divergence bug.
- **Delete legacy wholesale, keep co-located:** rejected — for state-machine/tools/state-store the legacy suite asserts *more*, so this drops real coverage.
- **Retire the entire legacy `__tests__/` tree (incl. integration/benchmarks/etc.):** rejected/deferred — those are single-location suites, not divergence pairs; out of scope for wave 3b.
- **Top-20 large-suite minimization (the audit's stretch tier):** deferred — it touches non-duplicate single-location suites (registry, prepare-delegation, build-skills) whose safety argument is weaker; revisit after the pair campaign proves the method.

### Open Questions

- **Duplicate-location CI guard — this campaign or a follow-up?** Proposed as part of DR-1's ratchet (a small `grep-gates` check). If it balloons, split to a follow-up issue. *(Resolves at plan decomposition.)*
- **Exact per-module mutation-scoping list for DR-4** — the covered-module set per pair is enumerated at plan/delegate time from each pair's imports. *(Deferred to Decomposition.)*
- **Pair ordering** — recommend piloting the smallest INV-8 pair (guards) and the most asymmetric pair (state-machine) first to validate the tool + oracle before the full fan-out. *(Resolves in Decomposition parallelization.)*
