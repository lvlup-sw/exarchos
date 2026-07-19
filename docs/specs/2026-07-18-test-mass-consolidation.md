# Spec: Coverage-gated test-mass consolidation (debloat wave 3b)

**Date:** 2026-07-18 · **Feature:** `test-mass-consolidation` · **Depth:** deep
**Inputs:** epic #1701 (debloat + structural enforcement) · issue #1705 (wave 3b) · parent spec `docs/specs/2026-07-15-debloat-wave1-structural-enforcement.md` · coverage/mutation substrate PR #1719 (`c78450c7`, on `origin/main`)
**Revision:** rev.1 — reworked the safety spine after a 3-voter adversarial plan-review refuted rev.0 (no blocking oracle for assertion loss; coverage union-blind; mutation non-functional + inverted; 15 pairs not 7).

> One unified artifact: `## Requirements` holds the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Anchored to `.exarchos/invariants.md` (dev catalog enabled). Test mass is unusual as a design target because **the tests are themselves the mechanical backstops for substrate invariants**, so several named "keep classes" map directly to invariants:

- **INV-2 (facade-equivalence):** the parity-harness tests are the proof CLI≡MCP → parity suites are **out of consolidation scope**.
- **INV-1 (event-sourcing-integrity):** reducers/projections are pure left-folds → the state-store and event-store-schema suites are targets *and* INV-1 backstops; every reducer/projection/schema assertion must survive.
- **INV-8 (idempotency-at-the-boundary):** the `withSession({operationId})` retry tests are its **sole deterministic backstop** (declared `mode: audit` precisely because no grep can prove it) → the compensation and guards suites carry these; the retry/idempotency assertions must survive intact.
- **INV-7 (substrate-serialization):** the two-tier concurrency guarantee is proven by the race suites (a keep-class) → race suites are **out of scope**.

The through-line, hardened after review: coverage non-regression is necessary but **blind to assertion loss** — and because line coverage is a *union*, a dropped case whose source line is still exercised by any other suite (or an untouched keep-class) is invisible to it *permanently*, not just at merge time. Coverage therefore cannot be the assertion-loss guarantee. The guarantee must be **deterministic and by-construction** (the AST manifest gate, DR-2); coverage and mutation are backstops, not the primary net.

## Design & Rationale

### Problem Statement

The exarchos-debloat audit named wave 3b "the largest LoC lever": units tested from **two locations** — a legacy `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/<subject>.test.ts` copy and a co-located `src/<area>/<subject>.test.ts` copy — should be consolidated.

Reconnaissance against the live tree corrects the premise twice over:

1. **The pairs are diverged, not duplicated.** All named pairs exist in both locations, but line counts differ in both directions and the larger side flips per subject — so there is no blanket "delete the legacy copy" rule; each side asserts behaviors the other does not.
2. **There are 15 duplicate-location pairs, not 7.** Beyond the 7 the audit named, eight more diverged same-basename cross-location pairs exist: `workflow/{checkpoint, migration, schemas}`, `views/{materializer, pipeline-view, snapshot-store, task-detail-view}`, `event-store/tools`.

The seven highest-value pairs (largest legacy mass and/or substrate-invariant backstops) are the **active scope**; the other eight are inventoried and deferred to a fast-follow (below), not silently omitted.

| Active-scope subject | legacy `__tests__/` | co-located | larger |
|---|---|---|---|
| state-machine | 3338 | 876 | legacy 4× |
| tools | 3387 | 817 (+8 split files) | legacy |
| state-store | 1544 (+resolve 36) | 1213 | legacy |
| compensation | 1166 | 1663 | co-located |
| guards | 762 | 1247 | co-located |
| views/handlers | 793 (+error-paths 116) | 1979 | co-located 2.5× |
| event-store schemas | 1006 | 4702 (+onboard 196) | co-located |

The durable defect is **structural**: the same unit tested in two places that drift apart. LoC reduction is a bounded secondary outcome, not the headline.

### Chosen Approach

