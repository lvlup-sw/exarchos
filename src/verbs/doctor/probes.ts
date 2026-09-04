/**
 * DoctorProbes — the probe bundle passed to every per-check function.
 *
 * Each check receives a single `DoctorProbes` argument rather than
 * reaching into `process.*` or module-scope state, so unit tests can
 * build checks with plain object overrides (DIM-4/T-4.2: ≤3 mocks per
 * test). Defaults bind to real runtime surfaces; the composer wires
 * them via `buildProbes(ctx)` at dispatch time, never at module init.
 *
 * Probe fields:
 *   - `fs`       — narrow filesystem surface (readFile / stat / access)
 *   - `env`      — process env snapshot
 *   - `git`      — narrow git surface (which, isRepo)
 *   - `sqlite`   — lazy handle getter for sqlite integrity probing; may
 *                  be null when no backend is attached (jsonl-only mode)
 *   - `detector` — AgentEnvironmentDetector callable
 *   - `eventStore` — the context's EventStore, forwarded by reference
 *   - `runtime`  — observable runtime metadata (node version), injected
 *                  rather than read via `process.*` inside checks
 *   - `stateDir` — resolved state directory path (forwarded from
 *                  DispatchContext)
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

/** Widened fs surface for doctor checks: readFile/stat from DetectorFs
 * plus an `access` probe for writability checks. Optional so tests can
 * omit it when irrelevant. */
export interface DoctorFs extends DetectorFs {
  access?(path: string, mode?: number): Promise<void>;
}

export interface DoctorGit {
  which(cmd: string): Promise<string | null>;
  isRepo(cwd: string): Promise<boolean>;
  /** Returns the `git --version` short string (e.g. "2.43.0") or null
   * when the binary is unavailable or emits unrecognized output. Used by
   * vcs-git-available for the Pass message. */
  version(): Promise<string | null>;
}

export interface DoctorSqlite {
  /**
   * Run a bounded backend integrity probe via the EventStore's narrow
   * accessor. The EventStore itself enforces the timeout and abort
   * contract (DIM-7); this probe is a thin forwarder. The returned
   * IntegrityResult is a discriminated union — callers pattern-match
   * on `ok` without type assertions (DIM-3).
   */
  runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult>;
}

export interface DoctorBundles {
  /**
   * Run the run-bundle resolvability sweep through the EventStore's own
   * accessor: every artifact digest a ledger event references must resolve
   * in the bundle store, and a settled stream must reference something. The
   * store enforces the timeout and abort contract; this probe is a thin
   * forwarder. The result is a discriminated union — callers pattern-match
   * on `ok` without type assertions.
   */
  runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<BundleIntegrityResult>;
}

export interface DoctorRuntime {
  /** Node.js version string (e.g. "v20.11.0") — injected so checks
   * don't read `process.version` directly (DIM-4). */
  readonly nodeVersion: string;
}

export interface DoctorSkills {
  /** Cheap drift detection over the content → skills pipeline. Returns
   * `{inSync:true}` when generated output matches source, otherwise
   * `{inSync:false, driftedPaths}` listing representative drifted files.
   * Must honor `signal` (AbortController) and stay within 2000ms
   * (DIM-7). */
  guardStatus(signal?: AbortSignal): Promise<{ inSync: boolean; driftedPaths?: string[] }>;
}

export interface DoctorPlugin {
  /** Version string from the installed plugin's package.json (Claude
   * Code plugin cache), or null when the plugin is not installed
   * locally. Compute per call — DIM-1 forbids module-global caching. */
  installedVersion(): Promise<string | null>;
  /** Version string from the repo-root package.json (the version this
   * MCP server was built from), or null when unreadable. */
  runningVersion(): Promise<string | null>;
}

