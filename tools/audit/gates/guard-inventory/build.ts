import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyEntrypointPredicate,
  hasDirectRunExit,
  isPathShaped,
  isTestArtifact,
  selfTestCandidates,
  type FilenameCoupledEntrypoint,
} from './artifact-predicates.js';
import { type ResolutionContext, indexShellIndirection, resolveHosts } from './hosts.js';
import { manifestPrimaries, parseSpecTasks, wave1Tasks } from './manifest.js';
import { type Enforcement, type GuardChannel, type GuardInventory, type GuardRecord, isEnforcingHost } from './model.js';
import { readPackageScripts } from './package-scripts.js';
import { MANIFEST_PATH, REPO_ROOT, SPEC_FALLBACK, SPEC_PATH, resolveHistoricalPath } from './paths.js';
import { productionImportedSet } from './production-modules.js';
import { scanGuardSuiteRoots, scanMcpScriptGates } from './scanners.js';
import { loadSuiteConfigs } from './vitest-projects.js';
import { type LoadedWorkflow, loadWorkflows } from './workflows.js';

export interface BuildOptions {
  readonly repoRoot?: string;
  readonly specText?: string;
  readonly manifestJson?: unknown;
  readonly workflows?: readonly LoadedWorkflow[];
  /** Channel 4's roots. Defaults to {@link GUARD_SUITE_ROOTS}. */
  readonly guardSuiteRoots?: readonly string[];
}

/**
 * Builds the guard inventory from the enforcer manifest, the frozen spec, the MCP script gates
 * and the guard suite roots. The spec `**Files:**` lists hold old paths, so
 * `resolveHistoricalPath` maps each one to the current tree. A spec module with no self-test
 * and no direct entry point has no executable verdict, so it goes to `compileTimeOnlyArtifacts`.
 * A `.sh` gate, or a script that cannot be read or parsed, counts as runnable, the stricter reading.
 * Only pull-request hosts decide `pathFilteredOnly`, because path filters apply before merge.
 */