**Union-preserving consolidation to a single canonical (co-located) location, guaranteed by a deterministic blocking manifest gate, with coverage and mutation as backstops.** For each pair, a ts-morph tool builds a per-case manifest: every legacy `it()`/`test()` case is classified `moved` (relocated verbatim, only imports rewritten) or `dedup-identical` (removed only because an identical case — normalized body **and** enclosing `beforeEach`/fixture context — already exists in the canonical target). The manifest gate **blocks** on any unaccounted case or any unproven `dedup-identical`, so assertion loss is impossible **by construction** — it does not depend on coverage seeing the loss or mutation running. The blocking coverage ratchet from #1719 is a union-limited backstop (catches accidental source deletion and the rare last-exerciser drop); a functional, source-targeted StrykerJS spot-check is an **advisory** confirmation keyed to merge volume. Keep-classes are protected. The structural win is ratcheted with a CI guard that forbids a legacy twin for **any** co-located subject, carrying an expiring allowlist for the eight deferred pairs so no new divergence can appear and the known eight are tracked, not tolerated silently. Chosen via the `deep`-rung decision points (scope = the 7 highest-value pairs; oracle = manifest-gate-primary + coverage backstop + advisory mutation).

## Requirements

The DR-N identifiers below are the single source the decomposition traces against.

### DR-1: Single canonical location, with an honest global anti-divergence ratchet

The seven active-scope subjects each end tested from one canonical co-located location; their legacy twins are retired. A CI ratchet guard then forbids a legacy `__tests__/{workflow,views,event-store}/<basename>.test.ts` twin for **any** co-located subject — not only the seven — carrying an **expiring allowlist** naming the eight deferred pairs, so no *new* two-location divergence can appear and the eight known ones are explicitly tracked.

**Acceptance criteria:**
- After the campaign, none of the seven subjects has both a `src/__tests__/…` and a co-located file.
- The check is a real basename-intersection script (the Task 012 guard), not a brace-glob `git ls-files` (git pathspec does not brace-expand, so that form is vacuously green) — it enumerates basenames present in both locations and fails on any not in the allowlist.
- After the seven land, the allowlist contains exactly the eight deferred pairs; removing a pair from the allowlist without consolidating it fails CI.
- The full server suite (`npm run test:run` in `servers/exarchos-mcp`) is green after each pair.

### DR-2: Union preservation enforced by a blocking manifest gate (the primary guarantee)

The primary safety guarantee is deterministic and by-construction, not oracle-dependent. A per-pair manifest classifies every legacy case as `moved` (verbatim body, only import specifiers rewritten) or `dedup-identical` (removed only because a case with identical normalized body **and** identical enclosing hook/fixture context already exists in the canonical target). The manifest gate **blocks** the pair on any legacy case that is unaccounted or whose `dedup-identical` claim fails the machine identity check. No case is dropped by human judgment, and no assertion can be silently lost.

**Acceptance criteria:**
- The manifest gate is **blocking** (a pair cannot merge with an unaccounted or unproven case).
- Every legacy case appears exactly once in the manifest as `moved` or `dedup-identical(<matching case ref>)`.
- The identity check for `dedup-identical` is whitespace/comment/quote-style-insensitive over the case body **and** its enclosing `describe` hook/fixture scope (`beforeEach`/`beforeAll`/shared fixture declarations); import-path rewrites are excluded from the hash. Body-identical cases under differing fixture context are classified `moved`, never `dedup-identical` (edge case that rev.0 missed).
- Cases differing only in `describe`/`it` title but asserting differently are `moved`, never `dedup-identical`.

### DR-3: Coverage non-regression backstop (blocking, explicitly union-limited)

