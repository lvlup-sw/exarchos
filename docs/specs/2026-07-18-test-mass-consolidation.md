# Spec: Coverage-gated test-mass consolidation (debloat wave 3b)

**Date:** 2026-07-18 · **Feature:** `test-mass-consolidation` · **Depth:** deep
**Inputs:** epic #1701 (debloat + structural enforcement) · issue #1705 (wave 3b) · parent spec `docs/specs/2026-07-15-debloat-wave1-structural-enforcement.md` · coverage/mutation substrate PR #1719 (`c78450c7`, on `origin/main`)
**Revisions:** rev.0 → rev.1 → **rev.2**. Two 3-voter adversarial plan-review rounds drove the design from "manual merge + prose 'blocking' + advisory oracles" to "deterministic tool-codegen'd merge + a real CI manifest gate (merge-base reconstruction) + per-pair PRs." See Exploration for the audit trail.

> One unified artifact: `## Requirements` holds the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Anchored to `.exarchos/invariants.md` (dev catalog enabled). The tests are themselves the mechanical backstops for substrate invariants, so several "keep classes" map directly to invariants:

- **INV-2 (facade-equivalence):** parity-harness tests prove CLI≡MCP → parity suites out of scope.
- **INV-1 (event-sourcing-integrity):** reducers/projections are pure left-folds → state-store and event-store-schema suites are targets *and* INV-1 backstops.
- **INV-8 (idempotency-at-the-boundary):** the `withSession({operationId})` retry tests are its sole deterministic backstop → compensation and guards carry them.
- **INV-7 (substrate-serialization):** race suites prove the two-tier guarantee → out of scope.

