# Spec: Coverage-gated test-mass consolidation (debloat wave 3b)

**Date:** 2026-07-18 · **Feature:** `test-mass-consolidation` · **Depth:** deep
**Inputs:** epic #1701 (debloat + structural enforcement) · issue #1705 (wave 3b) · parent spec `docs/specs/2026-07-15-debloat-wave1-structural-enforcement.md` · coverage/mutation substrate PR #1719 (`c78450c7`, on `origin/main`)
**Revisions:** rev.0 → rev.1 → rev.2 (two 3-voter adversarial rounds — see Exploration) → **rev.3** (scope expanded from 7 to all 15 duplicate-location pairs at the plan-review checkpoint).

> One unified artifact: `## Requirements` holds the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Anchored to `.exarchos/invariants.md` (dev catalog enabled). The tests are themselves the mechanical backstops for substrate invariants, so several "keep classes" map directly to invariants:

- **INV-2 (facade-equivalence):** parity-harness tests prove CLI≡MCP → parity suites out of scope.
- **INV-1 (event-sourcing-integrity):** reducers/projections/schemas are pure left-folds → state-store, event-store-schema, event-store/tools, workflow/schemas, and views/materializer (a projection) suites are targets *and* INV-1 backstops.
- **INV-8 (idempotency-at-the-boundary):** the `withSession({operationId})` retry tests are its sole deterministic backstop → compensation and guards carry them.
- **INV-7 (substrate-serialization):** race suites prove the two-tier guarantee → out of scope.