export interface DoctorInvariantsCatalog {
  /**
   * Resolve the effective invariant catalog from `.exarchos.yml` and report
   * whether any user-validatable catalog is `configured`, plus any
   * merge/load/reserved-namespace warnings folded by `resolveEffectiveCatalog`
   * (DR-9). The check turns a non-empty `warnings` list into a doctor Warning,
   * naming the offending catalog/id. `configured` is `false` only when the dev
   * catalog is disabled/absent AND no user catalogs are configured (the SDLC
   * baseline is compiled-in and build-validated, so it does not count). It is
   * phase-independent — a configured catalog whose entries do not project to a
   * given phase still counts as configured. Must honor `signal` and stay
   * within the 2000ms probe budget (DIM-7). */
  resolve(signal?: AbortSignal): Promise<{ configured: boolean; warnings: string[] }>;
}

/**
 * The resolved verification ladder the doctor check reports on (design §4.6):
 * which runtime commands the per-field layered resolver returned, whether any
 * toolchain was detectable at all, and the provenance of all six verification-
 * policy cells.
 *
 * The probe does ALL the disk work (config load + per-field resolution + the
 * six policy resolutions); the check stays disk-blind and only maps this shape
 * to a Pass/Warning/Skipped CheckResult. This is read-only visibility — nothing
 * here writes; the fix path remains the reconciler's.
 */
export interface VerificationToolchainResolution {
  /** Whether ANY project toolchain was detected (false ⇒ empty/unmarked repo). */
  readonly detected: boolean;
  /** The resolved verification-runtime commands; `null` per field = unresolved. */
  readonly runtime: {
    readonly test: string | null;
    readonly typecheck: string | null;
    readonly install: string | null;
    readonly mutation: string | null;
    readonly lint: string | null;
  };
  /**
   * All six `(riskTier × boundaryTouching)` policy cells with their resolved
   * provenance — `builtin` (frozen base table) vs `config` (.exarchos.yml
   * override). Read-only: the check NEVER mutates policy.
   */
  readonly policyCells: ReadonlyArray<{
    readonly riskTier: 'low' | 'medium' | 'high';
    readonly boundaryTouching: boolean;
    readonly source: 'builtin' | 'config';
  }>;
}

export interface DoctorVerificationToolchain {
  /**
   * Resolve the verification ladder's runtime + policy provenance from the
   * consumer's project root. Reads `.exarchos.yml` and probes project markers
   * via the shared `resolveVerificationRuntime` / `resolveVerificationPolicy`
   * resolvers (the single sources of truth) and folds the result into a
   * {@link VerificationToolchainResolution}. Must honor `signal` and stay
   * within the 2000ms probe budget (DIM-7). Read-only — emits/writes nothing.
   */
  resolve(signal?: AbortSignal): Promise<VerificationToolchainResolution>;
}

export interface DoctorProbes {
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
    // 'which' is POSIX-only; use 'where' on Windows
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
      // `git --version` prints "git version 2.43.0" (with optional
      // trailing suffix). Extract the semver-ish token; null if the
      // output shape is unrecognized.
      const match = stdout.match(/\d+\.\d+(?:\.\d+)?/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  },
};

/** Resolve a root by walking up from `startDir` until `marker` is found.
 *
 * `startDir` defaults to this module's directory — correct for locating the
 * plugin's OWN artifacts (its `package.json`, its `content/`). For a
 * USER-project artifact (e.g. `.exarchos.yml`) callers MUST pass
 * `process.cwd()`: in plugin mode the module lives under the plugin cache
 * (`~/.claude/plugins/...`), which has no `.exarchos.yml` ancestor, so a
 * module-relative walk would never find the consumer's config (#1482 review).
 *
 * Computed per call (DIM-1 forbids module-global caching). */
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
      // keep walking
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Lightweight drift heuristic: for each authored
 * `content/<domain>/skills/<name>/SKILL.md`, if any matching
 * `rendered/skills/<runtime>/<name>/SKILL.md` has an older mtime, treat that
 * skill as drifted. Fast, and avoids spawning `npm run skills:guard` (which
 * re-renders everything and would exceed the 2000ms probe budget).
 *
 * Sources sit one level deeper than the flat name they render to, so the
 * domain has to be walked rather than assumed away. Reading the domain as if
 * it were the skill finds no SKILL.md at all, and a probe that stats nothing
 * reports perfect sync. */