The through-line, hardened across two review rounds: **coverage cannot be the assertion-loss guarantee** (line coverage is a union — a dropped case whose line is still exercised elsewhere is invisible), and **neither can mutation** (blocked by #1720's full-suite dry-run failure). The guarantee must be deterministic, by-construction, **and CI-enforced against a reconstructed pre-image** — a manifest gate that is a real job, not implementer discipline.

## Design & Rationale

### Problem Statement

Units are tested from **two locations** — a legacy `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/<subject>.test.ts` copy and a co-located `src/<area>/<subject>.test.ts` copy. Reconnaissance corrects the audit's premise twice:

1. **The pairs are diverged, not duplicated** — line counts differ in both directions; the larger side flips per subject; each side asserts behaviors the other does not.
2. **There are 15 duplicate-location pairs, not 7.** Beyond the 7 named, both-location copies also exist for `workflow/{checkpoint, migration, schemas}`, `views/{materializer, pipeline-view, snapshot-store, task-detail-view}`, `event-store/tools`.

The seven highest-value pairs (largest legacy mass and/or substrate-invariant backstops) are the **active scope**; the other eight are inventoried and deferred to a tracked fast-follow (wave 3b-2), not silently omitted.

| Active-scope subject | legacy `__tests__/` | co-located | larger |
|---|---|---|---|
| state-machine | 3338 | 876 | legacy 4× |
| tools | 3387 | 817 (+8 split files) | legacy |
| state-store | 1544 (+resolve 36) | 1213 | legacy |
| compensation | 1166 | 1663 | co-located |
| guards | 762 | 1247 | co-located |
| views/handlers | 793 (+error-paths 116) | 1979 | co-located |
| event-store schemas | 1006 | 4702 (+onboard 196) | co-located |

The durable defect is **structural** (one unit, two drifting locations). Automated dedup is only safe for cases whose entire referenced context is identical — rare across diverged files — so **LoC reduction is modest and secondary; the win is de-divergence to one canonical location, locked by a ratchet.**

### Chosen Approach

**Tool-driven union-preserving relocation to one canonical (co-located) location, enforced by a CI manifest gate that reconstructs the pre-image.** A single TypeScript-compiler-API tool (Task 001) both (a) **emits** the merged canonical file — every legacy case relocated verbatim (imports rewritten), a case removed only when a case with identical body **and identical transitive referenced context** (enclosing hooks + module-scope helpers + resolved imports) already exists — and (b) **verifies** a manifest. The gate is made real by landing **each pair as its own PR**: a CI job (Task 004) reconstructs the pre-image legacy *and* pre-image canonical from the PR merge-base (`git show <base>:<path>` — the base is `origin/main`, which still holds every legacy twin) and **fails the PR** if any case from *either* pre-image suite is absent from the PR-HEAD canonical and not provably dedup-identical. Coverage non-regression (#1719) runs per PR as a union-limited backstop; mutation is explicitly deferred (blocked by #1720). Keep-classes are protected. A CI ratchet guard forbids a legacy twin for **any** co-located subject (area-qualified), with an expiring allowlist for the eight deferred pairs. Chosen via the `deep`-rung decisions (scope = 7 highest-value pairs; oracle = CI-enforced manifest gate primary + coverage backstop; mutation deferred).

## Requirements

### DR-1: Single canonical location, with an area-qualified global anti-divergence ratchet

The seven active subjects each end tested from one canonical co-located location; their legacy twins are retired. A CI ratchet guard forbids a legacy `__tests__/<area>/<basename>.test.ts` twin for **any** co-located subject, keyed on **(area, basename)** — because `schemas.test.ts` and `tools.test.ts` each appear as pairs in two areas (one active, one deferred) — carrying an **expiring allowlist** for the eight deferred pairs.

**Acceptance criteria:**
- After the campaign, none of the seven subjects has both a `src/__tests__/…` and a co-located file.
- The guard is a real (area, basename) intersection script (not a brace-glob `git ls-files`, which is vacuously green), and its scoped test includes the cross-area collision case (`workflow/schemas` deferred vs `event-store/schemas` active; `workflow/tools` active vs `event-store/tools` deferred).
- After the seven land, the allowlist contains exactly the eight deferred pairs; each entry carries an expiry.
- The full server suite is green after each pair.

### DR-2: CI-enforced bidirectional manifest gate (the primary guarantee)

The primary guarantee is a **blocking CI job**, not implementer discipline. Because each pair lands as its own PR (DR-7), the job reconstructs the pre-image legacy and pre-image canonical from the PR merge-base and asserts every case in *either* pre-image is present in the PR-HEAD canonical or provably `dedup-identical`. Identity requires an identical normalized body **and identical transitive referenced context** (enclosing `describe` hooks, module-scope helpers the body calls, and resolved import targets) — so divergent same-named helpers (e.g. `compensation`'s two `makeState` bodies) block dedup by construction. Assertion loss — on the legacy **or** the pre-existing canonical side — fails the PR.

**Acceptance criteria:**
- The manifest gate runs as a CI job on each consolidation PR (a lane with server deps, since it parses TS), reconstructing both pre-images via `git show <merge-base>:<path>`; it **blocks** (non-zero) on any unaccounted or unproven case from either pre-image.
- `dedup-identical` requires body + transitive referenced context identity (hooks, module-scope helpers, resolved imports); body-identical cases whose referenced context differs are `moved`, never dedup'd. The tool ships with the divergent-module-helper case as a tested fixture.
- The committed manifest artifact (per pair) matches the gate's recomputation from the merge-base (no trust in a hand-authored manifest).

### DR-3: Coverage non-regression backstop (blocking per PR, explicitly union-limited)

The blocking coverage ratchet (#1719 — lines 91.6 / statements 91.6 / functions 96.24 / branches 85.38, 0.1pp floored epsilon, fail-closed) runs on each per-pair PR. It is a **backstop, not the assertion-loss guarantee** (line coverage is union-blind); its value is catching accidental source deletion and last-exerciser drops. Coverage config excludes test files from the denominator, so retiring legacy suites is production-coverage-neutral under correct relocation.

**Acceptance criteria:**
- Each per-pair PR passes `scripts/check-coverage-ratchet.mjs` (blocking, no `--observe`) against the committed baseline; the baseline is never lowered.
- Fail-closed behavior preserved (missing/unparseable summary or baseline → exit 2).
- Reviews treat green coverage as necessary-not-sufficient; the DR-2 gate is the assertion-loss authority.

### DR-4: Mutation-adequacy is deferred (blocked by #1720), not relied upon

Mutation is the ideal assertion-loss oracle, but it cannot run here: #1720's failure is in StrykerJS's **dry-run** (the un-mutated full-suite baseline), which is upstream of and independent of any `--mutate` scoping — so a per-module run hits the same abort. The campaign therefore does **not** rely on mutation; the DR-2 gate is the guarantee.

**Acceptance criteria:**
- No task blocks on a mutation run; no acceptance criterion elsewhere requires a kill-set.
- Closeout (Task 013) records the dependency: when #1720 lands, a source-targeted mutation spot-check over the consolidated modules is added as advisory confirmation (a wave-3b-2 or follow-up line item), not gating.

### DR-5: Keep-classes are out of scope and protected

Parity (26 files), race (5), property (4 named / 45 fast-check), characterization (5), and acceptance (≈8) suites are not consolidation targets and must remain untouched — they back INV-2, INV-7, and characterization.

**Acceptance criteria:**
- The campaign's total changed-file set intersected with the keep-class globs is empty.
- Co-located keep-class files adjacent to targets (`state-machine.property.test.ts`, `tools.update.race.test.ts`, state-store acceptance suites, the shared `src/__tests__/parity-harness.ts`) are in a pre-flight protected inventory and neither moved nor deleted.
- If any retired legacy file imports `parity-harness.ts`, the harness is retained and importers re-pointed.

### DR-6: Substrate-backstop preservation via the uniform manifest gate

Because the DR-2 gate is **uniform across all seven pairs** and bidirectional, the INV-1 (state-store, schemas) and INV-8 (compensation, guards) backstop assertions get the same by-construction, CI-enforced protection as everything else — no reliance on invariant-keyed mutation (which rev.0 wrongly made the sole protection, under-covering the largest non-INV retirements).

**Acceptance criteria:**
- The INV-8 idempotent-retry cases and INV-1 reducer/projection/schema-validation cases are classified `moved` (never dedup-dropped) in their pair's manifest and named in the PR.
- Oracle strength is not keyed to invariant membership: the gate protects all pairs equally.

### DR-7: Per-pair PRs (the enforcement seam) with serialized landing

Each pair lands as its own pull request, so the DR-2 manifest gate and DR-3 coverage ratchet run in CI per pair — the enforcement seam a local `git merge --no-ff` (which triggers no CI) cannot provide. PRs land serially (stacked on the integration branch) so the coverage ratchet evaluates a coherent cumulative state.

**Acceptance criteria:**
- Each consolidation lands via its own PR that triggers the DR-2 gate + DR-3 ratchet; no pair is merged by a CI-invisible local merge.
- PRs are stacked/sequential (single-writer landing); where `serialize_merge` is `CAPABILITY_DENIED`, landing is a manual sequential merge of each already-CI-verified PR.
- The per-PR gate catches per-pair loss; the ratchet on each PR catches union-visible aggregate regression (union-invisible loss is caught by DR-2's bidirectional pre-image check, not coverage).

### DR-8: Base-substrate preflight (a delegate-phase dispatch check)

The campaign requires the #1719 substrate on its base. Worktree isolation bases on `origin/HEAD` (= `origin/main` = `c78450c7`, which has it), so the common path is safe; the preflight is an explicit belt-and-suspenders **dispatch-time check** (an orchestrator action the delegate phase runs), not merely a build-order dependency.

**Acceptance criteria:**
- The delegate phase executes the Task 003 check before dispatching each wave and aborts dispatch if `coverage-baseline.json` + `check-coverage-ratchet.mjs` are absent on the base (local `2f4c0e23` is the negative fixture); the pair tasks depend on Task 003 so the script exists first.
- Pair worktrees base on `origin/main` (≥ `c78450c7`) or a later integration branch including #1719.

## Technical Design

**The tool (Task 001, TypeScript compiler API — already a dependency; ts-morph is *not* in the tree).** `scripts/audit/consolidate-suite.mjs` parses a suite into cases `{ describePath, title, bodyHash, contextHash }`. `bodyHash` normalizes comments/whitespace/quote-style; `contextHash` is the transitive closure of what the body references — enclosing hooks, module-scope helpers/consts it calls, and the *resolved definitions* behind imported symbols (not just the specifier). Two modes: `--emit-merged` writes the canonical file (moved cases appended with disambiguated describe paths; dedup-identical omitted) so the relocation is deterministic codegen, not a multi-hour hand-merge; `--verify` recomputes the manifest from two pre-image files + the candidate canonical and exits non-zero on any lost/unproven case.

**The CI gate (Task 004).** A ci.yml job on consolidation PRs: for each retired subject in the diff, `git show <merge-base>:<legacy>` and `:<canonical>` reconstruct the pre-images, then `consolidate-suite.mjs --verify` blocks the PR on failure. Runs in a server-deps lane (not `grep-gates`).

**Ratchet guard (Task 012).** `check-no-duplicate-suites.mjs` enumerates (area, basename) pairs present under both locations and fails on any not in an expiring allowlist; runs in `grep-gates` (no deps).

**Oracles, priority order:** (1) DR-2 CI manifest gate — blocking, deterministic, bidirectional. (2) DR-3 coverage ratchet — blocking backstop, union-limited. Mutation (DR-4) deferred behind #1720.

## Integration Points

- `servers/exarchos-mcp/src/__tests__/{workflow,views,event-store}/*.test.ts` (7 active legacy twins + `state-store-resolve.test.ts`, `views/tools-error-paths.test.ts`) — **retired** into canonical targets.
- `servers/exarchos-mcp/src/{workflow,views,event-store}/*.test.ts` (7 canonical targets) — **receive** moved cases (via `--emit-merged`).
- `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared harness; verify importers, retain.
- `coverage-baseline.json`, `scripts/check-coverage-ratchet.mjs` — blocking backstop (unchanged).
- `.github/workflows/ci.yml` — new manifest-gate job (Task 004, deps lane) + duplicate-location ratchet (Task 012, grep-gates).
- New: `scripts/audit/consolidate-suite.mjs` (codegen + verify), `scripts/audit/check-no-duplicate-suites.mjs`, `scripts/audit/check-base-substrate.mjs`.

## Exploration

The divergent loop (no `/exarchos:discover` — grounded by in-repo recon) plus two adversarial plan-review rounds:

- **Option A — coverage-gated deletion:** rejected — coverage is union-blind.
- **Option B — mutation-anchored gate:** rejected — #1720 blocks the dry-run independent of scope; deferred (DR-4).
- **Option C — CI-enforced deterministic manifest gate + coverage backstop** (**chosen**).

**Audit trail.** Rev.0 (coverage-floor + advisory mutation) was refuted: no blocking oracle for assertion loss; coverage union-blind; mutation non-functional + inverted; 15 pairs not 7. Rev.1 introduced a manifest gate but round 2 refuted it three ways: the gate was prose, not CI-wired, and un-runnable after the legacy file is deleted (voter A/C); its identity ignored module-scope helpers, with a live `compensation` counter-example (voter B); the `--mutate` extension couldn't dodge #1720's dry-run (voter B). Rev.2 resolves these: per-pair PRs + merge-base reconstruction make the gate a real CI job; the tool does codegen and context-aware identity; mutation is honestly deferred.

## Alternatives considered

- **Keep both locations (status quo):** rejected — that is the divergence bug.
- **Delete legacy wholesale:** rejected — the legacy suite asserts *more* for state-machine/tools/state-store.
- **Local `git merge --no-ff` per pair, one synthesize PR (rev.1):** rejected — no CI event per pair, so the manifest gate could not enforce; hence per-pair PRs (DR-7).
- **Hand-merge the large suites:** rejected — multi-hour, crash-prone (project memory: crashed subagents lose WIP); the tool codegens the merge instead.
- **Consolidate all 15 pairs now:** deferred to wave 3b-2; the DR-1 guard holds the eight from further divergence meanwhile.
- **Top-20 large-suite minimization:** deferred.

## Open Questions

- **Scope: 7 now vs all 15.** Rev.2 keeps the bounded 7 and defers 8 (allowlisted). Expanding to 15 is viable (same tooling, larger fan-out) — a decision for the approval checkpoint.
- **Mutation re-enablement:** tracked to #1720; closeout files the follow-up.

## Decomposition

### Scope

**Target:** the 7 highest-value duplicate-location pairs + tooling/guards. **Excluded (deferred, tracked):** the 8 other pairs → wave 3b-2 (held from divergence by DR-1); top-20 minimization; non-pair `src/__tests__/` subdirs.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Single canonical location + area-qualified ratchet | 005, 006, 007, 008, 009, 010, 011, 012, 013 |
| DR-2 | CI-enforced bidirectional manifest gate | 001, 004, 005, 006, 007, 008, 009, 010, 011 |
| DR-3 | Coverage non-regression backstop (per PR) | 005, 006, 007, 008, 009, 010, 011, 013 |
| DR-4 | Mutation deferred (blocked #1720) | 013 |
| DR-5 | Keep-classes protected | 002, 005, 006, 007, 008, 009, 010, 011 |
| DR-6 | Substrate-backstop preservation | 001, 005, 008, 009, 011 |
| DR-7 | Per-pair PRs (enforcement seam), serialized | 004, 005, 006, 007, 008, 009, 010, 011, 013 |
| DR-8 | Base-substrate preflight | 003 |

### Tasks

Consolidation tasks are unusual: the test suite *is* the deliverable, so verification is "CI manifest gate (blocking) + coverage ratchet (blocking) + green suite," not a new test file.

### Task 001: Consolidation tool — codegen + bidirectional manifest verify (TypeScript compiler API)

**Risk Tier:** high
**Boundary Touching:** false
**Implements:** DR-2, DR-6
**Files:**
- `scripts/audit/consolidate-suite.mjs`
- `scripts/audit/consolidate-suite.test.ts`
**Verification:** high — the tool is the primary union-preservation mechanism: `--emit-merged` relocates every legacy case verbatim (deterministic codegen, no hand-merge) and `--verify` blocks on any case lost from either pre-image. Identity uses body + transitive referenced-context hash (enclosing hooks, module-scope helpers, resolved imports), so divergent same-named helpers block dedup. Uses the TypeScript compiler API (already a dependency; ts-morph is not in the tree). Scoped unit tests over crafted cases — identical, title-collision-but-divergent-body, identical-body-but-divergent-fixture, **identical-body-but-divergent-module-helper** (the live `compensation` `makeState` case), same-symbol-different-module-import — plus the `check_test_adequacy` kill-probe and an integration run over one real pair. A false `dedup-identical` is the campaign's core risk, adversarially tested.
**Dependencies:** None
**Parallelizable:** No (foundation)

### Task 002: Keep-class protected-file inventory + pre-flight guard

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5
**Files:**
- `scripts/audit/protected-suites.json`
- `scripts/audit/check-protected.mjs`
- `scripts/audit/check-protected.test.ts`
**Verification:** medium — scoped test asserting the guard flags a change-set intersecting a keep-class glob and passes a clean one; inventory generated from live keep-class globs + named adjacent files.
**Dependencies:** None
**Parallelizable:** Yes

### Task 003: Base-substrate preflight (delegate-phase dispatch check)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-8
**Files:**
- `scripts/audit/check-base-substrate.mjs`
- `scripts/audit/check-base-substrate.test.ts`
**Verification:** medium — asserts the #1719 substrate is present on the base and aborts dispatch when absent (local `2f4c0e23` is the negative fixture). The delegate phase runs it as a dispatch check before each wave; pairs depend on it so the script exists first. (Belt-and-suspenders: default isolation bases on `origin/main`, which already has the substrate.)
**Dependencies:** None
**Parallelizable:** Yes

### Task 004: CI manifest-gate job — merge-base pre-image reconstruction

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2, DR-7
**Files:**
- `.github/workflows/ci.yml`
- `scripts/audit/manifest-gate-ci.mjs`
- `scripts/audit/manifest-gate-ci.test.ts`
**Verification:** high — a CI job on consolidation PRs that, for each retired subject in the diff, reconstructs the pre-image legacy and canonical via `git show <merge-base>:<path>` and runs `consolidate-suite.mjs --verify`, blocking the PR on any lost/unproven case. This is the enforcement seam that makes DR-2 a gate rather than discipline. Runs in a server-deps lane (parses TS). Scoped test covering a PR that drops a case (fails) and a clean relocation (passes), including a dropped **pre-existing canonical** case (bidirectional).
**Dependencies:** 001
**Parallelizable:** No (foundation for the pairs' enforcement)

### Task 005: Consolidate `guards` pair (INV-8 pilot)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/guards.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts` (retired)
**Verification:** high — lands as its own PR; blocking CI manifest gate (bidirectional, every case from both pre-images accounted); coverage non-regression backstop ≥ baseline; green suite. Substrate-backstop preservation of the invariant INV-8 (idempotent-retry cases classified `moved`). Pilot: smallest INV-8 pair, validates tool codegen + CI gate end-to-end.
**Dependencies:** 001, 002, 003, 004
**Parallelizable:** Yes (pilot group)

### Task 006: Consolidate `state-machine` pair (asymmetry + high-volume pilot)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate; coverage backstop ≥ baseline; green suite. Pilot: legacy asserts 4× the co-located (3338→876) — highest merge-volume; the `--emit-merged` codegen (not a hand-merge) collapses the effort/crash risk. Must not touch adjacent `state-machine.property.test.ts` (keep-class).
**Dependencies:** 001, 002, 003, 004
**Parallelizable:** Yes (pilot group)

### Task 007: Consolidate `tools` (workflow) pair

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/tools.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate run with the eight co-located `tools.*.test.ts` split files included as canonical pre-image context (a case already in a split file is dedup-identical, not re-moved); coverage backstop ≥ baseline; green suite. Codegen'd merge (3387-line legacy). Must not touch adjacent `tools.update.race.test.ts` (keep-class).
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 008: Consolidate `compensation` pair (INV-8)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/compensation.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/compensation.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate — the divergent `makeState` module helpers make its context-aware identity load-bearing here (a naive body-only hash would false-dedup); coverage backstop ≥ baseline; green suite. Substrate-backstop preservation of the invariant INV-8, idempotent-retry cases `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 009: Consolidate `state-store` pair (INV-1)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/workflow/state-store.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts` (retired)
- `servers/exarchos-mcp/src/__tests__/workflow/state-store-resolve.test.ts` (retired — fold in)
**Verification:** high — own PR; blocking CI manifest gate (both legacy files as pre-image); coverage backstop ≥ baseline; green suite. Substrate-backstop preservation of the invariant INV-1, reducer/projection cases `moved`.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 010: Consolidate `views/handlers` pair

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:**
- `servers/exarchos-mcp/src/views/handlers.test.ts` (canonical target)
- `servers/exarchos-mcp/src/__tests__/views/handlers.test.ts` (retired)
- `servers/exarchos-mcp/src/__tests__/views/tools-error-paths.test.ts` (retired — fold in)
**Verification:** high — own PR; blocking CI manifest gate (both legacy files as pre-image); coverage backstop ≥ baseline; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 011: Consolidate `event-store schemas` pair (INV-1, largest target)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:**
- `servers/exarchos-mcp/src/event-store/schemas.test.ts` (canonical target, 4702 ln)
- `servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts` (retired)
**Verification:** high — own PR; blocking CI manifest gate — bidirectional check is load-bearing given the 4702-line canonical target (a pre-existing case dropped during merge is caught); coverage backstop ≥ baseline; green suite. Substrate-backstop preservation of the invariant INV-1, schema-validation cases `moved`. Codegen'd merge; must not touch adjacent `schemas.onboard.test.ts`. Sequence last.
**Dependencies:** 001, 002, 003, 004, 005, 006
**Parallelizable:** Yes (main wave)

### Task 012: Duplicate-location ratchet guard (area-qualified, expiring allowlist)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-1
**Files:**
- `scripts/audit/check-no-duplicate-suites.mjs`
- `scripts/audit/check-no-duplicate-suites.test.ts`
- `.github/workflows/ci.yml`
**Verification:** medium — a real (area, basename) intersection guard that fails when a legacy twin exists for any co-located subject not in the expiring allowlist; scoped test covering both directions **and** the cross-area collision (`schemas`, `tools`). Wired into `grep-gates` (no deps). Allowlist carries exactly the eight deferred pairs after the seven land. Lands after the pairs.
**Dependencies:** 005, 006, 007, 008, 009, 010, 011
**Parallelizable:** No

### Task 013: Campaign closeout + coverage-series verification + wave 3b-2 handoff

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-3, DR-4, DR-7
**Files:**
- `docs/specs/2026-07-18-test-mass-consolidation.md` (closeout notes)
**Verification:** medium — confirm none of the seven subjects remains a duplicate-location pair (Task 012 guard green, eight-pair allowlist), every per-pair PR passed the manifest gate + coverage ratchet in CI, then file wave 3b-2 for the eight deferred pairs, record the #1720 mutation-re-enablement follow-up, and update epic #1705.
**Dependencies:** 012
**Parallelizable:** No

### Parallelization

Critical path: **001 → 004 → {005, 006} (pilots) → {007, 008, 009, 010, 011} (main wave) → 012 → 013.**

- 002, 003 run in parallel with 001; 004 (CI gate) depends on 001.
- Delegate runs Task 003 (base-substrate check) before each wave; pairs base on `origin/main` (≥ #1719).
- Pilots 005 (guards, INV-8) and 006 (state-machine, highest-volume) validate tool codegen + CI gate before the fan-out.
- Main-wave 007–011 run concurrently in isolated worktrees, each landing as its own CI-gated PR.
- **Per-pair PRs are the enforcement seam (DR-7):** each triggers the DR-2 manifest gate + DR-3 ratchet in CI; PRs land serially (stacked; manual sequential merge where `serialize_merge` is capability-denied).
- 012 (ratchet guard) lands after all pairs; 013 closes out and hands off wave 3b-2.

### Completion checklist

- [ ] Every DR-N maps to at least one task; every task Implements an existing DR-N
- [ ] Every task carries a `riskTier` stamp
- [ ] High-tier tasks carry adequacy-judged verification (CI manifest gate + coverage + green suite)
- [ ] Open questions resolved or explicitly deferred
- [ ] Ready for `plan-review`
