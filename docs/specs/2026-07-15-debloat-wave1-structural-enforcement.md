# Spec: Debloat Program (Waves 1–2 + 3a) + Structural Enforcement

**Date:** 2026-07-15 (broadened 2026-07-16) · **Feature:** `debloat-wave1-structural-enforcement` · **Depth:** standard
**Scope:** epic #1701 — the v2.12-eligible program: #1702 (wave 1), #1703 (wave 2), #1704 (wave 3a), #1706 (enforcement phase 2), #1707 (T8 docs archival). **Excluded:** #1705 (wave 3b test-mass consolidation — gated on #1704's coverage baseline; its tasks are not honestly decomposable until that baseline exists) and #1708 (registry custom-tool API deletion — milestoned `v3.0.0` behind a cutover that has not happened).
**Naming:** the `wave1` featureId and filename are retained for event-stream continuity — the stream identity is immutable and renaming it would orphan the workflow's history. Read the title, not the slug, for scope.
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

**Program scope (DR-9 … DR-18).** The same reduction-plus-ratchet logic extends across the epic's v2.12-eligible waves, taken in one feature because they share the enforcement substrate and the `ci.yml` contention point:

- **Wave 2 (#1703, DR-9..DR-11)** — the ready-now SIMPLIFYs: a config surface that has been deprecated *and ignored* since #1334 but is still plumbed through four files (DR-9); ~165 ln of verified production cross-file clones plus a duplicated/triplicated resolver (DR-10); and a `--minify` A/B on the binary (DR-11). These are blocked on wave 1 by genuine file overlap (`registry.ts`, `config/resolve.ts`, and the projection seam), so they serialize behind it rather than running beside it.
- **Wave 3a (#1704, DR-12..DR-13)** — `test:coverage` exists but no workflow invokes it. This is the *same* "gate exists, unwired" class DR-5 closes for check-scripts, one layer up: coverage effectiveness is never measured, so the largest LoC lever (#1705's test-mass consolidation) cannot be attempted safely. Wiring coverage with a baseline + non-regression ratchet, backed by the in-tree diff-scoped mutation-adequacy gate, is what makes that follow-on wave verifiable — and is the reason #1705 stays out of this spec rather than being guessed at.
- **Enforcement phase 2 (#1706, DR-14..DR-17)** — the §7.5 items wave 1 left: the tsconfig strict-flag ratchet (532 mechanical fixes behind two flags both tsconfigs omit today), raising mechanically-checkable catalog invariants from `mode: audit` to `mode: check`, an error-envelope lint at the public handler boundary, and wiring the `vocabulary-lint` that already exists as an uninvoked script.
- **T8 (#1707, DR-18)** — repo-size hygiene in MB rather than code LoC: archival and dedup of superseded dated delivery artifacts, and one 2.11 MB SVG.

The unifying claim is the one re-verification measured: **every unwired rule decays.** Wave 1 proves it for dead modules (+2/week) and cycles (41→57 modules/week); DR-12's coverage ratchet and DR-14's flag flips are the same move applied to test effectiveness and type strictness. Reduction is the one-time gain; the ratchet is the deliverable.

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
- **The install size is measured before and after, and the delta is the bar** — not the audit's ~94 MiB figure, which is week-old targeting guidance and governs nothing. Task 008 measures the default install's closure on the branch, applies the mechanism, and re-measures; the criterion is that the promptfoo closure is gone and the remaining install is within a **declared, measured** margin of the promptfoo-free baseline the task itself establishes. Absence-of-promptfoo alone is too weak (a mechanism could remove promptfoo and still leave a 400 MiB install and pass), but an inherited number is not a bar either — the task derives its own.
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

Add `check-enforcer-wiring` (manifest-driven): every `scripts/check-*`/`lint-*` primary must be **transitively reachable from a CI workflow, and able to fail it** (a package-script reference counts only if some workflow invokes that script, directly or through another script), or be marked `advisory`/`retired` in the manifest with rationale.

**There are three trap classes, not one, and the audit's "5 unwired" is an undercount.** The gate must model all three:
1. **Orphan** — a primary no workflow references at all.
2. **Unreachable-script** — referenced only from an npm script no workflow invokes (`package.json:49`'s `validate` references `check-prefix-fingerprint.mjs` and `check-prose-lint.mjs`; no workflow runs `npm run validate`).
3. **Neutered** — reachable and running, but its exit code is swallowed so it can never fail. `package.json:35`'s `skills:guard` invokes `(npm run lint:inv6 || true)`: `lint-inv6.mjs` *runs in CI* and is structurally incapable of failing it. This is the most dangerous class — it looks wired.

**Dispositions (7+, re-enumerated by the task):** the audit's five — `check-golden-fixture-note` (wire in pr-body-check), `check-prefix-fingerprint` + `check-prose-lint` (wire in CI), `check-property-tests.sh` and `check-design-completeness.sh` (retire is the default; the latter is already a deprecated alias in the collapsed flow) — **plus** `lint-inv6.mjs` (class 3, `|| true`) and `lint-test-first-drift.mjs` (`package.json:32` `lint:test-first-drift`, invoked by no workflow). Both are `lint-*` primaries squarely inside DR-5's declared scope.

**Acceptance criteria:**
- The gate fails CI on a synthetic instance of **each** of the three trap classes — an orphan, a script reachable only via an unreachable npm script, and a `|| true`-swallowed invocation. The transitive and neutered fixtures are what distinguish this gate from a name-grep; without them a naive implementation passes its own self-test while leaving every real loophole open.
- Every primary dispositioned by the task's own enumeration — **not by this document's count**, which the audit already undercounted.
- `pr-body-check.yml` is a separate workflow, so a gate wired there is blocking within that workflow's own required status, not via `ci-gate` (DR-8) — the manifest records which workflow each primary belongs to.

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

All gates added or modified by this feature fail closed — a scanner crash, missing tool, or unparseable output is a FAIL, not a skip (the `6a335010` substrate-gate lesson). Gate scripts execute on **ubuntu only** — in `grep-gates` when they are zero-dependency, and in `test-root` when they need a Node toolchain (`ci.yml` has no Windows execution surface for either); Windows portability is *defensive* (INV-16)

**Job placement is determined by dependencies, not preference.** `grep-gates` deliberately runs **no `npm ci`**, so a gate that imports TypeScript via `tsx` cannot execute there. `ci.yml:119-127` sets the precedent: `desc:budget-guard` runs in `test-root` *"because it imports TOOL_REGISTRY via tsx, which needs both the root and MCP-server deps this job already installs. Sibling to skills:guard / lint:invariants."* Therefore: DR-17's `lint:invariants` (a `tsx` entrypoint) lands in **`test-root`**; DR-4's depcruise gate stays in `grep-gates` behind a root-only install; DR-13's mutation gate is a server TS module and lands in **`test-root`**. **Every task naming a `ci.yml` edit names its job**, and evidence cites the lane that actually runs the gate — grep-gates cannot observe a test-root gate

**How "blocking" works here — each gate lands as a step in a job that is already blocking.** `ci-gate` is the aggregator (`ci.yml:690` `needs:` + its evaluate block ~:693-763; `ci.yml:126`: *"Blocking via the ci-gate aggregator (test-root)"*). That `needs:` list is **job-keyed**, and `grep-gates`, `validate-no-legacy`, and `test-root` are all already in it. So a gate added as a **step** to one of those jobs blocks the moment it merges — a failing step fails its job, and that job is already aggregated. **No task in this spec adds a new job, so none touches the aggregator.** The one thing to prove per gate is that a synthetic violation reaches `ci-gate` red, which follows from the step's own fail-closed self-test plus its job's membership.

The nearby trap, recorded so no task rediscovers it: **blocking is job-keyed, so a gate in a job that is *not* aggregated is green theater** — `binary-matrix` and `e2e-process` are absent from `needs:` and cannot fail a PR today (`ci.yml:583`'s "Blocking gate as of T3.7" comment is stale). Nothing in this spec lands there. Whether that gap should be closed, and whether new gates should be jobs or steps, is deferred to **#1711** — it is a substrate-semantics decision, not this feature's: scripts must be runnable by Windows developers locally, proven by the static portability gate, not by a CI lane that does not exist. **Known obstacle, planned for:** because every enforcement task touches root `scripts/**`, the `test-windows-root` lane runs and is **blocking** on these PRs (`ci.yml:733-749` fails closed on root changes) — and that lane is chronically flaky (#1699, spawn timeouts). The plan does not pretend otherwise: root-side test additions stay minimal, and the documented rerun-on-flake policy (`gh run rerun --failed`) is the mitigation. The DR-1 deletion wave lands against the CI baseline (the stricter signal — the ~26 known-red locals are local-only), so post-deletion failures are attributable.

**Acceptance criteria:**
- Unit tests for each new/changed gate simulate tool-missing and scan-error paths and assert failure with a diagnostic naming the real cause.
- New scripts pass `check-windows-portability.mjs` (resolveExecutable, toPosix, no POSIX-only assumptions); gate steps green in the grep-gates job.
- `test-windows-root` passing (with reruns per the flake policy) is acknowledged as a merge requirement imposed by existing CI, not waived by this spec.
- Deletion PRs include the `scripts/audit/refgraph.mjs`/depcruise before/after delta in the PR body (measured, not asserted).

### DR-9: Remove the prune staleness knobs that are deprecated *and* ignored

`thresholdMinutes` / `prune.staleAfterDays` have been deprecated and **ignored** since #1334, yet remain plumbed through `orchestrate/prune-stale-workflows.ts` (~:284, ~:800-807), `registry.ts` (~:2778), `config/resolve.ts` (type, default, read, assign), and — **fifth site, missed by the audit's census** — `workflow/describe-config.ts:81`, which live-reads *both* the resolved field and its default (`annotate(config.prune.staleAfterDays, DEFAULTS.prune.staleAfterDays)`). Removing the field from `config/resolve.ts` breaks that file at typecheck, so it is in scope, not a surprise. Removing all of it removes a config surface that lies: it accepts input and discards it.

**The criterion is a symbol path, not a name.** "No production path reads either knob" is **not gradeable by name**: `thresholdMinutes` also exists as an unrelated per-signal contract field in `pruner/score.ts:85` and `topology/phase-contract.ts:55`, which this DR must **not** touch. The removal targets `config.prune.staleAfterDays` / the prune action's `thresholdMinutes` input specifically; a grep for the bare identifier is not evidence of completion and would produce false positives on two innocent modules.

**Acceptance criteria:**
- No production path reads either prune knob; all **five** plumbing sites are gone (the LoC estimate is the audit's ~45–90 ln and is re-measured by the task, not asserted).
- The unrelated same-named fields in `pruner/score.ts` and `topology/phase-contract.ts` are **untouched**, and the task's evidence distinguishes them by symbol path rather than identifier text.
- **The CLI flag disappears because the schema field is gone, not because a flag list was edited** — flags are auto-emitted from each action's Zod schema, so a surviving `--threshold-minutes` flag proves an incomplete removal. Assert on the emitted flag set, not on a grep.
- **The input-rejection behavior is pinned, not incidental:** a caller still passing the removed knob gets an actionable error naming the removal and #1334 — not an opaque unknown-key rejection and not a silent accept. The task declares which it is and tests it.
- `buildRegistrationSchema` still builds: removing a field from one action's schema must not disturb the shared-field base-type reconciliation (a field name colliding across actions with differing base types throws at registration).
- Prune behavior is unchanged for every non-removed input (the knobs were ignored, so no behavior may move).

### DR-10: Collapse the verified production duplication

Two distinct duplications, both re-verified in production code:
1. **`config/test-runtime-resolver.ts`** — duplicated pnpm/yarn/npm missing-script branches (~266-325) and triplicated per-field event construction (~495-556). ~50–80 ln. Table-drive both.
2. **~165 ln of cross-file clones** — gate preflight + policy-skip emission (the `contract-drift` / `mock-boundary` / `test-adequacy` / `check-integration-suite` / `static-analysis` handlers), VCS `computeOverallCiStatus` (azure-devops / gitlab / github), composite `envelopeWrap`, projection data-extractors (`rehydration` ↔ `taskstore` reducers), and oneshot-state validation (`finalize-oneshot` / `request-synthesize`).

**`envelopeWrap` is a four-copy clone, and the whole set is in scope.** Measured on this branch, the identical `(result: ToolResult, startedAt: number) => ToolResult` signature is defined **four** times — `views/composite.ts:62`, `workflow/composite.ts:37`, `orchestrate/composite.ts:634`, `event-store/composite.ts:88` — plus an `envelopeWrapWithCacheHints` variant at `workflow/composite.ts:61`. All four are in scope, and the variant is reconciled against the shared helper or explicitly justified as distinct behavior. **Nothing in this feature detects a residual clone** — knip covers files/exports/types, module-intent covers 0-importer modules, `no-circular` covers cycles — so a partial collapse would stand under a green ratchet indefinitely. Where a clone set is named, it is taken whole.

**Non-goal (pinned):** the `execute-merge ↔ merge-orchestrate` 66-ln clone **stays** — it is a migration/deprecation seam whose duplication is load-bearing, held equivalent by frozen parity tests. Collapsing it would delete the equivalence proof.

**Acceptance criteria:**
- `resolveTestRuntime` keeps its **layered per-field resolution order** exactly: override > `.exarchos.yml` direct > user `toolchains:` > task-runner > built-in registry > unresolved. Table-driving is a representation change; a resolution-order delta is a defect. Per-field provenance events keep identical shape and count.
- `config/toolchains.ts` remains the sole source of toolchain identity — the table must not become a second marker/command list.
- **`computeOverallCiStatus` extraction preserves per-provider behavior including the throws:** GitLab and Azure DevOps are partial `VcsProvider`s whose unimplemented methods throw by design. A shared helper that swallows or normalizes those throws changes behavior. Test each provider's path separately, throws included.
- Extracting the projection data-extractors preserves both reducers' folds byte-for-byte on a fixture log (INV-1: read-models are left-folds; a shared extractor must not re-order or coalesce).
- Each extraction is proven behavior-preserving by the existing tests passing **unmodified** — a test edited to accommodate a helper is a design smell and fails this criterion.

### DR-11: Binary `--minify` A/B — measure, then decide

`scripts/build-binary.ts` (~:138) runs `bun build --compile` with no minify flag. Add `--minify`, measure, keep only if it wins.

**Acceptance criteria:**
- Before/after **measured** binary size and cold-start delta recorded in the PR body — not asserted.
- Kept only if it wins on size with no behavioral delta: CLI smoke (a representative verb) and the `mcp` subcommand both green against the minified binary.
- **Explicit negative-result path:** if minify regresses startup, breaks stack-trace attributability, or changes any error message the harness matches on, the task lands the measurement and the rejection rationale, not the flag. A negative result is a completed task.

### DR-12: Wire `test:coverage` in CI with a baseline and a non-regression ratchet

`test:coverage` exists (`servers/exarchos-mcp/package.json` → `vitest run --coverage`) but **no workflow invokes it** — this is DR-5's "gate exists, unwired" class one layer up: coverage effectiveness is never measured. Run it on the CI Linux lane, check in `coverage-summary.json` as the baseline, and ratchet non-regression against it.

**Acceptance criteria:**
- **The baseline is captured from the CI Linux lane, never locally.** CI is the stricter and only trustworthy signal here — the known-red local suite is local-only, and a locally-captured baseline would bake local skips into the ratchet.
- **The ratchet's tolerance is measured, not guessed:** coverage is nondeterministic across runs (platform-skipped tests, flaky E2E/perf lanes). The task measures run-to-run variance over N≥3 CI runs and sets the epsilon from that measurement, recording both. A zero-epsilon ratchet on a nondeterministic metric is a flake generator, and an unmeasured epsilon is a guess that hides regressions.
- Fail-closed per DR-8: missing, empty, or unparseable coverage output is a FAIL naming the real cause — never a skip. A ratchet that passes when coverage did not run is the exact failure this DR exists to prevent.
- The baseline file records the commit and lane it was measured on.

### DR-13: Run diff-scoped mutation-adequacy as a measured advisory signal

Coverage measures *execution*, not *assertion* — a suite can execute a line and assert nothing. The in-tree diff-scoped `orchestrate/mutation-adequacy.ts` gate is the only instrument that sees that hole. Run it on the diff and surface its findings.

**What this DR does NOT claim, and why.** It is **not** a backstop that makes DR-12's percentage mean something, because the gate as built cannot enforce that. `mutation-adequacy.ts` excludes NoCoverage mutants from the score by construction — `denominator = total - noCoverage` (~:159), `mutationScore = killed / denominator` (~:160), `passed = mutationScore >= threshold` (~:712) — so a diff of 5 killed + 5 NoCoverage scores **1.0 and passes**. The severity machinery cannot fix that from config: `applyLadderGateSeverity` (`gate-utils.ts:367-409`) only ever *downgrades* (`passed:false → true`) and `resolveGateSeverity` is gate-keyed, not mutant-class-keyed. Blocking on NoCoverage would require changing the gate's `passed` computation — **a product-code design decision, deferred to #1711**, not something this spec can assert into existence.

So this DR ships the honest half: a measured signal and follow-ups. The assertion-hole *enforcement* arrives when #1711 resolves. Naming that boundary is the point — an advisory gate described as a backstop is how gates rot.

**Acceptance criteria:**
- **Diff-scoped only.** Full-tree mutation (`scope: 'full'`) is out of scope — the in-tree diff-scoped gate is the paved path; full-tree stryker is not.
- The gate runs on every PR diff and its report is visible; surviving and NoCoverage mutants become **recorded follow-ups**, not merge blocks.
- **Fail-closed per DR-8 applies to the gate's own execution**: a mutation-runner crash or unparseable report is a FAIL with a cause-naming diagnostic, distinct from "ran and found survivors" (advisory). That distinction is the only thing keeping an advisory gate from silently not running at all.
- The report states plainly that NoCoverage does not affect the score, so no reader mistakes a 1.0 for an assertion guarantee.

### DR-14: tsconfig strict-flag ratchet, with the cheat closed

Both tsconfigs are `strict: true` but omit `noUncheckedIndexedAccess` (+346 errors) and `exactOptionalPropertyTypes` (+186). Fix per-area, then flip each flag to lock it. 532 mechanical fixes (the counts are the audit's targeting guidance and are re-measured by their tasks).

**The `as unknown as` type-debt register is deferred to #1711**, not dropped. It needs an identity function this spec cannot supply: `{symbol, file}` cannot distinguish the multiple casts that share a file (`orchestrate/composite.ts` alone holds 13), so a subset register would pass a completeness check exactly where the debt concentrates; `{file, line, column}` churns on every edit and would be invalidated wholesale by this DR's own 532-fix wave. The census is also undefined — a naive scan returns 98 sites but includes a `.d.ts`, a `__shims__` module, a `.bench.ts`, and a `__tests__` fixture. A register with no workable key is a snapshot, and an unread snapshot is the documented-but-unwired decay this feature exists to stop; better to name the design question than to ship the thing the feature indicts.

**Acceptance criteria:**
- Both flags on in **both** tsconfigs, and **both typechecks green** — the root typecheck does not cover `servers/exarchos-mcp`, so "typecheck passes" without the server run is not evidence.
- **The cheat is closed and budgeted:** `noUncheckedIndexedAccess` is trivially defeated by `!` non-null assertions and `as` casts, which would flip the flag while abandoning its purpose. The task records a **measured** count of `!`/`as` sites introduced by the fix wave and justifies each above a declared budget; silencing rather than narrowing is a defect, and `as any` is barred outright (strict-TS convention: `unknown` + type guards).
- **High blast radius, full suite:** 532 fixes across the tree exceed what per-task scoped verification can see. Both full suites run in CI between merges of the fix waves, not just at the end.

### DR-15: Executable invariants — raise the mechanically-checkable ones to `check` and make them blocking

1 of 20 catalog invariants is a deterministic machine check (INV-4); `check_invariant_conformance` is registered `gate: { blocking: false }`. Raise the mechanically-checkable candidates (INV-8 idempotency, INV-13 two-event split, INV-14 native recovery, INV-16 portability greps) to `mode: check`, and make the gate blocking **for check-mode findings only**.

**Measured against `.exarchos/invariants.md`:**
- **INV-8 has no `mode:` field to raise.** Its entry (~:79-103) carries dimension/axis/cost-of-load/applies-to/summary/citations/references and **no machine-check block at all** — unlike INV-1 (~:18), INV-13 (~:239), INV-14 (~:280), INV-16 (~:669). Only **12** of 20 entries carry `mode:` (11 `audit` + INV-4 `check`). INV-8 is therefore not a mode flip: the task **authors a machine-check block from scratch**, materially larger work, scoped as such below.
- **There are 11 `mode: audit` entries** — the count that matters for what would go red if the gate's severity were raised globally. The "1 of 20 machine-checked" framing holds.

**Acceptance criteria:**
- Each raised invariant has a deterministic check with a self-test proving **both** directions: a synthetic violation FAILS, and the current conforming tree PASSES. A check that cannot fail is not a check — the same vacuous-gate class the wave-1 enforcer-wiring gate closes.
- Blocking applies to check-mode findings **only**; the 11 audit-mode entries stay advisory. Raising the gate's severity globally would make unproven audit entries block CI.
- **INV-8's check is authored, not flipped** — and if a deterministic idempotency check proves out of reach at task scope, INV-8 stays `audit` with rationale recorded and the other three still land. A flaky invariant check is worse than an honest advisory one.
- An invariant that cannot be made deterministic stays `audit` with rationale recorded — a flaky invariant check is worse than an honest advisory one.

### DR-16: Error-envelope lint at the public handler boundary

Public `orchestrate/**` / `adapters/**` handler catch-boundaries must return `ToolResult.error`, not raw throws (ts-morph or an ESLint rule). A raw throw at the boundary escapes the output contract: the caller gets a stack trace instead of a structured envelope.

**Acceptance criteria:**
- Self-test both directions: a synthetic handler with a raw-throw catch-boundary FAILS; the conforming tree PASSES.
- INV-2 holds: adapters carry zero behavior — the rule must not be satisfied by moving error *translation* into an adapter.
- Existing violations are fixed or allowlisted with owner + expiry in this gate's own register file, carrying **DR-6's exact schema** and validated by the same shared schema test (per Technical Design: one shape, per-gate files — a differently-*shaped* register is the accretion this feature exists to stop).
- Fail-closed per DR-8: rule-crash or unparseable source is a FAIL.

### DR-17: Wire `vocabulary-lint`

`npm run lint:invariants` exists; **no workflow runs it** — the same unwired class as DR-5 and DR-12. Wire it blocking in CI and extend its scope to action names and descriptions in normative directories.

**Acceptance criteria:**
- Blocking in CI, with a self-test proving a synthetic vocabulary violation fails the gate.
- The scope extension to action names/descriptions lands with its own violations fixed or allowlisted (owner + expiry) — wiring a gate whose new scope is already red is how gates get disabled.
- Fail-closed per DR-8; INV-4 holds — any skills-side finding is fixed in `skills-src/`, never in generated `skills/<runtime>/**`.

### DR-18: Docs and data archival — MB hygiene, with a real code seam

Repo size in MB, not code LoC: archive/docsite-exclude the superseded dated delivery artifacts in `docs/plans` + `docs/designs` (114.5K ln / 5.58 MB, preserving git history), dedup the duplicate-basename groups spanning plans ↔ designs ↔ proposals to one canonical + links (the audit's 105 groups / 211 files / 84K ln / 4.16 MB is week-old targeting guidance; the current tree scans to 102, and the task's own scan governs), and optimize `documentation/public/logo.svg` (measured at ~2.1 MB on this branch).

**Decided (not deferred):** `docs/research` + `docs/rca` (1.34 MB) **stay in-repo** — there is no size pressure justifying their removal, and they are live reference surfaces. Recorded here so the question is closed rather than re-opened each wave.

**Non-targets (pinned, from the audit's discipline):** generated artifacts are never archival targets — lockfiles, `snapshots.test.ts.snap` (9.4K ln generated oracle), `docs/schemas/tool-reference.md` (auto-generated), and the legacy hash manifest (explicit KEEP verdict — it has a live production reader in the default onboarding path).

**Acceptance criteria:**
- **No *new* broken doc links.** The link checker scans the whole `docs/` tree and already fails on ~190 pre-existing repo-wide breaks, so a whole-tree green is unattainable and is not the bar: the check is **diff-scoped** — links in and to the moved/deduped files resolve, measured as a before/after delta. Pre-existing breaks are out of scope and must not be silently absorbed into this feature's evidence.
- Inbound references from **code, skills-src, and commands** to archived paths are updated — the archive is a doc-surface move, and a skill pointing at a moved reference is a runtime break, not a doc nit.
- Dedup keeps exactly one canonical per group; the other members become links, not deletions (history preserved either way).
- Measured before/after repo size + file count in the PR body.
- **This DR edits `servers/exarchos-mcp/src/**`, and two of those edits are behavior.** A "zero `src/**` change" bar is unsatisfiable — ~48 production references across ~33 files (re-measured by the task; including a live relative markdown link at `telemetry/telemetry-projection.ts:183` and 8+ across `agents/adapters/*.ts`) point at exactly the artifacts this DR archives, so archiving while forbidding `src/**` edits would force stale production references.
- **"Comment/string-only" is not a proof of no-behavior, and is not the bar.** Two string constants *are* behavior and must be treated as code changes with tests: `workflow/rehydrate.ts:76` `LEGACY_DESIGN_DIR = 'docs/designs/'` classifies in-flight workflows as two-artifact vs unified (its own comment says such workflows "MUST resume and complete under the OLD path — no forced mid-flight migration"), and `architecture/vocabulary-lint.ts:188` `DATED_RECORD_TREES` freezes the trees the lint must not walk. The task **enumerates every `src/**` edit and classifies each as inert (comment/link text) or behavioral**; each behavioral one carries a test. A mechanical "the hunks are string-only" check would pass a change that silently breaks workflow classification.
- Both typechecks and both full suites green; **an in-flight workflow whose `designPath` points at an archived location still resolves** (regression test).

## Technical Design

Two independent workstreams compose: **reduction** (DR-1..3) touches `servers/exarchos-mcp/src` module deletions, the `execute-merge`/`schemas`/projection seam, and package layout; **enforcement** (DR-4..7) lands as `scripts/check-*.mjs` following the existing self-tested enforcer pattern, plus `.dependency-cruiser.cjs` rules and the `validate-no-legacy.sh` knip-args change, wired into the existing `grep-gates`/`no-legacy` CI blocks in `ci.yml`. DR-8 is a cross-cutting property of every gate task, not a separate component.

Ordering: enforcement gates land with baselines **captured after** the reductions merge (a gate baselined pre-deletion would allowlist the modules DR-1 removes). The module-intent scanner reuses the vendored `scripts/audit/refgraph.mjs` import-resolution logic (`.js`→`.ts` resolver, dynamic-import string scan) rather than reimplementing reachability; the audit detectors are checked in at `scripts/audit/` on this branch so every measured acceptance criterion is executable from the repo alone.

The `merge.rollback` seam is the only event-store-touching change; it follows the established retired-event pattern (read-tolerant fold, write-path removal) and keeps `execute-merge ↔ merge-orchestrate` parity tests as the equivalence proof (INV-2).

**Program composition (DR-9..DR-18).** Three further workstreams join, and the honest constraint is that they are *not* all independent:

- **`ci.yml` is the program's contention point.** Six tasks add steps to one workflow file (011, 012, 010, 013, 021, 022, 023, 029). The steps are additive and land in distinct jobs, but they collide textually, so they run as a **serial chain** rather than in parallel. No task touches `ci-gate`'s `needs:`/evaluate regions — every gate here is a step in a job already aggregated (see DR-8), so nothing needs wiring there. **This serialization — not test time — is the program's critical path.**
- **Wave 2's coupling to wave 1 is narrow: exactly one task is genuinely blocked.** Checked against the tree, per task:
  - **Task 016 is genuinely blocked** — `registry.ts` is edited by Task 006 (`merge.rollback` emission declaration, ~:2268) and by DR-9 (prune knob, ~:2778). Real overlap, real ordering.
  - **`config/resolve.ts` is not a wave1↔wave2 seam** — no wave-1 task (001-015) touches it; only 016 does.
  - **Task 020 (`--minify`) is independent** — no dependencies, runs in Wave A.
  - **Task 017 sequences on the 005 baseline, not on file overlap** — nothing in 001-004 touches `config/test-runtime-resolver.ts`. This is a deliberate choice to plan against a settled post-deletion graph, recorded as sequencing rather than conflict.
  - **The projection seam belongs to 019, via 006 only** — see its dependency below.
- **Wave 3a (DR-12..DR-13) is independent of the wave chain** and can run beside the deletion wave — its only coupling is the `ci.yml` chain above. It is also the gate that unlocks #1705, which is why it is in this spec and #1705 is not: 3b's task shapes are a function of 3a's measured baseline, so decomposing 3b now would be fiction.
- **Enforcement phase 2 (DR-14..DR-17) is mostly slack-fill**, with one exception: DR-14's 532 mechanical fixes are the largest blast radius in the program and touch files every other task also touches. The two flag ratchets serialize against each other (both edit both tsconfigs, and fixing one flag's errors churns the same files), and they land **last** among the code-touching work so they do not force constant rebasing on the deletion and extraction waves. DR-14's `as unknown as` register additionally waits on DR-6's allowlist schema.
- **T8 (DR-18) is not independent, though it looks it.** It is docs and one SVG by *intent*, but ~48 production references across ~33 files point at the archived artifacts, so it edits `src/**` — which puts it inside DR-14's 532-fix surface (024 must order behind it) and in direct collision with Task 029 over `architecture/vocabulary-lint.ts`, whose scope 029 extends and whose `DATED_RECORD_TREES` constant 030 must change. Two of its `src/**` edits are behavior, not text. It touches no `ci.yml`.

The new gates reuse the established substrate rather than inventing one: DR-12's ratchet, DR-16's lint, and DR-17's wiring all follow the self-tested `scripts/check-*.mjs` pattern with the DR-6 owner/expiry allowlist shape.

**One *contract*, two key shapes, per-gate register files.** The debt registers — `cycle-baseline.json` (DR-4), `knip-allowlist.json` (DR-6), `error-envelope-allowlist.json` (DR-16) — stay distinct files (different consumers, different gates; one blob would make the gates contend and serialize for no design reason).

**The registers do not share a row shape, and must not pretend to.** DR-6's entries are **symbol-keyed** `{symbol, file, owner, expires, rationale}`; DR-4's cycle baseline is **edge-keyed** `{rule, from, to, owner, rationale, issue, expires | permanent: true}` — no symbol/file, plus a `permanent: true` exemption for load-bearing seams (depcruise carries no native owner/issue metadata, which is why the baseline must supply it).

What they share is a **contract**, not a row: every entry, whatever its key, carries `{owner, expires | permanent, rationale}` and is validated against that contract by one shared schema **module**; key fields stay per-register. This keeps the anti-accretion property that matters — no register entry without an owner, an expiry, and a reason — without pretending an edge and a symbol are the same thing. It is also what makes DR-6's "every entry names an owner and an expiry, enforced by the schema" satisfiable for `cycle-baseline.json`.

**The validator is the contended artifact, not the registers.** The register *files* are deliberately separate (different consumers, different gates), but the shared schema module and its test are one file that Tasks 010 and 028 both extend — so they are ordered 010 → 028.

## Integration Points

- `servers/exarchos-mcp/src/orchestrate/execute-merge.ts` — remove legacy dual-emission (DR-2)
- `servers/exarchos-mcp/src/event-store/schemas.ts` — retire write-path `merge.rollback` entries (DR-2)
- `servers/exarchos-mcp/package.json` + `evals/graders/llm-{rubric,similarity}.ts` + `.github/workflows/eval-gate.yml` — promptfoo isolation (DR-3)
- `.dependency-cruiser.cjs` + `core/dispatch.ts`/`*/composite.ts` import edges — cycle gate (DR-4)
- `scripts/` (new `check-enforcer-wiring.mjs`, `check-module-intent.mjs`) + `.github/workflows/ci.yml` grep-gates block (DR-5, DR-7)
- `scripts/validate-no-legacy.sh` knip args + new allowlist file (DR-6)
- The 6 reserved-stub module headers (DR-7)
- `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts` (~:284, ~:800-807) + `registry.ts` (~:2778) + `config/resolve.ts` — prune knob removal (DR-9)
- `servers/exarchos-mcp/src/config/test-runtime-resolver.ts` (~266-325, ~495-556) — table-driving (DR-10)
- Gate handlers (`orchestrate/contract-drift.ts`, `mock-boundary.ts`, `test-adequacy.ts`, `check-integration-suite.ts`, `pure/static-analysis.ts`), `src/vcs/{github,gitlab,azure-devops}.ts` `computeOverallCiStatus`, composite `envelopeWrap` (`views/composite.ts`, `workflow/composite.ts`), `projections/rehydration/reducer.ts` ↔ `projections/taskstore/reducer.ts`, `orchestrate/finalize-oneshot.ts`/`request-synthesize.ts` — clone extraction (DR-10)
- `scripts/build-binary.ts` (~:138) — `--minify` A/B (DR-11)
- `servers/exarchos-mcp/package.json` `test:coverage` + `.github/workflows/ci.yml` Linux lane + new coverage baseline/ratchet gate (DR-12)
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.ts` — CI wiring, diff-scoped (DR-13)
- `tsconfig.json` (root) + `servers/exarchos-mcp/tsconfig.json` — strict-flag ratchet (DR-14)
- `.exarchos/invariants.md` catalog entries + `check_invariant_conformance` gate registration (DR-15)
- New error-envelope rule over `orchestrate/**` / `adapters/**` catch-boundaries (DR-16)
- `npm run lint:invariants` + `.github/workflows/ci.yml` wiring (DR-17)
- `docs/plans`, `docs/designs`, `documentation/public/logo.svg` (DR-18)

## Alternatives considered

- **Aggressive posture: delete the 6 header-reserved stubs now (~1,946 ln).** Rejected — the reserving issues are live intents; DR-7's expiry mechanism converts the keep/delete argument into a tracked lifecycle that self-resolves.
- **Dissolve the 57-module mega-cycle in this feature.** Rejected as scope — breaking the 14 mutual pairs plus a new-cycle ratchet stops the bleeding; full dispatch/composite layering is a follow-up (v3.0 candidate).
- **Reduction without enforcement (the original runbook framing).** Rejected on measurement — one week of drift (+44K lines, +16 cycle modules, +2 dead modules) shows deletion alone regresses.
- **Blanket test consolidation (T3 / wave 3b, #1705, ~2–6K ln, up to +4–10K).** Deferred — and this spec now lands its prerequisite rather than just naming it. The consolidation's premise is "coverage-preserving", which is unverifiable without DR-12's baseline; its task shapes are a *function* of what that baseline measures. Decomposing it now would be fiction dressed as a plan. It becomes plannable the moment DR-12 lands, and #1705 is the workflow that takes it.
- **Include #1705 in this spec anyway, as framed phases.** Rejected — the plan-coverage gate would be satisfied by tasks whose acceptance criteria cannot be written yet. A task that cannot state its own evidence bar is not a task; it is a placeholder that reviewers approve and implementers reinterpret.
- **Include #1708 (registry custom-tool API deletion).** Rejected on the version gate — it is milestoned `v3.0.0` behind a cutover that has not happened. Deleting a deprecated public API inside a v2.12 feature would ship a breaking change under a chore label.
- **Keep wave 1 as its own spec and follow with a second one for #1703–#1707.** Rejected by owner decision, with the tradeoff recorded: one spec pays a re-review of already-hardened DRs and delays wave-1's merge, but buys a single coherent verdict over the real scope — including the cross-wave couplings (the `ci.yml` chain, DR-14's blast radius against the extraction waves, DR-6's allowlist shape being reused by DR-14/DR-16) that two separate specs would each treat as someone else's problem.
- **Wire full-tree mutation (stryker) instead of the diff-scoped gate.** Rejected — the in-tree diff-scoped gate is the paved path; full-tree runtime cost is not justified when the diff is the thing under review.
- **Flip the tsconfig strict flags without a `!`/`as` budget.** Rejected — the flags are trivially satisfiable by the exact casts they exist to prevent, which would convert a real guarantee into a green check. DR-14's measured budget is what makes the flip mean anything.

## Open Questions

- **Reserved-stub expiry policy** (proposal: two minor releases from header stamp) — resolve at plan-review.
- **`merge.rollback` replay mechanism**: read-tolerant retained schema vs upcast-to-`merge.recovered` at the query seam — decide in the DR-2 task; INV-1 acceptance pins the behavior either way.
- **promptfoo isolation mechanism — RESOLVED (2026-07-16): eval-only workspace package.** Carrying this open changed the *shape of the plan*, not just a task's internals, so it could not stay open: the install-profile branch (`--omit=dev` + eval-gate-only install) would edit **every server-installing lane** in `ci.yml` (`test-mcp`, `test-windows` ~:204, `test-windows-root` ~:343, `e2e-process` ~:611, `outcome-tests` ~:669 — only `binary-matrix` ~:419 already passes `--omit=dev`), pulling DR-3 into the `ci.yml` serial chain and making the chain's completeness contingent on an unresolved question. The workspace branch is contained (server `package.json` + graders + `eval-gate.yml`), touches no shared CI lane, and keeps Task 008 independent in Wave A. The ~94 MiB target is a measured bar under either mechanism and remains DR-3's acceptance criterion.
- **DR-9 removed-knob rejection behavior — RESOLVED (2026-07-16): actionable error naming the removal and #1334.** Closed rather than carried: the deprecation has been live since #1334, and Task 016 already pins the branch with `PruneAction_LegacyKnobPassed_ActionableRemovalError`. Listing it as open while a named test pre-committed the answer meant a reviewer would have been approving a decision already made.
- **DR-12 coverage epsilon**: the tolerance is deliberately *not* proposed here — it is an output of the DR-12 task's N≥3 CI variance measurement. Naming a number now would be the guess the DR forbids.
- **DR-14 `!`/`as` budget**: the per-flag budget is set from the measured fix wave, not pre-committed. Open until DR-14 measures; the criterion (justify each site above the declared budget, no `as any`) holds regardless of the number.

## Decomposition

The decomposition maps every task to one or more DR-N from the section above.

### Scope

**Target:** Full design (DR-1 … DR-18) — epic #1701's v2.12-eligible program: #1702 (wave 1), #1703 (wave 2), #1704 (wave 3a), #1706 (enforcement phase 2), #1707 (T8).
**Excluded (explicit deferrals, rationale in Alternatives):** #1705 wave-3b test-mass consolidation — the largest LoC lever, gated on DR-12's coverage baseline and plannable only once it lands; #1708 registry custom-tool API deletion (v3.0.0 milestone, version-gated); full dissolution of the dispatch↔composite mega-cycle (v3.0 candidate — DR-4's ratchet stops its growth); full-tree mutation (DR-13 takes the diff-scoped paved path). Each is a follow-up with a named owner issue, not silently dropped.

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
| DR-8 | Fail-closed, portable gates; attributable baseline | 005, 010, 011, 012, 013, 015, 022, 023, 029, 033 |
| DR-9 | Prune staleness knob removal | 016 |
| DR-10 | Production duplication collapse | 017, 018, 019 |
| DR-11 | Binary `--minify` A/B | 020 |
| DR-12 | Coverage baseline + non-regression ratchet | 021, 022 |
| DR-13 | Diff-scoped mutation-adequacy backstop | 023 |
| DR-14 | tsconfig strict-flag ratchet | 024, 025 |
| DR-15 | Executable invariants (audit → check, blocking) | 027 |
| DR-16 | Error-envelope lint | 028 |
| DR-17 | `vocabulary-lint` wiring | 029 |
| DR-18 | Docs/data archival + dedup | 030, 031, 032 |

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
**Verification:** scoped: server typecheck + suite; confirm `adapters/cli.ts` registry auto-wiring and `index.ts` fast-paths carry no references (verified: `index.ts` fast-paths `run-tests` but has no dispatch for `run-mutation`/`run-contract`, so the verbs are genuinely unreachable). The stale prose these deletions strand in `event-store/` is swept by Task 007, which owns that file after Task 006 restructures it.
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
- stale **prose** references to the deleted detect-test-commands module: `servers/exarchos-mcp/src/config/exarchos-config-schema.ts` (~:7), `servers/exarchos-mcp/src/config/vendor/package-manager-detector/README.md` (~:14). (A third stale comment lives in the test-runtime resolver ~:12 and is fixed by **Task 017**, which owns that file — putting it here would collide with 017's table-driving.)
**Verification:** scoped: server typecheck + suite; `knip.json` reference to `telemetry/benchmarks/helpers` cleaned; **no comment describes a module this task deletes** — nothing breaks if these survive (they are prose), but DR-7's module-intent gate reads reachability, not prose, so nothing else in this feature would ever catch them. This is the doc-rot the feature is nominally against.
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 005: Post-deletion differential gate and measured delta

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-1, DR-8
**Files:**
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-baseline.md` (new — records the measured before/after refgraph + line-count delta, and the cascade-orphan disposition table)
- (conditional) cascade-orphan modules surfaced by the re-run — **enumerated in the baseline doc before any deletion**, never deleted ad hoc
**Verification:** root + server typecheck; both full suites in CI; refgraph re-run lists none of the 18; before/after line-count delta recorded in PR body
**Cascade-orphan bound (this task deletes nothing it cannot name):** the re-run may surface survivors newly at zero production importers because their only importers were deleted. Each is **enumerated and dispositioned in the baseline doc** — RESERVED-headered, class-allowlisted, or deleted. Deletion here is permitted **only** for an orphan whose evidence matches the DR-1 bar *and* which is recorded in the disposition table with that evidence; **any orphan needing judgment beyond that bar becomes its own task and re-enters decomposition rather than riding this one.** Unbounded, this task would be the largest unreviewed blast radius in the plan — it gates 009, 012, 013, 016, 017, 018, and 024 — so the tier matches 001-004 (which delete production code against enumerated file lists) and the disposition table is what keeps the file list honest.
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
- the remaining `merge.rollback`-bearing suites, all inside this task's blast radius: `servers/exarchos-mcp/src/orchestrate/execute-merge.deprecation-parity.test.ts` (6 refs — DR-10 pins this clone's parity tests as the equivalence proof, so it is load-bearing here), `servers/exarchos-mcp/src/projections/merge-orchestrator/reducer.test.ts` (13), `servers/exarchos-mcp/src/orchestrate/merge-orchestrate.integration.test.ts` (4), `servers/exarchos-mcp/src/projections/rehydration/reducer.test.ts` (2), `servers/exarchos-mcp/src/orchestrate/execute-merge.migration.test.ts` (1), `servers/exarchos-mcp/src/workflow/state-machine.test.ts` (1)
- `servers/exarchos-mcp/src/projections/merge-rollback-replay.regression.test.ts` (new: fixture log with legacy `merge.rollback` events folds to identical state across **all three** folding reducers, and the HSM merge-pending-exit guard behaves identically)
**Expected tests:** `executeMerge_RecoveryPath_EmitsOnlyMergeRecovered`, `executeMerge_RecoveryPath_NoLegacyRollbackAppend`, `replayFixture_LegacyRollbackEvents_FoldsToIdenticalWorkflowState`, `schemas_MergeRollback_ReadTolerantButNotEmittable`
**Verification:** high rung: scoped tests + `check_test_adequacy` kill-probe + integration suite; replay fixture containing legacy `merge.rollback` events folds to identical state; parity tests green
**Dependencies:** None
**Parallelizable:** Yes (distinct files from 001-004)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 007: Stale-prose sweep for the retired event and the deleted verbs

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1, DR-2
**Files:**
- `skills-src/**` mentions (edit source, `npm run build:skills`, commit both)
- `docs/**` and `workflow/playbooks.ts` wording where `merge.rollback` is described as current
- `src/**` comments describing the retired event as current: `servers/exarchos-mcp/src/orchestrate/merge-keys.ts` (~:5, lists it among "the four append sites") and `servers/exarchos-mcp/src/projections/rehydration/schema.ts` (~:101)
- `src/**` comments describing Task 002's deleted verbs as live: `servers/exarchos-mcp/src/event-store/schemas.ts` (~:329, :753, :2873, :2878 — documents `mutation.executing_started`/`mutation.executed` as "emitted by the `exarchos run-mutation` CLI verb") and `servers/exarchos-mcp/src/event-store/liveness-registry.ts` (~:25, :187)
**Scope note:** this task exists because **nothing else in this feature catches stale prose** — the module-intent gate reads reachability, knip reads exports, neither reads comments. It sweeps both DR-1's deleted verbs and DR-2's retired event in one pass, and lands after 006 restructures `schemas.ts` so the two do not contend on it.
**Verification:** static: skills:guard green (INV-4 — no direct `skills/**` edits); grep shows no doc **or `src/**` comment** claims `merge.rollback` is still emitted or that the deleted CLI verbs are live
**Dependencies:** 002, 006
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
**Verification:** medium rung: scoped tests for the absent-dep error path + adequacy probe; **the task measures the default install closure before and after** and records both — the bar is its own measured delta, not the audit's ~94 MiB (week-old targeting guidance that governs nothing); proving promptfoo absent is necessary but not sufficient, since a mechanism could drop promptfoo and still leave a 400 MiB install; eval-gate lane green
**Mechanism (resolved, see Open Questions):** eval-only **workspace package** — chosen partly *because* the install-profile alternative would have edited five server-installing `ci.yml` lanes and dragged DR-3 into the serial chain. This task touches no shared CI lane and stays independent.
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
- `scripts/audit/cycle-baseline.json` (finalized from Task 009's draft — depcruise has no native owner/issue metadata; entries are **edge-keyed** `{rule, from, to, owner, rationale, issue, expires | permanent: true}`. **`owner` is added** so the baseline meets the shared entry contract — DR-6's "every entry names an owner and an expiry, enforced by the schema" was unsatisfiable for this file while it had no owner field)
- new gate script over depcruise JSON output: FAILS on unbaselined cycle, expired entry, entry matching no current violation, and tool-missing/unparseable output
- `.github/workflows/ci.yml` — add the gate step to **`grep-gates`**, which currently runs **no** `npm ci`: add a root-only install step (the server/promptfoo closure is never installed there). `grep-gates` is already in `ci-gate`'s `needs:`, so the step blocks on merge (DR-8) — no aggregator edit. Plus root `package.json` (hoist `dependency-cruiser` to root devDependencies so the gate runs without the server install)
- the shared schema module + its test (ordered first: 010 → 028)
- self-test fixtures — **one per failure mode DR-4 enumerates**: synthetic cycle → FAIL; **expired baseline entry → FAIL**; **phantom entry (baselined edge matching no current violation) → FAIL**; tool-missing → FAIL
**Verification:** medium rung: the self-test covers **each** of DR-4's four enumerated failure modes by name — "fail-closed all ways" is not a gradeable claim, and the no-phantom rule is the one DR-4 leans on hardest (it is the reason not to pre-commit the dispatch→composite entries), so it gets an explicit fixture; bare `depcruise --validate` stays green (check_static_analysis unaffected); gate steps green in grep-gates
**Serialization note:** edits `ci.yml` (step only) — after Task 012 in the canonical chain (see Parallelization).
**Dependencies:** 005, 009, 012 (ci.yml serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 011: check-enforcer-wiring gate and the 5 dispositions

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5, DR-8
**Files:**
- `scripts/check-enforcer-wiring.mjs` (+ manifest + self-tests, one fixture per trap class)
- `.github/workflows/ci.yml`, `.github/workflows/pr-body-check.yml` (wire `check-golden-fixture-note`, `check-prefix-fingerprint`, `check-prose-lint`)
- retire-or-wire `check-property-tests.sh`, `check-design-completeness.sh` (retire default, recorded in manifest)
- disposition `scripts/lint-inv6.mjs` (reachable via `skills:guard` but `|| true`-swallowed — `package.json:35`) and `scripts/lint-test-first-drift.mjs` (`package.json:32`, invoked by no workflow)
**Expected tests:** `EnforcerWiring_OrphanScript_Fails`, `EnforcerWiring_ReachableOnlyViaUninvokedNpmScript_Fails`, `EnforcerWiring_ExitCodeSwallowedByOrTrue_Fails`
**Verification:** medium rung: tool/manifest-parse failure = FAIL; every primary dispositioned by the task's own enumeration. The self-test covers all three trap classes — the **transitive** and **neutered** fixtures are what make this a ratchet rather than a name-grep, since a naive "is this script mentioned anywhere" implementation passes the orphan test while leaving both real loopholes open. Both fixtures exist in the tree today (`package.json:49`'s uninvoked `validate`; `package.json:35`'s `|| true`). Dispositioning today's set proves the tree is clean now; only those fixtures prove the gate catches tomorrow's recurrence.
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 012: Export/type hygiene ratchet in CI (knip exports,types + owner/expiry allowlist)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-6, DR-8
**Files:**
- `scripts/validate-no-legacy.sh` (knip `--include files,dependencies,exports,types`)
- `.github/workflows/ci.yml` — **a server install step in the `validate-no-legacy` job.** Expanding knip to `exports,types` requires TypeScript resolution across both workspaces (`knip.json` declares two; `validate-no-legacy.sh:26`), but that job installs **root only** (~:462-463, `npm-ci-retry.sh` with no `working-directory`). Without this the expanded scope cannot resolve the server tree — a task that would have silently under-reported or crashed.
- `scripts/audit/knip-allowlist.json` (new sidecar — knip has no metadata-carrying allowlist; entries: `{symbol, file, owner, expires, rationale}`; a wrapper diffs knip output against it, FAILS on unallowlisted violations and on expired entries)
- dispositions for `validateAgentSpec`, `assertNever` (workflow/phase-kind), `hasExarchosBinding` + the ~50 dead exported types (fix or allowlist each); `getEmbeddedRuntime` is codegen-emitted (`scripts/codegen-runtimes.ts:124`, pinned by its test) — allowlist-with-rationale is the only in-scope path (a "fix" means generator + pin changes, out of scope)
**Verification:** medium rung: CI knip blocking with zero unallowlisted violations; allowlist schema test rejects entries missing owner/expiry; the knip-diff wrapper is itself a DR-8 gate — tool-missing and unparseable-output paths FAIL with cause-naming diagnostics (tested). **Census note:** knip treats tests/benches/evals as entry points (knip.json), so the enforced dead-export set is knip-semantic — smaller than the audit's prod-only ~50-type census; the ratchet enforces the knip set, and the audit census is targeting guidance only
**Serialization note:** edits `ci.yml` (the `validate-no-legacy` server-install step) — after Task 011 in the canonical chain (see Parallelization).
**Dependencies:** 005 (post-deletion baseline), 011 (ci.yml serialization)
**Parallelizable:** No
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

### Task 016: Remove the ignored prune staleness knobs

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-9
**Files:**
- `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts` (~:284, ~:800-807 — remove read + plumbing)
- `servers/exarchos-mcp/src/registry.ts` (~:2778 — remove the schema field; the CLI flag is auto-emitted from it and must disappear with it)
- `servers/exarchos-mcp/src/config/resolve.ts` (type, default, read, assign)
- `servers/exarchos-mcp/src/workflow/describe-config.ts` (~:81 — the fifth plumbing site: `annotate(config.prune.staleAfterDays, DEFAULTS.prune.staleAfterDays)` live-reads both the field and its default; removing the field from `resolve.ts` breaks this at typecheck) + `servers/exarchos-mcp/src/workflow/describe-config.test.ts`
- tests pinning the removed surface + a new test for the rejection behavior
**Expected tests:** `PruneSchema_RemovedKnob_NoLongerEmitsFlag`, `PruneAction_LegacyKnobPassed_ActionableRemovalError`, `Registration_PruneSchema_StillBuilds`, `DescribeConfig_StaleAfterDaysRemoved_OmitsAnnotatedField`
**Verification:** medium rung: scoped tests + adequacy probe; assert on the **emitted flag set** (schema-derived), not a grep; `buildRegistrationSchema` still builds (shared-field base-type reconciliation undisturbed); prune behavior unchanged for all non-removed inputs; **`describe-config` no longer annotates the removed field**
**Scope guard (name collision):** the removal targets `config.prune.staleAfterDays` and the prune action's `thresholdMinutes` input **by symbol path**. `pruner/score.ts:85` and `topology/phase-contract.ts:55` use `thresholdMinutes` as an unrelated per-signal contract field and are **out of scope** — a bare-identifier grep is not completion evidence and false-positives on both.
**Dependencies:** 005, 006 (both edit `registry.ts`; 006 lands first)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 017: Collapse the test-runtime resolver duplication by table-driving it

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/config/test-runtime-resolver.ts` (~266-325 duplicated pnpm/yarn/npm missing-script branches; ~495-556 triplicated per-field event construction; **also ~:12 — drop the stale comment describing the detect-test-commands module that Task 004 deletes**)
**Verification:** medium rung: scoped tests + adequacy probe; the existing resolver tests pass **unmodified** (a test edited to accommodate the table is a design smell per DR-10); layered per-field order preserved exactly (override > `.exarchos.yml` direct > user `toolchains:` > task-runner > built-in registry > unresolved); per-field provenance events identical in shape and count; `config/toolchains.ts` remains the sole toolchain-identity source — the table introduces no second marker/command list
**Dependencies:** 005
**Parallelizable:** Yes (after 005)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 018: Collapse the gate preflight + policy-skip duplication into a shared helper

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/orchestrate/contract-drift.ts`, `servers/exarchos-mcp/src/orchestrate/mock-boundary.ts`, `servers/exarchos-mcp/src/orchestrate/test-adequacy.ts`, `servers/exarchos-mcp/src/orchestrate/check-integration-suite.ts`, `servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts` (preflight + policy-skip emission → shared helper)
- `servers/exarchos-mcp/src/orchestrate/pure/gate-preflight.ts` (new leaf helper) + `servers/exarchos-mcp/src/orchestrate/pure/gate-preflight.test.ts`
**Verification:** medium rung: scoped tests + adequacy probe; each of the five handlers' existing tests pass **unmodified**; the policy-skip emission keeps identical event shape per handler (a shared emitter must not coalesce or re-label them)
**Dependencies:** 005
**Parallelizable:** Yes (after 005)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 019: Collapse the VCS, composite, projection, and oneshot-state duplication

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-10
**Files:**
- `servers/exarchos-mcp/src/vcs/github.ts`, `servers/exarchos-mcp/src/vcs/gitlab.ts`, `servers/exarchos-mcp/src/vcs/azure-devops.ts` — `computeOverallCiStatus` → shared helper
- **all four** `envelopeWrap` definitions → one shared helper: `servers/exarchos-mcp/src/views/composite.ts` (~:62), `servers/exarchos-mcp/src/workflow/composite.ts` (~:37), `servers/exarchos-mcp/src/orchestrate/composite.ts` (~:634), `servers/exarchos-mcp/src/event-store/composite.ts` (~:88); plus `envelopeWrapWithCacheHints` (`workflow/composite.ts` ~:61) — reconciled against the shared helper or justified in-task as distinct behavior
- `servers/exarchos-mcp/src/projections/rehydration/reducer.ts`, `servers/exarchos-mcp/src/projections/taskstore/reducer.ts` — shared data-extractors
- `servers/exarchos-mcp/src/orchestrate/finalize-oneshot.ts`, `servers/exarchos-mcp/src/orchestrate/request-synthesize.ts` — shared oneshot-state validation
- `servers/exarchos-mcp/src/projections/clone-extraction-fold.regression.test.ts` (new: fixture log folds identically through both reducers before and after extraction)
**Expected tests:** `ComputeOverallCiStatus_GitLabPartialProvider_StillThrows`, `ComputeOverallCiStatus_AzureDevOpsPartialProvider_StillThrows`, `Reducers_SharedExtractors_FoldFixtureLogIdentically`, `EnvelopeWrap_AllFourCallsites_IdenticalEnvelopeShape`
**Verification:** high rung: scoped tests + `check_test_adequacy` kill-probe + integration suite; **the existing tests of every touched module pass unmodified** — a test edited to accommodate a helper is a design smell and fails DR-10; **per-provider CI-status paths tested separately including the by-design throws** (GitLab/ADO are partial `VcsProvider`s — a helper that swallows or normalizes those throws changes behavior); reducer folds byte-identical on a fixture log (INV-1); **zero residual `envelopeWrap` definitions** outside the shared helper (grep is sufficient here — this is a definition count, not a semantic claim); the `execute-merge ↔ merge-orchestrate` 66-ln clone is **untouched** (pinned non-goal — its parity tests are the equivalence proof)
**Dependencies:** 006 — the only genuine overlap (both edit `projections/rehydration/reducer.ts`). Explicitly **not 009**: its files are `views/workflow-state-projection.ts`, `workflow/state-store.ts`, a new leaf module, `cycle-baseline.json`, and an architecture test, none of which 019 touches.
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 020: Binary `--minify` A/B

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-11
**Files:**
- `scripts/build-binary.ts` (~:138 — `--minify` added only if it wins)
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-baseline.md` (append the measured A/B)
**Verification:** medium rung: **named instruments, declared thresholds** — before/after binary size via `du` on the built artifact, cold-start via N≥5 timed `--version` invocations reported as median (the A/B is decided on the median, not one sample), and an **error-message diff**: the same failing invocation run against both binaries must produce byte-identical stderr. **Win threshold is declared before measuring** and recorded with the result, so "wins" is not adjudicated by implementer taste. **A negative result is a completed task** — if minify regresses startup, breaks stack-trace attributability, or alters any error message, land the measurement and rejection rationale, not the flag.
**Tier/evidence note:** this changes the **shipped release binary** — not low-tier work. Its CI evidence is also weak by default: `binary-matrix` is **absent from `ci-gate`'s `needs:` list** (`ci.yml:690`) and therefore already non-blocking, a lane that cannot fail a PR. The verification above must therefore run and be recorded **in the task**, not delegated to that lane. A single representative verb cannot see minify-induced changes to error text or stack traces, which is why the error-message diff is explicit.
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: true

### Task 021: Wire `test:coverage` in CI and capture the baseline

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-12
**Files:**
- `.github/workflows/ci.yml` — run `test:coverage` and publish `coverage-summary.json` as a step in **`test-mcp`** (the ubuntu server-test lane that already installs the server deps `vitest --coverage` needs; named explicitly per DR-8 rather than left as "the Linux lane", which resolves ambiguously to `test-mcp` or `test-root`)
- `scripts/audit/coverage-baseline.json` (new — checked-in baseline recording the commit, lane, **and the GitHub run-id of the CI run that produced it**)
**Verification:** medium rung: baseline **captured from CI, never locally** — the known-red local suite is local-only and would bake local skips into the ratchet; coverage artifact present and parseable in CI. **The provenance is mechanized, not asserted:** the baseline records the originating GitHub run-id and the ratchet validates it against a real run/artifact. A self-reported `"lane"` field would prove nothing, since a locally-captured file can simply claim to be from CI — and this provenance is the property the whole ratchet rests on.
**Serialization note:** edits `ci.yml` — after Task 013 in the canonical chain (see Parallelization).
**Dependencies:** 013 (ci.yml serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 022: Coverage non-regression ratchet, fail-closed

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-12, DR-8
**Files:**
- new gate script diffing `coverage-summary.json` against the checked-in baseline
- `.github/workflows/ci.yml` (blocking wiring)
- variance measurement recorded in the baseline doc + self-test fixtures (missing / empty / unparseable coverage → FAIL)
**Verification:** medium rung: self-test proves fail-closed all ways — **a ratchet that passes when coverage did not run is the exact failure DR-12 exists to prevent**; the epsilon is **set from a measured N≥3 CI variance run**, with both the runs and the derived epsilon recorded (a zero epsilon flakes, an unmeasured one hides regressions)
**Serialization note:** edits `ci.yml` — after Task 021.
**Dependencies:** 021
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 023: Run diff-scoped mutation-adequacy as an advisory signal

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-13, DR-8
**Files:**
- `.github/workflows/ci.yml` — run `orchestrate/mutation-adequacy.ts` diff-scoped as a step in **`test-root`** (it is a server TS module; per DR-8's placement rule `grep-gates` installs no deps and cannot run it)
- self-test fixtures separating runner-crash (FAIL, DR-8) from ran-and-found-mutants (advisory report)
**Expected tests:** `MutationGate_RunnerCrash_FailsClosedWithCause`, `MutationGate_SurvivedMutant_ReportsAdvisoryOnly`, `MutationGate_UnparseableReport_FailsClosed`
**Verification:** medium rung: diff-scoped only (`scope: 'full'` explicitly out); the report is visible on the PR and its findings become follow-ups; **fail-closed on the gate's own execution** — a crashed or unparseable run FAILS with a cause-naming diagnostic, which is the only thing separating an advisory gate from a gate that silently never ran. **This task does not make NoCoverage block**: the gate excludes NoCoverage from its score by construction and the severity path only downgrades, so blocking is a source change deferred to **#1711**.
**Serialization note:** edits `ci.yml` — after Task 022.
**Dependencies:** 022
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 024: `noUncheckedIndexedAccess` ratchet (+346)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-14
**Files:**
- `tsconfig.json` (root) + `servers/exarchos-mcp/tsconfig.json` (flag on, after the fixes)
- ~346 mechanical fix sites across both trees
- `!`/`as` budget measurement recorded in the PR body
**Expected tests:** `TsconfigRoot_NoUncheckedIndexedAccessEnabled_TypecheckGreen`, `TsconfigServer_NoUncheckedIndexedAccessEnabled_TypecheckGreen`, `FixWave_CastBudget_MeasuredAndWithinDeclaredLimit`
**Verification:** high rung: **both typechecks** (root does **not** cover `servers/exarchos-mcp`) + both full suites in CI; **the cheat is closed** — a measured count of `!`/`as` sites introduced by the fix wave, each above the declared budget justified, `as any` barred outright (strict-TS: `unknown` + type guards); **high blast radius** — full suites run between fix-wave merges, not only at the end, since per-task scoped verification cannot see this diff's reach
**Scope note:** the largest mechanical task in the program; the orchestrator may sub-wave the fix sites across worktrees, but the flag flip is atomic and lands last within the task.
**Semantic coupling with 017 (not just textual):** Task 017's deliverable is to *table-drive* the resolver, and **a table lookup is an indexed access** — `noUncheckedIndexedAccess` changes what correct table-driven code looks like. So 017-then-024 and 024-then-017 produce different implementations, and 017's acceptance ("existing tests pass unmodified") cannot arbitrate between them. 017 lands first, and 024 brings its table under the flag; authoring the table twice is the cost of getting the order right.
**Dependencies:** 005, 006, 007, 016, 017, 018, 019, 030 — **every src-touching task in the program**, so the fix wave lands last and nothing rebases onto 346 fixes. Each of these edits files inside the 532-fix surface: 016 (`prune-stale-workflows.ts`, `registry.ts`, `config/resolve.ts`, `describe-config.ts`), 017 (`test-runtime-resolver.ts`), 018 (the five gate handlers), 006/007 (the merge seam), 019 (the extraction set), and **030** (~48 reference edits plus two behavioral constants — T8 reads as docs-only but is not).
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 025: `exactOptionalPropertyTypes` ratchet (+186)

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-14
**Files:**
- `tsconfig.json` (root) + `servers/exarchos-mcp/tsconfig.json` (flag on, after the fixes)
- ~186 mechanical fix sites across both trees
- `!`/`as` budget measurement recorded in the PR body
**Expected tests:** `TsconfigRoot_ExactOptionalPropertyTypesEnabled_TypecheckGreen`, `TsconfigServer_ExactOptionalPropertyTypesEnabled_TypecheckGreen`, `FixWave_BothStrictFlags_FullSuitesGreen`
**Verification:** high rung: same bar as 024 — both typechecks, both full suites between merges, measured cast budget, no `as any`
**Dependencies:** 024 (both edit both tsconfigs; fixing one flag's errors churns the same files — strictly serialized, and in this order per the audit's sequencing)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 027: Raise the mechanically-checkable invariants to `check` and make them blocking

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-15
**Files:**
- `.exarchos/invariants.md` — INV-13 (~:239), INV-14 (~:280), INV-16 (~:669) raised `mode: audit` → `mode: check`; **INV-8 (~:79-103) gets a machine-check block authored from scratch — it has no `mode:` field to raise**
- `check_invariant_conformance` gate registration (`blocking: false` → blocking **for check-mode findings only**)
- per-invariant deterministic checks + self-tests
**Expected tests:** `InvariantGate_SyntheticViolation_FailsForCheckMode`, `InvariantGate_ConformingTree_Passes`, `InvariantGate_AuditModeFinding_StaysAdvisory`
**Verification:** medium rung: each raised invariant self-tests **both directions** — a synthetic violation FAILS and the current conforming tree PASSES (a check that cannot fail is vacuous — the same class DR-5's gate closes); blocking scoped to check-mode findings only (the **11** audit entries stay advisory, or CI goes red on unproven rules); any invariant that resists determinism stays `audit` with rationale — including INV-8, whose check is new work rather than a flip
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 028: Error-envelope lint at public catch-boundaries

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-16
**Files:**
- `scripts/check-error-envelope.mjs` (new ts-morph or ESLint rule over `servers/exarchos-mcp/src/orchestrate/**` and `servers/exarchos-mcp/src/adapters/**` handler catch-boundaries) + self-test fixture
- `scripts/audit/error-envelope-allowlist.json` (new register, symbol-keyed per the shared entry contract; a distinct file from the knip register so the two gates do not contend on one artifact)
- the shared schema module + its test
- `.github/workflows/ci.yml` — **the task names its host job before implementing**, per DR-8's placement rule: `grep-gates` only if the rule ships zero-dependency, otherwise `test-root` (a ts-morph rule needs deps `grep-gates` does not install)
**Verification:** medium rung: self-test both directions (synthetic raw-throw handler FAILS; conforming tree PASSES); INV-2 holds — the rule is not satisfied by moving error translation into an adapter; fail-closed (rule-crash / unparseable source = FAIL). Its host job is already in `ci-gate`'s `needs:`, so the step blocks on merge (DR-8).
**Dependencies:** 010 (both extend the shared schema module — the registers are separate files, but the **validator** is one contended artifact), 012 (allowlist shape)
**Parallelizable:** No (ordered 010 → 028 on the shared schema module)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 029: Wire `vocabulary-lint` and extend its scope

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-17, DR-8
**Files:**
- `.github/workflows/ci.yml` — add the `lint:invariants` step to the **`test-root` job**, not `grep-gates`
- scope extension to action names/descriptions in normative directories + fixes/allowlist for its new violations
- self-test (synthetic vocabulary violation → gate fails)
**Job-placement note:** `lint:invariants` is `tsx servers/exarchos-mcp/src/architecture/vocabulary-lint-cli.ts` — it needs `tsx` plus **root and server** deps. `grep-gates` runs no `npm ci` by design (and DR-4's depcruise gate depends on that staying true), so this gate cannot execute there. `ci.yml:119-127` sets the precedent explicitly for the sibling `desc:budget-guard`: it runs in `test-root` *"because it imports TOOL_REGISTRY via tsx... Sibling to skills:guard / lint:invariants."* Consequently Task 033 must **not** cite "grep-gates green" as this gate's evidence — that lane structurally cannot observe it.
**Verification:** medium rung: the extended scope's own violations already fixed or allowlisted before wiring (**wiring a gate whose new scope is red is how gates get disabled**); INV-4 — skills-side findings fixed in `skills-src/` with `build:skills` re-run, never in generated `skills/<runtime>/**`; fail-closed. `test-root` is already in `ci-gate`'s `needs:` list, so this gate blocks the moment its step lands (DR-8).
**Dependencies:** 023 (ci.yml serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 030: Archive the superseded dated delivery artifacts

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-18
**Files:**
- `docs/plans/**`, `docs/designs/**` — superseded dated artifacts archived / docsite-excluded (the audit's 114.5K ln / 5.58 MB is week-old targeting guidance, **re-measured by this task**; git history preserved)
- inbound reference updates from `skills-src/**`, `commands/**`, and `servers/exarchos-mcp/src/**` — ~48 refs across ~33 files at authoring (**the task re-measures**), e.g. `telemetry/telemetry-projection.ts` (~:183, a live relative markdown link), `registry.ts` (~:1148), `format.ts` (~:116, :353, :446), and 8+ across `agents/adapters/*.ts`
- **behavioral edits, each with a test:** `servers/exarchos-mcp/src/workflow/rehydrate.ts` (~:76 `LEGACY_DESIGN_DIR` — classifies in-flight workflows; legacy workflows must still resolve under the old path) and `servers/exarchos-mcp/src/architecture/vocabulary-lint.ts` (~:188 `DATED_RECORD_TREES` — scopes which trees the lint walks)
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-t8-baseline.md` (**new — DR-18's own measurement record**, created here and appended by 031/032; separate from the wave-1 deletion baseline so the T8 tasks do not contend with 005/020)
**Expected tests:** `Rehydrate_LegacyDesignPathArchived_StillResolvesUnderOldPath`, `VocabularyLint_DatedRecordTrees_ScopeUnchangedAfterArchival`
**Verification:** medium rung: **diff-scoped link check** — links in and to the moved files resolve, measured before/after (the checker scans all of `docs/` and already fails on ~190 pre-existing repo-wide breaks; a whole-tree green is unattainable and is **not** the bar, and pre-existing breaks must not be absorbed into this feature's evidence); **every `src/**` edit is enumerated and classified inert-vs-behavioral**, each behavioral one carrying a test; both typechecks + both full suites green; generated artifacts untouched (lockfiles, `snapshots.test.ts.snap`, `docs/schemas/tool-reference.md`, legacy hash manifest); measured before/after repo size + file count in the T8 baseline doc and PR body
**Tier note:** not low-tier — it changes two constants that steer workflow classification and lint scope.
**Dependencies:** 029 (both edit `architecture/vocabulary-lint.ts`: 029 extends its scope, 030 changes its `DATED_RECORD_TREES`)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 031: Dedup the duplicate-basename groups

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-18
**Files:**
- the duplicate-basename groups spanning `docs/plans` ↔ `docs/designs` ↔ `docs/proposals` — one canonical per group, the rest become links. Representative members: `docs/plans/2026-01-05-delegate-pr-fingerprint.md`, `docs/plans/2026-01-06-repo-management.md`, `docs/designs/2026-01-05-jules-api-schema-fix.md` (the full set is enumerated by the task's own scan, not by this list)
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-t8-baseline.md` (append the measured dedup delta)
**Verification:** static: exactly one canonical per group; non-canonical members are links, not deletions; diff-scoped link check green on the touched set; measured before/after file count + repo size in the PR body. **Re-measure, do not trust the citation:** the audit's 105 groups / 211 files is a week-old figure and the current tree scans to **102** groups — the task's own scan governs, per this spec's measured-not-asserted discipline
**Dependencies:** 030 (same doc tree; archival settles the surface first)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 032: Optimize the 2.11 MB logo asset

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-18
**Files:**
- `documentation/public/logo.svg` (measured at 2.1 MB on this branch — optimize in place)
- `docs/specs/2026-07-15-debloat-wave1-structural-enforcement-t8-baseline.md` (append the measured asset delta)
**Verification:** static: measured before/after size recorded in the T8 baseline doc; the asset still renders identically at its used sizes (visual check recorded)
**Gate note:** `svg` is absent from the task-decomposition gate's closed file-extension allowlist, so this task's real target is invisible to that parser (the same blind-spot class #1544 fixed for `.py`) — filed as **#1710**. The T8 baseline doc is a genuine artifact of this task, not a workaround for the gate.
**Dependencies:** 030 (creates the T8 baseline record this task appends to)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 033: Fail-closed conformance for the phase-2 gates

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-8
**Files:**
- unit tests across the coverage ratchet (022), the mutation wiring (023), the error-envelope rule (028), and the vocabulary-lint wiring (029): tool-missing / unparseable-output paths assert FAIL with cause-naming diagnostics
- run `scripts/check-windows-portability.mjs` over any new scripts
**Verification:** medium rung: all simulated failure paths red-then-fixed; mirrors Task 015 for the gates this broadening adds (015 stays scoped to the wave-1 gates); portability pass. **Evidence is per-gate, by lane**: 029's `lint:invariants` and 023's mutation gate run in **`test-root`**, so grep-gates cannot observe them (DR-8). Each gate's evidence names the lane that actually runs it.
**Dependencies:** 022, 023, 028, 029
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Parallelization

**Longest pole — the `ci.yml` chain (canonical; every task's `Serialization note` defers to this):** `011 → 012 → 010 → 013 → 021 → 022 → 023 → 029`, itself gated behind `{001-004} → 005` and `009`. Eight tasks add steps to one workflow file, so they land serially. **Plan the calendar around this chain, not around test runtime.** Task 033 depends on the chain's gates but edits no `ci.yml` — it is not a link in it. DR-3's mechanism was resolved to the workspace package partly to keep Task 008 out of the chain.
**Second pole — the tsconfig chain:** 005 → 006 → 019 → 024 → 025. It is **not** routed through 009: 009 and 019 share no file, so no edge exists between them, which keeps a high-tier extraction off the 532-fix wave's critical path.

- **Wave A** (parallel worktrees, no dependencies): 001, 002, 003, 004, 006, 008, 011, 014, 020, 027.
- **Wave B** (after 005): 017, 018; 012 also waits for 011 (ci.yml); 009 and 016 additionally wait for 006 (`views/workflow-state-projection.ts` and `registry.ts` respectively).
- **Wave C**: 007 (after 006), 010 (after 009+012), 019 (after 006), 013 (after 005+014+010); 030 (after 029 — both edit `architecture/vocabulary-lint.ts`), then 031 and 032 (after 030, which creates the T8 baseline record they append to).
- **Wave D**: the `ci.yml` chain 021 → 022 → 023 → 029, strictly serial; 015 (after 010, 011, 013) runs beside it. 028 lands here too (after 010 on the shared validator, and 012 for the allowlist shape).
- **Wave E**: 024 (after every src-touching task: 005, 006, 007, 016, 017, 018, 019, 030) → 025.
- **Wave F**: 033 (after 022, 023, 028, 029) — fail-closed conformance across the phase-2 gates.

Gate baselines (010, 012, 013, 021) are captured only after the deletion wave merges, per Technical Design ordering — a baseline captured pre-deletion would allowlist the modules DR-1 removes and bake deleted code into the coverage denominator.

**Dispatch note:** DR-14's two tasks (024, 025) carry ~532 mechanical fixes between them. The orchestrator may sub-wave those fix sites across worktrees, but each flag flip is atomic and lands last within its task, and both full suites run between fix-wave merges (per DR-14) — per-task scoped verification cannot see a diff of that reach.

### Completion checklist

- [ ] Every DR-N in `## Design & Rationale` maps to at least one task in the matrix
- [ ] Every task `Implements:` a DR-N that exists in this document (no forward-dangling references)
- [ ] Every task carries a `riskTier` stamp
- [ ] Medium/high-tier tasks carry adequacy-judged tests (test-after); low-tier tasks lean on static analysis
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] Every in-scope epic sub-issue (#1702, #1703, #1704, #1706, #1707) maps to at least one DR-N; every excluded one (#1705, #1708) carries a recorded rationale
- [ ] Every new gate (DR-12, DR-16, DR-17) has a both-directions self-test — synthetic violation FAILS, conforming tree PASSES
- [ ] **Every task naming a `ci.yml` edit names its job**, and every gate's evidence cites the lane that runs it (DR-8)
- [ ] **Every register has a consumer** — no checked-in JSON that no script reads
- [ ] **Every cited number an acceptance criterion depends on is re-measured by its task** — no figure inherited from the audit or an issue body governs a bar
- [ ] Ready for `plan-review`