async function defaultSkillsGuardStatus(
  signal?: AbortSignal,
): Promise<{ inSync: boolean; driftedPaths?: string[] }> {
  const root = await findRepoRoot('content');
  if (root === null) return { inSync: true }; // nothing to check
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
        continue; // a domain need not carry skills
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
        // runtime may not render every skill; skip missing entries
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

/** Find the installed plugin's package.json by scanning the Claude Code
 * plugin cache. DIM-1: computed per call, no caching. */
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
 * Resolve the effective invariant catalog from the project's `.exarchos.yml`
 * and report entry count + DR-9 warnings (malformed/missing user catalogs,
 * reserved-namespace ids). A representative `ideate`/`feature` projection key
 * surfaces every merge/load warning regardless of phase narrowing. DIM-1:
 * computed per call, no caching. A failure to load config degrades to an empty
 * resolution rather than throwing — the check decides Pass/Warning/Skip.
 *
 * P1 T5: the `resolve` argument is injected (defaults to the real
 * `resolveEffectiveCatalog`) purely so the defense-in-depth catch below is
 * testable. Catalog resolution already folds DR-9 degradations (malformed /
 * missing / reserved-namespace user sources) into `warnings`, but a
 * `ReservedNamespaceError` thrown by a built-in-layer regression that escapes
 * the resolver's own pre-filter must NOT crash the doctor probe — it is folded
 * into a named advisory naming the offending id. Exported for testing. */
export async function resolveInvariantsCatalog(
  signal?: AbortSignal,
  resolve: typeof resolveEffectiveCatalog = resolveEffectiveCatalog,
): Promise<{
  configured: boolean;
  warnings: string[];
}> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  // Resolve from the USER's cwd, NOT this module's location — `.exarchos.yml`
  // is a consumer-project artifact and the module lives in the plugin cache in
  // plugin mode (#1482 review). Mirrors the vcs-git-available check's cwd use.
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
  // `configured` is the phase-INDEPENDENT Skip signal: **is any catalog
  // REGISTERED?** (DR-31 / T-43.) It used to be two disjoint questions — "is
  // the `invariants.devCatalog` boolean enabled AND does the privileged path
  // exist on disk?" OR'd with "is `invariants.catalogs` non-empty?" — which
  // made this probe the fifth live reader of a boolean DR-31 retires, and gave
  // the doctor a repo-only notion of "configured" no consumer could reproduce.
  //
  // Now there is ONE question, asked through the single discovery authority
  // `resolveCatalogSources`: a `tier: dev` registration and a `tier: user`
  // registration count identically, and the retired boolean reaches this line
  // only after the config schema has desugared it into an ordinary
  // registration. The dev-tier disk-existence probe is gone with the branch: a
  // registered-but-missing file is a DR-9 degradation the resolver already
  // folds into `warnings` below, which is a Warning the operator should SEE,
  // not a silent Skip.
  //
  // The built-in SDLC baseline is compiled-in and build-validated, so it is
  // never a runtime validation target and does not count. The older signal —
  // entry count after projecting to `ideate` — misreported a configured
  // catalog whose entries are all non-`ideate` (e.g. `phase-affinity:
  // ['review']`) as "nothing configured", making the Pass branch unreachable
  // for such catalogs (#1482 review).
  const configured = resolveCatalogSources(config).length > 0;

  // Deprecated `.exarchos.yml` keys surface as operator-facing warnings so a
  // consumer carrying a retired key learns the replacement edit from `doctor`
  // rather than discovering it when the alias is finally dropped.
  const deprecationWarnings = deprecations.map((d) => `${d.key}: ${d.message}`);

  // Phase key is arbitrary here: DR-9 warnings are folded pre-projection, so
  // any phase surfaces every merge/load warning. We discard the projected
  // entries and decide Skip-vs-validate on `configured` instead.
  //
  // Defense-in-depth (P1 T5): the resolver already folds reserved-namespace
  // user-source ids into `warnings` via its DR-9 pre-filter, so this catch is
  // not on the common path. But a `ReservedNamespaceError` from a built-in
  // layer that escapes the pre-filter must degrade to a named advisory rather
  // than crashing the doctor probe — `doctor` is the operator's diagnostic of
  // last resort and must never itself throw on a malformed catalog.
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
 * Resolve the verification ladder's runtime + policy provenance from the USER's
 * project root for the verification-toolchain doctor check (design §4.6).
 *
 * Reads from `process.cwd()` (a consumer-project artifact, mirroring the
 * invariants probe's cwd reasoning — the module lives in the plugin cache in
 * plugin mode). The per-field commands come from `resolveVerificationRuntime`
 * (the single source of truth for runtime resolution); each of the six policy
 * cells is resolved via `resolveVerificationPolicy` over the resolved project
 * config (or the frozen built-ins when no config / a malformed config). This is
 * a READ-ONLY probe — it never emits a `command.resolved` event (no eventStore
 * is passed) and never writes. DIM-1: computed per call, no caching.
 *
 * The `resolveRuntime`/`loadConfig`/`resolvePolicy` seams are injected (defaults
 * are the real resolvers) purely so the probe is unit-testable. Exported for
 * testing. */
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

  // Normalize to the actual project root before resolving runtime/config. The
  // `.exarchos.yml` (then `.git`) ancestor walk mirrors resolveInvariantsCatalog
  // and load-exarchos-config's own fallback: when `doctor` runs from a nested
  // directory, anchoring BOTH the runtime resolver and config load to the same
  // repo root keeps a configured repo from misclassifying as Skipped/Warning
  // with all-builtin provenance. Resolve from the USER's cwd, NOT this module's
  // location (#1482 — in plugin mode the module lives in the plugin cache).
  const cwd = process.cwd();
  const repoRoot =
    (await findRepoRoot('.exarchos.yml', cwd)) ?? (await findRepoRoot('.git', cwd)) ?? cwd;

  // Per-field runtime resolution (test/typecheck/install/mutation/lint).
  const runtime = resolveRuntime(repoRoot);

  // A resolution with an `unresolved` aggregate source AND every legacy field
  // null is the "no project markers detected" signal — nothing the resolver
  // could anchor on. Treat that as not-detected so the check Skips rather than
  // Warns on a genuinely empty repo.
  const detected = !(
    runtime.source === 'unresolved' &&
    runtime.test === null &&
    runtime.typecheck === null &&
    runtime.install === null &&
    runtime.mutation === null &&
    runtime.lint === null
  );

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // Resolve project config for policy provenance. A missing/malformed config
  // degrades to the frozen built-in table (INV-4) — never a hard failure.
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
 * Build a DoctorProbes bundle from a DispatchContext. Each probe field
 * binds to a real runtime surface; tests bypass this factory entirely
 * by constructing a DoctorProbes literal with just the fields under
 * test.
 */
export function buildProbes(ctx: DispatchContext): DoctorProbes {
  return {
    fs: DEFAULT_FS,
    env: process.env,
    git: DEFAULT_GIT,
    // Thin forwarder to the EventStore's narrow integrity accessor.
    // The EventStore enforces timeout + abort internally (DIM-7) and
    // reports skipped when no applicable backend is attached, so this
    // probe never needs to reach for a raw sqlite handle (DIM-6).
    sqlite: {
      runIntegrityCheck: (opts) => ctx.eventStore.runIntegrityCheck(opts),
    },
    // The same shape for run-bundle custody: the store owns the sweep, its
    // timeout and its abort; the probe only forwards.
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
