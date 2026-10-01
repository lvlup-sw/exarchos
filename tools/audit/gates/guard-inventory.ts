// The guard inventory and its CI-reachability proof.
//
// For each guard, it finds the CI job that runs it, whether that job is
// path-filtered, and whether the job blocks or only observes. Four channels
// find the population: the enforcer-manifest primaries, the spec artifacts, the
// runnable gates under `tools/audit/core/`, and the modules of a declared guard
// suite. Each verdict comes from the workflow YAML, the npm scripts, the vitest
// include globs and the import specifiers. `GUARD_EXEMPTIONS` records each guard
// that is deliberately unreachable from CI, with an owner and an expiry.
//
// The inventory follows `.sh` wrappers transitively, but no `.mjs` or `.ts`
// runner. A miss reads as "unreachable", so it reports a wiring hole. It cannot
// see the files that a guard scans, or which jobs branch protection requires.
//
// This file re-exports the modules under `guard-inventory/`, so
// `guard-inventory.js` stays the one import path.

export {
  REPO_ROOT,
  SPEC_PATH,
  SPEC_FALLBACK,
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
