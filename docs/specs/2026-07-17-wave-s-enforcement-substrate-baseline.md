# Wave-S Enforcement Substrate — Conformance + Evidence Baseline

Implements: DR-10 (task 011, the last task of wave S).

This document is the empirical record for the wave-S enforcement substrate
(`docs/specs/2026-07-17-wave-s-enforcement-substrate.md`).
Every number, pass count, and code excerpt below was produced by a command run
in this worktree, or read directly from an artifact checked into the tree —
none of it is copied from the spec's acceptance criteria as an assertion of
completion.
Verification tree: branch `wave-s/011-conformance-sweep`, pinned to integration
tip `e6aedcd1` (`merge(wave-s): task 010 mutation-adequacy skill framing
(DR-6)`), the tip of `feat/wave-s-enforcement-substrate` as of 2026-07-17.

## 1. Self-test matrix

Every new gate's self-test was run in this worktree.
Each self-test exercises the conforming direction, the synthetic-violation
direction, and at least one fail-closed direction (DR-10's acceptance
criterion), per its own internal case naming.

| Script | Command | Result |
|---|---|---|
| `scripts/check-type-debt.test.sh` (DR-9) | `bash scripts/check-type-debt.test.sh` | **21 passed, 0 failed** |
| `scripts/check-coverage-ratchet.test.sh` (DR-5) | `bash scripts/check-coverage-ratchet.test.sh` | **22 passed, 0 failed** |
| `scripts/check-mutation-gate.test.sh` (DR-7) | `bash scripts/check-mutation-gate.test.sh` | **22 passed, 0 failed** |
| `scripts/ci-topology.test.ts` (DR-2) | `npx vitest run scripts/ci-topology.test.ts` | **4 passed, 0 failed** (1 test file) |

Both directions plus fail-closed, observed per script:

- **check-type-debt** — conforming: `TypeDebt_FreshBaselineOnCurrentTree_Passes`.
  Synthetic violation: `TypeDebt_ActualExceedsBudget_Fails`,
  `TypeDebt_NewFileWithCastsAbsentFromBaseline_Fails`,
  `TypeDebt_CensusHashMismatch_FailsClosed`.
  Fail-closed: `TypeDebt_MissingBaseline_FailsClosed`,
  `TypeDebt_UnparseableBaseline_FailsClosed`,
  `TypeDebt_ProvenancelessBaseline_FailsClosed`.
- **check-coverage-ratchet** — conforming: `IdenticalSummary_Passes`.
  Synthetic violation: `Regression_BeyondEpsilon_Fails`.
  Fail-closed: `SummaryMissing_FailsClosed`, `SummaryUnparseable_FailsClosed`,
  `BaselineMissingRunIds_FailsClosed`, `BaselineMissingVariance_FailsClosed`,
  `BaselineFileMissing_FailsClosed`.
  Observe-mode neutrality also asserted: `Observe_RegressionNeverBlocks`,
  `Observe_FailClosedNeverBlocks`.
- **check-mutation-gate** — conforming: `AllCoveredDiff_Passes`.
  Synthetic violation: `NoCoverageExceedsBudget_Fails`.
  Fail-closed: `GitFailure_FailsClosed`, `MissingTooling_FailsClosed`.
  Skip paths (neither pass nor fail-closed, logged and exit 0):
  `EmptyServerDiff_SkipExitsZero`, `NonPrEvent_SkipExitsZero`.
  Degrade handling: `DegradedCarrier_FailsBlocking`,
  `DegradedCarrier_ObserveNeverBlocks`, `NoCoverageFailure_ObserveNeverBlocks`,
  `NoResolvableToolchain_Fails`.
- **ci-topology.test.ts** — 4 tests cover completeness (job outside
  `needs`/allowlist fails), evaluate coverage (`needs.<job>.result` clause
  missing fails), skip-guard coverage (filtered job without a skip-guard
  fails), and the real, current `ci.yml` passing all three checks
  simultaneously.

## 2. Enforcer-wiring completeness

```
$ node scripts/check-enforcer-wiring.mjs
check-enforcer-wiring: clean — 21 primaries dispositioned.
```

`scripts/enforcer-wiring-manifest.json` currently carries 21 `primaries`
entries: 16 `gating`, 3 `advisory`, 2 `retired`.
Every new `scripts/check-*` primary introduced by this spec has both a
manifest entry and an unfiltered grep-gates `.test.sh` re-assert step:

| Script | Manifest disposition | grep-gates re-assert step (`.github/workflows/ci.yml`) |
|---|---|---|
| `scripts/check-type-debt.mjs` | `gating` (line 122-127 of the manifest) | `check-type-debt self-test re-assert (DR-10)` → `bash scripts/check-type-debt.test.sh` (ci.yml:692) |
| `scripts/check-coverage-ratchet.mjs` | `gating` (line 36-41) | `check-coverage-ratchet self-test re-assert (DR-10)` → `bash scripts/check-coverage-ratchet.test.sh` (ci.yml:694) |
| `scripts/check-mutation-gate.mjs` | `advisory` (line 76-80) | `check-mutation-gate self-test re-assert (DR-10)` → `bash scripts/check-mutation-gate.test.sh` (ci.yml:796) |

`scripts/check-enforcer-wiring.mjs` itself is manifest-entered (`gating`,
manifest line 48-53) and re-asserted via `Enforcer wiring gate (DR-5/DR-8, task
011)` (ci.yml:707-708). `scripts/ci-topology.test.ts` is re-asserted via `CI-topology
conformance test (DR-2)` → `npx --no-install vitest run scripts/ci-topology.test.ts`
(ci.yml:782), which also rides `test-root`'s filtered suite (harmless
duplication, per DR-2's own acceptance criteria).

## 3. Filter byte-identity proof

```
$ git diff origin/main -- .github/workflows/ci.yml
```

`origin/main` at capture time is `2f4c0e2366f7dd1076d5cc52ab3683c5c113b991`
(`refactor: debloat wave 1 + structural-enforcement gates (DR-1..18) (#1714)`)
— the pre-wave-S baseline this spec's tasks build on top of. The full diff is
276 lines; every hunk is additive comments, new gate steps, `fetch-depth: 0`,
or the coverage/mutation instrumentation inside `test-mcp` and `binary-matrix`.
No hunk touches the `changes:` job's `paths:` filters, the `test-mcp`/`test-root`
`if:` filter expressions, or `outcome-tests`.

Extracted the `changes:` job block (path-filter definitions) and the
`outcome-tests:` job block from both `origin/main`'s `ci.yml` and this tree's
`ci.yml` and diffed them directly (not via the unified diff, as a second,
independent check):

```
$ diff <(changes: job, origin/main) <(changes: job, HEAD)
CHANGES JOB IDENTICAL   (0 lines of diff)

$ diff <(outcome-tests: job, origin/main) <(outcome-tests: job, HEAD)
OUTCOME-TESTS JOB BYTE-IDENTICAL   (44 lines each side, 0 lines of diff)
```

Delta: **none**, for both path filters and `outcome-tests` — confirmed
byte-identical to `origin/main`, satisfying DR-3's "Both `root` and `mcp`
filters are byte-identical to main" acceptance criterion and the "What this
does NOT touch" clause of the Technical Design section.

The touched regions in the 276-line diff, by area:

- `changes:` job header — a doc-only comment block (Gate hosting taxonomy,
  DR-1) inserted above the job, not inside its filter body.
- `test-mcp` job — `actions/checkout@v4` gains `fetch-depth: 0` (DR-7); the
  plain `npm run test:run` step is replaced by the coverage-instrumented step
  + ratchet step + artifact upload + the RUN_EVALS-preserving eval step +
  the observe-mode mutation step + the composed-path Stryker smoke test.
- `binary-matrix` job — a doc-only disposition comment (DR-4), no behavior
  change.
- `grep-gates` job — new zero-dep-prefix steps (type-debt, two `.test.sh`
  re-asserts) and a new tsx-tail block (vocabulary-lint, ci-topology test,
  bun setup + the third `.test.sh` re-assert).
- `e2e-process` job — a doc-only disposition comment (DR-4), no behavior
  change.
- `ci-gate` evaluate script — two new skip-guard clauses (DR-3: `test-root`/
  `test-mcp` skipped-as-passed on a root/mcp-touching PR fails closed).

## 4. Aggregator completeness / allowlist state

`scripts/ci-topology.test.ts` passes (4/4, §1 above) against the real,
current `ci.yml` — zero top-level jobs sit outside `ci-gate.needs` ∪ the
in-test `NON_BLOCKING_ALLOWLIST`. The allowlist, read directly from
`scripts/ci-topology.test.ts`:

```ts
const NON_BLOCKING_ALLOWLIST: Record<string, AllowlistEntry> = {
  'e2e-process': {
    rationale:
      'Measured 3.33% failure-when-executed over last 60 completed ci.yml runs (> 2% blocking threshold); known SQLITE_BUSY flake cluster.',
    issue: '#1718',
  },
  'binary-matrix': {
    rationale:
      'Release-lane compile evidence, not a per-PR gate (standing reason the --minify A/B was dropped).',
    issue: '#1703',
  },
};
```

DR-4 measured dispositions:

- **`e2e-process` — non-blocking.** Measured over the last 60 completed
  `ci.yml` runs (2026-07-17) via the GitHub Actions runs/jobs API: 60/60
  executed (no path filter gates this job), 2/60 failed — a 3.33%
  failure-rate-when-executed, above the spec's 2% blocking threshold. Both
  failures were in the "Run process-fidelity suite" step, consistent with the
  known `SQLITE_BUSY` flake cluster. Stays non-blocking; the corrected
  `ci.yml` comment (the stale "Blocking gate as of T3.7" claim — never true,
  this job has never been in `ci-gate.needs` — is replaced) records the
  measured rate. Follow-up to burn down the flake and flip to blocking:
  **#1718**.
- **`binary-matrix` — non-blocking.** Declared non-blocking with rationale:
  release-lane compile evidence, not a per-PR gate — the standing reason the
  `--minify` A/B comparison was dropped (**#1703**). Measured over the same
  60-run window: 300/300 per-target job instances executed (5-target matrix
  × 60 runs), 0 failed; the disposition is architectural, not a reliability
  call, so the measured 0% failure rate does not change it.

The DR-3 residual scripts-filter-hole follow-up (root-suite tests hosted
under `scripts/` that are not this spec's own gates, and so are not covered
by the unfiltered grep-gates re-asserts, still skip on scripts-only PRs) is
tracked as **#1717**, cited in `docs/guides/ci-gate-hosting.md`'s "Follow-up:
the residual scripts-filter hole" section (carries the #1699 Windows-lane
constraint).

## 5. Coverage baseline provenance

`servers/exarchos-mcp/coverage-baseline.json` (captured task 009), read
directly from the tree:

| Metric | Baseline (pct) | Measured spread (pp) | Floored epsilon (pp) |
|---|---|---|---|
| lines | 91.60 | 0.03 | 0.10 |
| statements | 91.60 | 0.03 | 0.10 |
| functions | 96.24 | 0.03 | 0.10 |
| branches | 85.38 | 0.04 | 0.10 |

Originating run-ids (`runIds`, all `conclusion: success` on
`feat/wave-s-enforcement-substrate`):

- `29622454248` (commit `b494afbd`) — lines 91.58, statements 91.58, functions
  96.21, branches 85.42
- `29623082084` (commit `06069514`) — lines 91.57, statements 91.57, functions
  96.21, branches 85.41
- `29624088763` (commit `0d91a8bd`) — lines 91.60, statements 91.60, functions
  96.24, branches 85.38 (the latest of the three — its baseline `pct` values
  are this run's numbers)

All 4 metrics measured a sub-floor spread (0.03-0.04pp across the 3 runs), so
the 0.1pp floor governs every metric's epsilon verbatim — per DR-5's floor
rule (`epsilon_m = max(observed spread_m, 0.1 percentage points)`), a zero or
near-zero epsilon is never used. `laneConfig.RUN_EVALS` records that the
measured lane pins `RUN_EVALS: ''` via the step-level `env:` override, so the
baseline and every comparison are RUN_EVALS-independent (never confounded by
`needs.changes.outputs.prompts`).

Coverage ratchet disposition: **BLOCKING**, flipped in task 009
(`scripts/check-coverage-ratchet.mjs` runs without `--observe` in
`.github/workflows/ci.yml`'s `test-mcp` job — ci.yml:67 of the origin/main
diff, "Coverage ratchet — blocking (DR-5)"), and the manifest entry disposition
is `gating` (§2 above), matching the manifest's honesty contract (task 009 flips
script + manifest atomically).

## 6. Eval-lane preservation proof

`origin/main`'s `test-mcp` job carries a single job-level `env:` derivation:

```yaml
env:
  RUN_EVALS: ${{ needs.changes.outputs.prompts == 'true' && '1' || '' }}
```