The blocking coverage ratchet on `origin/main` (#1719 — lines 91.6 / statements 91.6 / functions 96.24 / branches 85.38, epsilon floored at 0.1pp, fail-closed) runs per merge. It is a **backstop, not the assertion-loss guarantee**: line coverage is a union, so a dropped assertion on a line still exercised by another suite or a keep-class is invisible to it. Its real value is catching accidental source deletion and the rare case where the last exerciser of a line is dropped.

**Acceptance criteria:**
- Each per-pair merge passes `scripts/check-coverage-ratchet.mjs` (blocking, no `--observe`) against the committed `coverage-baseline.json`; the baseline is never lowered to accommodate a consolidation.
- Fail-closed behavior is preserved (missing/unparseable summary or baseline → exit 2).
- The spec and reviews treat a green ratchet as necessary-not-sufficient; the DR-2 manifest gate is the assertion-loss authority.

### DR-4: Functional advisory mutation confirmation, keyed to merge volume

A source-targeted StrykerJS spot-check confirms assertion preservation where coverage is weakest — the highest merge-volume retirements. It is **advisory** (the DR-2 manifest gate is the block) and requires the `stryker-adapter.mjs` interface to actually support per-module targeting, which it does not today (it parses only `--since`, and an unknown `--mutate` arg falls through to the #1720-broken full-tree run).

**Acceptance criteria:**
- `stryker-adapter.mjs` is extended with an explicit `--mutate <globs>` passthrough (Task 004) that scopes mutation to named source modules, bypassing the `--since` diff path (a test-only diff has no changed source and yields an empty mutatable surface).
- For each pair whose retired legacy suite is ≥1000 lines or larger than its co-located target (state-machine, tools, state-store, compensation, event-store schemas) **and** the two INV-backstop pairs (guards, compensation, state-store, schemas), capture the mutant kill-set over the covered module before and after; any newly-surviving mutant is triaged (restore a test or record why acceptable) and reported in the pair's PR.
- The spot-check is advisory: it never blocks a merge (consistent with #1720 keeping mutation observe-mode). If a module's Stryker run cannot complete, the pair records the degradation and relies on the DR-2 manifest gate + a manual assertion-parity note.

### DR-5: Keep-classes are out of scope and protected

Parity (26 files), race (5), property (4 named / 45 fast-check), characterization (5), and acceptance (9) suites are not consolidation targets and must remain untouched — they are the mechanical backstops for INV-2, INV-7, and behavioral characterization.

**Acceptance criteria:**
- The campaign's total changed-file set intersected with the keep-class globs is empty.
- Co-located keep-class files adjacent to targets (`state-machine.property.test.ts`, `tools.update.race.test.ts`, the state-store acceptance suites, the shared `src/__tests__/parity-harness.ts`) are in a pre-flight protected-file inventory and are neither moved nor deleted.
- If any retired legacy file imports the shared `parity-harness.ts`, the harness is retained and importers re-pointed.

### DR-6: Substrate-backstop preservation via the uniform manifest gate

Because the DR-2 manifest gate is **uniform across all seven pairs**, the INV-1 (state-store, event-store schemas — reducer/projection purity, schema validation) and INV-8 (compensation, guards — `withSession({operationId})` idempotent-retry) backstop assertions receive the same by-construction protection as everything else — with no reliance on invariant-keyed mutation (which rev.0 wrongly made the sole protection, leaving the largest non-INV retirements weaker). The INV pairs additionally receive the DR-4 advisory mutation as extra confirmation.

**Acceptance criteria:**
- The INV-8 idempotent-retry cases and INV-1 reducer/projection/schema-validation cases are classified `moved` (never `dedup-dropped`) in their pair's manifest, and named in the pair's report.
- Oracle strength is not keyed to invariant membership: the manifest gate protects all pairs equally; advisory mutation covers the highest-volume pairs regardless of INV status.

### DR-7: Serialized merges via manual `git merge --no-ff` (capability-aware)

Integration merges are single-writer serialized so the blocking coverage ratchet runs per merge against a coherent cumulative state. Serialization gives merge-ordering coherence; it does **not** make coverage see assertion loss (that is DR-2's job).

**Acceptance criteria:**
- Merges into the integration branch are sequential. The primary mechanism is a manual `git merge --no-ff` from the integration worktree, because `serialize_merge` returns `CAPABILITY_DENIED` on this environment's read-only tier; `serialize_merge` is used where the capability is granted.
- The coverage ratchet (DR-3) runs on each merge, not once at campaign end.
- Single-writer discipline is an orchestrator responsibility, verified at closeout (DR-1/Task 013).

### DR-8: Base-substrate preflight (a delegate-phase gate, not an orphan script)

The campaign requires the #1719 coverage substrate on its base. Local `main` (`2f4c0e23`) lacks it; `origin/main` (`c78450c7`) has it. The check must gate **dispatch**, so it runs as a delegate-phase preflight before each wave, not as a script authored mid-campaign with no consumer.

**Acceptance criteria:**
- The delegate phase runs the Task 003 preflight before dispatching any wave; the seven pair tasks declare a dependency on Task 003 so it is built and passing first.
- The preflight asserts `servers/exarchos-mcp/coverage-baseline.json` and `scripts/check-coverage-ratchet.mjs` exist on the base ref and aborts dispatch with a clear message otherwise.
- Pair worktrees base on `origin/main` (≥ `c78450c7`) or a later integration branch that includes #1719, not local HEAD.

## Technical Design

**Manifest tool (ts-morph) — the blocking gate.** `scripts/audit/consolidate-suite.mjs` parses a suite into cases: `{ describePath, title, bodyHash, fixtureHash }`, where `bodyHash` normalizes comments/whitespace/quote-style and canonicalizes import specifiers, and `fixtureHash` covers the enclosing `describe` hook/fixture scope. A legacy case is `dedup-identical` only if a canonical case matches on `(title, bodyHash, fixtureHash)`; otherwise `moved`. The tool emits the manifest and exits non-zero if any legacy case is unaccounted — this exit code is the blocking gate wired into each pair's verification. ts-morph is already the repo's AST tool (referenced by #1706).

**Mutation adapter extension.** `stryker-adapter.mjs` today parses only `--since=<base>`. Task 004 adds a `--mutate <globs>` passthrough that sets Stryker's `mutate` to the named modules and skips the `--since` diff computation, so a per-module kill-set can be captured on a test-only change (which otherwise has an empty mutatable surface). Stryker stays advisory (`thresholds.break` unset; #1720 keeps CI mutation observe-mode).

**Ratchet guard.** `scripts/audit/check-no-duplicate-suites.mjs` enumerates basenames present under both `src/__tests__/{workflow,views,event-store}/` and the co-located `src/<area>/`, and fails on any not in an expiring allowlist. It runs in the `grep-gates` CI job (no `npm ci`). The allowlist starts with all 15 pairs, shrinks to the 8 deferred as the 7 land, and each entry carries an expiry.

**Oracles, in priority order.** (1) DR-2 manifest gate — blocking, deterministic. (2) DR-3 coverage ratchet — blocking backstop, union-limited. (3) DR-4 mutation — advisory, volume-keyed, functional via the adapter extension.

## Integration Points

- `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/*.test.ts` (7 active legacy twins + `state-store-resolve.test.ts`, `views/tools-error-paths.test.ts`) — **retired** into canonical targets.
- `servers/exarchos-mcp/src/{workflow,views,event-store}/*.test.ts` (7 canonical targets) — **receive** moved cases.
- `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared harness; verify importers, retain.
- `servers/exarchos-mcp/coverage-baseline.json`, `scripts/check-coverage-ratchet.mjs` — blocking backstop (enforced, unchanged).
- `servers/exarchos-mcp/scripts/stryker-adapter.mjs`, `stryker.conf.mjs` — **extended** with `--mutate` (Task 004).
- `.github/workflows/ci.yml` (`grep-gates` job) — new duplicate-location ratchet guard.
- New: `scripts/audit/consolidate-suite.mjs` (manifest gate), `scripts/audit/check-no-duplicate-suites.mjs` (ratchet), `scripts/audit/check-base-substrate.mjs` (preflight).

## Exploration

Three approaches were weighed against the divergence finding and the coverage-blindness problem (the divergent loop; no `/exarchos:discover` pass was needed — grounded by in-repo reconnaissance). The rev.0 → rev.1 rework is itself a product of a 3-voter adversarial plan-review that refuted the first cut.

- **Option A — coverage-gated deletion** (the audit's literal framing): rejected — coverage is line-level *and* union-blind; a dropped assertion on a still-covered line is permanently invisible.
- **Option B — mutation-anchored gate**: rejected as the gate — mutation is observe-mode (#1720), the adapter needs a `--mutate` extension to run per-module at all, and even functional it is probabilistic. Retained as DR-4's advisory confirmation.
- **Option C — deterministic manifest gate + coverage backstop + advisory mutation** (**chosen**): the blocking guarantee is a by-construction AST manifest (nothing dropped but provable duplicates, fixture context included), so assertion loss is impossible independent of the probabilistic oracles; coverage and mutation are defense-in-depth. This is what survived the redesign the panel forced.

## Alternatives considered

- **Keep both locations (status quo):** rejected — that *is* the divergence bug.
- **Delete legacy wholesale, keep co-located:** rejected — for state-machine/tools/state-store the legacy suite asserts *more*.
- **Consolidate all 15 pairs in this wave:** deferred, not rejected — the 8 additional pairs (`workflow/{checkpoint,migration,schemas}`, `views/{materializer,pipeline-view,snapshot-store,task-detail-view}`, `event-store/tools`) are smaller and non-substrate-critical; they become **wave 3b-2** once the method is proven on the 7, and are held from divergence by the DR-1 guard's expiring allowlist in the meantime.
- **Top-20 large-suite minimization (audit stretch tier):** deferred — touches non-duplicate single-location suites; revisit after the pair campaign.

## Open Questions

- **Scope: 7 now vs all 15.** Rev.1 keeps the user's bounded 7-pair scope and defers the other 8 (allowlisted, tracked). Expanding to 15 in one wave is a viable alternative if preferred — same method, larger fan-out. *(For the approval checkpoint.)*
- **Per-module mutation scoping list (DR-4):** the covered-module set per pair is enumerated at delegate time from each pair's imports (recorded in the pilot tasks first).
- **Deferred-pairs follow-up issue:** file wave 3b-2 for the 8 deferred pairs at closeout (Task 013).

## Decomposition

The decomposition maps every task to one or more DR-N from `## Requirements` above.

### Scope

**Target:** The 7 highest-value duplicate-location pairs + enabling tooling/guards. **Excluded (deferred, tracked):** the 8 other duplicate-location pairs → wave 3b-2 (held from divergence by the DR-1 allowlist); top-20 large-suite minimization; the non-pair `src/__tests__/` subdirs.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Single canonical location + global ratchet guard | 005, 006, 007, 008, 009, 010, 011, 012, 013 |
| DR-2 | Blocking manifest gate (primary guarantee) | 001, 005, 006, 007, 008, 009, 010, 011 |
| DR-3 | Coverage non-regression backstop | 005, 006, 007, 008, 009, 010, 011, 013 |
| DR-4 | Functional advisory mutation (volume-keyed) | 004, 005, 006, 007, 008, 009, 010, 011 |
| DR-5 | Keep-classes protected | 002, 005, 006, 007, 008, 009, 010, 011 |
| DR-6 | Substrate-backstop preservation | 001, 005, 008, 009, 011 |
| DR-7 | Serialized merges (capability-aware) | 013 |
| DR-8 | Base-substrate preflight | 003 |

### Tasks

Each task carries a `riskTier` stamp selecting its verification depth. Consolidation tasks are unusual: the test suite *is* the deliverable, so their verification is "blocking manifest gate + coverage ≥ baseline + advisory mutation," not a new test file.

### Task 001: Manifest tool — the blocking union-preservation gate (ts-morph)

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-2, DR-6
**Files:**
- `scripts/audit/consolidate-suite.mjs`
- `scripts/audit/consolidate-suite.test.ts`
**Verification:** high — this tool is the primary blocking guarantee for union preservation: it proves every legacy case is `moved` verbatim or `dedup-identical` before any deletion, so no asserted behavior is silently lost by construction. Its identity check hashes the case body **and** the enclosing `beforeEach`/fixture context. Scoped unit tests over crafted case pairs (identical, title-collision-but-divergent-body, identical-body-but-divergent-fixture, import-path-only-diff), the `check_test_adequacy` kill-probe, and an integration run over one real pair. A false `dedup-identical` — an invisible assertion loss — is the campaign's core risk, so the identity check is adversarially tested.
**Dependencies:** None
**Parallelizable:** No (foundation — every pair task consumes it)

### Task 002: Keep-class protected-file inventory + pre-flight guard

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5
**Files:**
- `scripts/audit/protected-suites.json`
- `scripts/audit/check-protected.mjs`
- `scripts/audit/check-protected.test.ts`
**Verification:** medium — scoped test asserting the guard flags a change-set intersecting a keep-class glob and passes a clean one; the checked-in inventory is generated from the live keep-class globs (parity/race/property/characterization/acceptance) plus the named adjacent files.
**Dependencies:** None
**Parallelizable:** Yes

### Task 003: Base-substrate preflight (delegate-phase dispatch gate)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-8
**Files:**
- `scripts/audit/check-base-substrate.mjs`
- `scripts/audit/check-base-substrate.test.ts`
**Verification:** medium — asserts the #1719 substrate (`coverage-baseline.json` + `check-coverage-ratchet.mjs`) is present on the base and aborts dispatch when absent (local `2f4c0e23` is the negative fixture). The delegate phase runs this before each wave; the pair tasks depend on it so it is built and passing before dispatch — closing the "fail before dispatch" intent that an orphan script cannot enforce.
**Dependencies:** None
**Parallelizable:** Yes

### Task 004: Extend stryker-adapter with explicit `--mutate` module targeting

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-4
**Files:**
- `servers/exarchos-mcp/scripts/stryker-adapter.mjs`
- `servers/exarchos-mcp/scripts/stryker-adapter.test.ts`
**Verification:** medium — the adapter today parses only `--since`; add a `--mutate <globs>` passthrough that scopes Stryker's `mutate` to named source modules and skips the diff path, so a per-module mutation kill-set can be captured on a test-only change (which has an empty mutatable surface under `--since`). Scoped test asserting `--mutate` sets the module glob and does not fall through to the full-tree run. Mutation stays advisory (`thresholds.break` unset).
**Dependencies:** None
**Parallelizable:** Yes

### Task 005: Consolidate `guards` pair (INV-8 pilot)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-6
**Files:**
- `servers/exarchos-mcp/src/workflow/guards.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts` (retired)
**Verification:** high — blocking manifest gate (every legacy case `moved`/`dedup-identical`); merged suite green; coverage non-regression backstop ≥ baseline (blocking); advisory mutation spot-check over `workflow/guards.ts` for substrate-backstop preservation of the invariant INV-8 (idempotent-retry cases classified `moved`). Pilot: smallest INV-8 pair, validates the tool + oracles end-to-end.
**Dependencies:** 001, 002, 003, 004
**Parallelizable:** Yes (pilot group)

### Task 006: Consolidate `state-machine` pair (asymmetry + high-volume pilot)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5
**Files:**
- `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts` (retired)
**Verification:** high — blocking manifest gate; merged suite green; coverage non-regression backstop ≥ baseline; advisory mutation over `workflow/state-machine.ts`. Pilot: legacy asserts 4× the co-located suite (3338→876) — the highest merge-volume, highest false-dedup surface — so it is a mandatory-to-run advisory mutation target. Must not touch adjacent `state-machine.property.test.ts` (keep-class). Note: a large multi-hour merge, not a 2–5-minute task; granularity is one-pair-per-task (cannot sub-split without file conflict).
**Dependencies:** 001, 002, 003, 004
**Parallelizable:** Yes (pilot group)

### Task 007: Consolidate `tools` (workflow) pair

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5
**Files:**
- `servers/exarchos-mcp/src/workflow/tools.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (retired)
**Verification:** high — blocking manifest gate run against both the co-located `tools.test.ts` **and** the eight `tools.*.test.ts` split files (a case already in a split file is `dedup-identical`, not re-moved); merged suite green; coverage backstop ≥ baseline; advisory mutation over `workflow/tools.ts` (3387-line legacy retirement — high-volume). Must not touch adjacent `tools.update.race.test.ts` (keep-class). Large multi-hour merge.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 008: Consolidate `compensation` pair (INV-8)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-6
**Files:**
- `servers/exarchos-mcp/src/workflow/compensation.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/compensation.test.ts` (retired)
**Verification:** high — blocking manifest gate; merged suite green; coverage backstop ≥ baseline; advisory mutation over `workflow/compensation.ts` for substrate-backstop preservation of the invariant INV-8, idempotent-retry cases classified `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 009: Consolidate `state-store` pair (INV-1)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-6
**Files:**
- `servers/exarchos-mcp/src/workflow/state-store.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts` (retired)
- `servers/exarchos-mcp/src/__tests__/workflow/state-store-resolve.test.ts` (retired — fold into canonical)
**Verification:** high — blocking manifest gate (both legacy files); merged suite green; coverage backstop ≥ baseline; advisory mutation over the state-store source for substrate-backstop preservation of the invariant INV-1, reducer/projection cases classified `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 010: Consolidate `views/handlers` pair

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5
**Files:**
- `servers/exarchos-mcp/src/views/handlers.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/views/handlers.test.ts` (retired)
- `servers/exarchos-mcp/src/__tests__/views/tools-error-paths.test.ts` (retired — fold into canonical)
**Verification:** high — blocking manifest gate (both legacy files); merged suite green; coverage backstop ≥ baseline; advisory mutation over the views/handlers source.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 011: Consolidate `event-store schemas` pair (INV-1, largest target)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-4, DR-5, DR-6
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.test.ts` (canonical target, 4702 ln)
- `servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts` (retired)
**Verification:** high — blocking manifest gate; merged suite green; coverage backstop ≥ baseline; advisory mutation over the event-store schema source for substrate-backstop preservation of the invariant INV-1, schema-validation cases classified `moved`. Must not touch adjacent `schemas.onboard.test.ts`. Largest canonical target — sequence last; large multi-hour merge.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 012: Duplicate-location ratchet guard with expiring allowlist

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Files:**
- `scripts/audit/check-no-duplicate-suites.mjs`
- `scripts/audit/check-no-duplicate-suites.test.ts`
- `.github/workflows/ci.yml`
**Verification:** medium — a real basename-intersection guard that fails when a legacy `__tests__/{workflow,views,event-store}/<basename>.test.ts` twin exists for any co-located subject not in the expiring allowlist; scoped test covering both directions. Wired into `grep-gates` (no `npm ci`). The allowlist carries exactly the eight deferred pairs after the seven land. Lands after the pairs so it does not fail on still-present in-scope duplicates.
**Dependencies:** 005, 006, 007, 008, 009, 010, 011
**Parallelizable:** No

### Task 013: Campaign closeout + coverage-series verification + wave 3b-2 handoff

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-3, DR-7
**Files:**
- `docs/specs/2026-07-18-test-mass-consolidation.md` (closeout notes)
**Verification:** medium — confirm none of the seven subjects remains a duplicate-location pair (Task 012 guard green with the eight-pair allowlist), the coverage ratchet ran green **per merge** across the serialized series (single-writer via manual `git merge --no-ff`), every pair's manifest + advisory mutation report is attached, then file the wave 3b-2 follow-up for the eight deferred pairs and update epic #1705.
**Dependencies:** 012
**Parallelizable:** No

### Parallelization

Critical path: **001 → {005, 006} (pilots) → {007, 008, 009, 010, 011} (main wave) → 012 → 013.**

- 002, 003, 004 run in parallel with 001 (independent tooling/guards); all four are foundation for the pairs.
- Delegate runs Task 003 (base-substrate preflight) before each wave dispatch; pairs base on `origin/main` (≥ #1719).
- Pilots 005 (guards, INV-8) and 006 (state-machine, highest-volume) run concurrently once foundation lands; they de-risk the tool and oracles before the fan-out.
- Main-wave pairs 007–011 run concurrently in isolated worktrees after the pilots.
- **Merges are single-writer serialized (DR-7):** manual `git merge --no-ff` from the integration worktree (serialize_merge is `CAPABILITY_DENIED` here), each followed by the blocking coverage ratchet, so the union-limited backstop runs on a coherent cumulative state.
- 012 (ratchet guard) lands after all pairs; 013 closes out and hands off wave 3b-2.

### Completion checklist

- [ ] Every DR-N in `## Requirements` maps to at least one task
- [ ] Every task `Implements:` a DR-N that exists in this document
- [ ] Every task carries a `riskTier` stamp
- [ ] High-tier tasks carry adequacy-judged verification (manifest gate + coverage + advisory mutation)
- [ ] Open questions resolved or explicitly deferred with rationale
- [ ] Ready for `plan-review`
