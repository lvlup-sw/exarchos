// tools/audit/gates/guard-inventory.ts
//
// The guard inventory and its CI-reachability proof.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// "The mechanism ships and nothing calls it" is this program's declared dominant
// risk, and the enforcement build-out accumulated instances of it faster than
// anything noticed. Each was reported by the work that shipped it, against
// itself: `resolveDispatchShape` has no production caller; the `auditVacuity*`
// family is driven only by co-located vitest; `cli-derivation-guard` is complete
// but deliberately unwired; the authority census runs only inside a
// PATH-FILTERED job, so it is unenforced on every PR that does not touch MCP
// paths.
//
// The class is live rather than theoretical: registering one gate surfaced that
// `npm run validate` is invoked by NO workflow, so a validate-only wiring would
// itself have been an instance of the risk it was meant to close.
// `tools/audit/gates/enforcer-wiring-manifest.json` names that trap class
// `unreachable-npm`.
//
// This module answers, per guard: WHICH CI JOB runs it, whether that job is
// PATH-FILTERED, and whether it BLOCKS or merely OBSERVES.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DERIVED AND WHAT IS NOT — READ THIS BEFORE EDITING
//
// This program has been bitten repeatedly by instruments measuring a text proxy
// instead of a structural fact, and twice by hand-maintained lists that silently
// omitted a member. A guard absent from this inventory is the one place an
// unwired guard can hide from the instrument built to find it. So the split is
// stated explicitly rather than left to inference:
//
//   DERIVED (no hand-maintenance anywhere in the chain)
//     - The guard POPULATION, from four independent channels (see below). A
//       guard has to hide from all four to escape.
//     - Every VERDICT: hosting job, path-filter keys, blocking-vs-observing,
//       and production reachability. All parsed out of `.github/workflows/*.yml`,
//       the two `package.json` script tables, the two `vitest.config.ts` include
//       globs, and TypeScript import specifiers. Never asserted.
//
//   HAND-MAINTAINED (small, reviewable, and EXPIRING by construction)
//     - {@link GUARD_EXEMPTIONS}: the record of a guard that is deliberately not
//       reachable from CI. Each entry carries an owner, a blocking reason, and an
//       ISO expiry. An expired entry FAILS. An entry whose guard turns out to be
//       reachable FAILS (a stale exemption is a wiring lie). An entry naming a
//       guard outside the inventory FAILS.
//
//   NOT DERIVABLE AT ALL — stated so it cannot be mistaken for coverage
//     - A guard's SCAN SURFACE (the files it reads). `docs/guides/ci-gate-hosting.md`'s
//       two-surface subset rule needs both the scan surface and the implementation
//       surface. Only the implementation surface is a structural fact about the
//       guard's own path, so {@link auditGuardInventory} enforces THAT half and
//       reports the other half as unproven. Concretely: `dispatch-shape.ts`'s
//       prose-binding test reads `content/**`, which is outside its host job's
//       `mcp` filter — a real two-surface violation this instrument cannot see.
//     - Whether a job is a REQUIRED branch-protection check. That is repo
//       settings, out-of-repo, and not YAML-assertable (ci.yml says so itself in
//       two places). For `ci.yml` the `ci-gate` aggregator stands in for it; for
//       every other workflow, "blocking" means only "runs on pull_request and its
//       exit code is not swallowed".
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR DISCOVERY CHANNELS
//
//   1. ENFORCER-MANIFEST PRIMARIES. Every non-`retired` entry in
//      `tools/audit/gates/enforcer-wiring-manifest.json`. This channel guarantees the
//      inventory's denominator is never SMALLER than the manifest's, so a new
//      `scripts/check-*|lint-*` gate enters this inventory automatically — its
//      author cannot forget. Note the manifest's own enumerator
//      (`enumeratePrimaryFiles`) globs `scripts/(check|lint)-*.{mjs,sh}` at the
//      ROOT scripts dir only: not `.ts`, not `tools/audit/`, not
//      `tools/audit/core/`. Channel 3 exists because of that hole.
//
//   2. SPEC ARTIFACTS. The `**Files:**` line of every first-wave task in the
//      frozen internal-mechanics spec named by `SPEC_PATH`. Wave membership is
//      parsed from the `**Wave N…**` headers, and `[ANCHOR]` tasks (the later-wave
//      placeholders that trail the first block with no intervening header) are
//      excluded by their own heading tag — never by a task-number range.
//
//   3. RUNNABLE GATES UNDER `tools/audit/core/`. A module is a guard
//      executable iff it has a STATEMENT-LEVEL `process.exit(…)` entrypoint (a
//      real parse, not a name match or a text scan) AND a co-located self-test.
//      The self-test half is the definition of a guard this program already
//      committed to — "each guard's self-test runs in the same CI job as the
//      guard" — not one invented here. A runnable module with no co-located
//      self-test is REPORTED ({@link GuardInventory.runnableWithoutSelfTest})
//      rather than silently dropped, so the exclusion stays reviewable.
//
//   4. MODULES OF A DECLARED GUARD SUITE ({@link GUARD_SUITE_ROOTS}). A suite
//      root is a directory whose modules exist to police the tree, so under one
//      of them a non-test module with a co-located self-test IS a guard — the
//      same self-test criterion as channel 3, minus the runnable half, because a
//      census states its verdict through its test rather than through an exit
//      code.
//
//      This channel exists because channels 1–3 discover a census only by NAME.
//      Channel 2 reads a FROZEN spec's `**Files:**` list, and measured on the
//      landing branch that is the SOLE channel for all nine conformance censuses
//      in this inventory — including three of the five gates in the exit proof.
//      So relocating one makes its spec path stop resolving, it drops to
//      {@link GuardInventory.unresolvedSpecArtifacts}, and a guard that stops
//      being discovered stops being audited. Channel 4 answers the question from
//      the tree instead, so a directory move retargets one constant rather than
//      un-governing a census.
//
// ─────────────────────────────────────────────────────────────────────────────
// INDIRECT HOSTING: A GUARD RUN BY A SHELL SCRIPT THAT A RUN-STEP RUNS
//
// The first resolver matched a guard's path as TEXT inside a run-step's command.
// That model cannot see one level of indirection, and the tree is full of it:
// `ci.yml` runs `bash tools/audit/gates/validate-no-legacy.sh`, and THAT script runs
// `knip-diff.ts`. The guard's path never appears in the workflow at all, so it
// read as `[unwired-guard]` while running on every PR. Same shape for
// `validate-plugin.sh`, which is now a thin `exec node …/validate-plugin.mjs`.
//
// Two properties of that chain decide how it must be measured, and both defeat
// the obvious implementation:
//
//   1. THE PATH IS NEVER WRITTEN AS A LITERAL AT THE CALL SITE. The script says
//      `KNIP_DIFF="$SCRIPT_DIR/../knip-diff.ts"` and then `"$TSX_BIN"
//      "$KNIP_DIFF"`. Resolving it means resolving shell VARIABLES, plus the two
//      directory anchors this repo's scripts use (`$(cd "$(dirname
//      "${BASH_SOURCE[0]}")" && pwd)` and `$(cd "$X/.." && pwd)`).
//   2. THE LITERAL PATH *DOES* APPEAR — IN TWO COMMENTS. `validate-no-legacy.sh`
//      names `tools/audit/knip-diff.ts` in prose on two lines and nowhere else.
//      So a substring scan of the raw text answers "reachable" for a reason that
//      is not an invocation, and a substring scan of the COMMENT-STRIPPED text
//      answers "unreachable" even though the guard runs. Text-matching and real
//      invocation disagree here in BOTH directions, in-tree, today. That is why
//      this is a parse: words are split quote-aware, comments are removed, and
//      variables are resolved against the assignments in force at that line.
//
// What is deliberately NOT counted as an invocation:
//   - a path in a comment (removed before anything else looks at the text);
//   - a path merely ASSIGNED to a variable and never used in a command line —
//     assignment is not execution, and a wrapper that names a guard without
//     running it must still read as unwired;
//   - a word that is not in command position and not an argument of an
//     INTERPRETER ({@link SHELL_INTERPRETERS}). `[[ -x "$TSX_BIN" ]]` names a
//     real file in a test, not an execution.
//
// BOUND — stated rather than left to inference. The walk is bounded by LANGUAGE,
// not by depth: it follows `.sh` wrappers transitively (terminating on a `seen`
// set, exactly as {@link expandNpmScripts} does for npm chains), but it does not
// enter a NON-shell wrapper. Concretely it misses:
//   - a guard spawned by a `.mjs`/`.ts` runner. `tools/audit/gates/run-validate.mjs` is the
//     live example: it reads its step table from `tools/audit/gates/validate-manifest.json`
//     and `spawnSync`s each entry. Following it is not merely unimplemented, it
//     would be WRONG TODAY — `ci.yml` invokes it as `--list`, which prints the
//     table and executes nothing, so treating the manifest's entries as executed
//     would manufacture reachability CI does not provide.
//   - a path computed at run time from command-substitution output other than the
//     two `cd`/`dirname` anchors above, or assembled by `find -exec`/`xargs`.
// Both directions of that bound fail toward "unreachable" — the direction that
// REPORTS a wiring hole rather than hiding one.
//
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN BLIND SPOT, REPORTED RATHER THAN CLOSED
//
// `tools/audit/` is scanned by neither the enforcer manifest nor channel 3, and
// two runnable gates there (`check-base-substrate.ts`, `check-protected.mjs`) are
// referenced by no workflow and no npm script. They belong to a later enforcement
// substrate, so closing them was out of the scope that built this — but the hole
// is real and is recorded here so it is not rediscovered.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THE MODULES UNDER `guard-inventory/` FIT TOGETHER
//
// The pipeline reads left to right. `paths` anchors the repository and declares
// the four channels' roots. `workflows`, `package-scripts`, `shell-lexer` and
// `shell-walk` parse the CI substrate — YAML, npm chains, and the shell
// indirection described above. `model` declares what a guard and a host ARE.
// `manifest`, `artifact-predicates` and `scanners` are the four discovery
// channels. `vitest-projects` and `hosts` decide, per artifact, which job runs
// it and whether that job blocks. `production-modules` answers the reachability
// half. `exemptions` is the one hand-maintained list. `build` assembles the
// inventory, `audit` states the verdict, `render` prints it.
//
// This file re-exports all of it, so `guard-inventory.js` remains the single
// import path for the gate, its self-test, and every consumer.

