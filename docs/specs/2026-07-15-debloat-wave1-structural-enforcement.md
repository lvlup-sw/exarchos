# Spec: Debloat Wave 1 + Structural-Enforcement Ratchet

**Date:** 2026-07-15 · **Feature:** `debloat-wave1-structural-enforcement` · **Depth:** standard
**Inputs:** the exarchos-debloat audit bundle (audit @ `main@f70b1e8`, 2026-07-08; distributed as a local untracked `docs/exarchos-debloat-audit-bundle.zip` — not in version control); this session's re-verification @ `main@b3a58d7a` (2026-07-15): detectors re-run on current main + three read-only comb passes over every load-bearing claim. The bundle's detectors are **vendored in-repo on this branch at `scripts/audit/{refgraph,cycle-hubs,compose}.mjs`** (smoke-tested against the current tree), so every acceptance criterion below is executable from the repo alone. Bundle-sourced measurements (install MiB, decay rates, the ~50-type census) are targeting guidance; every number an acceptance criterion depends on is re-measured by its own task.

> One unified artifact: `## Design & Rationale` is the DR-N source; `## Decomposition` maps tasks → DR-N within this same document.

## Constraints

Anchored to `.exarchos/invariants.md`:
- INV-1: The append-only event log is the source of truth; every read-model is a left-fold over events — the `merge.rollback` retirement must keep historical logs replayable.
- INV-2: CLI and MCP are both facades over a single functional dispatch core; adapters carry zero behavior — cycle-breaking at dispatch/composite seams must not move logic into adapters.
- INV-4: Generated `skills/<runtime>/**` is build output; enforcement changes touching skills land in `skills-src/` only.
- INV-16: New check scripts and gates stay correct on Windows as well as POSIX (resolveExecutable, toPosix, handle-release before rmdir).

## Design & Rationale

### Problem Statement

The verified audit shows Exarchos's bloat is structural, not quality rot: production code is only ~22% of a 730K-line repo, but **18 hard-dead production modules (~4.2K lines with their tests, including the dead `sync/` trio — `conflict`, `sync-state`, `config`; the live `outbox`/`composite`/`sync-handler`/`types` stay)** ship in every build; the legacy `merge.rollback` event is still dual-emitted at `execute-merge.ts:746-773` despite being marked "removed in v2.12" while the package sits at `2.12.0-preview.3`; and a default dev install pulls **~1,186 MiB** of `node_modules`, ~1,091 MiB of which is the promptfoo closure used only by the eval gate.

The deeper finding is *why* this accretes: the codebase's discipline is **documented but unwired**. The production import graph shows 9 circular SCCs — including a 57-module dispatch↔composite mega-cycle — as counted by the type-blind import scanner (the runtime-edge cycle set is smaller and is pinned during DR-4's baseline capture), with no `no-circular` rule either way; 5 of 16 enforcer scripts are CI-unwired (two exist only in a `validate` script no workflow invokes); only 1 of 20 catalog invariants is a deterministic machine check; and export/type hygiene is explicitly deferred in the knip gate, leaving 4 dead value exports and ~50 dead exported types standing.

Re-verification one week after the audit measured the decay rate directly: **+44K repo lines, the mega-cycle grew 41 → 57 modules, and 2 new dead-in-prod modules appeared.** Reduction without enforcement regresses within weeks.

### Chosen Approach

Land the audit's Wave-1 verified-safe reductions and, in the same feature, convert the anti-bloat rules into blocking CI gates so the reduction ratchets instead of eroding. Posture per the audit: aggressive on proposals, conservative on merge — every deletion passes a differential gate (typecheck, full root+server suites, `refgraph`/depcruise re-run showing no unintended new orphans) before landing. Where a full structural fix is too large for this feature (the mega-cycle), the gate lands as a **ratchet**: a checked-in baseline of existing violations, blocking on any new one.

The one audit "owner decision" — the 6 header-reserved dead stubs — is resolved structurally rather than by posture argument: they get machine-tracked `RESERVED(issue, owner, expires)` headers under a new module-intent gate (DR-7), and deletion happens at expiry if no consumer lands.

## Requirements

### DR-1: Delete the verified hard-dead production modules with their attached tests