This job-level env is **unchanged** in the current tree (same expression,
same job) — confirmed present verbatim in `ci.yml`. The coverage-instrumented
suite step that replaces the old `npm run test:run` overrides it per-step to
`RUN_EVALS: ''`, so the measured coverage lane never varies with
prompts-touching PRs (per DR-5's "measured lane is pinned" requirement). The
eval tests that step used to carry (`src/evals/harness.test.ts`,
`src/evals/graders/llm-rubric.test.ts`) are preserved by a dedicated
conditional step added in task 007:

```yaml
- name: Eval lane (RUN_EVALS-gated, prompts-touching PRs only) (DR-5)
  if: needs.changes.outputs.prompts == 'true'
  env:
    RUN_EVALS: '1'
  run: npx vitest run src/evals/harness.test.ts src/evals/graders/llm-rubric.test.ts
```

The `if:` predicate (`needs.changes.outputs.prompts == 'true'`) is the
identical predicate `origin/main`'s job-level derivation used to gate
`RUN_EVALS=1`, and the step sets `RUN_EVALS: '1'` directly — an exact
reproduction of the old derivation, just moved from an ambient job-level env
var (which the coverage step would otherwise have inherited and confounded)
to an explicit, isolated step. The eval lane fires on prompts-touching PRs
exactly as before — the DR-5 non-negotiable is met.

## 7. Deviations from the plan

Recorded honestly, per DR-10's own standard (never assert a spec's acceptance
criteria as fact without the run that proves it):

### Mutation gate DEFERRED to observe (not the planned dual flip)

Task 009's spec text called for flipping **both** the coverage ratchet and
the mutation gate to blocking together. The actual landed change
(commit `c7fbd7ff`, "feat(coverage): capture CI baseline + floored epsilon,
flip coverage ratchet to blocking; mutation stays observe pending #1720
(DR-5)") is a scope change: only the coverage ratchet flipped. The mutation
gate (`scripts/check-mutation-gate.mjs`) stays `--observe` in
`.github/workflows/ci.yml`'s `test-mcp` job, and its
`enforcer-wiring-manifest.json` entry stays `advisory` (§2 table above) —
disposition matches actual behavior, per the manifest's honesty contract.

Reason: StrykerJS's dry-run fails `validateResultCompleted` on the full
server suite, so the diff-scoped mutation gate degrades in CI rather than
producing a clean verdict. Flipping it to blocking under that condition would
fail every PR regardless of the actual diff's mutation adequacy — the exact
skip-pass/false-block theater this spec exists to prevent.

Exit condition and tracking issue: **#1720** (cited in both the manifest
entry's rationale and the `ci.yml` step comment as the flip's precondition).

The DR-6 mechanism itself is unaffected by this deferral and is fully
implemented and unit-tested by task 001 (commit `a7fd8d79`,
`feat(mutation): NoCoverage blocking axis (DR-6)`): the handler's two-knob
`passed` computation, the projection fold carrying `noCoverage`, and the
block-mode guard's Check 4b are all live code with passing tests
(`mutation-adequacy.test.ts`, `workflow-state-projection.test.ts`,
`guards.test.ts`, `composite.test.ts`, `event-injection.test.ts` — 687 lines
added across handler/projection/guard/injector in that commit). What is
deferred is only the CI wiring's blocking flip, not the enforcement axis
itself.

### DR-6 review-path enforcement is opt-in, not on-by-default here

The spec's DR-6 §4 states this repo's review configuration "adapts the
mutation gate as a blocking review dimension (D1 via `adaptLadderGate`)" and
implies the NoCoverage axis therefore strengthens live review verdicts here
automatically once a runner exists. Verified against the actual resolved
config:

- `servers/exarchos-mcp/src/config/resolve.ts:196` sets
  `'mutation-adequacy': { enabled: true, blocking: false, ... }` as the
  per-gate default — deliberately **not** inheriting `dimensions.D1`'s
  blocking default. `D1: { ...DEFAULT_DIMENSION }` (line 168) is the
  dimension-level default; the per-gate override at line 196 is what actually
  governs `mutation-adequacy`'s severity.
- `resolve.ts:430-431` resolves `mutationEnforcement` from
  `project.review?.['mutation-enforcement']`, defaulting to `'advisory'`
  (`DEFAULTS.review.mutationEnforcement` at line 200) when unset.