export function buildGuardInventory(options: BuildOptions = {}): GuardInventory {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const specAbs = join(repoRoot, SPEC_PATH);
  const specFallbackAbs = join(repoRoot, SPEC_FALLBACK);
  const specText =
    options.specText ??
    (existsSync(specAbs)
      ? readFileSync(specAbs, 'utf8')
      : existsSync(specFallbackAbs)
        ? readFileSync(specFallbackAbs, 'utf8')
        : '');
  const manifestJson: unknown =
    options.manifestJson ?? JSON.parse(readFileSync(join(repoRoot, MANIFEST_PATH), 'utf8'));
  const workflows = options.workflows ?? loadWorkflows(repoRoot);

  const readScript = (path: string): string | null => {
    try {
      return readFileSync(join(repoRoot, path), 'utf8');
    } catch {
      return null;
    }
  };

  const base: ResolutionContext = {
    workflows,
    rootPkg: readPackageScripts(repoRoot, ''),
    suites: loadSuiteConfigs(repoRoot),
    exists: (path) => existsSync(join(repoRoot, path)),
    readScript,
  };
  const ctx: ResolutionContext = { ...base, shellIndex: indexShellIndirection(base) };

  const channels = new Map<string, Set<GuardChannel>>();
  const tasksByArtifact = new Map<string, Set<string>>();
  const add = (artifact: string, channel: GuardChannel): void => {
    const set = channels.get(artifact) ?? new Set<GuardChannel>();
    set.add(channel);
    channels.set(artifact, set);
  };

  for (const primary of manifestPrimaries(manifestJson)) add(primary, 'enforcer-manifest');

  const isRunnable = (artifact: string): boolean => {
    if (artifact.endsWith('.sh')) return true;
    if (!/\.[cm]?[jt]s$/.test(artifact)) return false;
    try {
      return hasDirectRunExit(readFileSync(join(repoRoot, artifact), 'utf8'), artifact);
    } catch {
      return true;
    }
  };

  const unresolvedSpecArtifacts: string[] = [];
  const compileTimeOnlyArtifacts: string[] = [];
  for (const task of wave1Tasks(parseSpecTasks(specText))) {
    for (const raw of task.files) {
      if (!isPathShaped(raw)) continue;
      const file = resolveHistoricalPath(raw, ctx.exists);
      if (!ctx.exists(file)) {
        unresolvedSpecArtifacts.push(file);
        continue;
      }
      if (isTestArtifact(file)) continue;
      if (!/\.[cm]?[jt]s$|\.sh$/.test(file)) continue;
      const hasSelfTest = selfTestCandidates(file).some((c) => ctx.exists(c));
      if (!hasSelfTest && !isRunnable(file)) {
        compileTimeOnlyArtifacts.push(file);
        continue;
      }
      add(file, 'wave1-spec');
      const ids = tasksByArtifact.get(file) ?? new Set<string>();
      ids.add(task.id);
      tasksByArtifact.set(file, ids);
    }
  }

  const mcpScan = scanMcpScriptGates(repoRoot);
  for (const gate of mcpScan.gatesWithSelfTest) add(gate, 'mcp-scripts-gate');

  const suiteScan = scanGuardSuiteRoots(repoRoot, options.guardSuiteRoots);
  for (const module of suiteScan.modulesWithSelfTest) add(module, 'conformance-suite');

  const imported = productionImportedSet(repoRoot);

  const guards: GuardRecord[] = [...channels.entries()]
    .map(([artifact, channelSet]) => {
      const hosts = resolveHosts(artifact, ctx);
      const runnable = isRunnable(artifact);
      const enforcing = hosts.filter((host) => isEnforcingHost(host, runnable));
      const enforcement: Enforcement =
        enforcing.length === 0 ? 'unreachable' : enforcing.some((h) => h.blocking) ? 'blocks' : 'observes';
      const enforcingOnPr = enforcing.filter((h) => h.onPullRequest);
      return {
        artifact,
        channels: [...channelSet].sort(),
        wave1Tasks: [...(tasksByArtifact.get(artifact) ?? [])].sort(),
        hosts,
        runnable,
        enforcement,
        pathFilteredOnly: enforcingOnPr.length > 0 && enforcingOnPr.every((h) => h.pathFilterKeys.length > 0),
        productionImported: /\.[cm]?ts$/.test(artifact) ? imported.has(artifact) : null,
      };
    })
    .sort((a, b) => a.artifact.localeCompare(b.artifact));

  const filenameCoupledEntrypoints: FilenameCoupledEntrypoint[] = [];
  let entrypointPredicatesScanned = 0;
  for (const guard of guards) {
    if (!/\.[cm]?[jt]s$/.test(guard.artifact)) continue;
    const source = readScript(guard.artifact);
    if (source === null) continue;
    entrypointPredicatesScanned += 1;
    const { coupledLiterals } = classifyEntrypointPredicate(source, guard.artifact);
    if (coupledLiterals.length > 0) {
      filenameCoupledEntrypoints.push({ artifact: guard.artifact, literals: coupledLiterals });
    }
  }

  return {
    guards,
    suiteModulesWithoutSelfTest: suiteScan.modulesWithoutSelfTest,
    runnableWithoutSelfTest: mcpScan.runnableWithoutSelfTest,
    compileTimeOnlyArtifacts: [...new Set(compileTimeOnlyArtifacts)].sort(),
    unresolvedSpecArtifacts: [...new Set(unresolvedSpecArtifacts)].sort(),
    filenameCoupledEntrypoints,
    entrypointPredicatesScanned,
    indirection: ctx.shellIndex ?? { byStep: new Map(), runStepsWalked: 0, wrapperScriptsWalked: [], unresolvedInvocations: [] },
  };
}