Remove the 18 modules re-verified dead on `main@b3a58d7a` (17 audit survivors — `projections/cadence.ts` is already gone — plus the `views/output-cap.ts` re-export shim): `quality/regression-eval-generator`, `benchmarks/emit-results`, `cli-commands/run-mutation`, `cli-commands/run-contract`, `cli-commands/checkpoint`, `session/lifecycle`, `sync/conflict`, `sync/sync-state`, `sync/config`, `views/unified-task-view`, `views/output-cap`, `review/comment-parser`, `review/merge-gate`, `errors.ts` (top-level), `orchestrate/detect-test-commands`, `mcp/tools-call-handler`, `telemetry/benchmarks/helpers`, `orchestrate/tools-config` — each with its co-located test file(s). `core/dispatch.economy-seam.ts` is **kept** (test-infra: self-testing INV-17 lint gate).

**Acceptance criteria:**
- `node scripts/audit/refgraph.mjs servers/exarchos-mcp/src` (vendored in-repo) lists none of the 18. Deleting a module can orphan a survivor whose only importers were deleted — any such **cascade orphan** surfaced by the re-run is dispositioned in Task 005 (deleted in the same wave under the same evidence bar, given a RESERVED header, or class-allowlisted); the final scan shows zero *undispositioned* dead modules.
- `npm run typecheck` (root **and** `servers/exarchos-mcp` — the root typecheck does not cover the server) and both test suites green in CI.
- Non-co-located test consumers of deleted modules are partially rewritten, not deleted wholesale, preserving their live-module coverage (known: `event-store/liveness-instance-id.emitters.test.ts`, `quality/__tests__/flywheel-integration.test.ts`).
- The live `sync/` modules (`outbox.ts`, `composite.ts`, `sync-handler.ts`, `types.ts`) are untouched.

### DR-2: Complete the overdue `merge.rollback` retirement without breaking replay

Stop the legacy dual-emission in `orchestrate/execute-merge.ts` (~746-773) and remove the write-path surface (`event-store/schemas.ts` name list :156, categorization :624, data map :3199, type map :3519; projection cases; playbook/doc wording), while **preserving the fold of historical stores that contain `merge.rollback` events** (INV-1): the read side stays tolerant (retained read-only schema or an upcast to `merge.recovered` — decided in decomposition).

**Acceptance criteria:**
- No production code path appends `merge.rollback`; `merge.recovered` is the sole recovery event.
- A fixture event log containing legacy `merge.rollback` events still materializes to the same workflow state as before the change (regression test).
- No registration/claim surface still advertises `merge.rollback` emission: the `registry.ts` emission declaration (~:2268) and `runbooks/definitions.ts` `autoEmits` (~:682, pinned by `definitions.test.ts`) are updated with the write path.
- Parity/migration tests updated in the same change; `skills-src`/docs wording follows.

### DR-3: Isolate promptfoo so the default install is light

Move the eval runner's `promptfoo` dependency behind an opt-in surface (eval-only workspace/package or install profile — mechanism decided in decomposition) so a normal `servers/exarchos-mcp` dev install drops from ~1,186 MiB to ~94 MiB (measured closure), while `.github/workflows/eval-gate.yml` continues to install and run evals unchanged.

**Acceptance criteria:**
- Fresh default dev install completes without downloading the promptfoo closure (verify via lockfile closure or `du` on `node_modules`).
- `evals/graders/llm-{rubric,similarity}.ts` fail with an actionable "install the eval package" error when promptfoo is absent — not an opaque import crash.
- Server typecheck stays green in non-eval lanes: the graders (which `await import('promptfoo')` and sit inside the default-typechecked tree) are either relocated into the eval surface or given an ambient module declaration — decided with the mechanism, declared in the task.
- eval-gate CI lane green; no other CI lane installs promptfoo.

### DR-4: Cycle gate — break the mutual pairs, ratchet `no-circular`

