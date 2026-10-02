/**
 * The probe bundle that the doctor composer passes to each check.
 * A check reads runtime facts from this bundle, so a unit test can build a check
 * with plain object overrides. `buildProbes(ctx)` binds the real defaults at
 * dispatch time, not at module load.
 */

import { promises as nodeFs, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { EventStore, IntegrityResult } from '../../events/store.js';
import type { BundleIntegrityResult } from '../../events/bundle/integrity.js';
import {
  detectAgentEnvironments,
  type AgentEnvironment,
  type DetectorFs,
} from '../../runtime/agent-environment-detector.js';
import { loadExarchosConfig } from '../../config/load-exarchos-config.js';
import type { ConfigDeprecation } from '../../config/exarchos-config-schema.js';
import { resolveEffectiveCatalog } from '../../architecture/resolve-effective-catalog.js';
import { resolveCatalogSources } from '../../architecture/catalog-sources.js';
import { ReservedNamespaceError } from '../../architecture/catalog-merge.js';
import { resolveVerificationRuntime } from '../../config/test-runtime-resolver.js';
import { resolveVerificationPolicy } from '../../workflow/verification-policy-resolver.js';
import { resolveConfig, type ResolvedProjectConfig } from '../../config/resolve.js';
import type { RiskTier } from '../../workflow/verification-policy.js';

const execFileAsync = promisify(execFile);

/** The `DetectorFs` surface plus an optional `access` probe for writability checks. */
export interface DoctorFs extends DetectorFs {
  access?(path: string, mode?: number): Promise<void>;
}

export interface DoctorGit {
  which(cmd: string): Promise<string | null>;
  isRepo(cwd: string): Promise<boolean>;
  /** Returns the version token of `git --version`, for example "2.43.0", or null when git is absent or the output is unknown. */
  version(): Promise<string | null>;
}

export interface DoctorSqlite {
  /** Runs the backend integrity probe of the EventStore. The store enforces the timeout and the abort. */
  runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult>;
}

export interface DoctorBundles {
  /**
   * Runs the run-bundle sweep of the EventStore. Each artifact digest that a ledger event
   * references must resolve in the bundle store. A settled stream must reference an artifact.
   * The store enforces the timeout and the abort.
   */
  runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<BundleIntegrityResult>;
}

export interface DoctorRuntime {
  /** The Node.js version string, for example "v20.11.0". */
  readonly nodeVersion: string;
}

export interface DoctorSkills {
  /**
   * Detects drift between authored skills and rendered skills, and lists drifted files.
   * Must honor `signal` and finish within the probe budget.
   */
  guardStatus(signal?: AbortSignal): Promise<{ inSync: boolean; driftedPaths?: string[] }>;
}

export interface DoctorPlugin {
  /** The version in the `package.json` of the installed plugin in the Claude Code plugin cache, or null. Computed per call. */
  installedVersion(): Promise<string | null>;
  /** The version in the nearest ancestor `package.json` of this module, or null when unreadable. */
  runningVersion(): Promise<string | null>;
}

export interface DoctorInvariantsCatalog {
  /**
   * Resolves the invariant catalog from `.exarchos.yml`. `configured` is true when a catalog
   * source is registered, for any phase. The built-in baseline does not count. One or more
   * warnings make the check give one doctor Warning. Must honor `signal` and finish within the
   * probe budget.
   */
  resolve(signal?: AbortSignal): Promise<{ configured: boolean; warnings: string[] }>;
}

/**
 * The verification ladder that the doctor check reports: the resolved runtime commands,
 * toolchain detection, and the source of each policy cell. The probe does the disk reads.
 * The check only maps this shape to a result.
 */
export interface VerificationToolchainResolution {
  /** False when the repository has no project markers. */
  readonly detected: boolean;
  /** The resolved commands. A `null` field is unresolved. */
  readonly runtime: {
    readonly test: string | null;
    readonly typecheck: string | null;
    readonly install: string | null;
    readonly mutation: string | null;
    readonly lint: string | null;
  };
  /** Each `(riskTier, boundaryTouching)` cell with its source: the `builtin` table or a `config` override. */
  readonly policyCells: ReadonlyArray<{
    readonly riskTier: 'low' | 'medium' | 'high';
    readonly boundaryTouching: boolean;
    readonly source: 'builtin' | 'config';
  }>;
}

export interface DoctorVerificationToolchain {
  /**
   * Resolves the runtime commands and policy sources from the project root of the consumer.
   * Must honor `signal` and finish within the probe budget.
   */
  resolve(signal?: AbortSignal): Promise<VerificationToolchainResolution>;
}

/** The default per-check time budget of the composer. A caller can pass a different `timeoutMs`. */
export const DEFAULT_CHECK_BUDGET_MS = 2000;

export interface DoctorProbes {
  /**
   * The per-check budget for this run, in milliseconds. A check with a bounded sweep sizes
   * the sweep from this value, so that its own verdict arrives before the composer timeout.
   */
  readonly checkBudgetMs: number;
  readonly fs: DoctorFs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly git: DoctorGit;
  readonly sqlite: DoctorSqlite;
  readonly bundles: DoctorBundles;
  readonly detector: (signal?: AbortSignal) => Promise<AgentEnvironment[]>;
  readonly eventStore: EventStore;
  readonly runtime: DoctorRuntime;
  readonly stateDir: string;
  readonly skills: DoctorSkills;
  readonly plugin: DoctorPlugin;
  readonly invariants: DoctorInvariantsCatalog;
  readonly verificationToolchain: DoctorVerificationToolchain;
}

const DEFAULT_FS: DoctorFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  stat: (p) => nodeFs.stat(p),
  access: (p, mode) => nodeFs.access(p, mode ?? fsConstants.F_OK),
};

