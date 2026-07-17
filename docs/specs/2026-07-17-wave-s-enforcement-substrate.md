# Spec: Wave S — Enforcement-Substrate Semantics + Coverage/Mutation CI Wiring

**Issues:** #1711 (Wave S design), #1704 (Wave 3a) · **Parent epic:** #1701
**designDepth:** standard — the uncertainty was already burned down by six rounds of dispatched adversarial plan-review on PR #1700 (which produced #1711's verified problem statement); what remains is convergent decision-making against the tree, not open exploration.
**Revision 1 (2026-07-17):** first dispatched plan-review round (2 voters, both refuted) surfaced four HIGH gaps — no mutation runner in the tree, type-debt gate unwired, `coverage-summary.json` never produced by the current reporter set, and missing enforcer-wiring-manifest ownership — plus the grep-gates taxonomy falsehood and the scripts/** implementation-surface hole. All are incorporated below; every factual claim re-verified against main.

## Constraints

Anchored to `.exarchos/invariants.md`:

- **INV-5b (output-contract):** Tool outputs are structured `ToolResult` carriers; a gate's carrier shape is a published contract — additive evolution only.
- **INV-2 (facade-equivalence):** The `mutation-adequacy` orchestrate action is reachable from both the CLI and MCP facades; a semantics change must land identically on both paths (it lives in the shared handler, not an adapter).
- **INV-1 (event-sourcing integrity):** The workflow-state projection is a pure left-fold; DR-6's enforcement-path change extends the folded shape additively and must fold identical legacy logs identically.
- **INV-6 (workload-agnosticism):** Gates added here are repo-level CI mechanisms; nothing may key on a specific workflow type.
- **INV-16 (os-portability, pulled on demand):** New check scripts follow the wave-1 DR-8 convention — fail-closed, attributable, and portable within their declared host.

Spec-level constraint carried from wave 1 (spec `2026-07-15-debloat-wave1-structural-enforcement.md`, DR-8): every gate fails closed on missing tools or unparseable output, ships a self-test exercising both directions (synthetic violation FAILS, conforming tree PASSES), and its baseline artifacts are attributable to a source. Additionally (wave-1 DR-5 substrate, verified live): `scripts/check-enforcer-wiring.mjs` runs unfiltered on every PR and requires every `scripts/check-*`/`lint-*` primary to carry an entry in `scripts/enforcer-wiring-manifest.json` and to be reachable-and-failable from a named workflow — every script this spec adds must land with its manifest entry and its wiring.

## Design & Rationale

### Problem Statement

An enforcement gate only governs if two properties hold: it **runs** on the PRs it polices, and it **can fail** them. On current main both properties are accidental, not designed:

1. **Path filters silently disarm gates.** `test-root` (`ci.yml:64`) and `test-mcp` (`:133`) run only when `changes.outputs.root`/`.mcp` match (filters at `:41-62`; `root` excludes `servers/**`, `scripts/**`, `commands/**`, `docs/**`). `ci-gate` (`:806`) fails only on `failure|cancelled` and prints "All checks passed (skipped jobs are OK)" (`:882`). A gate stepped into a filtered job is skipped-as-passed on every PR outside its host's filter. Nastier: both filters include `.github/workflows/ci.yml`, so the PR that *lands* a gate always runs it — the self-test passes, then the gate silently stops governing. The hole extends to **implementation surfaces**: the root unit suite executes `scripts/**/*.test.ts`, yet `scripts/**` is outside the `root` filter — a scripts-only PR can weaken a gate or its tests while `test-root` skips-as-passes.
2. **The aggregator is hand-maintained and already drifted.** `ci-gate.needs` (`:809`) is a hand-edited list; `e2e-process` (`:704`) carries a "Blocking gate as of T3.7" comment while being absent from `needs:` — it cannot fail a PR. `binary-matrix` is likewise silently non-blocking. Nothing detects the next drift.
3. **Three enforcement semantics were never pinned**, and six adversarial reviewers refuted three attempts to pin them in spec prose (#1711): where a gate whose scan surface exceeds its host's filter should live; whether diff-scoped NoCoverage mutants block (`mutation-adequacy.ts` scores 5-killed + 5-NoCoverage as 1.0 and passes — and even a `passed:false` carrier reaches no enforcement: the workflow-state projection folds the gate event into `reviews['mutation-adequacy']` with `status:'pass'` unconditionally, and `guards.ts` block-mode enforcement compares only `mutationScore` against the threshold); and what identity function makes an `as unknown as` type-debt register enforceable.
4. **Coverage is never measured in CI** (`test:coverage` exists in `servers/exarchos-mcp/package.json`; no workflow invokes it — and the vitest coverage reporter set `['text','json','html']` never emits `coverage-summary.json` totals at all), so wave 3b's "coverage-preserving consolidation" (#1705) is unverifiable. Likewise **no mutation runner is installed anywhere in the tree** (no stryker dependency, no config, no `mutation:` toolchain entry) — the in-tree `mutation-adequacy` gate resolves no runner and returns a skip-**pass**, so the R5 review dimension has been structurally unable to fail on this repo. Both are the "exists, not wired" class the wave-1 enforcer-wiring gate closed for check-scripts.

### Chosen Approach

Make gate hosting a **decided convention backed by a machine-checked topology contract**, then wire the wave-3a gates onto sound hosts under that convention — installing the missing substrate (mutation runner, coverage summary reporter) rather than wiring theater over its absence.

**The host taxonomy already exists in the tree — name it accurately and enforce it.** Four host classes cover every gate (the tree's own NOTE at `ci.yml:605-608` warns that a "grep-gates are zero-dependency" framing is false for the job as a whole — the taxonomy names the two regions separately):

| Host class | Existing host | Filter | Deps | For gates whose… |
|---|---|---|---|---|
| Zero-dep prefix, unfiltered | `grep-gates` (early steps) | none | none | check is a self-contained script (grep/node, no install) |
| Deps tail, unfiltered | `grep-gates` (tsx tail — installs BOTH dep trees at `ci.yml:620-625`) | none | root + MCP `npm ci` | check needs tsx over repo source AND scans surfaces broader than any filter |
| Deps, unfiltered, suite-shaped | `outcome-tests` | none | root + MCP `npm ci` + binary build | outcome-tier suites (not lint-shaped gates — job identity stays single-purpose) |
| Deps, filtered | `test-root` / `test-mcp` | `root` / `mcp` | per-job | scan surface **and** implementation surface are subsets of the host's filter |

The rule: **a gate may live in a filtered job only when both its scan surface and its implementation surface are subsets of that job's filter.** Everything else goes to an unfiltered host. This resolves every stalled instance without new jobs: the coverage ratchet and diff-scoped mutation gate scan `servers/**` — the `mcp` filter — so `test-mcp` is *correct*, not a compromise (their `scripts/` implementations are covered by unfiltered `.test.sh` re-asserts in grep-gates, the established task-015 pattern); `vocabulary-lint` scans `skills-src/`, `commands/`, `docs/architecture/`, `docs/guides/` (broader than any filter) and needs both dep trees (`tsx` entrypoint), so it joins the **grep-gates tsx tail**, which already installs exactly those deps for the fingerprint/prose/cycle gates. The implementation-surface half of the rule also closes a live hole: `scripts/**` joins the `root` filter, because the root unit suite executes `scripts/**/*.test.ts` today and the current filter violates the subset rule for `test-root` itself.

**Drift becomes a test failure, not a review hope.** A root-suite conformance test parses `ci.yml` and asserts the aggregator's completeness (every job blocking or explicitly declared non-blocking with rationale) and the skip-guard coverage of filtered `needs:` jobs — by structural containment over the evaluate step's template text, fixture-tested in both directions. With `scripts/**` in the `root` filter, neither the topology nor the detector can change without the detector running.

**The two semantic questions get the smallest mechanism that actually blocks.** NoCoverage becomes a second, orthogonal pass-axis on the mutation gate (deterministic, therefore the *safest* blocking axis) — carried through to the **workflow enforcement path** (projection fold + block-mode guard), not just the carrier. Type-debt gets a per-file count-budget ratchet — the same checked-in-baseline idiom wave 1 established for cycles and exports — hosted in grep-gates' zero-dep prefix and wired there in this spec (not deferred).

## Requirements

### DR-1: Gate-host decision table is the documented convention

The four-class host taxonomy and the two-surface subset rule land as normative documentation: a comment block at the top of `ci.yml`'s job section and a short guide section in one canonical prose location (no duplication). Every gate added by this spec cites its host-class row at its wiring site.

**Acceptance criteria:**
- The decision table (host class × filter × deps × subset rule, four rows as above) exists in exactly one canonical prose location, referenced (not restated) from `ci.yml`.
- The table documents grep-gates' dual identity (zero-dep prefix + deps tail) consistently with the existing NOTE at `ci.yml:605-608` — no "zero-dependency job" claim anywhere.
- Each gate wired by DR-5..DR-9 carries a one-line comment naming its host-class row and why the two-surface subset rule holds (or doesn't apply) for it.
- The stale `e2e-process` "Blocking gate as of T3.7" comment is corrected to state the job's actual disposition (see DR-4).
- `pr-body-check.yml` is documented as outside `ci-gate`'s contract (separate workflow; branch-protection concern).

### DR-2: CI-topology conformance test — the aggregator cannot drift silently

A root-suite test (`scripts/ci-topology.test.ts`) parses `.github/workflows/ci.yml` and asserts, via structural containment over the workflow YAML and the evaluate step's template text (fixture-tested, not bash-parsed — the mechanism is containment, and the acceptance bar is the fixture suite):

1. **Completeness:** every top-level job key is either in `ci-gate.needs` or in an explicit in-test allowlist of declared-non-blocking jobs, each entry carrying a rationale string and (where applicable) a tracking-issue reference.
2. **Evaluate coverage:** for every job in `ci-gate.needs` (except `ci-gate` itself), the evaluate step's script contains a `needs.<job>.result` clause matched against `failure|cancelled`.
3. **Skip-guard coverage:** for every path-filtered job in `ci-gate.needs`, the evaluate script contains a fail-closed skip-guard keyed on the corresponding `changes.outputs.<key>` — where the job→key mapping is derived from each job's `if:` expression (the test parses `needs.changes.outputs.<key>` out of the `if:` text).

**Acceptance criteria:**
- Self-test all three directions with fixtures under `scripts/__fixtures__/ci-topology/`: (a) a job absent from `needs` and allowlist FAILS; (b) a filtered `needs` job with no skip-guard FAILS; (c) a `needs` job with no evaluate clause FAILS; the post-DR-3/DR-4 real `ci.yml` PASSES.
- The test runs in the root suite (`npm run test:run`); host soundness holds under the two-surface rule because DR-3 adds `scripts/**` to the `root` filter — both the governed artifact (`ci.yml`) and the detector's own implementation (`scripts/ci-topology.test.ts` + fixtures) are inside the filter.
- The allowlist is in the test file itself (reviewable in the same diff that adds a job), not a separate config that can rot.

### DR-3: Close the skipped-as-passed and implementation-surface holes

Two `ci-gate` evaluate guards mirroring the existing Windows pattern (`:847-851`, `:864-868`): fail when `changes.outputs.root == 'true'` but `test-root` was skipped, and when `changes.outputs.mcp == 'true'` but `test-mcp` was skipped. Plus one deliberate filter change: **`scripts/**` joins the `root` filter** — the root unit suite already executes `scripts/**/*.test.ts`, so the current filter violates the subset rule for `test-root` itself, and every gate whose implementation lives in `scripts/` is otherwise disarm-able by a scripts-only PR.

**Acceptance criteria:**
- Both guard clauses present in the evaluate script, fail-closed (exit 1 with an attributable `::error::` message naming the dropped lane).
- The `root` filter gains exactly `scripts/**`; the `mcp` filter is byte-identical to main; no other filter entry changes.
- DR-2's conformance test asserts the guards' presence structurally.

### DR-4: The two silently-non-blocking jobs get measured dispositions

The dispositions are **measured, not guessed** (the same standard DR-5 imposes on epsilon): the implementing task queries the last ≥50 completed CI runs and computes each job's failure rate *among runs where it executed*.

- **`e2e-process`:** decision rule — if the measured failure-rate-when-executed is ≤2%, it enters `ci-gate.needs` with an evaluate clause (blocking; the stale "Blocking gate as of T3.7" comment becomes true again). If higher, it is declared non-blocking in DR-2's allowlist with the measured rate in the rationale, the comment is corrected, and a follow-up issue is filed to burn down the flake class (`SQLITE_BUSY` per the known cluster) and flip it — the allowlist entry cites the issue and the measurement.
- **`binary-matrix`:** declared non-blocking with rationale: release-lane compile evidence, not a per-PR gate (the standing reason the `--minify` A/B was dropped, #1703).

**Acceptance criteria:**
- The measurement (run count, executed count, failure rate per job) is recorded in the PR body and in the allowlist rationale (or the `needs:` addition's comment).
- Whichever branch the rule selects, zero jobs remain outside both `needs:` and the allowlist (DR-2 completeness passes).
- If e2e-process stays non-blocking: the follow-up issue exists and is cited in the corrected comment.

### DR-5: Coverage baseline + non-regression ratchet in `test-mcp`

`test-mcp` gains a coverage step: run `npm run test:coverage` (server tree), then a ratchet script compares `coverage-summary.json` totals against a checked-in baseline (`servers/exarchos-mcp/coverage-baseline.json`) with a **measured, floored** epsilon.

- **The summary must first exist:** `servers/exarchos-mcp/vitest.config.ts`'s coverage reporter set is `['text','json','html']` today — `json-summary` is added so `coverage-summary.json` (totals) is actually produced. Without this the entire DR is theater; the ratchet fails closed on a missing summary from day one.
- **Baseline provenance:** captured from CI runs, never locally (the ~26 known-red local suite would bake local skips into the ratchet). The baseline file records the originating GitHub run-ids and the ratchet validates their presence and format.
- **Epsilon is measured, then floored:** the landing PR collects ≥3 CI coverage runs, records per-metric spread in the baseline file, and sets `epsilon_m = max(observed spread_m, 0.1 percentage points)`. The floor resolves the degenerate zero-variance case (V8 totals on an identical tree are typically deterministic) — a zero epsilon is never used even when measured.
- **Host soundness (two-surface rule):** scan surface `servers/exarchos-mcp/**` ⊆ `mcp` filter; the `scripts/` implementation is re-asserted by an unfiltered `.test.sh` step in grep-gates (task-015 pattern) and covered by the `root`-filter `scripts/**` addition (DR-3).

**Acceptance criteria:**
- Ratchet FAILS on a synthetic regression exceeding epsilon; PASSES on an identical re-run; FAILS CLOSED on missing/unparseable `coverage-summary.json`; FAILS CLOSED on a baseline missing run-ids or variance (self-test covers all four).
- `vitest.config.ts` emits `json-summary`; the CI step uploads `coverage-summary.json` as a run artifact.
- Baseline file carries run-ids + measured spread + the derived floored epsilon per metric.
- Blocking via `test-mcp`'s existing `ci-gate` membership; step comment cites its DR-1 host-class row.

### DR-6: Mutation NoCoverage becomes a blocking axis — carrier AND enforcement path

`orchestrate/mutation-adequacy.ts`: the carrier's `mutationScore` definition is **unchanged** (`killed / (total − noCoverage)` — INV-5b: consumers keep their semantics). The change lands at every layer that decides pass/fail:

1. **Handler:** the `passed` computation (`:712`) gains a second, orthogonal knob: for diff-scoped runs, `passed = mutationScore >= threshold && noCoverage <= maxNoCoverage`, with `maxNoCoverage` defaulting to **0**. The carrier additively gains the fields the axis needs (`noCoverage` already exists; the failure message attributes NoCoverage to file/line).
2. **Projection fold:** `views/workflow-state-projection.ts` folds the mutation `gate.executed` into `reviews['mutation-adequacy']` with `status:'pass'` **unconditionally** today (only `passed` is carried as a field); the fold additively carries `noCoverage` so the enforcement guard can see the axis. Legacy events without the field fold exactly as before (INV-1).
3. **Block-mode guard:** `workflow/guards.ts` Check 4 compares only `mutationScore` against the threshold today — a 5-killed + 5-NoCoverage diff passes block-mode enforcement at score 1.0. Under `review.mutationEnforcement: block`, the guard additionally blocks when the folded `noCoverage` exceeds the configured `maxNoCoverage` (default 0), with an attributable reason string.

Rationale: for a *diff*-scoped gate the changed line is the subject — an uncovered changed line is exactly the "test executes nothing" defect the gate exists for; and NoCoverage is deterministic (runner-budget-insensitive), making it the safest axis to block on, while the survivor threshold remains the flake-budget-sensitive one.

**Acceptance criteria:**
- A diff scoring 5 killed + 5 NoCoverage now FAILS at the handler AND blocks at the enforcement guard under block-mode; an all-covered diff at the same score PASSES unchanged on both paths.
- Carrier evolution is additive only; both facades see the identical change (shared handler — INV-2); a fixture log of legacy mutation events folds byte-identical through the extended projection (INV-1).
- Severity plumbing documented honestly: `applyLadderGateSeverity` downgrades the returned verdict only — the recorded `gate.executed` event is emitted before severity application and is not rewritten; config relaxation affects the carrier consumers, not history.

### DR-7: Diff-scoped mutation-adequacy wired into CI — with its runner actually installed

Two halves, both mandatory (wiring without the runner is the skip-pass theater the Problem Statement condemns):

- **Runner substrate:** `@stryker-mutator/core` + the vitest runner land as **pinned devDependencies** of `servers/exarchos-mcp`, with a checked-in stryker config and a `mutation:` toolchain entry in `.exarchos.yml` resolving to `npx --no-install stryker run ...` (no unpinned network fetch — the resolver's built-in `npx stryker run` fallback must never fire in CI). A smoke self-test proves the runner produces a parseable report on a tiny fixture scope, within a documented runtime budget.
- **CI wiring:** `test-mcp` gains a step invoking the in-tree diff-scoped gate via `scripts/run-mutation-gate.mjs` against the PR's `base...head` diff (paved path — full-tree stryker remains out of scope). The step: runs **only on `pull_request` events** (push-to-main is skipped with an explicit logged reason — the tree was validated at PR time and a squash-merge lands the same tree); **fetches the PR base ref explicitly** before diffing (`test-mcp`'s checkout is shallow); distinguishes **git-failure → fail-closed** from **genuinely-empty server diff → logged skip** (the handler's diff seam degrades to `[]` on any git failure today — the runner script must not let that read as "no changes").

**Acceptance criteria:**
- No unpinned `npx` fetch anywhere on the path; deleting the stryker devDependency makes the smoke self-test FAIL (tool-missing fail-closed direction).
- A fabricated uncovered-line diff FAILS via the DR-6 axis (exercised in the gate's self-test).
- Degrade-without-verdict (runner crash, unparseable report) is failure, per wave-1 DR-8.
- The step's skip conditions are exactly two — non-PR event, empty server diff — each with a logged reason; git failure is neither.
- Runtime budget documented and enforced by the stryker config (diff-scoped mutant count bound).
- Host-class comment cites DR-1 (scan surface `servers/**` ⊆ `mcp` filter; implementation re-asserted unfiltered per DR-10).

### DR-8: vocabulary-lint wired into the grep-gates tsx tail

`npm run lint:invariants` (tsx entrypoint, needs root + server deps) lands as a step in **grep-gates' deps-installed tsx tail** — unfiltered, already in `ci-gate.needs`, and already installing both dep trees for the fingerprint/prose/cycle gates (`ci.yml:620-625`), so the marginal cost is one tsx invocation. `outcome-tests` keeps its single suite-shaped identity untouched. Scope is the current live surfaces only (`skills-src/`, `commands/`, `docs/architecture/`, `docs/guides/`); the `registry.ts` action-description scope extension stays deferred (#1706).

**Acceptance criteria:**
- Step present in the tsx tail (after the dep installs, alongside the existing tsx-backed gates); a seeded vocabulary violation fails the script (self-test at the script level).
- Step comment cites its DR-1 host-class row (deps tail, unfiltered).
- `outcome-tests` is byte-identical to main; the `mcp` filter is byte-identical to main; the `root` filter changes only by DR-3's `scripts/**` addition.

### DR-9: Type-debt register — per-file count budget, hosted AND wired in grep-gates

The `as unknown as` register uses **per-file count budgets** as its identity function: `scripts/check-type-debt.mjs` (zero-dep node) + a checked-in `scripts/type-debt-baseline.json`, **wired as a grep-gates zero-dep-prefix step by this spec** (not deferred — an unwired register is the "exists, not wired" class this spec exists to close).

- **Census definition (pinned):** files under `src/**` and `servers/exarchos-mcp/src/**`, excluding `**/*.test.ts`, `**/*.bench.ts`, `**/*.d.ts`, `**/__tests__/**`, `**/__shims__/**`, `**/__mocks__/**`, `**/__shared__/**`, `**/evals/**` (eval-harness fixture code is not production debt), and `src/runtimes/embedded.ts` (generated output locked by `runtimes:guard` — its casts are codegen's, not hand debt). The script's exclusion list is the census definition — the baseline is regenerable from it.
- **Ratchet semantics (mirrors the wave-1 ratchet idiom):** a file exceeding its budget FAILS; a file absent from the baseline with count > 0 FAILS; a stale-high budget (baseline above actual) follows whichever behavior the existing wave-1 ratchets (`cycle-gate`, knip-diff) use — the plan pins it to that precedent for consistency.
- **Provenance (DR-10):** the baseline records the generating script's census-definition hash (a stable digest of the exclusion-glob list) and the `--update` flag path; the script REJECTS a baseline whose census hash does not match its own (a baseline generated under a different census cannot silently govern).
- **Rejected identities, recorded:** `{symbol, file}` cannot distinguish multiple casts in one file (subset-register passes; completeness unenforceable); `{file, line, col}` churns on unrelated edits — the 532-fix tsconfig wave that already landed in PR #1714 would have invalidated such a register wholesale, which is the concrete demonstration; content-hash collides on identical casts and churns on renames; inline suppressions put an annotation wave ahead of any enforcement.

**Acceptance criteria:**
- Self-test both directions plus fail-closed: seeded over-budget fixture FAILS; current tree + fresh baseline PASSES; missing baseline FAILS CLOSED; census-hash mismatch FAILS CLOSED.
- Baseline regeneration is a script flag (`--update`), so future fix waves ratchet it down mechanically.
- Wired as a grep-gates zero-dep-prefix step with its manifest entry (DR-10); blocks every PR from merge day.

### DR-10: Fail-closed, self-tested, attributable, and REACHABLE — error handling across every new mechanism

Every script/gate added by DR-2..DR-9 follows the wave-1 DR-8 convention, extended with the wiring obligations the first review round proved missing:

**Acceptance criteria:**
- Fail-closed on missing tools, missing inputs, and unparseable outputs — never skip-as-pass. Each failure message names the artifact and the reason.
- Each ships a self-test exercising: the synthetic-violation direction, the conforming direction, and at least one fail-closed direction.
- **Every new `scripts/check-*` script lands with its `scripts/enforcer-wiring-manifest.json` entry in the same task that adds the script** — the existing enforcer-wiring gate red-flags an orphan or unlisted check script on every PR, so a script and its manifest entry are atomic.
- **Every new check script's `.test.sh` self-test is stepped into grep-gates** (unfiltered, task-015 pattern) — self-tests run on every PR, not once as landing evidence.
- Baseline artifacts are attributable: coverage carries run-ids + variance; type-debt carries the census-definition hash; both are rejected by their consumers when provenance is missing.
- No new gate lives in a filtered host whose filter does not contain both its scan surface and its implementation surface (DR-1 rule; DR-2 enforces the aggregator side; DR-3 closes the `scripts/**` half).

## Technical Design

**Files touched (by area):**

- `.github/workflows/ci.yml` — skip-guards in `ci-gate` evaluate + `scripts/**` root-filter addition (DR-3); DR-4 disposition (either a `needs:` addition + evaluate clause, or allowlist rationale) + corrected comments; coverage + mutation steps in `test-mcp` (DR-5, DR-7); vocabulary-lint step in the grep-gates tsx tail (DR-8); type-debt step in the grep-gates zero-dep prefix (DR-9); `.test.sh` re-assert steps for the new check scripts (DR-10); host-class comments (DR-1). All `ci.yml` edits land serially (wave-1 discipline).
- `scripts/` — `ci-topology.test.ts` + `__fixtures__/ci-topology/` (DR-2); `check-type-debt.mjs` + `type-debt-baseline.json` + `check-type-debt.test.sh` (DR-9); `check-coverage-ratchet.mjs` + self-test (DR-5); `run-mutation-gate.mjs` + self-test (DR-7); **`enforcer-wiring-manifest.json` entries for every new check script** (DR-10).
- `servers/exarchos-mcp/` — `src/orchestrate/mutation-adequacy.ts` (+tests) — two-knob `passed` (DR-6); `src/views/workflow-state-projection.ts` + `src/workflow/guards.ts` (+tests) — enforcement-path reach (DR-6); `vitest.config.ts` — `json-summary` reporter (DR-5); `package.json` + `package-lock.json` — pinned stryker devDeps (DR-7); stryker config file (DR-7); `coverage-baseline.json` (DR-5).
- `.exarchos.yml` — `mutation:` toolchain entry (DR-7).
- Docs: one canonical decision-table location (DR-1).

**What this does NOT touch:** the `mcp` filter and `outcome-tests` (byte-identical); the `root` filter except the deliberate `scripts/**` addition; `mutationScore` semantics; any wave-2 surface (all of #1703's tasks are verified already landed on main via PR #1714 — no overlap exists); branch-protection settings (`pr-body-check.yml` is out of `ci-gate`'s contract, documented in DR-1).

## Integration Points

- **ci-gate aggregator** — DR-3 guards and DR-2's structural assertions must agree; DR-2 is authored against the post-DR-3/DR-4 evaluate block.
- **`mutation-adequacy` action** — shared handler behind both facades (INV-2); consumed by the R5 review dimension and now CI (DR-7). The fold/guard changes (DR-6) touch the same projection the review→synthesize dead-lock guard reads — the no-toolchain skip-pass path must keep folding as skip-pass (a repo with no runner still transitions; this repo now HAS a runner, so the path becomes vestigial here but stays correct for consumer repos).
- **enforcer-wiring gate** — every new check script registers in its manifest; the gate's reachable-and-failable check is the standing proof the wiring stays live.
- **Wave 3b (#1705)** — DR-5's baseline is its gate; the floored epsilon is the enabling constant.
- **#1706 (deferred remainder)** — the `registry.ts` vocabulary-lint scope extension and the error-envelope lint land there, on the DR-1 convention; the type-debt register (this spec) is the substrate its future fix waves ratchet down.

## Alternatives considered

- **Widen the `root` filter to cover vocabulary-lint's surfaces** — rejected: every docs/commands PR would run the full root job to get a seconds-long lint; the grep-gates tsx tail already pays the dep-install cost unfiltered.
- **Host vocabulary-lint in `outcome-tests`** — rejected (revision 1): it would be the second identity grafted onto a suite-shaped job, and the grep-gates tsx tail already installs both dep trees for exactly this gate shape; outcome-tests stays single-purpose.
- **A new dedicated unfiltered `lint-gates` job** — rejected: duplicates two `npm ci` that grep-gates' tail already performs.
- **Auto-generate `ci-gate.needs` / the evaluate block** — rejected: CI generating CI adds a meta-build step and its own drift surface; the conformance test achieves cannot-drift with a fraction of the machinery.
- **Redefine `mutationScore` to include NoCoverage in the denominator** — rejected: mutates a published carrier's semantics under consumers (INV-5b); the two-knob form keeps both signals attributable.
- **Wire the mutation gate without installing a runner** — rejected (revision 1): the resolver skip-passes with no runner, so the wiring would be green theater — the exact #1704 defect; conversely mapping degrade→failure with no runner reds every server PR. The runner is a prerequisite, not an option.
- **Guess the e2e-process disposition** — rejected (revision 1): the first round correctly refuted an unmeasured flake-rate assertion; DR-4 now measures and applies a decision rule.
- **Type-debt identity via `{file,line,col}` / content-hash / inline suppressions** — rejected per DR-9's recorded rationale.

## Open Questions

None blocking. The two empirical constants (coverage epsilon per metric, e2e-process failure rate) are measured by their owning tasks with decided fallback rules (floor 0.1pp; the ≤2% blocking rule), so no open decision remains in either.

## Decomposition

### Scope

**Target:** DR-1 … DR-10 — the full spec: #1711 (all three semantic decisions land as mechanisms) and #1704 (coverage + mutation wired into CI on sound hosts, with their substrate installed).
**Excluded, each with a named owner:**
- **#1705 (wave 3b)** — consumes DR-5's baseline; its own campaign workflow.
- **#1706 (enforcement phase 2 remainder)** — the `registry.ts` vocabulary-lint scope extension and the error-envelope lint (the tsconfig ratchet and executable-invariants halves are verified already landed via PR #1714).
- **Flipping `e2e-process` to blocking when the measured rate exceeds the DR-4 rule** — the follow-up issue owns the flake burn-down.
- **Full-tree mutation (stryker `scope:'full'`)** — DR-7 wires the diff-scoped paved path only.

### Traceability matrix (DR-N → tasks)

| DR | Requirement | Tasks |
|----|-------------|-------|
| DR-1 | Gate-host decision table documented | 005, 006, 007 |
| DR-2 | CI-topology conformance test | 008 |
| DR-3 | Skip-guards + scripts/** root-filter addition | 006 |
| DR-4 | Measured dispositions for non-blocking jobs | 006, 008 |
| DR-5 | Coverage summary + baseline + ratchet in test-mcp | 003, 007, 009 |
| DR-6 | Mutation NoCoverage axis — carrier + enforcement path | 001, 010 |
| DR-7 | Mutation runner substrate + diff-scoped CI wiring | 004, 007, 012 |
| DR-8 | vocabulary-lint in the grep-gates tsx tail | 007 |
| DR-9 | Type-debt count-budget register, wired | 002, 007 |
| DR-10 | Fail-closed, self-tested, attributable, reachable | 002, 003, 004, 008, 011 |

### Tasks

### Task 001: Mutation NoCoverage axis — handler, projection fold, block-mode guard

**Risk Tier:** high
**Boundary Touching:** true
**Implements:** DR-6
**Files:**
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.ts` (the `passed` computation ~:712 gains the `maxNoCoverage` knob, default 0 for diff scope; failure message attributes NoCoverage to file/line; carrier evolution additive only)
- `servers/exarchos-mcp/src/orchestrate/mutation-adequacy.test.ts` (extend)
- `servers/exarchos-mcp/src/views/workflow-state-projection.ts` (~:530 — the `reviews['mutation-adequacy']` fold additively carries `noCoverage`)
- `servers/exarchos-mcp/src/workflow/guards.ts` (~:382-398 — Check 4 block-mode enforcement additionally blocks on `noCoverage > maxNoCoverage` with an attributable reason)
- tests for both (projection fold fixture including legacy events without the field; guard block/pass both directions)
**Expected tests:** `Passed_DiffScopeKilledPlusNoCoverageMix_Fails`, `Passed_AllCoveredAtThreshold_PassesUnchanged`, `Passed_NoCoverageWithinExplicitBudget_Passes`, `FailureMessage_NoCoverageMutants_AttributesFileAndLine`, `Fold_LegacyMutationEventWithoutNoCoverage_FoldsIdentically`, `GuardCheckFour_NoCoverageExceedsBudget_BlocksUnderEnforcement`, `GuardCheckFour_AllCovered_PassesUnchanged`
**Verification:** high rung: scoped tests + adequacy probe + the projection/guard integration suites; carrier fields and `mutationScore` semantics byte-identical for existing consumers (INV-5b); legacy fixture log folds byte-identical (INV-1); both facades see the change via the shared handler (INV-2 — no adapter edit anywhere in the diff); the no-toolchain skip-pass path still folds as skip-pass (review→synthesize dead-lock guard unchanged for runner-less repos)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 002: Type-debt count-budget register (script + baseline + manifest + self-test)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-9, DR-10
**Files:**
- `scripts/check-type-debt.mjs` (new — zero-dep node; census globs per DR-9 including the `**/evals/**` and `src/runtimes/embedded.ts` exclusions; `--update` regenerates the baseline; baseline carries the census-definition hash and the script rejects a mismatched or provenance-less baseline; stale-high-budget behavior pinned to the wave-1 ratchet precedent, named in-code)
- `scripts/type-debt-baseline.json` (new — generated by `--update` on the current tree)
- `scripts/check-type-debt.test.sh` (new — seeded over-budget FAILS; current tree + fresh baseline PASSES; missing baseline FAILS CLOSED; census-hash mismatch FAILS CLOSED; seeded `.d.ts`/`__shims__`/`.bench.ts`/`evals` files are not counted)
- `scripts/enforcer-wiring-manifest.json` (entry for the new check script — atomic with the script per DR-10)
**Verification:** medium rung: self-test all directions; the enforcer-wiring gate's own run passes with the new entry (no orphan)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 003: Coverage summary reporter + ratchet script (compare, provenance, fail-closed)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-5, DR-10
**Files:**
- `servers/exarchos-mcp/vitest.config.ts` (coverage reporter set gains `json-summary` — without it no `coverage-summary.json` exists to ratchet)
- `scripts/check-coverage-ratchet.mjs` (new — zero-dep node; reads `coverage-summary.json` totals vs `servers/exarchos-mcp/coverage-baseline.json`; per-metric floored epsilon from the baseline (`max(spread, 0.1pp)`); `--observe` mode records without failing; rejects a baseline missing run-ids or variance)
- `scripts/check-coverage-ratchet.test.sh` (new — synthetic regression beyond epsilon FAILS; identical summary PASSES; missing/unparseable summary FAILS CLOSED; provenance-less baseline FAILS CLOSED)
- `scripts/enforcer-wiring-manifest.json` (entry — atomic with the script)
**Verification:** medium rung: self-test all four directions; a local `npm run test:coverage` smoke run produces `coverage-summary.json` with totals (reporter proof); no live baseline is committed by this task (that is 009's CI-provenance job)
**Dependencies:** 002 (manifest serialization — both edit `scripts/enforcer-wiring-manifest.json`)
**Parallelizable:** No (manifest chain)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 004: Mutation-gate CI runner script (diff computation + invocation + self-test)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-7, DR-10
**Files:**
- `scripts/run-mutation-gate.mjs` (new — fetches the PR base ref explicitly (shallow checkout), computes the `base...head` diff scoped to `servers/exarchos-mcp/src/**`, invokes the `mutation-adequacy` action through the server entrypoint; exactly two logged skip conditions — non-PR event, empty server diff; git failure is fail-closed, never an empty diff; degrade-without-verdict maps to failure per wave-1 DR-8)
- `scripts/run-mutation-gate.test.sh` (new — fabricated uncovered-line diff FAILS via the DR-6 axis; empty server-diff exits success-with-logged-skip; git-failure path FAILS; missing tooling FAILS CLOSED)
- `scripts/enforcer-wiring-manifest.json` (entry — atomic with the script)
**Verification:** medium rung: self-test both directions + both fail-closed paths; the skip/failure taxonomy in the script matches DR-7's enumeration exactly
**Dependencies:** 001, 012, 003 (manifest serialization — 002 → 003 → 004 all edit `scripts/enforcer-wiring-manifest.json`)
**Parallelizable:** No (manifest chain)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 005: Gate-host decision table (canonical guide)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-1
**Files:**
- `docs/guides/ci-gate-hosting.md` (new — the four-row host taxonomy including grep-gates' dual identity, the two-surface subset rule, the allowlist contract with `ci-topology.test.ts`, and the `pr-body-check.yml` out-of-scope note)
**Verification:** static: diff-scoped link check on the new file only; the taxonomy text agrees with the `ci.yml:605-608` NOTE (no zero-dependency-job claim)
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 006: Close the skipped-as-passed hole and the implementation-surface hole (skip-guards, scripts/** filter addition, measured dispositions)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-3, DR-4, DR-1
**Files:**
- `.github/workflows/ci.yml` (only file: `test-root`/`test-mcp` skip-guards in the `ci-gate` evaluate step mirroring the `:847`/`:864` pattern; `scripts/**` added to the `root` filter; e2e-process disposition per the DR-4 measurement — either `needs:` + evaluate clause, or corrected comment citing the measured rate + follow-up issue; `binary-matrix` disposition comment; jobs-section header comment pointing at `docs/guides/ci-gate-hosting.md`)
**Expected tests:** none in this task — the structural assertions land in 008 against this task's output
**Verification:** medium rung: the DR-4 measurement (≥50 completed runs via `gh api`, per-job executed count + failure rate) recorded in the PR body; guards fail-closed with attributable `::error::` messages; if non-blocking branch taken, the follow-up issue is filed and cited; workflow YAML parses (actionlint or a dry `gh workflow view` equivalent)
**Dependencies:** 005 (pointer target must exist)
**Parallelizable:** No (`ci.yml` serialization)
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 007: Gate-step wiring (coverage observe-mode, mutation, vocabulary-lint, type-debt, self-test re-asserts)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5, DR-7, DR-8, DR-9, DR-1
**Files:**
- `.github/workflows/ci.yml` (only file: `test-mcp` gains the coverage step — `npm run test:coverage`, then `check-coverage-ratchet.mjs --observe`, then upload `coverage-summary.json` as an artifact — and the mutation step — `run-mutation-gate.mjs`, PR-events only with explicit base fetch; grep-gates zero-dep prefix gains the type-debt step; grep-gates tsx tail gains the vocabulary-lint step; grep-gates gains `.test.sh` re-assert steps for check-type-debt, check-coverage-ratchet, and run-mutation-gate (task-015 pattern); each step carries its DR-1 host-class comment)
**Verification:** medium rung: on this task's own PR push, `test-mcp` runs coverage + mutation green (observe-mode coverage; the mutation step exercises the installed runner) and grep-gates runs type-debt + vocabulary-lint + the re-asserts green; the `mcp` filter and `outcome-tests` byte-identical to main; coverage artifact appears on the run
**Dependencies:** 002, 003, 004, 006 (`ci.yml` serialization; scripts + runner must exist)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 008: CI-topology conformance test (completeness, evaluate coverage, skip-guards)

**Risk Tier:** medium
**Boundary Touching:** false
**Implements:** DR-2, DR-4, DR-10
**Files:**
- `scripts/ci-topology.test.ts` (new — root-suite vitest; structural containment over the workflow YAML + evaluate template text; derives the filtered-job→changes-key mapping from each job's `if:` expression; carries the in-test non-blocking allowlist with rationale strings + issue refs per the DR-4 measured outcome)
- `scripts/__fixtures__/ci-topology/` (new — three synthetic workflows: unlisted job; filtered `needs:` job without skip-guard; `needs:` job without evaluate clause)
**Expected tests:** `Topology_UnlistedJobOutsideAllowlist_Fails`, `Topology_FilteredNeedsJobWithoutSkipGuard_Fails`, `Topology_NeedsJobWithoutEvaluateClause_Fails`, `Topology_CurrentWorkflow_Passes`
**Verification:** medium rung: scoped tests + adequacy probe; runs inside `npm run test:run`; host soundness per the two-surface rule (both `ci.yml` and `scripts/**` are in the post-DR-3 `root` filter)
**Dependencies:** 006, 007 (authored against the final evaluate block and step set)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 009: Coverage baseline capture from CI + floored epsilon + flip to blocking

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-5
**Files:**
- `servers/exarchos-mcp/coverage-baseline.json` (new — totals from ≥3 CI runs of this feature's `test-mcp` coverage artifacts, with originating run-ids, per-metric spread, and the derived `max(spread, 0.1pp)` epsilon)
- `.github/workflows/ci.yml` (flip the ratchet step `--observe` → blocking)
**Verification:** medium rung: the baseline's run-ids resolve to real runs on this feature's branch (recorded in the PR body); the ratchet passes blocking on the next push; the floor rule applied verbatim (zero observed spread → 0.1pp epsilon recorded); fail-closed paths re-asserted by 003's self-test (unchanged)
**Dependencies:** 007 (temporal: needs ≥3 CI runs of the wired coverage step; `ci.yml` serialization)
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 010: mutation-adequacy skill framing update (blocking CI context)

**Risk Tier:** low
**Boundary Touching:** false
**Implements:** DR-6
**Files:**
- `skills-src/mutation-adequacy/SKILL.md` (the "advisory by default — never blocks" framing gains the CI-context nuance: with a runner installed, the diff-scoped CI wiring and block-mode enforcement block on the NoCoverage axis)
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
- `docs/specs/2026-07-17-wave-s-enforcement-substrate-baseline.md` (new — the evidence record: every new gate's self-test results in both directions, the fail-closed matrix, the filter delta (exactly `scripts/**` in root), allowlist state at merge, the DR-4 measurement, coverage baseline provenance, manifest completeness — every new check script has its entry and its grep-gates re-assert step)
**Verification:** medium rung: run every self-test added by 002/003/004/008 and record results; assert zero jobs outside `needs:` ∪ allowlist on the final tree; assert the manifest covers every `scripts/check-*` primary; every baseline artifact carries its provenance fields
**Dependencies:** 002, 008, 009, 010
**Parallelizable:** No
**testingStrategy:** propertyTests: false, benchmarks: false

### Task 012: Mutation runner substrate (pinned stryker + config + toolchain entry + smoke self-test)

**Risk Tier:** medium
**Boundary Touching:** true
**Implements:** DR-7
**Files:**
- `servers/exarchos-mcp/package.json` + `package-lock.json` (pinned `@stryker-mutator/core` + vitest-runner devDeps)
- stryker config file under `servers/exarchos-mcp/` (diff-scoped invocation shape, mutant-count bound, runtime budget, report format the in-tree parser accepts)
- `.exarchos.yml` (`mutation:` toolchain entry resolving to `npx --no-install stryker run ...` — the resolver's unpinned `npx stryker run` fallback must never fire)
- smoke self-test (script or test file: the runner produces a parseable report on a tiny fixture scope within budget; deleting the devDep makes it FAIL)
**Verification:** medium rung: smoke self-test both directions (runner present → parseable report; runner absent → fail-closed); `resolveTestRuntime`'s `mutation` field resolves to the pinned entry (provenance event asserts the `.exarchos.yml` layer, not the built-in fallback); documented runtime budget recorded in the config
**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** propertyTests: false, benchmarks: false

### Parallelization

- **Wave A (parallel):** 001, 002, 005, 012
- **Manifest chain (serial — all three edit `scripts/enforcer-wiring-manifest.json`):** 002 → 003 → 004
- **Wave B (parallel, after their dependencies):** 004 (after 001 + 012 + 003), 010 (after 001)
- **`ci.yml` chain (serial, one editor at a time):** 006 → 007 → 009 — every `ci.yml`-touching task is on this chain and no other task touches the file
- **Post-chain:** 008 (after 007), then 011 (after 002, 008, 009, 010)
- **Critical path:** 005 → 006 → 007 → 009 → 011 (the 009 link includes the temporal ≥3-CI-runs wait, which overlaps 008's authoring rather than serializing after it)