**Edge semantics and instrument (pinned):** the gate counts **runtime edges only** — `import type`-only edges are excluded; dynamic `import()` edges count as runtime. **dependency-cruiser is the sole acceptance instrument** (it is type-aware; type-only edges are excluded by default). The vendored `scripts/audit/{refgraph,cycle-hubs}.mjs` scanners are **type-blind** (their regex counts `import type` as an edge) — they remain exploratory/targeting tools and are never acceptance instruments; their 9-SCC / 14-pair / 57-module figures are type-inflated upper bounds. Under runtime semantics the verified state of the audited pairs is: **one genuine runtime mutual pair** (`views/workflow-state-projection.ts ↔ workflow/state-store.ts`); the composite→dispatch, `hsm-definitions→state-machine`, `resolver→format`, `hooks→reconcile`, `reserved-tier-guard→scaffold`, `lifecycle-core→verb`, and `store↔backend` back-edges are already `import type` or one-way; `adapters/mcp ↔ index` is **not a cycle** (one-way dynamic import; `mcp.ts` deliberately never imports `index`). Two genuine runtime cycles are known going in: `workflow-state-projection ↔ state-store` (fix by extraction) and `core/dispatch ↔ telemetry/middleware` (`dispatch.ts:1242/1256` dynamic import out; `middleware.ts:3` value-imports `enforceResponseEconomy` back — fix by extraction or baseline with rationale + issue). The work: capture the true runtime-cycle baseline with depcruise, fix the projection↔state-store pair by extraction, disposition the dispatch↔middleware cycle, then add `no-circular` wired **blocking** in CI — failing on any *new, unbaselined* runtime cycle. **The measured capture governs the final baseline** — entries exist only for cycles depcruise actually reports (the `dispatch → */composite` lazy seams are likely in *no* runtime cycle since the composite back-edges are `import type`; they get entries only if the capture proves otherwise — pre-committing them would trip the gate's own no-phantom rule).

**Acceptance criteria:**
- depcruise (type-aware, dynamic-imports-counted) reports zero cycles outside the checked-in baseline; the `workflow-state-projection ↔ state-store` runtime pair is gone; the `dispatch ↔ telemetry/middleware` cycle is fixed or baselined with rationale + owning issue.
- The gate's tools are actually installed where it runs: the grep-gates job currently does **no** `npm ci` (all existing gates are zero-dependency by design) — Task 010/011 add a root-only install step (small closure; the server/promptfoo closure is never installed there) and hoist `dependency-cruiser` to root devDependencies.
- The gate fails on: a synthetic new cycle, an expired baseline entry, and a baseline entry matching **no** current violation (no phantom masking). `permanent: true` entries (load-bearing seams) carry rationale + owning issue and are exempt from expiry.
- The shared `.dependency-cruiser.cjs` keeps bare `depcruise --validate` green (`no-circular` ships at non-error severity there) so the dogfooded `check_static_analysis`/`runBoundaryLint` path does not go permanently red; blocking is enforced by the CI gate script over depcruise JSON output.
- INV-2 holds — no behavior moves into adapters to dodge an edge.

### DR-5: Enforcer-wiring gate — every enforcer live or explicitly retired

Add `check-enforcer-wiring` (manifest-driven): every `scripts/check-*`/`lint-*` primary must be **transitively reachable from a CI workflow** (a package-script reference counts only if some workflow invokes that script, directly or through another script — closing the `npm run validate` loophole where a "referenced" gate never runs), or be marked `advisory`/`retired` in the manifest with rationale. Disposition the 5 currently-unwired enforcers: wire `check-golden-fixture-note` (pr-body-check) and `check-prefix-fingerprint` + `check-prose-lint` (CI); retire or wire `check-property-tests.sh` and `check-design-completeness.sh` (the latter is already a deprecated alias in the collapsed flow — retire is the default).

**Acceptance criteria:**
- The gate fails CI when a `scripts/check-*` primary is neither referenced nor manifest-dispositioned (self-test with a synthetic orphan script).
- All 5 named enforcers dispositioned; none remain silently dead.
- The `npm run validate` trap class is closed: no gate exists only in a script no workflow invokes.

### DR-6: Export/type hygiene ratchet in CI

Extend the CI knip invocation (`scripts/validate-no-legacy.sh:80`) from `--include files,dependencies` to also cover `exports,types`, with a checked-in allowlist carrying owner + expiry for every exception. Fix or allowlist the 4 verified dead value exports (`getEmbeddedRuntime`, `validateAgentSpec`, `assertNever` in `workflow/phase-kind.ts`, `hasExarchosBinding`) and the ~50 dead exported types.

**Acceptance criteria:**
- CI knip runs with exports+types included and is blocking; zero unallowlisted violations at land.
- Every allowlist entry names an owner and an expiry (enforced by the allowlist schema, not convention).

### DR-7: Module-intent gate — dead modules cannot silently accrete

Add `check-module-intent`: a production module with zero production importers fails CI unless it carries a `RESERVED(issue, owner, expires)` header or belongs to a declared class (test-infra, build-shim, type-test entrypoint). Convert the 6 header-reserved stubs (`orchestrate/vcs/push-with-lease` #1596, `runtime/command-shim-emitter` #1590/#1609, `projections/diff-states` #1475, `workflow/depth-proposal` #1581, `projections/bisect` #1555, `mcp/tasks-methods` #1273) from prose reservations into tracked headers with expiry; expired-and-unadopted modules become deletion tasks.

**Acceptance criteria:**
- Gate detects a synthetic new 0-importer module and fails; the 18 DR-1 deletions plus the 6 tracked reservations leave the scan clean.
- Each RESERVED header's issue reference is validated to exist in the header format (not against the live tracker); expiry is a parseable date.
- The accretion class measured in re-verification (+2 dead modules/week) is closed: a new dead module cannot merge unannotated.

### DR-8: Gates fail closed, portably, with an attributable baseline

All gates added or modified by this feature fail closed — a scanner crash, missing tool, or unparseable output is a FAIL, not a skip (the `6a335010` substrate-gate lesson). Gate scripts **execute in the ubuntu grep-gates job only** (`ci.yml` has no Windows execution surface for them); Windows portability is *defensive* (INV-16): scripts must be runnable by Windows developers locally, proven by the static portability gate, not by a CI lane that does not exist. **Known obstacle, planned for:** because every enforcement task touches root `scripts/**`, the `test-windows-root` lane runs and is **blocking** on these PRs (`ci.yml:733-749` fails closed on root changes) — and that lane is chronically flaky (#1699, spawn timeouts). The plan does not pretend otherwise: root-side test additions stay minimal, and the documented rerun-on-flake policy (`gh run rerun --failed`) is the mitigation. The DR-1 deletion wave lands against the CI baseline (the stricter signal — the ~26 known-red locals are local-only), so post-deletion failures are attributable.

**Acceptance criteria:**
- Unit tests for each new/changed gate simulate tool-missing and scan-error paths and assert failure with a diagnostic naming the real cause.
- New scripts pass `check-windows-portability.mjs` (resolveExecutable, toPosix, no POSIX-only assumptions); gate steps green in the grep-gates job.
- `test-windows-root` passing (with reruns per the flake policy) is acknowledged as a merge requirement imposed by existing CI, not waived by this spec.
- Deletion PRs include the `scripts/audit/refgraph.mjs`/depcruise before/after delta in the PR body (measured, not asserted).

## Technical Design

Two independent workstreams compose: **reduction** (DR-1..3) touches `servers/exarchos-mcp/src` module deletions, the `execute-merge`/`schemas`/projection seam, and package layout; **enforcement** (DR-4..7) lands as `scripts/check-*.mjs` following the existing self-tested enforcer pattern, plus `.dependency-cruiser.cjs` rules and the `validate-no-legacy.sh` knip-args change, wired into the existing `grep-gates`/`no-legacy` CI blocks in `ci.yml`. DR-8 is a cross-cutting property of every gate task, not a separate component.

Ordering: enforcement gates land with baselines **captured after** the reductions merge (a gate baselined pre-deletion would allowlist the modules DR-1 removes). The module-intent scanner reuses the vendored `scripts/audit/refgraph.mjs` import-resolution logic (`.js`→`.ts` resolver, dynamic-import string scan) rather than reimplementing reachability; the audit detectors are checked in at `scripts/audit/` on this branch so every measured acceptance criterion is executable from the repo alone.

The `merge.rollback` seam is the only event-store-touching change; it follows the established retired-event pattern (read-tolerant fold, write-path removal) and keeps `execute-merge ↔ merge-orchestrate` parity tests as the equivalence proof (INV-2).

## Integration Points

- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` — remove legacy dual-emission (DR-2)
- `servers/exarchos-mcp/src/event-store/schemas.ts` — retire write-path `merge.rollback` entries (DR-2)
- `servers/exarchos-mcp/package.json` + `evals/graders/llm-{rubric,similarity}.ts` + `.github/workflows/eval-gate.yml` — promptfoo isolation (DR-3)
- `.dependency-cruiser.cjs` + `core/dispatch.ts`/`*/composite.ts` import edges — cycle gate (DR-4)
- `scripts/` (new `check-enforcer-wiring.mjs`, `check-module-intent.mjs`) + `.github/workflows/ci.yml` grep-gates block (DR-5, DR-7)
- `scripts/validate-no-legacy.sh` knip args + new allowlist file (DR-6)
- The 6 reserved-stub module headers (DR-7)

## Alternatives considered

- **Aggressive posture: delete the 6 header-reserved stubs now (~1,946 ln).** Rejected — the reserving issues are live intents; DR-7's expiry mechanism converts the keep/delete argument into a tracked lifecycle that self-resolves.
- **Dissolve the 57-module mega-cycle in this feature.** Rejected as scope — breaking the 14 mutual pairs plus a new-cycle ratchet stops the bleeding; full dispatch/composite layering is a follow-up (v3.0 candidate).
- **Reduction without enforcement (the original runbook framing).** Rejected on measurement — one week of drift (+44K lines, +16 cycle modules, +2 dead modules) shows deletion alone regresses.
- **Blanket test consolidation (T3, ~2–10K ln).** Deferred — coverage-gated by the audit's own analysis; requires `test:coverage` CI wiring and a coverage baseline first (follow-up workflow, with the tsconfig strict-flag ratchet and docs archival).

## Open Questions

- **Reserved-stub expiry policy** (proposal: two minor releases from header stamp) — resolve at plan-review.
- **`merge.rollback` replay mechanism**: read-tolerant retained schema vs upcast-to-`merge.recovered` at the query seam — decide in the DR-2 task; INV-1 acceptance pins the behavior either way.
- **promptfoo isolation mechanism**: eval-only workspace package vs install-profile split (`--omit=dev` posture + eval-gate-only install) — decide in the DR-3 task; the measured ~94 MiB target pins the outcome.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 … DR-8).
**Excluded (explicit deferrals, rationale in Alternatives):** T3 coverage-gated test consolidation; tsconfig `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` ratchet (+532 fixes); full dissolution of the dispatch↔composite mega-cycle; T8 docs archival; Wave-2 SIMPLIFYs (prune knobs, resolver table-driving); `bun build --minify` A/B. Each is a follow-up workflow, not silently dropped.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Delete verified hard-dead modules + tests | 001, 002, 003, 004, 005 |
| DR-2 | `merge.rollback` retirement, replay-safe | 006, 007 |
| DR-3 | promptfoo isolation | 008 |
| DR-4 | Mutual-pair break + `no-circular` ratchet | 009, 010 |
| DR-5 | Enforcer-wiring gate | 011 |
| DR-6 | knip exports/types ratchet | 012 |
| DR-7 | Module-intent gate + RESERVED headers | 013, 014 |
| DR-8 | Fail-closed, portable gates; attributable baseline | 005, 010, 011, 012, 013, 015 |

### Tasks

### Task 001: Delete the dead sync subsystem slice

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/sync/conflict.ts` (delete)
- `servers/exarchos-mcp/src/sync/sync-state.ts` (delete)
- `servers/exarchos-mcp/src/sync/config.ts` (delete)
- `servers/exarchos-mcp/src/sync/sync-state.test.ts`, `src/sync/config.test.ts`, `src/__tests__/sync/conflict.test.ts`, `src/__tests__/sync/config.test.ts` (delete)
**Verification:** scoped: server typecheck + server suite; confirm `sync/outbox.ts`, `sync/composite.ts` (live) untouched and no dangling imports
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 002: Delete dead CLI shims and session lifecycle

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/cli-commands/checkpoint.ts`, `run-mutation.ts`, `run-contract.ts` (+ co-located tests) (delete)
- `servers/exarchos-mcp/src/session/lifecycle.ts` (+ test) (delete)
- `servers/exarchos-mcp/src/event-store/liveness-instance-id.emitters.test.ts` (partial rewrite — it imports `handleRunMutation` as an INV-10 liveness emitter under test; replace with a live emitter, preserve the rest of its coverage)
**Verification:** scoped: server typecheck + suite; confirm `adapters/cli.ts` registry auto-wiring and `index.ts` fast-paths carry no references
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 003: Delete dead review/views modules and the orphan error taxonomy

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/review/comment-parser.ts`, `review/merge-gate.ts` (+ co-located tests) (delete)
- `servers/exarchos-mcp/src/views/unified-task-view.ts` + its non-co-located test `servers/exarchos-mcp/src/__tests__/views/unified-task-view.test.ts` (delete)
- `servers/exarchos-mcp/src/views/output-cap.ts` (+ co-located test) (delete)
- `servers/exarchos-mcp/src/errors.ts` (+ `errors.test.ts`) (delete)
**Verification:** scoped: server typecheck + suite; verify `views/output-cap.ts` consumers all import `core/economy.js` directly (re-export shim retired)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 004: Delete dead bench/quality/orchestrate/mcp leftovers

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `servers/exarchos-mcp/src/benchmarks/emit-results.ts`, `quality/regression-eval-generator.ts`, `orchestrate/detect-test-commands.ts`, `mcp/tools-call-handler.ts`, `telemetry/benchmarks/helpers.ts`, `orchestrate/tools-config.ts` (+ co-located/characterization tests, incl. `orchestrate/tools-config-wiring.test.ts`) (delete)
- `servers/exarchos-mcp/src/quality/__tests__/flywheel-integration.test.ts` (partial rewrite — cross-module integration test importing `generateRegressionEval`/`writeAutoRegressionCase`; drop only those paths, preserve its live coverage of calibrated-correlation, refinement-signal, hints, and the code-quality/eval-results views)
**Verification:** scoped: server typecheck + suite; `knip.json` reference to `telemetry/benchmarks/helpers` cleaned
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 005: Post-deletion differential gate and measured delta

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1, DR-8
**Files:**
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-baseline.md` (new — records the measured before/after refgraph + line-count delta)
**Verification:** root + server typecheck; both full suites in CI; refgraph re-run lists none of the 18; any cascade orphan (survivor newly at zero prod importers because its only importers were deleted) is dispositioned here — deleted under the same evidence bar, RESERVED-headered, or class-allowlisted — and recorded in the baseline doc; before/after line-count delta recorded in PR body
**Dependencies:** 001, 002, 003, 004
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 006: Retire merge.rollback write path, replay-safe

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-2
**Files:**
- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` (drop legacy append ~746-773)
- `servers/exarchos-mcp/src/event-store/schemas.ts` (write-path entries; read-tolerance decision)
- **all** fold/consumer sites of the event (typecheck breaks at each if the type-map entry is dropped): `views/workflow-state-projection.ts` (case ~:587), `projections/rehydration/reducer.ts` (case ~:947), `workflow/hsm-definitions.ts` (string-compare in merge-pending-exit guard ~:143), merge-orchestrator projections
- `servers/exarchos-mcp/src/runbooks/definitions.ts` `autoEmits` (~:682) + `definitions.test.ts` pin; `registry.ts` `merge.rollback` emission declaration (~:2268)
- event-type census pins in **both** schema suites: `event-store/schemas.test.ts` (count :584, membership :2888) and `__tests__/event-store/schemas.test.ts` (:486-532); `views/workflow-state-projection.test.ts` (:1206 folds the event)
- `servers/exarchos-mcp/src/orchestrate/execute-merge.test.ts` (update: no legacy append asserted)
- `servers/exarchos-mcp/src/projections/merge-rollback-replay.regression.test.ts` (new: fixture log with legacy `merge.rollback` events folds to identical state across **all three** folding reducers, and the HSM merge-pending-exit guard behaves identically)
**Expected tests:** `executeMerge_RecoveryPath_EmitsOnlyMergeRecovered`, `executeMerge_RecoveryPath_NoLegacyRollbackAppend`, `replayFixture_LegacyRollbackEvents_FoldsToIdenticalWorkflowState`, `schemas_MergeRollback_ReadTolerantButNotEmittable`
**Verification:** high rung: scoped tests + `check_test_adequacy` kill-probe + integration suite; replay fixture containing legacy `merge.rollback` events folds to identical state; parity tests green
**Dependencies:** None
**Parallelizable:** Yes (distinct files from 001-004)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 007: merge.rollback wording sweep in docs and skills sources

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-2
**Files:**
- `skills-src/**` mentions (edit source, `npm run build:skills`, commit both)
- `docs/**` and `workflow/playbooks.ts` wording where `merge.rollback` is described as current
**Verification:** static: skills:guard green (INV-4 — no direct `skills/**` edits); grep shows no doc claims `merge.rollback` is still emitted
**Dependencies:** 006
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 008: Isolate promptfoo behind an opt-in eval surface

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-3
**Files:**
- `servers/exarchos-mcp/package.json` (+ lockfiles; mechanism per Open Question)
- `servers/exarchos-mcp/src/evals/graders/llm-rubric.ts`, `llm-similarity.ts` (actionable absent-dep error) + the typecheck mechanism artifact (grader relocation into the eval surface, or an ambient module declaration — one of the two lands as a file in this task)
- `servers/exarchos-mcp/src/evals/graders/llm-rubric.test.ts`, `llm-similarity.test.ts`, `llm-helper.test.ts` (all `vi.mock('promptfoo')` by name — move/adapt with the mechanism)
- `.github/workflows/eval-gate.yml` (eval-lane install)
**Verification:** medium rung: scoped tests for the absent-dep error path + adequacy probe; fresh default install measured without promptfoo closure; eval-gate lane green
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 009: Fix the runtime projection↔state-store pair and capture the depcruise cycle baseline

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-4
**Scope note:** per DR-4's pinned semantics, most audited pairs are already conforming (`import type` or one-way) — verified per-pair in the design section. The real work: (a) depcruise runtime-cycle capture over `servers/exarchos-mcp/src` — the authoritative SCC set; (b) extraction fix for `views/workflow-state-projection.ts ↔ workflow/state-store.ts` (shared helpers `isPlainObject`/`applyDotPath`/`StateStoreError` move to a leaf module); (c) disposition `core/dispatch ↔ telemetry/middleware` (extract `enforceResponseEconomy` to a leaf, or baseline with rationale + issue); (d) draft `scripts/audit/cycle-baseline.json` strictly from the measured capture — no entry without a matching depcruise violation (`adapters/mcp ↔ index` is not a cycle; the `dispatch → */composite` seams are baselined only if the capture reports them).
**Files:**
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts`, `servers/exarchos-mcp/src/workflow/state-store.ts` + new shared leaf module for the extracted helpers
- `scripts/audit/cycle-baseline.json` (draft — finalized in Task 010)
- `servers/exarchos-mcp/src/architecture/import-cycles.test.ts` (new: shells depcruise with JSON output via the existing `runCommandSync`/`resolveExecutable` pattern — the `.cmd`-shim spawn class — with a per-test timeout above the child budget, since this test runs in the blocking `test-windows` MCP lane; asserts zero cycles outside the baseline file)
**Expected tests:** `importGraph_DepcruiseRuntimeEdges_ZeroUnbaselinedCycles`, `stateStoreProjectionSeam_NoRuntimeBackEdge`
**Verification:** high rung: extraction + scoped tests + integration suite; depcruise re-run shows the projection↔state-store cycle gone and no cycle outside the drafted baseline (the type-blind `cycle-hubs.mjs` is exploratory only — not an acceptance instrument)
**Dependencies:** 005 (stable post-deletion import graph), 006 (both edit `views/workflow-state-projection.ts` — 006 lands first)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 010: no-circular depcruise rule as a blocking ratchet

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-4, DR-8
**Files:**
- `.dependency-cruiser.cjs` (no-circular under DR-4's pinned semantics, at **non-error severity** — the shared config has an existing consumer, `runBoundaryLint` in `orchestrate/pure/static-analysis.ts:208`, which runs bare `depcruise --validate` and folds any non-zero exit into `check_static_analysis` FAIL; blocking is enforced only by the gate script below)
- `scripts/audit/cycle-baseline.json` (finalized from Task 009's draft — depcruise has no native owner/issue metadata; entries: `{rule, from, to, rationale, issue, expires | permanent: true}`)
- new gate script over depcruise JSON output: FAILS on unbaselined cycle, expired entry, entry matching no current violation, and tool-missing/unparseable output
- `.github/workflows/ci.yml` (blocking wiring in the grep-gates job — which currently runs **no** `npm ci`: add a root-only install step; the server/promptfoo closure is never installed there) + root `package.json` (hoist `dependency-cruiser` to root devDependencies so the gate runs without the server install)
- self-test fixture (synthetic cycle → gate fails; tool-missing → gate fails)
**Verification:** medium rung: self-test proves fail-closed all ways; bare `depcruise --validate` stays green (check_static_analysis unaffected); gate steps green in grep-gates
**Serialization note:** edits `ci.yml` — serialized against Tasks 011 and 013 (011 → 010 → 013).
**Dependencies:** 005, 009, 011 (ci.yml serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 011: check-enforcer-wiring gate and the 5 dispositions

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5, DR-8
**Files:**
- `scripts/check-enforcer-wiring.mjs` (+ manifest + self-test)
- `.github/workflows/ci.yml`, `.github/workflows/pr-body-check.yml` (wire `check-golden-fixture-note`, `check-prefix-fingerprint`, `check-prose-lint`)
- retire-or-wire `check-property-tests.sh`, `check-design-completeness.sh` (retire default, recorded in manifest)
**Verification:** medium rung: self-test with synthetic orphan script fails the gate; tool/manifest-parse failure = FAIL; all 16+ primaries dispositioned
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 012: Export/type hygiene ratchet in CI (knip exports,types + owner/expiry allowlist)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-6, DR-8
**Files:**
- `scripts/validate-no-legacy.sh` (knip `--include files,dependencies,exports,types`)
- `scripts/audit/knip-allowlist.json` (new sidecar — knip has no metadata-carrying allowlist; entries: `{symbol, file, owner, expires, rationale}`; a wrapper diffs knip output against it, FAILS on unallowlisted violations and on expired entries)
- dispositions for `validateAgentSpec`, `assertNever` (workflow/phase-kind), `hasExarchosBinding` + the ~50 dead exported types (fix or allowlist each); `getEmbeddedRuntime` is codegen-emitted (`scripts/codegen-runtimes.ts:124`, pinned by its test) — allowlist-with-rationale is the only in-scope path (a "fix" means generator + pin changes, out of scope)
**Verification:** medium rung: CI knip blocking with zero unallowlisted violations; allowlist schema test rejects entries missing owner/expiry; the knip-diff wrapper is itself a DR-8 gate — tool-missing and unparseable-output paths FAIL with cause-naming diagnostics (tested). **Census note:** knip treats tests/benches/evals as entry points (knip.json), so the enforced dead-export set is knip-semantic — smaller than the audit's prod-only ~50-type census; the ratchet enforces the knip set, and the audit census is targeting guidance only
**Dependencies:** 005 (post-deletion baseline)
**Parallelizable:** Yes (after 005)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 013: check-module-intent gate (reachability + RESERVED headers)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-7, DR-8
**Files:**
- `scripts/check-module-intent.mjs` (reuse the vendored `scripts/audit/refgraph.mjs` `.js`→`.ts` resolver — dead-module detection is reachability, where type-blindness is acceptable: a type-only importer still justifies existence; class allowlist: test-infra, build-shim, type-test entrypoint) + self-test; expired-and-unadopted RESERVED headers FAIL the gate (the DR-7 "deletion happens at expiry" enforcement point)
- `.github/workflows/ci.yml` (blocking wiring — serialized after Task 010's ci.yml edit)
**Verification:** medium rung: synthetic new 0-importer module fails; scan crash = FAIL; current tree scans clean given 014's headers; gate steps green in grep-gates
**Dependencies:** 005, 014, 010 (ci.yml serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 014: RESERVED headers on the six reserved stubs

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-7
**Files:**
- `orchestrate/vcs/push-with-lease.ts` (#1596), `runtime/command-shim-emitter.ts` (#1590/#1609), `projections/diff-states.ts` (#1475), `workflow/depth-proposal.ts` (#1581), `projections/bisect.ts` (#1555), `mcp/tasks-methods.ts` (#1273) — header-only edits: `RESERVED(issue, owner, expires)` per the 013 format
**Verification:** static: typecheck; 013's parser accepts all six headers
**Dependencies:** None (header format agreed with 013; can land first)
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 015: Cross-gate fail-closed and portability conformance

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-8
**Files:**
- unit tests across `check-enforcer-wiring.mjs`, `check-module-intent.mjs`, the knip-diff wrapper, and the depcruise gate script: tool-missing / unparseable-output paths assert FAIL with cause-naming diagnostics
- run `scripts/check-windows-portability.mjs` over the new scripts
**Verification:** medium rung: all simulated failure paths red-then-fixed; evidence = grep-gates job green + `check-windows-portability.mjs` pass (per DR-8 — there is no Windows execution surface for gate steps)
**Dependencies:** 010, 011, 013
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Parallelization

Critical path: {001-004} → 005 → 009 (also gated on 006) → 010 → 013 → 015.
Wave A (parallel worktrees): 001, 002, 003, 004, 006, 008, 011, 014.
Wave B (after 005): 012; 009 additionally waits for 006 (both edit `views/workflow-state-projection.ts`).
Wave C: 007 (after 006), 010 (after 009), then 013 (after 005+014+010 — `ci.yml` edits serialize 011 → 010 → 013).
Wave D: 015 (after 010, 011, 013).
Gate baselines (010, 012, 013) are captured only after the deletion wave merges, per Technical Design ordering.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document (no forward-dangling references)
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Ready for `plan-review`