export {
  REPO_ROOT,
  SPEC_PATH,
  MANIFEST_PATH,
  MCP_SCRIPTS_DIR,
  GUARD_SUITE_ROOTS,
  HISTORICAL_PATH_REWRITES,
  resolveHistoricalPath,
} from './guard-inventory/paths.js';

export {
  AGGREGATOR_JOB,
  CI_WORKFLOW,
  parseWorkflow,
  loadWorkflows,
  needsList,
  pathFilterKeys,
  pathFilterGlobs,
  type WorkflowStep,
  type WorkflowJob,
  type Workflow,
  type LoadedWorkflow,
} from './guard-inventory/workflows.js';

export {
  readPackageScripts,
  expandNpmScripts,
  type PackageScripts,
} from './guard-inventory/package-scripts.js';

export {
  SHELL_INTERPRETERS,
  stripShellComments,
  joinShellContinuations,
  shellCommandSegments,
  shellWords,
} from './guard-inventory/shell-lexer.js';

export {
  resolveShellExecutions,
  type ShellExecution,
  type ShellWalk,
} from './guard-inventory/shell-walk.js';

export {
  isEnforcingHost,
  type GuardChannel,
  type HostingVia,
  type Enforcement,
  type GuardHost,
  type GuardRecord,
  type GuardInventory,
} from './guard-inventory/model.js';