- This repo's `.exarchos.yml` sets `review.dimensions.D1: blocking` (and
  D2-D5), but does **not** set `review.mutation-enforcement: block` anywhere
  in the file.

So the NoCoverage axis's block-mode guard path (Check 4b) is live code, fully
reachable, and unit-tested — but it only fires when a repo (including this
one) explicitly opts in with `review.mutation-enforcement: block`. This repo
has not made that opt-in. Task 010's skill framing update
(commit `3b3e8a00`) was corrected to state this precisely: "opt-in, the same
way the score's severity is" — rather than "this repo has it on by default,"
which the original spec text implied.

### Four CI-only defects surfaced by the PR-#1719 soak and fixed

These are gates/paths that only execute in CI (not locally), so they were
invisible until the feature branch's own PR (#1719) actually ran the wave-S
workflow end to end:

1. **stryker-adapter Windows-portability** (commit `3a70f61f`) —
   `stryker-adapter.mjs` tripped the Windows-portability grep-gate on two
   counts: `new URL(import.meta.url).pathname` (non-portable path handling,
   fixed with `fileURLToPath(import.meta.url)`) and a resolved-binary
   `execFileSync` call the gate's dynamic-spawn rule flagged. Fix broadens
   the gate's `CI_TOOLING_RE` exemption to match a `scripts/` path segment at
   any depth (not just the repo root), so nested build-tool dirs like
   `servers/*/scripts/` are recognized as CI tooling. Self-test added with a
   kill-probe proving the old regex would have reported red.
2. **`.exarchos.yml` schema validation** (commit `a9cada58`) —
   `ProjectConfigSchema_DefaultExarchosYml_ParsesSuccessfully` validated the
   real `.exarchos.yml` against `ProjectConfigSchema` alone, which never
   models the top-level `mutation` toolchain-override key (added in task
   017, predating wave-S). Fixed by pointing the test at
   `FullExarchosConfigSchema` (the #1479 dual-reader unified schema), with a
   negative test added proving a genuine top-level typo is still rejected
   (no passthrough hole opened).
3. **DR-14 root cast-budget** (same commit, `a9cada58`) — task 001's Check
   4b (`guards.ts`) duplicated Check 4a's
   `reviews[...] as Record<string, unknown> | undefined` cast and added a
   second `state._maxNoCoverage as number` cast, pushing the `asCast` delta
   to +6 against the fixed baseline (1 over the `DELTA_BUDGET.asCast=5`
   ceiling). Both casts replaced with real narrowing — `isPlainObject` (the
   existing type guard in `state-mutation.ts`) for the review-dimension
   lookup, and a local `const` capture of the already-`typeof`-narrowed
   `_maxNoCoverage` budget. Verified in the diff: 2 `as` casts removed, 0
   added, no behavior change; delta now measures +4.
4. **mutation gate `<base>...HEAD` merge-base diff** (commit `06069514`) —
   `check-mutation-gate.mjs` diffs `<base>...HEAD` (three-dot, merge-base) to
   scope changed `servers/exarchos-mcp/src` files. `test-mcp`'s checkout was
   shallow (`depth: 1` implicitly), so the merge-base commit was absent and
   the diff failed with "no merge base." Observe mode masked the failure;
   it would have failed closed once task 009 flipped the gate to blocking.
   Fixed with `fetch-depth: 0` on `test-mcp`'s checkout (mirrors other jobs
   in this file that already need full history).

Plus the **DR-10 attribution fix** (commit `4edf8cb4`,
"fix(mutation): surface runner stderr in adapter + handler degrade reason
(DR-10 attributability, #1719)"): `stryker-adapter.mjs` and
`mutation-adequacy.ts` are extended to capture and surface a bounded tail
(1500 chars, keeping the tail of the output rather than the head, since a
runner's actual failure is almost always near the end of its transcript) of
Stryker's own stdout/stderr on both the exec-failure path and the
"exited cleanly but no report" path. Before this fix, a degraded mutation
gate run reported only a generic wrapper message
(`execFileSync`'s "Command failed: ..."), with no way to see *why* Stryker
failed. This is what made **#1720** (the StrykerJS `validateResultCompleted`
dry-run failure blocking the mutation-gate flip, §"Mutation gate DEFERRED"
above) observable in the first place — without this fix, the investigation
in #1720 would have nothing but an opaque non-zero exit code to work from.
