# Spec: Test-suite de-divergence (debloat wave 3b)

**Date:** 2026-07-18 · **Feature:** `test-mass-consolidation` · **Depth:** deep
**Inputs:** epic #1701 · issue #1705 · parent spec `docs/specs/2026-07-15-debloat-wave1-structural-enforcement.md` · coverage/mutation substrate PR #1719 (`c78450c7`, on `origin/main`) · CI-substrate lessons from Wave S (#1711 — `ci-gate.needs` semantics)
**Revisions:** rev.0 → rev.1 → rev.2 → rev.3 → **rev.4**. Three 3-voter adversarial rounds (9 voters) — see Exploration for the full trail.

> One unified artifact: `## Requirements` holds the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Anchored to `.exarchos/invariants.md` (dev catalog enabled). The tests are the mechanical backstops for substrate invariants, so several "keep classes" map to invariants — parity (INV-2), race (INV-7), and the reducer/projection/schema suites (INV-1); the `withSession` retry tests are INV-8's sole deterministic backstop.

Two hard-won constraints from review govern the whole design:
- **No oracle can be trusted to prove two test cases equivalent.** Coverage is union-blind; mutation is blocked (#1720); a semantic identity hash silently ignores `vi.mock`/`vi.hoisted`/env context that changes behavior. The only safe equivalence signal is **textual identity** of the case *and* its enclosing file preamble (modulo import-path rewrites).
- **Vitest module mocks are file-scoped and non-composable.** A file can hold one `vi.mock('X', …)`. Two twins mocking the same module differently **cannot** be merged into one file without behavior change — so a naive "merge into one file" is unsound; the safe operation is preamble-conditional.

## Design & Rationale

### Problem Statement

Units are tested from **two directories** — a legacy `servers/exarchos-mcp/src/__tests__/<area>/<x>.test.ts` copy and a co-located `src/<area>/<x>.test.ts` copy — that have **diverged** (line counts differ in both directions; the larger side flips per subject; each asserts things the other does not). An authoritative enumeration (every `src/__tests__/**/*.test.ts` with a co-located twin) finds **17** such pairs — not the 7 the audit named, nor the 15 an earlier revision assumed. The inventory is **mechanically enumerated, not hand-listed** (a hand count drifted 7→15→17 across review); the 17 below are as enumerated on 2026-07-18 and the enumerator + ratchet (Tasks 001/022) are the authority:

| # | Subject (area/base) | legacy | co-located | larger | substrate | known preamble |
|---|---|---|---|---|---|---|
| 1 | workflow/state-machine | 3338 | 876 | legacy | | tbd |
| 2 | workflow/tools | 3387 | 817 (+8 splits) | legacy | | tbd |
| 3 | workflow/state-store | 1544 (+resolve 36) | 1213 | legacy | INV-1 | **relocate** (22 mock/env vs 0) |
| 4 | workflow/compensation | 1166 | 1663 | co-located | INV-8 | **relocate** (child_process mock diverges) |
| 5 | workflow/guards | 762 | 1247 | co-located | INV-8 | tbd |
| 6 | workflow/checkpoint | 353 | 889 | co-located | | tbd |
| 7 | workflow/migration | 240 | 149 | legacy | | tbd |
| 8 | workflow/schemas | 1030 | 779 | legacy | INV-1 | tbd |
| 9 | views/handlers | 793 (+err 116) | 1979 | co-located | | tbd |
| 10 | views/materializer | 481 | 733 | co-located | INV-1 | tbd |
| 11 | views/pipeline-view | 257 | 169 | legacy | | tbd |
| 12 | views/snapshot-store | 417 | 147 | legacy | | tbd |
| 13 | views/task-detail-view | 114 | 166 | co-located | | tbd |
| 14 | event-store/schemas | 1006 | 4702 (+onboard 196) | co-located | INV-1 | tbd |
| 15 | event-store/tools | 511 | 1092 | co-located | INV-1 | tbd |
| 16 | sync/outbox | 435 | 210 | legacy | | tbd |
| 17 | utils/process | 17 | 59 | co-located | | tbd |

The durable defect is **structural**: one unit tested from two drifting directories. Review established that safe automated dedup is near-zero across diverged, mock-incompatible twins — so **this is a de-divergence campaign (collapse to one directory, lock with a ratchet), roughly LoC-neutral; it is *not* the "largest LoC lever" the audit framed.** The value is eliminating a real maintenance hazard, honestly scoped.

### Chosen Approach

**Per pair, the tool chooses merge-or-relocate on textual preamble compatibility; a CI gate proves no case was lost.** A TypeScript-compiler-API + textual tool (Task 001), per pair:
- **Merge** the legacy cases into the co-located canonical file **iff** the two files' module-scope preambles (imports, `vi.mock`/`vi.hoisted`/`vi.stubEnv`/`vi.stubGlobal`, module-scope helpers/consts, hooks) are **textually identical modulo import-path rewrites** — then drop only cases that are textually identical (modulo imports) to one already present, and move the rest. Identical preambles ⇒ no divergent mock or colliding helper to mishandle, so the merge is sound by construction.
- **Relocate** otherwise: move the legacy file into the co-located directory as a distinct sibling (e.g. `<x>.legacy.test.ts`), unchanged except import-path rewrites. This kills the two-directory divergence without forcing incompatible mocks into one file. `state-store` and `compensation` are known relocate cases.

Either way, the legacy `__tests__/` copy is gone. Each pair lands as its own PR; a **CI job wired into `ci-gate.needs`** (so it actually blocks) reconstructs both pre-images from the merge-base (`git show`, `fetch-depth: 0`) and fails the PR unless every pre-image case is present in the PR-HEAD result (merged file or relocated sibling) or is a textually-proven duplicate. Coverage non-regression (#1719) is a union-limited backstop; mutation is deferred (#1720). A ratchet guard forbids any `__tests__/` twin for any co-located subject, allowlist shrinking to **0**. Chosen via the `deep`-rung decisions (scope = all 17 pairs; operation = preamble-conditional merge/relocate; oracle = textual-identity CI gate primary + coverage backstop).

## Requirements

### DR-1: One directory per subject for all 17 pairs, ratchet to an empty allowlist

Each of the 17 subjects ends tested from its co-located directory only — legacy cases either merged into the twin file (preamble-compatible) or the legacy file relocated as a co-located sibling (preamble-divergent). The pair inventory is mechanically enumerated (not hand-listed). A CI ratchet guard forbids a legacy `__tests__/<area>/<base>.test.ts` twin for any co-located subject, keyed on **(area, basename)** (because `schemas` and `tools` are pairs in two areas each), allowlist shrinking to **0**.

**Acceptance criteria:**
- After the campaign, no subject has a `src/__tests__/…` twin of a co-located file; the guard's allowlist is empty.
- The guard and the inventory come from one (area, basename) intersection enumerator (not a brace-glob `git ls-files`, which is vacuously green); its test covers the cross-area collision (`workflow/schemas` vs `event-store/schemas`; `workflow/tools` vs `event-store/tools`) and confirms the count is 17 against the live tree.
- The full server suite is green after each pair.

### DR-2: Textual-identity CI gate, ci-gate-wired and bidirectional (the primary guarantee)

The guarantee is a **required CI check**, using only **textual** equivalence (no semantic hash). On each per-pair PR the job reconstructs the pre-image legacy and pre-image canonical from the merge-base and asserts every case in either pre-image is present in the PR-HEAD result (merged file or relocated sibling) verbatim modulo import-path rewrites, **or** is a textually-proven duplicate (case body **and** full file preamble textually identical modulo imports). Merge is permitted only under preamble textual identity; otherwise the pair must relocate. This closes, by construction, the `vi.mock`/`vi.hoisted`/env-divergence and module-scope symbol-collision channels a semantic oracle missed.

**Acceptance criteria:**
- The gate runs as a CI job **added to `ci-gate.needs` (or as a step in an already-required job)** with `fetch-depth: 0`, reconstructing pre-images via `git show <merge-base>:<path>`; it **blocks** on any pre-image case absent from the result and not a textual duplicate. A job merely present in ci.yml but absent from `ci-gate.needs` fails open and does not satisfy this.
- Dedup requires case + full-preamble textual identity modulo imports; a merge is rejected (pair must relocate) if preambles differ. The tool ships fixtures for: preamble-identical merge, preamble-divergent → relocate, `vi.mock`-factory-divergent → relocate, textual-duplicate-case → dedup.
- The committed per-pair manifest matches the gate's independent recomputation from the merge-base.

### DR-3: Coverage non-regression backstop (blocking per PR, union-limited)

The blocking coverage ratchet (#1719 — `scripts/check-coverage-ratchet.mjs` reading `servers/exarchos-mcp/coverage-baseline.json`; lines 91.6 / statements 91.6 / functions 96.24 / branches 85.38; 0.1pp floored epsilon; fail-closed) runs on each per-pair PR. It is a **backstop, not the assertion-loss guarantee** (line coverage is union-blind); coverage config excludes test files from the denominator, so relocation/merge is production-coverage-neutral.

**Acceptance criteria:**
- Each per-pair PR passes the ratchet (blocking, no `--observe`) against the committed baseline at `servers/exarchos-mcp/coverage-baseline.json`; the baseline is never lowered.
- Fail-closed preserved (missing/unparseable summary or baseline → exit 2).
- Reviews treat green coverage as necessary-not-sufficient; DR-2 is the assertion-loss authority.

### DR-4: Mutation-adequacy is deferred (blocked by #1720), not relied upon

Mutation is the ideal oracle but cannot run: #1720's failure is StrykerJS's full-suite **dry-run**, upstream of and independent of `--mutate` scope (confirmed by the round-3 panel; origin/main's gate is `--observe`, PR-only). The campaign does not rely on it.

**Acceptance criteria:**
- No task blocks on a mutation run; no acceptance criterion requires a kill-set.
- Closeout (Task 023) records that when #1720 lands, a source-targeted spot-check over the consolidated modules is added as advisory confirmation.

### DR-5: Keep-classes are out of scope and protected

Dedicated keep-class suites — parity (`*.parity.test.ts` + `views/parity`, `event-store/parity`), race (`*.race.test.ts`), property (`*.property.test.ts`), characterization (`*.characterization.test.ts`), acceptance (`*.acceptance.test.ts`) — are not consolidation targets. Keep-class status is by **dedicated-suite suffix**, not by a file merely importing `fast-check` (e.g. `event-store/tools.test.ts` imports fast-check but is a mixed consolidation target; its property cases relocate/merge verbatim).

**Acceptance criteria:**
- The campaign's changed-file set intersected with the keep-class suffix globs is empty.
- Co-located keep-class files adjacent to targets are in a pre-flight protected inventory and untouched — including `state-machine.property.test.ts`, `tools.update.race.test.ts`, `views/materializer.property.test.ts`, and the shared `src/__tests__/parity-harness.ts`. (No `state-store.acceptance` file exists; the inventory is generated from the live tree, not hand-listed.)
- If any retired legacy file imports `parity-harness.ts`, the harness is retained and importers re-pointed.

### DR-6: Substrate-backstop preservation via the uniform gate

Because the DR-2 textual gate is **uniform across all 17 pairs** and bidirectional, the INV-1 (state-store, event-store schemas, event-store/tools, workflow/schemas, views/materializer) and INV-8 (compensation, guards) backstop assertions get the same by-construction protection as every pair — no reliance on invariant-keyed mutation.

**Acceptance criteria:**
- INV-8 idempotent-retry cases and INV-1 reducer/projection/schema-validation cases are present (merged or relocated) in the result and named in the PR; none is dropped except as a textual duplicate.
- Oracle strength is not keyed to invariant membership.

### DR-7: Per-pair PRs (the enforcement seam), ci-gate-wired, serialized

Each pair lands as its own PR so the DR-2 gate + DR-3 ratchet run in CI per pair — a local `git merge --no-ff` triggers no CI and cannot enforce. PRs land serially so the ratchet sees a coherent cumulative state.

**Acceptance criteria:**
- Each consolidation lands via its own PR that triggers the DR-2 gate (ci-gate-required) + DR-3 ratchet; no pair merges via a CI-invisible local merge.
- PRs land single-writer (stacked; manual sequential merge where `serialize_merge` is `CAPABILITY_DENIED`).
- **Operational risk (accepted):** 17 serialized coverage-instrumented PRs each re-run the MCP suite, exposing the campaign ~17× to the documented flaky-E2E / perf / `SQLITE_BUSY` class; mitigation is `gh run rerun --failed` per the known-flake runbook, not baseline relaxation.

### DR-8: Base-substrate preflight (a delegate-phase dispatch check)

The campaign requires the #1719 substrate on its base. Worktree isolation bases on `origin/HEAD` (= `origin/main` = `c78450c7`, which has it), so the common path is safe; the preflight is an explicit dispatch-time check.

**Acceptance criteria:**
- The delegate phase runs the Task 003 check before each wave and aborts dispatch if `servers/exarchos-mcp/coverage-baseline.json` + `scripts/check-coverage-ratchet.mjs` are absent on the base (local `2f4c0e23` is the negative fixture); pairs depend on Task 003.
- Pair worktrees base on `origin/main` (≥ `c78450c7`) or a later integration branch including #1719.

## Technical Design

**The tool (Task 001).** `scripts/audit/consolidate-suite.mjs` (TypeScript compiler API for case/preamble extraction; textual comparison for equivalence). Modes: `--enumerate` (list all (area, basename) duplicate pairs — the authoritative inventory); `--plan <pair>` (classify merge vs relocate by textual preamble identity modulo imports); `--emit` (produce the merged canonical file *or* the relocated sibling); `--verify <pair>` (from two pre-image files + the result, assert every pre-image case is present verbatim-modulo-imports or a textual duplicate — the check the CI gate runs). Equivalence is textual, never a semantic hash, so `vi.mock`/`vi.hoisted`/env divergence forces relocate, not a silent drop. Because merge requires identical preambles, no module-scope symbol collision or divergent mock can occur in a merged file.

**The CI gate (Task 004).** A ci.yml job on consolidation PRs, `fetch-depth: 0`, added to **`ci-gate.needs`** (the repo's required-check aggregator — a job absent from it fails open, per the Wave-S lesson); reconstructs pre-images via `git show <merge-base>:<path>` and runs `--verify`, blocking on failure. Server-deps lane.

**Ratchet guard (Task 022).** `check-no-duplicate-suites.mjs` uses the same `--enumerate` logic; fails on any (area, basename) twin not in a shrinking allowlist; runs in `grep-gates` (no deps).

**Oracles, priority order:** (1) DR-2 textual CI gate — blocking, ci-gate-wired, deterministic. (2) DR-3 coverage ratchet — blocking backstop, union-limited. Mutation deferred (#1720).

## Integration Points

- `servers/exarchos-mcp/src/__tests__/<area>/*.test.ts` (17 legacy twins + fold-ins `state-store-resolve`, `views/tools-error-paths`) — retired (merged or relocated).
- `servers/exarchos-mcp/src/<area>/*.test.ts` (17 canonical dirs) — receive merged cases or a relocated sibling.
- `servers/exarchos-mcp/src/__tests__/parity-harness.ts` — shared harness; verify importers, retain.
- `servers/exarchos-mcp/coverage-baseline.json`, `scripts/check-coverage-ratchet.mjs` — blocking backstop (path corrected — baseline is under `servers/exarchos-mcp/`).
- `.github/workflows/ci.yml` — manifest-gate job wired into `ci-gate.needs` with `fetch-depth: 0` (Task 004) + duplicate-location ratchet in `grep-gates` (Task 022).
- New: `scripts/audit/consolidate-suite.mjs`, `scripts/audit/manifest-gate-ci.mjs`, `scripts/audit/check-no-duplicate-suites.mjs`, `scripts/audit/check-base-substrate.mjs`, `scripts/audit/check-protected.mjs`.

## Exploration

Divergent loop (no `/exarchos:discover`) + three adversarial rounds:
- **A — coverage-gated deletion:** rejected (coverage union-blind).
- **B — mutation-anchored gate:** rejected (#1720 blocks the dry-run); deferred (DR-4).
- **C — CI-enforced textual gate + preamble-conditional merge/relocate** (**chosen**).

**Audit trail.** Rev.0 refuted: no blocking oracle; 15 pairs not 7; mutation inverted. Rev.1 refuted: gate was prose + un-runnable post-deletion; identity ignored module-scope helpers; `--mutate` can't dodge #1720. Rev.2 (per-pair PRs + merge-base reconstruction + codegen + context-aware identity) round-3-refuted: identity still ignored `vi.mock`/`vi.hoisted`/env; **the file-merge itself is unsound where module-scope mocks diverge** (vitest mocks are file-scoped); 17 pairs not 15; CI job not blocking unless in `ci-gate.needs`. Rev.3 expanded to 15. **Rev.4** (this): textual-only equivalence + preamble-conditional merge/relocate (dissolves the mock/symbol channel by construction), 17 pairs mechanically enumerated, gate wired into `ci-gate.needs` with `fetch-depth: 0`, path + keep-class-framing corrections. The round-3 panel confirmed as *sound*: merge-base reconstruction, the per-pair-PR model, and the mutation deferral.

## Alternatives considered

- **Keep both directories (status quo):** rejected — the divergence bug.
- **Delete legacy wholesale:** rejected — legacy asserts *more* for several pairs.
- **Force every pair into one file (rev.2/3):** rejected — unsound where module-scope mocks diverge (vitest file-scoping); hence preamble-conditional relocate.
- **Semantic identity hash:** rejected — silently ignores mock/env context; textual identity only.
- **Local `git merge --no-ff` per pair:** rejected — no CI event; per-pair PRs instead.
- **Defer 8/10 pairs (rev.2):** superseded — checkpoint chose all 17.
- **Top-20 large-suite minimization:** deferred.

## Open Questions

- **Merge vs relocate split is data-dependent:** the `--plan` mode determines it per pair at implementation; the pilots (005/006) report the realized split so the main-wave effort estimate firms up. `state-store`/`compensation` are known relocate.
- **Mutation re-enablement:** tracked to #1720; closeout files the follow-up.

## Decomposition

### Scope

**Target:** all 17 duplicate-location pairs + tooling/guards. **Excluded:** top-20 large-suite minimization; legacy-only `__tests__/` files with no co-located twin (e.g. `stack/`, `tasks/`, `integration/`, `benchmarks/`, `skills/`) — not divergence pairs.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | One directory per subject + ratchet (empty allowlist) | 005–021, 022, 023 |
| DR-2 | Textual-identity CI gate (ci-gate-wired, bidirectional) | 001, 004, 005–021 |
| DR-3 | Coverage non-regression backstop | 005–021, 023 |
| DR-4 | Mutation deferred (#1720) | 023 |
| DR-5 | Keep-classes protected | 002, 005–021 |
| DR-6 | Substrate-backstop preservation | 001, 005, 008, 009, 014, 015, 019 |
| DR-7 | Per-pair PRs (enforcement seam), serialized | 004, 005–021, 023 |
| DR-8 | Base-substrate preflight | 003 |

(“005–021” denotes each of tasks 005 through 021 individually — the 17 pairs.)

### Tasks

All 17 pair tasks are high-tier, boundary-touching; each lands as its own PR (DR-7) gated by the DR-2 CI check; each is merge-or-relocate per the tool's `--plan`. Verification per pair = DR-2 textual gate (blocking) + DR-3 coverage ratchet (blocking) + green suite.

### Task 001: Consolidation tool — enumerate / plan(merge|relocate) / emit / verify (textual, TS compiler API)

**Risk Tier:** high · **Boundary Touching:** false · **Implements:** DR-2, DR-6
**Files:** `scripts/audit/consolidate-suite.mjs`, `scripts/audit/consolidate-suite.test.ts`
**Verification:** high — textual equivalence only (no semantic hash); `--plan` classifies merge vs relocate by full-preamble textual identity modulo imports; `--emit` produces the merged file or relocated sibling; `--verify` is the CI gate's check. Fixtures: preamble-identical→merge, preamble-divergent→relocate, `vi.mock`-factory-divergent→relocate, `vi.hoisted`-state-divergent→relocate, textual-duplicate-case→dedup, import-path-only-diff→duplicate. `check_test_adequacy` kill-probe + integration run over one real pair.
**Dependencies:** None · **Parallelizable:** No (foundation)

### Task 002: Keep-class protected-file inventory + pre-flight guard (generated from the live tree)

**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-5
**Files:** `scripts/audit/protected-suites.json`, `scripts/audit/check-protected.mjs`, `scripts/audit/check-protected.test.ts`
**Verification:** medium — inventory generated from live keep-class suffix globs + named adjacent files (`state-machine.property`, `tools.update.race`, `views/materializer.property`, `parity-harness.ts`); guard flags a change-set intersecting a keep-class glob, passes a clean one.
**Dependencies:** None · **Parallelizable:** Yes

### Task 003: Base-substrate preflight (delegate-phase dispatch check)

**Risk Tier:** low · **Boundary Touching:** false · **Implements:** DR-8
**Files:** `scripts/audit/check-base-substrate.mjs`, `scripts/audit/check-base-substrate.test.ts`
**Verification:** medium — asserts `servers/exarchos-mcp/coverage-baseline.json` + `scripts/check-coverage-ratchet.mjs` present on the base; aborts dispatch when absent (local `2f4c0e23` negative fixture); delegate runs it before each wave.
**Dependencies:** None · **Parallelizable:** Yes

### Task 004: CI textual-gate job — merge-base reconstruction, fetch-depth:0, wired into ci-gate.needs

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-2, DR-7
**Files:** `.github/workflows/ci.yml`, `scripts/audit/manifest-gate-ci.mjs`, `scripts/audit/manifest-gate-ci.test.ts`
**Verification:** high — CI job on consolidation PRs, `fetch-depth: 0`, reconstructs both pre-images via `git show <merge-base>:<path>` and runs `--verify`, blocking on any lost/unproven case; **added to `ci-gate.needs`** so it is a required check (a job absent from the aggregator fails open — the Wave-S lesson). Scoped test: PR dropping a legacy case (fails), dropping a pre-existing canonical case (fails, bidirectional), clean merge (passes), clean relocate (passes).
**Dependencies:** 001 · **Parallelizable:** No (foundation)

### Task 005: Consolidate workflow/guards (INV-8 pilot)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/guards.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
**Verification:** high — own PR; `--plan` decides merge/relocate; DR-2 textual gate (bidirectional) blocking; coverage backstop ≥ baseline; green suite; substrate-backstop preservation of the invariant INV-8 (idempotent-retry cases present). Pilot: validates tool + ci-gate wiring end-to-end and reports the realized merge/relocate split.
**Dependencies:** 001, 002, 003, 004 · **Parallelizable:** Yes (pilot group)

### Task 006: Consolidate workflow/state-machine (asymmetry + high-volume pilot)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/state-machine.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/state-machine.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite. Pilot: highest merge-volume (3338 legacy). Must not touch adjacent `state-machine.property.test.ts` (keep-class).
**Dependencies:** 001, 002, 003, 004 · **Parallelizable:** Yes (pilot group)

### Task 007: Consolidate workflow/tools

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/tools.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts`
**Verification:** high — own PR; DR-2 gate run with the eight co-located `tools.*.test.ts` split files as canonical context (a case already split out is a textual duplicate, not re-added); coverage backstop; green suite. Must not touch `tools.update.race.test.ts`.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 008: Consolidate workflow/compensation (INV-8, known relocate)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/compensation.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/compensation.test.ts`
**Verification:** high — own PR; the twins' `child_process` mocks diverge (sync vs async factory) so `--plan` yields **relocate** (legacy file moved co-located as a sibling, not force-merged); DR-2 gate confirms every legacy case present verbatim; coverage backstop; green suite; INV-8 idempotent-retry cases preserved.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 009: Consolidate workflow/state-store (INV-1, known relocate)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/state-store.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/state-store.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/state-store-resolve.test.ts` (fold-in)
**Verification:** high — own PR; legacy has 22 module-scope mock/env constructs vs 0 co-located → `--plan` yields **relocate**; DR-2 gate (all three source files as pre-image) confirms presence; coverage backstop; green suite; INV-1 reducer/projection cases preserved.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 010: Consolidate views/handlers

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/handlers.test.ts`, `servers/exarchos-mcp/src/__tests__/views/handlers.test.ts`, `servers/exarchos-mcp/src/__tests__/views/tools-error-paths.test.ts` (fold-in)
**Verification:** high — own PR; DR-2 gate (both legacy files as pre-image); coverage backstop; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 011: Consolidate event-store/schemas (INV-1, largest target)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/event-store/schemas.test.ts`, `servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts`
**Verification:** high — own PR; DR-2 gate (bidirectional load-bearing given the 4702-line canonical); coverage backstop; green suite; INV-1 schema-validation cases preserved. Must not touch `schemas.onboard.test.ts`. Sequence late.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 012: Consolidate workflow/checkpoint

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/checkpoint.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/checkpoint.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 013: Consolidate workflow/migration

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/migration.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/migration.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 014: Consolidate workflow/schemas (INV-1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/workflow/schemas.test.ts`, `servers/exarchos-mcp/src/__tests__/workflow/schemas.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite; INV-1 cases preserved. Distinct from event-store/schemas (Task 011) — the (area, basename) allowlist must not conflate them.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 015: Consolidate views/materializer (INV-1 projection)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/views/materializer.test.ts`, `servers/exarchos-mcp/src/__tests__/views/materializer.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite; INV-1 (projection) cases preserved. **Must not touch adjacent `views/materializer.property.test.ts` (keep-class).**
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 016: Consolidate views/pipeline-view

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/pipeline-view.test.ts`, `servers/exarchos-mcp/src/__tests__/views/pipeline-view.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 017: Consolidate views/snapshot-store

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/snapshot-store.test.ts`, `servers/exarchos-mcp/src/__tests__/views/snapshot-store.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 018: Consolidate views/task-detail-view

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/views/task-detail-view.test.ts`, `servers/exarchos-mcp/src/__tests__/views/task-detail-view.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite. Smallest pair.
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 019: Consolidate event-store/tools (INV-1)

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-6, DR-7
**Files:** `servers/exarchos-mcp/src/event-store/tools.test.ts`, `servers/exarchos-mcp/src/__tests__/event-store/tools.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite; INV-1 cases preserved. This canonical file imports `fast-check` (a mixed file, not a dedicated property suite — its fc cases relocate/merge verbatim). Distinct from workflow/tools (Task 007). 
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 020: Consolidate sync/outbox

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/sync/outbox.test.ts`, `servers/exarchos-mcp/src/__tests__/sync/outbox.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite. (Missed by the audit and by rev.0–3; surfaced by the round-3 exhaustive enumeration.)
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 021: Consolidate utils/process

**Risk Tier:** high · **Boundary Touching:** true · **Implements:** DR-1, DR-2, DR-3, DR-5, DR-7
**Files:** `servers/exarchos-mcp/src/utils/process.test.ts`, `servers/exarchos-mcp/src/__tests__/utils/process.test.ts`
**Verification:** high — own PR; DR-2 gate; coverage backstop; green suite. Disjoint assertions (legacy tests `isPidAlive`; co-located tests `needsWindowsShell`/`runCommandSync`/`spawnCommandSync`) — `--plan` likely **relocate** or additive merge; the gate proves `isPidAlive` coverage is not dropped. (Also missed until round-3 enumeration.)
**Dependencies:** 001, 002, 003, 004, 005, 006 · **Parallelizable:** Yes (main wave)

### Task 022: Duplicate-location ratchet guard (area-qualified, allowlist → empty)

**Risk Tier:** medium · **Boundary Touching:** true · **Implements:** DR-1
**Files:** `scripts/audit/check-no-duplicate-suites.mjs`, `scripts/audit/check-no-duplicate-suites.test.ts`, `.github/workflows/ci.yml`
**Verification:** medium — a real (area, basename) intersection guard (shares Task 001's `--enumerate` logic) failing on any twin not in the allowlist; test covers both directions **and** the cross-area collision (`schemas`, `tools`) and asserts the live count is 17. Wired into `grep-gates`. After all 17 land, the allowlist is empty.
**Dependencies:** 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 021 · **Parallelizable:** No

### Task 023: Campaign closeout + coverage-series verification + #1720 mutation handoff

**Risk Tier:** medium · **Boundary Touching:** false · **Implements:** DR-1, DR-3, DR-4, DR-7
**Files:** `docs/specs/2026-07-18-test-mass-consolidation.md`
**Verification:** medium — confirm none of the 17 subjects remains a duplicate-location pair (Task 022 guard green, empty allowlist), every per-pair PR passed the DR-2 gate + coverage ratchet in CI, record the realized merge/relocate split and the #1720 mutation-re-enablement follow-up, update epic #1705 with the de-divergence (not LoC-lever) reframe.
**Dependencies:** 022 · **Parallelizable:** No

### Parallelization

Critical path: **001 → 004 → {005, 006} (pilots) → {007–021} (main wave, 15 pairs) → 022 → 023.**

- 002, 003 run in parallel with 001; 004 (CI gate) depends on 001.
- Delegate runs Task 003 before each wave; pairs base on `origin/main` (≥ #1719).
- Pilots 005 (guards, INV-8) and 006 (state-machine, high-volume) validate the tool + ci-gate wiring and report the realized merge/relocate split before the fan-out.
- Main-wave 007–021 run concurrently in isolated worktrees, each a distinct co-located file + distinct legacy file (no conflicts); only 004/022 touch `ci.yml` and are sequenced.
- **Per-pair PRs are the enforcement seam (DR-7):** each triggers the ci-gate-required DR-2 gate + DR-3 ratchet; PRs land serially. Accept ~17× flaky-CI exposure; mitigate with `gh run rerun --failed`.
- 022 lands after all 17 pairs; 023 closes out.

### Completion checklist

- [ ] Every DR-N maps to a task; every task Implements an existing DR-N
- [ ] Every task carries a `riskTier` stamp
- [ ] High-tier tasks carry adequacy-judged verification (DR-2 textual gate + coverage + green suite)
- [ ] Open questions resolved or explicitly deferred
- [ ] Ready for `plan-review`