const DEFAULT_GIT: DoctorGit = {
  which: async (cmd) => {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(whichCmd, [cmd]);
      const trimmed = stdout.trim().split(/\r?\n/)[0] ?? '';
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  },
  isRepo: async (cwd) => {
    try {
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  },
  version: async () => {
    try {
      const { stdout } = await execFileAsync('git', ['--version']);
      const match = stdout.match(/\d+\.\d+(?:\.\d+)?/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  },
};

/**
 * Returns the first directory, from `startDir` upward, that holds `marker`. It checks at most
 * eight directories, `startDir` included. `startDir` defaults to this module directory, which
 * finds the artifacts of the plugin. For a consumer artifact such as `.exarchos.yml`, pass
 * `process.cwd()`. In plugin mode the module is in the plugin cache, which has no consumer
 * ancestor.
 */
async function findRepoRoot(
  marker: string,
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): Promise<string | null> {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    try {
      await nodeFs.access(join(dir, marker), fsConstants.F_OK);
      return dir;
    } catch {
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Marks a skill as drifted when a `rendered/skills/<runtime>/<name>/SKILL.md` is older than
 * its `content/<domain>/skills/<name>/SKILL.md`. An mtime compare fits the probe budget,
 * and a full re-render does not. The walk must include the domain level. A walk that skips
 * it finds no source file and reports sync. A missing tree, or a runtime that does not render
 * a skill, counts as in sync.
 */
async function defaultSkillsGuardStatus(
  signal?: AbortSignal,
): Promise<{ inSync: boolean; driftedPaths?: string[] }> {
  const root = await findRepoRoot('content');
  if (root === null) return { inSync: true };
  const srcRoot = join(root, 'content');
  const outRoot = join(root, 'rendered', 'skills');
  let srcSkills: Array<{ name: string; path: string }>;
  try {
    const domains = (await nodeFs.readdir(srcRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    srcSkills = [];
    for (const domain of domains) {
      let names: string[];
      try {
        names = (await nodeFs.readdir(join(srcRoot, domain, 'skills'), { withFileTypes: true }))
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }
      for (const name of names) {
        srcSkills.push({ name, path: join(srcRoot, domain, 'skills', name, 'SKILL.md') });
      }
    }
  } catch {
    return { inSync: true };
  }
  let runtimes: string[];
  try {
    runtimes = (await nodeFs.readdir(outRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { inSync: true };
  }

  const drifted: string[] = [];
  for (const skill of srcSkills) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    let srcMtime: number;
    try {
      srcMtime = (await nodeFs.stat(skill.path)).mtimeMs;
    } catch {
      continue;
    }
    for (const runtime of runtimes) {
      const outPath = join(outRoot, runtime, skill.name, 'SKILL.md');
      try {
        const outMtime = (await nodeFs.stat(outPath)).mtimeMs;
        if (outMtime < srcMtime) {
          drifted.push(`rendered/skills/${runtime}/${skill.name}/SKILL.md`);
        }
      } catch {
      }
    }
  }

  return drifted.length === 0 ? { inSync: true } : { inSync: false, driftedPaths: drifted };
}

async function readPackageVersion(path: string): Promise<string | null> {
  try {
    const raw = await nodeFs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Reads the plugin-cache version directories in descending numeric name order. Returns the first
 * string `version` from a `package.json`, or null.
 */
async function defaultInstalledPluginVersion(): Promise<string | null> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const cacheRoot = join(home, '.claude', 'plugins', 'cache', 'lvlup-sw', 'exarchos');
  let versions: string[];
  try {
    versions = (await nodeFs.readdir(cacheRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
      );
  } catch {
    return null;
  }
  for (const v of versions) {
    const pkg = await readPackageVersion(join(cacheRoot, v, 'package.json'));
    if (pkg !== null) return pkg;
  }
  return null;
}

async function defaultRunningVersion(): Promise<string | null> {
  const root = await findRepoRoot('package.json');
  if (root === null) return null;
  return readPackageVersion(join(root, 'package.json'));
}

/**
 * Resolves the invariant catalog from the `.exarchos.yml` above `process.cwd()`.
 * `configured` is true when `resolveCatalogSources` finds a registered source, for any phase.
 * Deprecated config keys and resolver warnings come back as `warnings`. A config load failure
 * returns a warning, not a throw.
 *
 * The resolver folds warnings before phase projection, so the `plan` phase key is arbitrary.
 * A `ReservedNamespaceError` becomes a warning, because `doctor` must not throw on a bad
 * catalog. The `resolve` seam exists for tests.
 */
export async function resolveInvariantsCatalog(
  signal?: AbortSignal,
  resolve: typeof resolveEffectiveCatalog = resolveEffectiveCatalog,
): Promise<{
  configured: boolean;
  warnings: string[];
}> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const root = await findRepoRoot('.exarchos.yml', process.cwd());
  if (root === null) return { configured: false, warnings: [] };
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let config;
  let deprecations: ConfigDeprecation[] = [];
  try {
    const loaded = loadExarchosConfig(root, { findRepoRoot: () => root });
    config = loaded?.config;
    deprecations = loaded?.deprecations ?? [];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      configured: false,
      warnings: [`Failed to load .exarchos.yml at '${root}': ${reason}`],
    };
  }
  const configured = resolveCatalogSources(config).length > 0;

  const deprecationWarnings = deprecations.map((d) => `${d.key}: ${d.message}`);

  try {
    const { warnings } = resolve({
      repoRoot: root,
      config,
      phase: 'plan',
      workflowType: 'feature',
    });
    return { configured, warnings: [...deprecationWarnings, ...warnings] };
  } catch (err) {
    if (err instanceof ReservedNamespaceError) {
      return {
        configured,
        warnings: [
          ...deprecationWarnings,
          `Invariant catalog resolution surfaced a reserved-namespace ` +
            `conflict on id '${err.id}': ${err.message}`,
        ],
      };
    }
    throw err;
  }
}

/** The six `(riskTier × boundaryTouching)` policy cells, in stable order. */
const POLICY_CELLS: ReadonlyArray<{ riskTier: RiskTier; boundaryTouching: boolean }> = [
  { riskTier: 'low', boundaryTouching: false },
  { riskTier: 'low', boundaryTouching: true },
  { riskTier: 'medium', boundaryTouching: false },
  { riskTier: 'medium', boundaryTouching: true },
  { riskTier: 'high', boundaryTouching: false },
  { riskTier: 'high', boundaryTouching: true },
];

/**
 * Resolves the verification ladder for the verification-toolchain doctor check.
 * It anchors at the nearest `.exarchos.yml` from `process.cwd()` upward. Without one, it uses the
 * nearest `.git`, then `process.cwd()`. Thus the runtime resolver and the config load use the
 * same root from a nested directory.
 *
 * `detected` is false when the source is `unresolved` and each command is null. A missing or
 * bad config gives the built-in policy table. The probe passes no event store, so it emits no
 * event. The `deps` seams exist for tests.
 */
export async function resolveVerificationToolchain(
  signal?: AbortSignal,
  deps: {
    resolveRuntime?: typeof resolveVerificationRuntime;
    loadConfig?: typeof loadExarchosConfig;
    resolvePolicy?: typeof resolveVerificationPolicy;
  } = {},
): Promise<VerificationToolchainResolution> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const resolveRuntime = deps.resolveRuntime ?? resolveVerificationRuntime;
  const loadConfig = deps.loadConfig ?? loadExarchosConfig;
  const resolvePolicy = deps.resolvePolicy ?? resolveVerificationPolicy;

  const cwd = process.cwd();
  const repoRoot =
    (await findRepoRoot('.exarchos.yml', cwd)) ?? (await findRepoRoot('.git', cwd)) ?? cwd;

  const runtime = resolveRuntime(repoRoot);

  const detected = !(
    runtime.source === 'unresolved' &&
    runtime.test === null &&
    runtime.typecheck === null &&
    runtime.install === null &&
    runtime.mutation === null &&
    runtime.lint === null
  );

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let config: ResolvedProjectConfig | undefined;
  try {
    const loaded = loadConfig(repoRoot, { findRepoRoot: () => repoRoot });
    config = loaded?.config ? resolveConfig(loaded.config) : undefined;
  } catch {
    config = undefined;
  }

  const policyCells = POLICY_CELLS.map(({ riskTier, boundaryTouching }) => {
    const { source } = resolvePolicy(riskTier, boundaryTouching, config);
    return { riskTier, boundaryTouching, source };
  });

  return {
    detected,
    runtime: {
      test: runtime.test,
      typecheck: runtime.typecheck,
      install: runtime.install,
      mutation: runtime.mutation,
      lint: runtime.lint,
    },
    policyCells,
  };
}

/**
 * Builds the real probe bundle from a dispatch context. The `sqlite` and `bundles` probes
 * forward to the event store. The store owns the timeout and the abort. It also returns a skip
 * when the backend does not support the probe.
 */
export function buildProbes(ctx: DispatchContext): DoctorProbes {
  return {
    checkBudgetMs: DEFAULT_CHECK_BUDGET_MS,
    fs: DEFAULT_FS,
    env: process.env,
    git: DEFAULT_GIT,
    sqlite: {
      runIntegrityCheck: (opts) => ctx.eventStore.runIntegrityCheck(opts),
    },
    bundles: {
      runIntegrityCheck: (opts) => ctx.eventStore.runBundleIntegrityCheck(opts),
    },
    detector: (signal) => detectAgentEnvironments(undefined, signal),
    eventStore: ctx.eventStore,
    runtime: { nodeVersion: process.version },
    stateDir: ctx.stateDir,
    skills: { guardStatus: defaultSkillsGuardStatus },
    plugin: {
      installedVersion: defaultInstalledPluginVersion,
      runningVersion: defaultRunningVersion,
    },
    invariants: { resolve: (signal) => resolveInvariantsCatalog(signal) },
    verificationToolchain: {
      resolve: (signal) => resolveVerificationToolchain(signal),
    },
  };
}