The through-line, hardened across two review rounds: **coverage cannot be the assertion-loss guarantee** (line coverage is a union — a dropped case whose line is still exercised elsewhere is invisible), and **neither can mutation** (blocked by #1720's full-suite dry-run failure). The guarantee must be deterministic, by-construction, **and CI-enforced against a reconstructed pre-image** — a manifest gate that is a real job, not implementer discipline.

## Design & Rationale

### Problem Statement

Units are tested from **two locations** — a legacy `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/<subject>.test.ts` copy and a co-located `src/<area>/<subject>.test.ts` copy. Reconnaissance corrects the audit's premise twice: the pairs are **diverged, not duplicated** (line counts differ in both directions; the larger side flips per subject), and there are **15 duplicate-location pairs, not the 7 the audit named**. All 15 are in scope (scope decision taken at the plan-review checkpoint — expand rather than defer):

| # | Subject | legacy | co-located | larger | substrate |
|---|---|---|---|---|---|
| 1 | workflow/state-machine | 3338 | 876 | legacy 4× | |
| 2 | workflow/tools | 3387 | 817 (+8 splits) | legacy | |
| 3 | workflow/state-store | 1544 (+resolve 36) | 1213 | legacy | INV-1 |
| 4 | workflow/compensation | 1166 | 1663 | co-located | INV-8 |
| 5 | workflow/guards | 762 | 1247 | co-located | INV-8 |
| 6 | workflow/checkpoint | 353 | 889 | co-located | |
| 7 | workflow/migration | 240 | 149 | legacy | |
| 8 | workflow/schemas | 1030 | 779 | legacy | INV-1 |
| 9 | views/handlers | 793 (+err 116) | 1979 | co-located | |
| 10 | views/materializer | 481 | 733 | co-located | INV-1 (projection) |
| 11 | views/pipeline-view | 257 | 169 | legacy | |
| 12 | views/snapshot-store | 417 | 147 | legacy | |
| 13 | views/task-detail-view | 114 | 166 | co-located | |
| 14 | event-store/schemas | 1006 | 4702 (+onboard 196) | co-located | INV-1 |
| 15 | event-store/tools | 511 | 1092 | co-located | INV-1 |

The durable defect is **structural** (one unit, two drifting locations). Automated dedup is only safe for cases whose entire referenced context is identical — rare across diverged files — so **LoC reduction is modest and secondary; the win is de-divergence to one canonical location, locked by a ratchet that ends with an empty allowlist (no legacy twin permitted anywhere).**

### Chosen Approach

**Tool-driven union-preserving relocation of all 15 pairs to one canonical (co-located) location each, enforced by a CI manifest gate that reconstructs the pre-image.** A single TypeScript-compiler-API tool (Task 001) both (a) **emits** the merged canonical file — every legacy case relocated verbatim (imports rewritten), a case removed only when a case with identical body **and identical transitive referenced context** (enclosing hooks + module-scope helpers + resolved imports) already exists — and (b) **verifies** a manifest. The gate is made real by landing **each pair as its own PR**: a CI job (Task 004) reconstructs the pre-image legacy *and* pre-image canonical from the PR merge-base (`git show <base>:<path>` — the base is `origin/main`, which still holds every legacy twin) and **fails the PR** if any case from *either* pre-image suite is absent from the PR-HEAD canonical and not provably dedup-identical. Coverage non-regression (#1719) runs per PR as a union-limited backstop; mutation is explicitly deferred (blocked by #1720). Keep-classes are protected. A CI ratchet guard forbids a legacy twin for **any** co-located subject (area-qualified); its allowlist shrinks from 15 to **0** as pairs land, so at completion no two-location divergence is permitted anywhere. Chosen via the `deep`-rung decisions (scope = all 15 pairs; oracle = CI-enforced manifest gate primary + coverage backstop; mutation deferred).

## Requirements

### DR-1: Single canonical location for all 15 subjects, with an area-qualified ratchet ending at an empty allowlist

Each of the 15 subjects ends tested from one canonical co-located location; its legacy twin is retired. A CI ratchet guard forbids a legacy `__tests__/<area>/<basename>.test.ts` twin for **any** co-located subject, keyed on **(area, basename)** — because `schemas.test.ts` and `tools.test.ts` each appear as pairs in two areas (workflow and event-store) — with an allowlist that shrinks to **empty** as the 15 land.

**Acceptance criteria:**
- After the campaign, none of the 15 subjects has both a `src/__tests__/…` and a co-located file, and the guard's allowlist is empty.
- The guard is a real (area, basename) intersection script (not a brace-glob `git ls-files`, which is vacuously green); its scoped test includes the cross-area collision case (`workflow/schemas` vs `event-store/schemas`; `workflow/tools` vs `event-store/tools`).
- Removing a subject from the allowlist without consolidating it fails CI.
- The full server suite is green after each pair.

### DR-2: CI-enforced bidirectional manifest gate (the primary guarantee)

The primary guarantee is a **blocking CI job**, not implementer discipline. Because each pair lands as its own PR (DR-7), the job reconstructs the pre-image legacy and pre-image canonical from the PR merge-base and asserts every case in *either* pre-image is present in the PR-HEAD canonical or provably `dedup-identical`. Identity requires an identical normalized body **and identical transitive referenced context** (enclosing `describe` hooks, module-scope helpers the body calls, and resolved import targets) — so divergent same-named helpers (e.g. `compensation`'s two `makeState` bodies) block dedup by construction. Assertion loss — on the legacy **or** the pre-existing canonical side — fails the PR.

**Acceptance criteria:**
- The manifest gate runs as a CI job on each consolidation PR (a lane with server deps, since it parses TS), reconstructing both pre-images via `git show <merge-base>:<path>`; it **blocks** on any unaccounted or unproven case from either pre-image.
- `dedup-identical` requires body + transitive referenced context identity; body-identical cases whose referenced context differs are `moved`, never dedup'd. The tool ships with the divergent-module-helper case (compensation `makeState`) as a tested fixture.
- The committed manifest artifact (per pair) matches the gate's recomputation from the merge-base (no trust in a hand-authored manifest).

### DR-3: Coverage non-regression backstop (blocking per PR, explicitly union-limited)

The blocking coverage ratchet (#1719 — lines 91.6 / statements 91.6 / functions 96.24 / branches 85.38, 0.1pp floored epsilon, fail-closed) runs on each per-pair PR. It is a **backstop, not the assertion-loss guarantee** (line coverage is union-blind); its value is catching accidental source deletion and last-exerciser drops. Coverage config excludes test files from the denominator, so retiring legacy suites is production-coverage-neutral under correct relocation.

**Acceptance criteria:**
- Each per-pair PR passes `scripts/check-coverage-ratchet.mjs` (blocking, no `--observe`) against the committed baseline; the baseline is never lowered.
- Fail-closed behavior preserved (missing/unparseable summary or baseline → exit 2).
- Reviews treat green coverage as necessary-not-sufficient; the DR-2 gate is the assertion-loss authority.

### DR-4: Mutation-adequacy is deferred (blocked by #1720), not relied upon

Mutation is the ideal assertion-loss oracle, but it cannot run here: #1720's failure is in StrykerJS's **dry-run** (the un-mutated full-suite baseline), upstream of and independent of any `--mutate` scoping. The campaign does **not** rely on mutation; the DR-2 gate is the guarantee.

**Acceptance criteria:**
- No task blocks on a mutation run; no acceptance criterion elsewhere requires a kill-set.
- Closeout (Task 021) records the dependency: when #1720 lands, a source-targeted mutation spot-check over the consolidated modules is added as advisory confirmation, not gating.

### DR-5: Keep-classes are out of scope and protected

Parity (26), race (5), property (4 named / 45 fast-check), characterization (5), and acceptance (≈8) suites are not consolidation targets — they back INV-2, INV-7, and characterization.

**Acceptance criteria:**
- The campaign's total changed-file set intersected with the keep-class globs is empty.
- Co-located keep-class files adjacent to targets are in a pre-flight protected inventory and neither moved nor deleted — including `state-machine.property.test.ts`, `tools.update.race.test.ts`, **`views/materializer.property.test.ts`**, the state-store acceptance suites, and the shared `src/__tests__/parity-harness.ts`.
- If any retired legacy file imports `parity-harness.ts`, the harness is retained and importers re-pointed.

### DR-6: Substrate-backstop preservation via the uniform manifest gate

Because the DR-2 gate is **uniform across all 15 pairs** and bidirectional, the INV-1 (state-store, event-store schemas, event-store/tools, workflow/schemas, views/materializer) and INV-8 (compensation, guards) backstop assertions get the same by-construction, CI-enforced protection as everything else — no reliance on invariant-keyed mutation.

**Acceptance criteria:**
- The INV-8 idempotent-retry cases and INV-1 reducer/projection/schema-validation cases are classified `moved` (never dedup-dropped) in their pair's manifest and named in the PR.
- Oracle strength is not keyed to invariant membership: the gate protects all pairs equally.

### DR-7: Per-pair PRs (the enforcement seam) with serialized landing

Each pair lands as its own pull request, so the DR-2 manifest gate and DR-3 coverage ratchet run in CI per pair — the enforcement seam a local `git merge --no-ff` (which triggers no CI) cannot provide. PRs land serially (stacked on the integration branch) so the coverage ratchet evaluates a coherent cumulative state.

**Acceptance criteria:**
- Each consolidation lands via its own PR that triggers the DR-2 gate + DR-3 ratchet; no pair is merged by a CI-invisible local merge.
- PRs are stacked/sequential (single-writer landing); where `serialize_merge` is `CAPABILITY_DENIED`, landing is a manual sequential merge of each already-CI-verified PR.
- Per-PR gate catches per-pair loss; the ratchet on each PR catches union-visible aggregate regression (union-invisible loss is caught by DR-2's bidirectional pre-image check).

### DR-8: Base-substrate preflight (a delegate-phase dispatch check)

The campaign requires the #1719 substrate on its base. Worktree isolation bases on `origin/HEAD` (= `origin/main` = `c78450c7`, which has it), so the common path is safe; the preflight is an explicit **dispatch-time check** the delegate phase runs, not merely a build-order dependency.

**Acceptance criteria:**
- The delegate phase executes the Task 003 check before dispatching each wave and aborts dispatch if `coverage-baseline.json` + `check-coverage-ratchet.mjs` are absent on the base (local `2f4c0e23` is the negative fixture); pair tasks depend on Task 003 so the script exists first.
- Pair worktrees base on `origin/main` (≥ `c78450c7`) or a later integration branch including #1719.

## Technical Design

**The tool (Task 001, TypeScript compiler API — already a dependency; ts-morph is *not* in the tree).** `scripts/audit/consolidate-suite.mjs` parses a suite into cases `{ describePath, title, bodyHash, contextHash }`. `bodyHash` normalizes comments/whitespace/quote-style; `contextHash` is the transitive closure of what the body references — enclosing hooks, module-scope helpers/consts it calls, and the *resolved definitions* behind imported symbols. `--emit-merged` writes the canonical file (moved cases appended with disambiguated describe paths; dedup-identical omitted) so relocation is deterministic codegen, not a multi-hour hand-merge; `--verify` recomputes the manifest from two pre-image files + the candidate canonical and exits non-zero on any lost/unproven case.

**The CI gate (Task 004).** A ci.yml job on consolidation PRs: for each retired subject in the diff, `git show <merge-base>:<legacy>` and `:<canonical>` reconstruct the pre-images, then `consolidate-suite.mjs --verify` blocks the PR on failure. Runs in a server-deps lane.

**Ratchet guard (Task 020).** `check-no-duplicate-suites.mjs` enumerates (area, basename) pairs present under both locations and fails on any not in a shrinking allowlist; runs in `grep-gates` (no deps).

**Oracles, priority order:** (1) DR-2 CI manifest gate — blocking, deterministic, bidirectional. (2) DR-3 coverage ratchet — blocking backstop, union-limited. Mutation (DR-4) deferred behind #1720.

## Integration Points

- `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/*.test.ts` (15 legacy twins + `state-store-resolve.test.ts`, `views/tools-error-paths.test.ts`) — **retired**.
- `servers/exarchos-mcp/src/{workflow,views,event-store}/*.test.ts` (15 canonical targets) — **receive** moved cases (via `--emit-merged`).
- `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared harness; verify importers, retain.
- `coverage-baseline.json`, `scripts/check-coverage-ratchet.mjs` — blocking backstop (unchanged).
- `.github/workflows/ci.yml` — new manifest-gate job (Task 004, deps lane) + duplicate-location ratchet (Task 020, grep-gates).
- New: `scripts/audit/consolidate-suite.mjs`, `scripts/audit/manifest-gate-ci.mjs`, `scripts/audit/check-no-duplicate-suites.mjs`, `scripts/audit/check-base-substrate.mjs`, `scripts/audit/check-protected.mjs`.

## Exploration

The divergent loop (no `/exarchos:discover` — grounded by in-repo recon) plus two adversarial plan-review rounds:

- **Option A — coverage-gated deletion:** rejected — coverage union-blind.
- **Option B — mutation-anchored gate:** rejected — #1720 blocks the dry-run independent of scope; deferred (DR-4).
- **Option C — CI-enforced deterministic manifest gate + coverage backstop** (**chosen**).

**Audit trail.** Rev.0 (coverage-floor + advisory mutation) refuted: no blocking oracle; coverage union-blind; mutation non-functional + inverted; 15 pairs not 7. Rev.1 (manifest gate) refuted three ways: the gate was prose, not CI-wired, and un-runnable after the legacy file is deleted; its identity ignored module-scope helpers (live `compensation` `makeState` counter-example); `--mutate` couldn't dodge #1720's dry-run. Rev.2 resolved these (per-pair PRs + merge-base reconstruction → real CI job; codegen + context-aware identity; mutation deferred). Rev.3 expands scope to all 15 pairs per the checkpoint decision.

## Alternatives considered

- **Keep both locations (status quo):** rejected — that is the divergence bug.
- **Delete legacy wholesale:** rejected — the legacy suite asserts *more* for several pairs.
- **Local `git merge --no-ff` per pair, one synthesize PR (rev.1):** rejected — no CI event per pair; hence per-pair PRs (DR-7).
- **Hand-merge the large suites:** rejected — multi-hour, crash-prone; the tool codegens the merge.
- **Consolidate only the 7 named pairs, defer 8 (rev.2):** superseded — the checkpoint decision expanded to all 15 (removes the divergence class in one campaign; the ratchet ends at an empty allowlist).
- **Top-20 large-suite minimization:** deferred (single-location suites, weaker safety argument).

## Open Questions

- **Mutation re-enablement:** tracked to #1720; closeout files the follow-up.
- **Per-module mutation scoping list:** deferred until #1720 unblocks mutation.

## Decomposition

### Scope

**Target:** all 15 duplicate-location pairs + tooling/guards. **Excluded:** top-20 large-suite minimization; the non-pair `src/__tests__/` subdirs (integration/, benchmarks/, skills/, stack/, sync/, tasks/, utils/).

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Single canonical location + area-qualified ratchet (empty allowlist) | 005–019, 020, 021 |
| DR-2 | CI-enforced bidirectional manifest gate | 001, 004, 005–019 |
| DR-3 | Coverage non-regression backstop (per PR) | 005–019, 021 |
| DR-4 | Mutation deferred (blocked #1720) | 021 |
| DR-5 | Keep-classes protected | 002, 005–019 |
| DR-6 | Substrate-backstop preservation | 001, 005, 008, 009, 011, 014, 015, 019 |
| DR-7 | Per-pair PRs (enforcement seam), serialized | 004, 005–019, 021 |
| DR-8 | Base-substrate preflight | 003 |

(“005–019” denotes each of tasks 005 through 019 individually.)

### Tasks

Consolidation tasks are unusual: the test suite *is* the deliverable, so verification is "CI manifest gate (blocking) + coverage ratchet (blocking) + green suite," not a new test file. All 15 pair tasks are high-tier and boundary-touching; each lands as its own PR (DR-7) and is gated by the DR-2 CI manifest gate.

### Task 001: Consolidation tool — codegen + bidirectional manifest verify (TypeScript compiler API)

**Risk Tier:** high · **Boundary Touching:** false · **Implements:** DR-2, DR-6
**Files:** `scripts/audit/consolidate-suite.mjs`, `scripts/audit/consolidate-suite.test.ts`
**Verification:** high — `--emit-merged` relocates every legacy case verbatim (deterministic codegen, no hand-merge); `--verify` blocks on any case lost from either pre-image. Identity uses body + transitive referenced-context hash (hooks, module-scope helpers, resolved imports), so divergent same-named helpers block dedup. TypeScript compiler API (ts-morph is not in the tree). Scoped tests over crafted cases — identical, title-collision-but-divergent-body, identical-body-but-divergent-fixture, **identical-body-but-divergent-module-helper** (the live `compensation` `makeState` case), same-symbol-different-module-import — plus `check_test_adequacy` kill-probe and an integration run over one real pair.
**Dependencies:** None · **Parallelizable:** No (foundation)

### Task 002: Keep-class protected-file inventory + pre-flight guard

**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-5
**Files:** `scripts/audit/protected-suites.json`, `scripts/audit/check-protected.mjs`, `scripts/audit/check-protected.test.ts`
**Verification:** medium — scoped test asserting the guard flags a change-set intersecting a keep-class glob (parity/race/property/characterization/acceptance) and passes a clean one; inventory includes the named adjacent files (`state-machine.property`, `tools.update.race`, `views/materializer.property`, state-store acceptance, `parity-harness.ts`).
**Dependencies:** None · **Parallelizable:** Yes

### Task 003: Base-substrate preflight (delegate-phase dispatch check)

**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-8
**Files:** `scripts/audit/check-base-substrate.mjs`, `scripts/audit/check-base-substrate.test.ts`
**Verification:** medium — asserts the #1719 substrate is present on the base and aborts dispatch when absent (local `2f4c0e23` is the negative fixture); the delegate phase runs it before each wave; pairs depend on it so it exists first.
**Dependencies:** None · **Parallelizable:** Yes

### Task 004: CI manifest-gate job — merge-base pre-image reconstruction

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2, DR-7
**Files:** `.github/workflows/ci.yml`, `scripts/audit/manifest-gate-ci.mjs`, `scripts/audit/manifest-gate-ci.test.ts`
**Verification:** high — CI job on consolidation PRs that reconstructs both pre-images via `git show <merge-base>:<path>` and runs `consolidate-suite.mjs --verify`, blocking the PR on any lost/unproven case; the enforcement seam that makes DR-2 a gate. Server-deps lane. Scoped test covering a PR that drops a legacy case (fails), one that drops a **pre-existing canonical** case (fails, bidirectional), and a clean relocation (passes).
**Dependencies:** 001 · **Parallelizable:** No (foundation)

### Task 005: Consolidate workflow/guards (INV-8 pilot)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/guards.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate (bidirectional); coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-8 (idempotent-retry cases `moved`). Pilot: smallest INV-8 pair, validates tool codegen + CI gate end-to-end.
**Dependencies:** 001, 002, 003, 004 · **Parallelizable:** Yes (pilot group)

### Task 006: Consolidate workflow/state-machine (asymmetry + high-volume pilot)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate; coverage backstop ≥ baseline; green suite. Pilot: legacy asserts 4× the co-located (3338→876), highest merge-volume; `--emit-merged` codegen collapses the effort/crash risk. Must not touch adjacent `state-machine.property.test.ts` (keep-class).
**Dependencies:** 001, 002, 003, 004 · **Parallelizable:** Yes (pilot group)

### Task 007: Consolidate workflow/tools

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/tools.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (retired)
**Verification:** high — own PR; CI manifest gate run with the eight co-located `tools.*.test.ts` split files as canonical pre-image context (a case already in a split file is dedup-identical, not re-moved); coverage backstop ≥ baseline; green suite. Codegen'd merge (3387-line legacy). Must not touch `tools.update.race.test.ts` (keep-class).
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 008: Consolidate workflow/compensation (INV-8)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/compensation.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/workflow/compensation.test.ts` (retired)
**Verification:** high — own PR; CI manifest gate where the divergent `makeState` module helpers make context-aware identity load-bearing (a body-only hash would false-dedup); coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-8, idempotent-retry cases `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 009: Consolidate workflow/state-store (INV-1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/state-store.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts` (retired), `servers/exarchos-mcp/src/__tests__/workflow/state-store-resolve.test.ts` (retired — fold in)
**Verification:** high — own PR; CI manifest gate (both legacy files as pre-image); coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-1, reducer/projection cases `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 010: Consolidate views/handlers

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/handlers.test.ts` (canonical), `servers/exarchos-mcp/src/__tests__/views/handlers.test.ts` (retired), `servers/exarchos-mcp/src/__tests__/views/tools-error-paths.test.ts` (retired — fold in)
**Verification:** high — own PR; CI manifest gate (both legacy files as pre-image); coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 011: Consolidate event-store/schemas (INV-1, largest target)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/event-store/schemas.test.ts` (canonical, 4702 ln), `servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts` (retired)
**Verification:** high — own PR; CI manifest gate where the bidirectional check is load-bearing given the 4702-line canonical target; coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-1, schema-validation cases `moved`. Must not touch `schemas.onboard.test.ts`. Codegen'd merge; sequence late.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 012: Consolidate workflow/checkpoint

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/checkpoint.test.ts` (canonical, 889 ln), `servers/exarchos-mcp/src/__tests__/workflow/checkpoint.test.ts` (retired, 353 ln)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 013: Consolidate workflow/migration

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/migration.test.ts` (canonical, 149 ln), `servers/exarchos-mcp/src/__tests__/workflow/migration.test.ts` (retired, 240 ln — larger legacy)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 014: Consolidate workflow/schemas (INV-1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/schemas.test.ts` (canonical, 779 ln), `servers/exarchos-mcp/src/__tests__/workflow/schemas.test.ts` (retired, 1030 ln — larger legacy)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-1 (schema-validation cases `moved`). Distinct from event-store/schemas (Task 011) — the (area, basename) allowlist must not conflate them.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 015: Consolidate views/materializer (INV-1 projection)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/views/materializer.test.ts` (canonical, 733 ln), `servers/exarchos-mcp/src/__tests__/views/materializer.test.ts` (retired, 481 ln)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-1 (projection). **Must not touch adjacent `views/materializer.property.test.ts` (keep-class).**
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 016: Consolidate views/pipeline-view

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/pipeline-view.test.ts` (canonical, 169 ln), `servers/exarchos-mcp/src/__tests__/views/pipeline-view.test.ts` (retired, 257 ln — larger legacy)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 017: Consolidate views/snapshot-store

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/snapshot-store.test.ts` (canonical, 147 ln), `servers/exarchos-mcp/src/__tests__/views/snapshot-store.test.ts` (retired, 417 ln — larger legacy)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 018: Consolidate views/task-detail-view

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/task-detail-view.test.ts` (canonical, 166 ln), `servers/exarchos-mcp/src/__tests__/views/task-detail-view.test.ts` (retired, 114 ln)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite. Smallest pair.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 019: Consolidate event-store/tools (INV-1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/event-store/tools.test.ts` (canonical, 1092 ln), `servers/exarchos-mcp/src/__tests__/event-store/tools.test.ts` (retired, 511 ln)
**Verification:** high — own PR; CI manifest gate; coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-1. Distinct from workflow/tools (Task 007) — the (area, basename) allowlist must not conflate them.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 020: Duplicate-location ratchet guard (area-qualified, allowlist → empty)

**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `scripts/audit/check-no-duplicate-suites.mjs`, `scripts/audit/check-no-duplicate-suites.test.ts`, `.github/workflows/ci.yml`
**Verification:** medium — a real (area, basename) intersection guard that fails when a legacy twin exists for any co-located subject not in the allowlist; scoped test covering both directions **and** the cross-area collision (`schemas`, `tools`). Wired into `grep-gates` (no deps). After all 15 land, the allowlist is empty. Lands after the pairs.
**Dependencies:** 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019 · **Parallelizable:** No

### Task 021: Campaign closeout + coverage-series verification + #1720 mutation handoff

**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-1, DR-3, DR-4, DR-7
**Files:** `docs/specs/2026-07-18-test-mass-consolidation.md` (closeout notes)
**Verification:** medium — confirm none of the 15 subjects remains a duplicate-location pair (Task 020 guard green, empty allowlist), every per-pair PR passed the manifest gate + coverage ratchet in CI, then record the #1720 mutation-re-enablement follow-up and update epic #1705.
**Dependencies:** 020 · **Parallelizable:** No

### Parallelization

Critical path: **001 → 004 → {005, 006} (pilots) → {007–019} (main wave, 13 pairs) → 020 → 021.**

- 002, 003 run in parallel with 001; 004 (CI gate) depends on 001.
- Delegate runs Task 003 (base-substrate check) before each wave; pairs base on `origin/main` (≥ #1719).
- Pilots 005 (guards, INV-8) and 006 (state-machine, highest-volume) validate tool codegen + CI gate before the fan-out.
- Main-wave 007–019 (13 pairs) run concurrently in isolated worktrees, each landing as its own CI-gated PR. Each edits a distinct co-located file + deletes a distinct legacy file, so no file conflicts; only 004/020 touch `ci.yml` (both non-parallel with each other by sequencing).
- **Per-pair PRs are the enforcement seam (DR-7):** each triggers the DR-2 manifest gate + DR-3 ratchet; PRs land serially (stacked; manual sequential merge where `serialize_merge` is capability-denied).
- 020 (ratchet guard) lands after all 15 pairs; 021 closes out.

### Completion checklist

- [ ] Every DR-N maps to at least one task; every task Implements an existing DR-N
- [ ] Every task carries a `riskTier` stamp
- [ ] High-tier tasks carry adequacy-judged verification (CI manifest gate + coverage + green suite)
- [ ] Open questions resolved or explicitly deferred
- [ ] Ready for `plan-review`
