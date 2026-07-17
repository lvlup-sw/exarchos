# Spec: Wave S — Enforcement-Substrate Semantics + Coverage/Mutation CI Wiring

**Issues:** #1711 (Wave S design), #1704 (Wave 3a) · **Parent epic:** #1701
**designDepth:** standard — the uncertainty was already burned down by six rounds of dispatched adversarial plan-review on PR #1700 (which produced #1711's verified problem statement); what remains is convergent decision-making against the tree, not open exploration.

## Constraints

Anchored to `.exarchos/invariants.md`:

- **INV-5b (output-contract):** Tool outputs are structured `ToolResult` carriers; a gate's carrier shape is a published contract — additive evolution only.
- **INV-2 (facade-equivalence):** The `mutation-adequacy` orchestrate action is reachable from both the CLI and MCP facades; a semantics change must land identically on both paths (it lives in the shared handler, not an adapter).
- **INV-6 (workload-agnosticism):** Gates added here are repo-level CI mechanisms; nothing may key on a specific workflow type.
- **INV-16 (os-portability, pulled on demand):** New check scripts follow the wave-1 DR-8 convention — fail-closed, attributable, and portable within their declared host (CI runs them on ubuntu; local invocation must not assume a POSIX-only toolchain beyond what existing `scripts/check-*` already assume).

Spec-level constraint carried from wave 1 (spec `2026-07-15-debloat-wave1-structural-enforcement.md`, DR-8): every gate fails closed on missing tools or unparseable output, ships a self-test exercising both directions (synthetic violation FAILS, conforming tree PASSES), and its baseline artifacts are attributable to a source.

## Design & Rationale

### Problem Statement

An enforcement gate only governs if two properties hold: it **runs** on the PRs it polices, and it **can fail** them. On current main both properties are accidental, not designed:

1. **Path filters silently disarm gates.** `test-root` (`ci.yml:64`) and `test-mcp` (`:133`) run only when `changes.outputs.root`/`.mcp` match (filters at `:41-62`; `root` excludes `servers/**`, `scripts/**`, `commands/**`, `docs/**`). `ci-gate` (`:806`) fails only on `failure|cancelled` and prints "All checks passed (skipped jobs are OK)" (`:882`). A gate stepped into a filtered job is skipped-as-passed on every PR outside its host's filter. Nastier: both filters include `.github/workflows/ci.yml`, so the PR that *lands* a gate always runs it — the self-test passes, then the gate silently stops governing.
2. **The aggregator is hand-maintained and already drifted.** `ci-gate.needs` (`:809`) is a hand-edited list; `e2e-process` (`:704`) carries a "Blocking gate as of T3.7" comment while being absent from `needs:` — it cannot fail a PR. `binary-matrix` is likewise silently non-blocking. Nothing detects the next drift.
3. **Three enforcement semantics were never pinned**, and six adversarial reviewers refuted three attempts to pin them in spec prose (#1711): where a gate whose scan surface exceeds its host's filter should live; whether diff-scoped NoCoverage mutants block (`mutation-adequacy.ts` scores 5-killed + 5-NoCoverage as 1.0 and passes); and what identity function makes an `as unknown as` type-debt register enforceable.
4. **Coverage is never measured in CI** (`test:coverage` exists in `servers/exarchos-mcp/package.json`, no workflow invokes it), so wave 3b's "coverage-preserving consolidation" (#1705) is unverifiable — the same "exists, not wired" class the wave-1 enforcer-wiring gate closed for check-scripts.

### Chosen Approach

Make gate hosting a **decided convention backed by a machine-checked topology contract**, then wire the wave-3a gates onto sound hosts under that convention.

**The host taxonomy already exists in the tree — name it and enforce it.** Three host classes cover every gate:

| Host class | Existing host | Filter | Deps | For gates whose… |
|---|---|---|---|---|
| Zero-dep, unfiltered | `grep-gates` | none | none | check is a self-contained script (grep/node, no install) |
| Deps, unfiltered | `outcome-tests` | none | root + MCP `npm ci` | check needs tsx/vitest/built artifacts AND scans surfaces broader than any filter |
| Deps, filtered | `test-root` / `test-mcp` | `root` / `mcp` | per-job | scan surface is a **subset** of the host's filter |

The rule: **a gate may live in a filtered job only when its scan surface is a subset of that job's filter.** Everything else goes to an unfiltered host. This resolves every stalled instance without new jobs: the coverage ratchet and diff-scoped mutation gate scan `servers/**` — exactly the `mcp` filter — so `test-mcp` is *correct*, not a compromise; `vocabulary-lint` scans `skills-src/`, `commands/`, `docs/architecture/`, `docs/guides/` (broader than any filter) and needs both dep trees (`tsx` entrypoint), so it goes to `outcome-tests`, stepped before the binary build for fast failure.

**Drift becomes a test failure, not a review hope.** A root-suite conformance test parses `ci.yml` and asserts the aggregator's completeness (every job blocking or explicitly declared non-blocking with rationale) and the skip-guard coverage of filtered `needs:` jobs. Its own hosting is sound under the rule it enforces: its scan surface is exactly `.github/workflows/ci.yml`, which is in the `root` filter — CI topology cannot change without triggering it.

**The two semantic questions get the smallest mechanism that actually blocks.** NoCoverage becomes a second, orthogonal pass-axis on the mutation gate (deterministic, therefore the *safest* blocking axis) rather than a redefinition of `mutationScore`. Type-debt gets a per-file count-budget ratchet — the same checked-in-baseline idiom wave 1 established for cycles (`no-circular`) and exports (`knip`) — hosted in `grep-gates`.

## Requirements

### DR-1: Gate-host decision table is the documented convention

The host taxonomy and subset rule above land as normative documentation: a comment block at the top of `ci.yml`'s job section and a short guide section (`docs/guides/` or the architecture docs, one canonical location — no duplication). Every gate added by this spec cites its host-class row at its wiring site.

**Acceptance criteria:**
- The decision table (host class × filter × deps × subset rule) exists in exactly one canonical prose location, referenced (not restated) from `ci.yml`.
- Each gate wired by DR-5..DR-9 carries a one-line comment naming its host class and why the subset rule holds (or doesn't apply) for it.
- The stale `e2e-process` "Blocking gate as of T3.7" comment is corrected to state the job's actual disposition (see DR-4).

### DR-2: CI-topology conformance test — the aggregator cannot drift silently

A co-located root-suite test (e.g. `scripts/ci-topology.test.ts` beside a small parser, or a single self-contained test file) parses `.github/workflows/ci.yml` and asserts:

1. **Completeness:** every top-level job key is either in `ci-gate.needs` or in an explicit in-test allowlist of declared-non-blocking jobs, each entry carrying a rationale string and (where applicable) a tracking-issue reference.
2. **Evaluate coverage:** for every job in `ci-gate.needs` (except `ci-gate` itself), the evaluate step's script contains a `needs.<job>.result` clause matched against `failure|cancelled`.
3. **Skip-guard coverage:** for every *path-filtered* job in `ci-gate.needs`, the evaluate script contains a fail-closed skip-guard keyed on the corresponding `changes.outputs.<key>` (the `:847`/`:864` pattern).

**Acceptance criteria:**
- Self-test both directions: a synthetic workflow fixture with (a) a job absent from `needs` and allowlist, (b) a filtered `needs` job with no skip-guard, each FAILS; the post-DR-3/DR-4 real `ci.yml` PASSES.
- The test runs in the root suite (`npm run test:run`), whose host (`test-root`) is sound for it: its scan surface is exactly `ci.yml`, which is in the `root` filter.
- The allowlist is in the test file itself (reviewable in the same diff that adds a job), not a separate config that can rot.

### DR-3: Skip-guards for the filtered test jobs close the skipped-as-passed hole

`ci-gate`'s evaluate step gains two guards mirroring the existing Windows pattern (`:847-851`, `:864-868`): fail when `changes.outputs.root == 'true'` but `test-root` was skipped, and when `changes.outputs.mcp == 'true'` but `test-mcp` was skipped.

**Acceptance criteria:**
- Both guard clauses present in the evaluate script, fail-closed (exit 1 with an attributable `::error::` message naming the dropped lane).
- DR-2's conformance test asserts their presence structurally (this is the machine check; the guards themselves cannot be integration-tested from inside a PR).

### DR-4: The two silently-non-blocking jobs get explicit dispositions

- **`e2e-process`:** declared **non-blocking** in DR-2's allowlist, with rationale: the suite has a known `SQLITE_BUSY` flake class; making it blocking taxes every PR with retries. The stale "Blocking gate as of T3.7" comment is corrected. A follow-up issue is filed to burn down the flake and flip it into `needs:` (the allowlist entry cites it).
- **`binary-matrix`:** declared **non-blocking** with rationale: it is release-lane evidence (compile matrix), not a per-PR gate; this is the standing reason the `--minify` A/B was dropped (#1703).

**Acceptance criteria:**
- Both jobs appear in the DR-2 allowlist with rationale + issue reference (e2e-process) at merge.
- The corrected `e2e-process` comment states it is non-blocking and why, citing the follow-up issue.
- Zero jobs remain outside both `needs:` and the allowlist (DR-2 completeness passes).

### DR-5: Coverage baseline + non-regression ratchet in `test-mcp`

`test-mcp` gains a coverage step: run `npm run test:coverage` (server tree), then a ratchet script compares `coverage-summary.json` totals against a checked-in baseline (`servers/exarchos-mcp/coverage-baseline.json`) with a **measured** epsilon.

- **Baseline provenance:** captured from a CI run, never locally (the ~26 known-red local suite would bake local skips into the ratchet). The baseline file records the originating GitHub run-id and the ratchet validates its presence and format.
- **Epsilon is measured, not guessed:** the landing PR runs the coverage job ≥3 times (matrix or re-run), records per-metric variance in the baseline file, and derives epsilon from observed spread. A zero epsilon flakes; an unmeasured one hides regressions.
- **Host soundness:** scan surface is `servers/exarchos-mcp/**` — a subset of the `mcp` filter (DR-1 rule); a PR that cannot touch server code cannot regress server coverage. DR-3's skip-guard covers the wiring-regression case.

**Acceptance criteria:**
- Ratchet FAILS on a synthetic regression exceeding epsilon; PASSES on an identical re-run; FAILS CLOSED on missing/unparseable `coverage-summary.json` (self-test covers all three).
- Baseline file carries run-id + measured variance; ratchet rejects a baseline missing either.
- Blocking via `test-mcp`'s existing `ci-gate` membership; step comment cites its DR-1 host-class row.

### DR-6: Mutation NoCoverage becomes a blocking axis (two-knob pass computation)

`orchestrate/mutation-adequacy.ts`: the carrier's `mutationScore` definition is **unchanged** (`killed / (total − noCoverage)` — INV-5b: consumers keep their semantics). The handler's `passed` computation (`:712`) gains a second, orthogonal knob: for diff-scoped runs, `passed = mutationScore >= threshold && noCoverage <= maxNoCoverage`, with `maxNoCoverage` defaulting to **0**. Rationale: for a *diff*-scoped gate the changed line is the subject — an uncovered changed line is exactly the "test executes nothing" defect the gate exists for; and NoCoverage is deterministic (runner-budget-insensitive), making it the safest axis to block on, while the survivor threshold remains the flake-budget-sensitive one.

**Acceptance criteria:**
- A diff scoring 5 killed + 5 NoCoverage now FAILS (previously passed at 1.0); an all-covered diff at the same score PASSES unchanged.
- Carrier evolution is additive only; existing carrier fields and their meanings are untouched; both facades (CLI/MCP) see the identical change (shared handler — INV-2).
- The failure message attributes NoCoverage to file/line so the fix is actionable.
- Existing gate-severity plumbing untouched: `applyLadderGateSeverity` can still downgrade the verdict via explicit config (relaxation stays possible; silent strengthening does not occur elsewhere).

### DR-7: Diff-scoped mutation-adequacy wired into CI as the effectiveness backstop

`test-mcp` gains a step invoking the in-tree diff-scoped mutation gate against the PR's base...head diff (paved path — full-tree stryker remains out of scope). With DR-6, the wired gate can actually fail: NoCoverage on changed server lines blocks.

**Acceptance criteria:**
- Step computes the PR diff in CI and invokes the `mutation-adequacy` action on it; a fabricated uncovered-line diff FAILS the job (exercised in the gate's self-test, not live CI).
- Fail-closed on runner/tooling absence or unparseable report (existing parse entry point already degrades — the CI wiring must treat degrade-without-verdict as failure, per wave-1 DR-8).
- Host-class comment cites DR-1 (scan surface `servers/**` ⊆ `mcp` filter).
- Runtime budget documented; the step is skipped-with-failure never silently (skip conditions, if any, enumerated and guarded).

### DR-8: vocabulary-lint wired into `outcome-tests`

`npm run lint:invariants` (tsx entrypoint, needs root + server deps) lands as a step in `outcome-tests` — unfiltered, already in `ci-gate.needs`, already installs both dep trees — ordered **before** the binary build so lint failures surface in seconds. Scope is the current live surfaces only (`skills-src/`, `commands/`, `docs/architecture/`, `docs/guides/`); the `registry.ts` action-description scope extension stays deferred (#1706).

**Acceptance criteria:**
- Step present before the binary-build step; a seeded vocabulary violation fails the job (self-test at the script level, as live CI cannot be seeded).
- Job name/header comment updated to reflect the broadened duty (outcome tier + unfiltered lint gates), citing its DR-1 host-class row.
- No filter widening anywhere: the `root`/`mcp` filters are byte-identical before and after this DR.

### DR-9: Type-debt register — per-file count budget, hosted in `grep-gates`

The `as unknown as` register uses **per-file count budgets** as its identity function: `scripts/check-type-debt.mjs` (zero-dep node, grep-gates conventions) + a checked-in `scripts/type-debt-baseline.json` mapping file → count.

- **Census definition (pinned):** files under `src/**` and `servers/exarchos-mcp/src/**`, excluding `**/*.test.ts`, `**/*.bench.ts`, `**/*.d.ts`, `**/__tests__/**`, `**/__shims__/**`, `**/__mocks__/**`, and fixture/stub helpers under `**/__shared__/**`. The script's exclusion list is the census definition — the baseline is regenerable from it.
- **Ratchet semantics (mirrors wave-1 `no-circular`/knip idiom):** a file exceeding its budget FAILS; a file absent from the baseline with count > 0 FAILS; counts below budget prompt a baseline ratchet-down in the same PR (the script reports the delta; whether stale-high budgets hard-fail follows the existing wave-1 ratchet behavior for consistency — the plan pins it to whichever `check-enforcer-wiring`/knip already do).
- **Rejected identities, recorded:** `{symbol, file}` cannot distinguish the 13 casts in `orchestrate/composite.ts` (subset-register passes; completeness unenforceable); `{file, line, col}` churns on unrelated edits and the deferred 532-fix tsconfig wave (#1706) would invalidate it wholesale; content-hash collides on identical casts and churns on renames; inline suppressions put an annotation wave ahead of any enforcement.

**Acceptance criteria:**
- Self-test both directions: seeded fixture with an over-budget file FAILS; the current tree with a freshly generated baseline PASSES.
- Baseline regeneration is a script flag (`--update`), so #1706's fix waves ratchet it down mechanically.
- Hosted in `grep-gates` (zero-dep, unfiltered — DR-1 row cited); blocks every PR from merge day.

### DR-10: Fail-closed, self-tested, attributable — error handling across every new mechanism

Every script/gate added by DR-2..DR-9 follows the wave-1 DR-8 convention:

**Acceptance criteria:**
- Fail-closed on missing tools, missing inputs, and unparseable outputs — never skip-as-pass. Each failure message names the artifact and the reason.
- Each ships a self-test exercising: the synthetic-violation direction, the conforming direction, and at least one fail-closed direction.
- Baseline artifacts (coverage, type-debt) are attributable: coverage carries CI run-id + variance; type-debt carries the generating script version/flag; both are rejected by their consumers when provenance is missing.
- No new gate is stepped into a filtered host whose filter does not contain the gate's full scan surface (DR-1 rule; DR-2 enforces the aggregator side).

## Technical Design

**Files touched (by area):**

- `.github/workflows/ci.yml` — skip-guards in `ci-gate` evaluate (DR-3); coverage + mutation steps in `test-mcp` (DR-5, DR-7); vocabulary-lint step in `outcome-tests` (DR-8); corrected `e2e-process` comment + host-class comments (DR-1, DR-4). The wave-1 serialization discipline applies: all `ci.yml` edits land serially.
- `scripts/` — `ci-topology.test.ts` (+ fixture workflows) (DR-2); `check-type-debt.mjs` + `type-debt-baseline.json` + self-test (DR-9); coverage-ratchet script + self-test (DR-5).
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.ts` (+ its tests) — two-knob `passed` (DR-6).
- `servers/exarchos-mcp/coverage-baseline.json` — CI-captured baseline (DR-5).
- Docs: one canonical decision-table location (DR-1).

**What this does NOT touch:** the `root`/`mcp` filters (byte-identical); `mutationScore` semantics; `grep-gates`' zero-install property; any wave-2 file (`registry.ts`, `config/resolve.ts`, the gate handlers — no overlap with tasks 016-019, so the two tracks parallelize); branch-protection settings (repo-settings, not tree — `pr-body-check.yml` is explicitly out of `ci-gate`'s contract and noted as such in the DR-1 documentation).

## Integration Points

- **ci-gate aggregator** — DR-3 guards and DR-2's structural assertions must agree; DR-2 is authored against the post-DR-3 evaluate block.
- **`mutation-adequacy` action** — shared handler behind both facades (INV-2); consumed by the R5 review dimension (`mutation-adequacy` skill) and now CI (DR-7). The skill's advisory framing updates only if it claims "cannot block" (it gains a blocking CI context).
- **Wave 3b (#1705)** — DR-5's baseline is its gate; the epsilon measurement is the enabling artifact.
- **#1706 (deferred)** — DR-9's register is the substrate its tsconfig fix waves ratchet down; the vocabulary-lint `registry.ts` scope extension and error-envelope lint land there, on the DR-1 convention.

## Alternatives considered

- **Widen the `root` filter to cover vocabulary-lint's surfaces** — rejected: every docs/commands PR would run the full root job (typecheck + suite + guards, minutes) to get a seconds-long lint; filter growth re-litigates per gate; the filter stops meaning "root package changed".
- **A new dedicated unfiltered `lint-gates` job** — rejected for now: costs two `npm ci` per PR to duplicate what `outcome-tests` already installs. Revisit only if outcome-tests' identity/runtime muddies.
- **Auto-generate `ci-gate.needs` / the evaluate block** — rejected: CI generating CI adds a meta-build step and its own drift surface; the conformance test achieves cannot-drift with a fraction of the machinery.
- **Redefine `mutationScore` to the Stryker-standard denominator (NoCoverage included)** — rejected: mutates a published carrier's semantics under consumers (INV-5b); conflates "test asserts nothing" with "line never executed"; the two-knob form keeps both signals attributable.
- **Make `e2e-process` blocking now** — rejected: known `SQLITE_BUSY` flake class would tax every PR; disposition is explicit-non-blocking + tracked flip after burn-down (DR-4).
- **Type-debt identity via `{file,line,col}` / content-hash / inline suppressions** — rejected per DR-9's recorded rationale.

## Open Questions

- **Epsilon magnitude** — unknowable until measured; DR-5 makes measurement part of the landing PR (≥3 CI runs). Not a blocker: the mechanism is specified, the constant is empirical.
- **`outcome-tests` job rename** — if any external required-check reference names "Outcome Tests (linux-x64)", renaming breaks it. Resolution at implementation: attempt a read-only branch-protection query; if unreadable, keep the job `name:` stable and broaden only the comment.

## Decomposition

### Scope

**Target:** DR-1 … DR-10 — the full spec: #1711 (all three semantic decisions land as mechanisms) and #1704 (coverage + mutation wired into CI on sound hosts).
**Excluded, each with a named owner:**
- **#1705 (wave 3b)** — consumes DR-5's baseline; its own campaign workflow.
- **#1706 (enforcement phase 2)** — the tsconfig fix waves that ratchet DR-9's baseline down, the `registry.ts` vocabulary-lint scope extension, and the error-envelope lint (each lands on the DR-1 convention once this spec establishes it).
- **Flipping `e2e-process` to blocking** — DR-4 declares it non-blocking with a tracked follow-up issue; the flip is gated on flake burn-down, not this spec.
- **Full-tree mutation (stryker)** — DR-7 wires the diff-scoped paved path only.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Gate-host decision table documented | 005, 006 |
| DR-2 | CI-topology conformance test | 008 |
| DR-3 | Skip-guards for filtered test jobs | 006 |
| DR-4 | Dispositions for silently-non-blocking jobs | 006 |
| DR-5 | Coverage baseline + ratchet in test-mcp | 003, 007, 009 |
| DR-6 | Mutation NoCoverage blocking axis | 001, 010 |
| DR-7 | Diff-scoped mutation gate wired into CI | 004, 007 |
| DR-8 | vocabulary-lint wired into outcome-tests | 007 |
| DR-9 | Type-debt count-budget register | 002 |
| DR-10 | Fail-closed, self-tested, attributable | 002, 003, 004, 008, 011 |

### Tasks

### Task 001: Two-knob mutation pass computation (NoCoverage blocking axis)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-6
**Files:**
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.ts` (the `passed` computation ~:712 gains the `maxNoCoverage` knob, default 0 for diff scope; carrier evolution additive only — `mutationScore` definition untouched)
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.test.ts` (extend)
**Expected tests:** `Passed_DiffScopeKilledPlusNoCoverageMix_Fails`, `Passed_AllCoveredAtThreshold_PassesUnchanged`, `Passed_NoCoverageWithinExplicitBudget_Passes`, `FailureMessage_NoCoverageMutants_AttributesFileAndLine`, `Severity_ConfigDowngrade_StillDowngradesNewAxis`
**Verification:** medium rung: scoped tests + adequacy probe; carrier fields and `mutationScore` semantics byte-identical for existing consumers (INV-5b — assert the carrier shape additively); both facades see the change via the shared handler (INV-2 — no adapter edit anywhere in the diff)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 002: Type-debt count-budget register (script + baseline + self-test)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-9, DR-10
**Files:**
- `scripts/check-type-debt.mjs` (new — zero-dep node; census globs per DR-9; `--update` regenerates the baseline; ratchet semantics mirror the existing wave-1 ratchet scripts' stale-baseline behavior, pinned in-code with a comment naming which script it mirrors)
- `scripts/type-debt-baseline.json` (new — generated by `--update` on the current tree)
- `scripts/check-type-debt.test.sh` (new — seeded fixture over-budget FAILS; current tree + fresh baseline PASSES; missing baseline FAILS CLOSED)
**Verification:** medium rung: self-test both directions + fail-closed; census excludes exactly the DR-9 glob list (assert a seeded `.d.ts`/`__shims__`/`.bench.ts` file is not counted)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 003: Coverage ratchet script (compare, provenance, fail-closed)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5, DR-10
**Files:**
- `scripts/check-coverage-ratchet.mjs` (new — zero-dep node; reads `coverage-summary.json` totals vs `servers/exarchos-mcp/coverage-baseline.json`; per-metric epsilon from the baseline's recorded variance; `--observe` mode records without failing; rejects a baseline missing run-id or variance)
- `scripts/check-coverage-ratchet.test.sh` (new — synthetic regression beyond epsilon FAILS; identical summary PASSES; missing/unparseable summary FAILS CLOSED; baseline without provenance FAILS CLOSED)
**Verification:** medium rung: self-test all four directions; no live baseline is committed by this task (that is 009's CI-provenance job)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 004: Mutation-gate CI runner (diff computation + invocation + self-test)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-7, DR-10
**Files:**
- `scripts/run-mutation-gate.mjs` (new — computes the PR `base...head` diff scoped to `servers/exarchos-mcp/src/**`, invokes the `mutation-adequacy` action through the server entrypoint, maps degrade-without-verdict to failure per wave-1 DR-8)
- `scripts/run-mutation-gate.test.sh` (new — fabricated uncovered-line diff FAILS via the two-knob axis; empty server-diff exits success-with-skip-reason explicitly logged; missing tooling FAILS CLOSED)
**Verification:** medium rung: self-test both directions + fail-closed; the skip path (no server files in diff) is an enumerated, logged exit — never silent
**Dependencies:** 001
**Parallelizable:** Yes (after 001)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 005: Gate-host decision table (canonical guide)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `docs/guides/ci-gate-hosting.md` (new — the host taxonomy, the subset rule, the allowlist contract with `ci-topology.test.ts`, and the `pr-body-check.yml` out-of-scope note)
**Verification:** static: diff-scoped link check on the new file only (the whole-tree checker fails on ~190 pre-existing breaks and is not the bar)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 006: Aggregator hardening (skip-guards, dispositions, host-class pointers)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-4, DR-1
**Files:**
- `.github/workflows/ci.yml` (only file: `test-root`/`test-mcp` skip-guards in the `ci-gate` evaluate step mirroring the `:847`/`:864` pattern; corrected `e2e-process` comment stating non-blocking + why + follow-up issue; `binary-matrix` disposition comment; jobs-section header comment pointing at `docs/guides/ci-gate-hosting.md`)
**Expected tests:** none in this task — the structural assertions land in 008 against this task's output; CI on this task's own PR push is the live exercise
**Verification:** medium rung: the evaluate script parses (`bash -n` equivalent via a dry workflow-lint or actionlint if present); guards fail-closed with attributable `::error::` messages; the e2e-process follow-up issue is filed and its number cited in the comment and the PR body
**Dependencies:** 005 (pointer target must exist)
**Parallelizable:** No (`ci.yml` serialization)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 007: Gate-step wiring (coverage observe-mode, mutation, vocabulary-lint)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5, DR-7, DR-8
**Files:**
- `.github/workflows/ci.yml` (only file: `test-mcp` gains the coverage step — `npm run test:coverage`, then `check-coverage-ratchet.mjs --observe`, then upload `coverage-summary.json` as an artifact; `test-mcp` gains the mutation step — `run-mutation-gate.mjs`; `outcome-tests` gains the vocabulary-lint step ordered before the binary build, with the job header comment reflecting broadened duty; each step carries its DR-1 host-class comment)
**Verification:** medium rung: on this task's own PR push, `test-mcp` runs coverage + mutation green and `outcome-tests` runs the lint green; the `root`/`mcp` filters are byte-identical to main (DR-8 acceptance); coverage artifact appears on the run
**Dependencies:** 003, 004, 006 (`ci.yml` serialization; scripts must exist)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 008: CI-topology conformance test (completeness, evaluate coverage, skip-guards)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-2, DR-10
**Files:**
- `scripts/ci-topology.test.ts` (new — root-suite vitest; parses `.github/workflows/ci.yml`; asserts DR-2's three properties; carries the in-test non-blocking allowlist with rationale strings + issue refs for `e2e-process` and `binary-matrix`)
- `scripts/__fixtures__/ci-topology/` (new — synthetic workflow fixtures: unlisted job; filtered `needs:` job without skip-guard)
**Expected tests:** `Topology_UnlistedJobOutsideAllowlist_Fails`, `Topology_FilteredNeedsJobWithoutSkipGuard_Fails`, `Topology_CurrentWorkflow_Passes`, `Topology_NeedsJobWithoutEvaluateClause_Fails`
**Verification:** medium rung: scoped tests + adequacy probe; runs inside `npm run test:run` (host soundness: scan surface is exactly `ci.yml`, which is in the `root` filter)
**Dependencies:** 006, 007 (authored against the final evaluate block and step set)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 009: Coverage baseline capture from CI + measured epsilon + flip to blocking

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/coverage-baseline.json` (new — totals from ≥3 CI runs of this feature's `test-mcp` coverage artifacts, with originating run-ids and per-metric variance; epsilon derived from observed spread)
- `.github/workflows/ci.yml` (flip the ratchet step `--observe` → blocking)
**Verification:** medium rung: the baseline's run-ids resolve to real runs on this feature's branch (recorded in the PR body); the ratchet passes blocking on the next push; fail-closed paths re-asserted by 003's self-test (unchanged)
**Dependencies:** 007 (temporal: needs ≥3 CI runs of the wired coverage step; `ci.yml` serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 010: mutation-adequacy skill framing update (blocking CI context)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-6
**Files:**
- `skills-src/mutation-adequacy/SKILL.md` (the "advisory by default — never blocks" framing gains the CI-context nuance: the diff-scoped CI wiring blocks on the NoCoverage axis)
- `skills/<runtime>/mutation-adequacy/**` (regenerated via `npm run build:skills`)
- snapshot baselines (`vitest -u` for the render snapshots, per the dual-baseline discipline)
**Verification:** low rung: `npm run skills:guard` green; snapshot diff reviewed as intentional
**Dependencies:** 001
**Parallelizable:** Yes (after 001)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 011: Cross-gate DR-10 conformance sweep + measurement record

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-10
**Files:**
- `docs/specs/2026-07-17-wave-s-enforcement-substrate-baseline.md` (new — the evidence record: every new gate's self-test results in both directions, the fail-closed matrix, filter byte-identity proof, allowlist state at merge, coverage baseline provenance)
**Verification:** medium rung: run every self-test added by 002/003/004/008 and record results; assert zero jobs outside `needs:` ∪ allowlist on the final tree; assert `root`/`mcp` filters byte-identical to main; every baseline artifact carries its provenance fields
**Dependencies:** 002, 008, 009, 010
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Parallelization

- **Wave A (parallel):** 001, 002, 003, 005
- **Wave B (parallel, after wave A members they depend on):** 004 (after 001), 010 (after 001)
- **`ci.yml` chain (serial, one editor at a time):** 006 → 007 → 009 — every `ci.yml`-touching task is on this chain and no other task touches the file
- **Post-chain:** 008 (after 007), then 011 (after 002, 008, 009, 010)
- **Critical path:** 005 → 006 → 007 → 009 → 011 (the 009 link includes the temporal ≥3-CI-runs wait, which overlaps 008's authoring rather than serializing after it)