export {
  manifestPrimaries,
  parseSpecTasks,
  wave1Tasks,
  type SpecTask,
} from './guard-inventory/manifest.js';

export {
  isPathShaped,
  isTestArtifact,
  hasDirectRunExit,
  classifyEntrypointPredicate,
  SELF_TEST_MIRRORS,
  selfTestCandidates,
  type FilenameCoupledEntrypoint,
  type EntrypointPredicate,
} from './guard-inventory/artifact-predicates.js';

export {
  scanMcpScriptGates,
  scanGuardSuiteRoots,
  type McpScriptScan,
  type GuardSuiteScan,
} from './guard-inventory/scanners.js';

export {
  parseVitestProjects,
  vitestProjectSelectors,
  globMatches,
  loadSuiteConfigs,
  suiteForTest,
  type SuiteId,
  type VitestProject,
  type SuiteConfig,
  type SuiteMembership,
} from './guard-inventory/vitest-projects.js';

export {
  runsOnPullRequest,
  vitestPathOperands,
  indexShellIndirection,
  resolveHosts,
  type ResolutionContext,
  type ShellIndirectionIndex,
} from './guard-inventory/hosts.js';

export {
  enumerateProductionModules,
  collectImportSpecifiers,
  resolveRelativeSpecifier,
  productionImportedSet,
} from './guard-inventory/production-modules.js';

export {
  GUARD_EXEMPTIONS,
  type ExemptedFinding,
  type GuardExemption,
} from './guard-inventory/exemptions.js';

export { buildGuardInventory, type BuildOptions } from './guard-inventory/build.js';
export { auditGuardInventory, type InventoryAudit } from './guard-inventory/audit.js';
export { describeHost, renderInventoryTable } from './guard-inventory/render.js';
