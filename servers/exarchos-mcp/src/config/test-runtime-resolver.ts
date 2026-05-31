// ─── Unified Test Runtime Resolver ──────────────────────────────────────────
//
// Owns resolution of test/typecheck/install commands for a repository. The
// resolver inspects project markers (package.json, *.csproj, Cargo.toml,
// pyproject.toml) and returns a typed ResolvedRuntime describing which
// commands to run plus the source of the resolution.
//
// This module is the new authoritative source for runtime resolution. It
// intentionally does NOT import detect-test-commands.ts — that module will
// become a compatibility shim layered on top of this resolver.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { logger } from '../logger.js';
import { loadExarchosConfig, type LoadResult } from './load-exarchos-config.js';
import { detectToolchain } from './toolchains.js';
import { LOCKS } from './vendor/package-manager-detector/lockfiles.generated.js';

const resolverLogger = logger.child({ subsystem: 'test-runtime-resolver' });

export type ResolutionSource = 'config' | 'detection' | 'override' | 'unresolved';

export interface ResolvedRuntime {
  test: string | null;
  typecheck: string | null;
  install: string | null;
  source: ResolutionSource;
  /** Present when the resolver could not determine commands and no override was supplied. */
  remediation?: string;
}

export interface ResolveOptions {
  override?: {
    test?: string;
    typecheck?: string;
    install?: string;
  };
  /** For testing: inject the config loader. Defaults to loadExarchosConfig from T12. */
  loadConfig?: (worktreePath: string) => LoadResult | null;

  /**
   * EventStore for emitting `command.resolved` events. When undefined, no
   * events are emitted (allows callers like CLI tooling that runs before init
   * to resolve commands without requiring an EventStore). When provided,
   * three events are emitted per call (one per field).
   *
   * Constructor-injection only — the resolver MUST NOT instantiate or look up
   * an EventStore itself. See PR #1185 (single-composition-root).
   */
  eventStore?: {
    append: (
      stream: string,
      event: { type: string; data: unknown },
    ) => void | Promise<void>;
  };

  /**
   * Stream ID to emit on. REQUIRED when `eventStore` is provided. Typically
   * the featureId of the active workflow.
   */
  stream?: string;
}

/**
 * Allowlist pattern for command overrides. Rejects shell metacharacters
 * (`;|&$\``(){}!<>) and control whitespace (`\n`, `\t`, `\r`) — only plain
 * spaces are allowed as token separators. Mirrors the .exarchos.yml schema
 * pattern in `exarchos-config-schema.ts` for unified semantics.
 */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

// Remediation copy for the "no project markers detected" branch. Includes a
// minimal `.exarchos.yml` example so a dispatched agent has something
// concrete to paste, plus a pointer to the workflow-state skill where the
// configuration story is documented end-to-end. Format chosen to render
// readably in both Markdown contexts and plain-text logs.
const UNRESOLVED_REMEDIATION =
  'No project markers detected. Add a .exarchos.yml at the repo root, ' +
  'for example: `test: pytest`, `typecheck: pyright`, `install: pip install -e .`. ' +
  'See skills-src/workflow-state/SKILL.md for the full configuration reference, ' +
  'or pass an override (test/typecheck/install) to this resolver.';

function assertSafe(label: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid ${label} override: must not be empty or whitespace-only`);
  }
  if (!SAFE_COMMAND_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid ${label} override: contains disallowed characters. Must match ${SAFE_COMMAND_PATTERN}`,
    );
  }
}

interface DetectionResult {
  test: string | null;
  typecheck: string | null;
  install: string | null;
  detected: boolean;
  /**
   * When set, the project markers were detected but the package.json scripts
   * required to run tests are missing. The resolver should surface this as
   * an `unresolved` source with the supplied remediation text.
   */
  unresolvedReason?: string;
}

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
  /** Yarn Berry / pnpm corepack signal. Used to discriminate Yarn versions. */
  packageManager?: string;
}

interface PackageJsonReadResult {
  json: PackageJsonShape | null;
  malformed: boolean;
}

function readPackageJson(repoRoot: string): PackageJsonReadResult {
  const pjPath = path.join(repoRoot, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pjPath, 'utf8');
  } catch {
    return { json: null, malformed: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { json: parsed as PackageJsonShape, malformed: false };
    }
    return { json: {}, malformed: false };
  } catch {
    return { json: null, malformed: true };
  }
}

function hasScript(pkg: PackageJsonShape | null, name: string): boolean {
  if (!pkg || !pkg.scripts || typeof pkg.scripts !== 'object') return false;
  const value = pkg.scripts[name];
  return typeof value === 'string' && value.trim().length > 0;
}

/** Node package managers this resolver models. `deno` (also in LOCKS) is not one. */
const NODE_PACKAGE_MANAGERS = new Set(['bun', 'pnpm', 'yarn', 'npm']);

/**
 * Detect the Node-ecosystem package manager in use for a project.
 *
 * Returns the package manager based on lockfile presence, in priority order
 * (bun > pnpm > yarn > npm default). The lockfile→agent mapping is sourced from
 * the vendored `package-manager-detector` `LOCKS` table (ordered most-specific
 * first) rather than a hand-maintained list — see
 * `./vendor/package-manager-detector/README.md`.
 *
 * Lockfiles only matter when a `package.json` declares the project — a stray
 * lockfile from a partial git checkout should not promote a non-Node tree to
 * Node detection. Returns `null` when no `package.json` is present.
 */
function detectNodePackageManager(
  repoRoot: string,
): 'bun' | 'pnpm' | 'yarn' | 'npm' | null {
  if (!existsSync(path.join(repoRoot, 'package.json'))) {
    return null;
  }
  for (const [lockfile, agent] of Object.entries(LOCKS)) {
    if (NODE_PACKAGE_MANAGERS.has(agent) && existsSync(path.join(repoRoot, lockfile))) {
      return agent as 'bun' | 'pnpm' | 'yarn' | 'npm';
    }
  }
  return 'npm';
}

/**
 * Yarn Berry (v2+) uses `yarn install --immutable`; Yarn Classic (v1) does
 * not understand that flag. Berry projects always carry one of:
 *   - `.yarnrc.yml` (Berry-only config file; v1 uses `.yarnrc`)
 *   - `.yarn/releases/` (Berry-bundled binary)
 *   - `packageManager: "yarn@>=2..."` field in package.json
 * Detect any of these signals; absence implies Yarn Classic.
 */
function isYarnBerry(repoRoot: string, pkg: PackageJsonShape | null): boolean {
  if (existsSync(path.join(repoRoot, '.yarnrc.yml'))) return true;
  if (existsSync(path.join(repoRoot, '.yarn', 'releases'))) return true;
  const declared = pkg?.['packageManager'];
  if (typeof declared === 'string' && /^yarn@(?:[2-9]|\d{2,})\b/.test(declared)) {
    return true;
  }
  return false;
}

function detect(repoRoot: string): DetectionResult {
  // Priority order: package.json > *.csproj > Cargo.toml > pyproject.toml
  const pm = detectNodePackageManager(repoRoot);
  if (pm !== null) {
    const { json: pkg, malformed } = readPackageJson(repoRoot);
    if (malformed) {
      return {
        test: null,
        typecheck: null,
        install: null,
        detected: true,
        unresolvedReason:
          'Malformed package.json: failed to parse JSON. Fix the syntax error or add a .exarchos.yml with explicit test/typecheck/install commands.',
      };
    }
    if (pm === 'bun') {
      // bun has a built-in `bun test` runner that does not depend on a
      // `scripts.test` entry — never fail script-existence on bun test.
      return {
        test: 'bun test',
        typecheck: 'tsc --noEmit',
        install: 'bun install',
        detected: true,
      };
    }
    if (pm === 'pnpm') {
      if (!hasScript(pkg, 'test')) {
        return {
          test: null,
          typecheck: null,
          install: 'pnpm install --frozen-lockfile',
          detected: true,
          unresolvedReason:
            'package.json is missing a "test" script. Add a "test" entry under scripts (e.g., "test": "vitest run") or define test/typecheck commands in .exarchos.yml.',
        };
      }
      return {
        test: 'pnpm test',
        typecheck: hasScript(pkg, 'typecheck') ? 'pnpm run typecheck' : 'tsc --noEmit',
        install: 'pnpm install --frozen-lockfile',
        detected: true,
      };
    }
    if (pm === 'yarn') {
      // `--immutable` is Berry-only; Classic (v1) rejects it. Pick the install
      // command from the detected version. Both versions still get the same
      // test/typecheck shape — those scripts are user-defined.
      const yarnInstall = isYarnBerry(repoRoot, pkg)
        ? 'yarn install --immutable'
        : 'yarn install --frozen-lockfile';
      if (!hasScript(pkg, 'test')) {
        return {
          test: null,
          typecheck: null,
          install: yarnInstall,
          detected: true,
          unresolvedReason:
            'package.json is missing a "test" script. Add a "test" entry under scripts (e.g., "test": "vitest run") or define test/typecheck commands in .exarchos.yml.',
        };
      }
      return {
        test: 'yarn test',
        typecheck: hasScript(pkg, 'typecheck') ? 'yarn run typecheck' : 'tsc --noEmit',
        install: yarnInstall,
        detected: true,
      };
    }
    if (pm === 'npm') {
      if (!hasScript(pkg, 'test:run')) {
        return {
          test: null,
          typecheck: null,
          install: 'npm install',
          detected: true,
          unresolvedReason:
            'package.json is missing a "test:run" script. Add a "test:run" entry under scripts (e.g., "test:run": "vitest run") or define test/typecheck commands in .exarchos.yml.',
        };
      }
      return {
        test: 'npm run test:run',
        typecheck: hasScript(pkg, 'typecheck') ? 'npm run typecheck' : 'tsc --noEmit',
        install: 'npm install',
        detected: true,
      };
    }
  }

  // Non-node toolchains: delegate identity + canonical commands to the registry,
  // the single source of truth for markers. This is where `.slnx`/`.sln` now
  // resolve (#1507) and where the expanded ecosystem set (go, java, ruby, …)
  // comes from. The node branch above already handled package.json repos with
  // their package-manager nuance, so the registry's node entry is never reached
  // here. Non-node entries carry test-only commands (typecheck/install null),
  // preserving the resolver's prior output shape.
  const toolchain = detectToolchain(repoRoot);
  if (toolchain) {
    return {
      test: toolchain.commands.test,
      typecheck: toolchain.commands.typecheck,
      install: toolchain.commands.install,
      detected: true,
    };
  }

  return { test: null, typecheck: null, install: null, detected: false };
}

export function resolveTestRuntime(repoRoot: string, options?: ResolveOptions): ResolvedRuntime {
  const override = options?.override;

  if (override) {
    if (override.test !== undefined) assertSafe('test', override.test);
    if (override.typecheck !== undefined) assertSafe('typecheck', override.typecheck);
    if (override.install !== undefined) assertSafe('install', override.install);
  }

  // Validate emission contract up-front: eventStore requires stream.
  if (options?.eventStore && (options.stream === undefined || options.stream === '')) {
    throw new Error(
      'resolveTestRuntime: stream is required when eventStore is provided',
    );
  }

  const det = detect(repoRoot);

  // Load config (T12 — propagates schema/parse errors as hard failures).
  const loadConfig = options?.loadConfig ?? loadExarchosConfig;
  const configResult = loadConfig(repoRoot);
  const config = configResult?.config;

  // Per-field merge: override > config > detection.
  type Layer = 'override' | 'config' | 'detection';
  const pick = (
    overrideVal: string | undefined,
    configVal: string | undefined,
    detectVal: string | null,
  ): { value: string | null; layer: Layer | null } => {
    if (overrideVal !== undefined) return { value: overrideVal, layer: 'override' };
    if (configVal !== undefined) return { value: configVal, layer: 'config' };
    if (detectVal !== null) return { value: detectVal, layer: 'detection' };
    return { value: null, layer: null };
  };

  const testPick = pick(override?.test, config?.test, det.test);
  const typecheckPick = pick(override?.typecheck, config?.typecheck, det.typecheck);
  const installPick = pick(override?.install, config?.install, det.install);

  const contributingLayers = new Set<Layer>(
    [testPick.layer, typecheckPick.layer, installPick.layer].filter(
      (l): l is Layer => l !== null,
    ),
  );

  // Aggregate source label = highest-precedence layer that contributed any
  // non-null field. override > config > detection > unresolved.
  let source: ResolutionSource;
  if (contributingLayers.has('override')) {
    source = 'override';
  } else if (contributingLayers.has('config')) {
    source = 'config';
  } else if (contributingLayers.has('detection')) {
    source = 'detection';
  } else {
    source = 'unresolved';
  }

  // Compute the final ResolvedRuntime first so emission has the same view as
  // the caller. Two tricky cases below:
  //   1) Detection had `unresolvedReason` (e.g., missing test:run script) and
  //      neither override nor config supplied `test`. The aggregate result is
  //      flagged 'unresolved' with the detection-specific remediation.
  //   2) Nothing contributed at all → generic 'unresolved'.

  let result: ResolvedRuntime;
  // Per-field event source/command/remediation for emission. Derived from the
  // same layer tracking that drives the aggregate, but unresolved fields are
  // emitted with source: 'unresolved' rather than null. The schema requires a
  // non-empty remediation string for every `source: 'unresolved'` event, so
  // each entry carries its own — even in the "partial detection" case (e.g.,
  // .NET/Rust/Python where typecheck/install have no resolver default).
  type PerFieldEvent = {
    field: 'test' | 'typecheck' | 'install';
    command: string | null;
    source: ResolutionSource;
    /** Required when source === 'unresolved'. */
    remediation?: string;
  };
  let perFieldEvents: PerFieldEvent[];

  // Per-field remediation builder for the partial-unresolved case. Avoids
  // hard-coding project-type strings in the message — the resolver shouldn't
  // know whether it's looking at .NET vs Rust at this layer.
  const fieldUnresolvedRemediation = (field: 'typecheck' | 'install'): string =>
    `No ${field} command available for this project from detection. ` +
    `Add a "${field}" entry to .exarchos.yml or pass an override.`;

  if (
    det.unresolvedReason &&
    testPick.layer !== 'override' &&
    testPick.layer !== 'config'
  ) {
    // Detection couldn't produce a runnable test command, but override/config
    // may still have contributed valid `typecheck` or `install` values —
    // honor them per the documented precedence (override > config > detection).
    // The aggregate source remains `unresolved` because `test` is unrunnable,
    // but per-field events keep their actual source so the audit trail is
    // accurate.
    const layerToSource = (layer: Layer | null): ResolutionSource =>
      layer === null ? 'unresolved' : layer;
    result = {
      test: null,
      typecheck: typecheckPick.value,
      install: installPick.value,
      source: 'unresolved',
      remediation: det.unresolvedReason,
    };
    perFieldEvents = [
      { field: 'test', command: null, source: 'unresolved', remediation: det.unresolvedReason },
      {
        field: 'typecheck',
        command: typecheckPick.value,
        source: layerToSource(typecheckPick.layer),
        ...(typecheckPick.layer === null
          ? { remediation: fieldUnresolvedRemediation('typecheck') }
          : {}),
      },
      {
        field: 'install',
        command: installPick.value,
        source: layerToSource(installPick.layer),
        ...(installPick.layer === null
          ? { remediation: fieldUnresolvedRemediation('install') }
          : {}),
      },
    ];
  } else if (source === 'unresolved') {
    result = {
      test: null,
      typecheck: null,
      install: null,
      source: 'unresolved',
      remediation: UNRESOLVED_REMEDIATION,
    };
    perFieldEvents = [
      { field: 'test', command: null, source: 'unresolved', remediation: UNRESOLVED_REMEDIATION },
      { field: 'typecheck', command: null, source: 'unresolved', remediation: UNRESOLVED_REMEDIATION },
      { field: 'install', command: null, source: 'unresolved', remediation: UNRESOLVED_REMEDIATION },
    ];
  } else {
    result = {
      test: testPick.value,
      typecheck: typecheckPick.value,
      install: installPick.value,
      source,
    };
    const layerToSource = (layer: Layer | null): ResolutionSource =>
      layer === null ? 'unresolved' : layer;
    const buildEvent = (
      field: 'test' | 'typecheck' | 'install',
      pick: { value: string | null; layer: Layer | null },
    ): PerFieldEvent => {
      if (pick.layer === null) {
        // Detected projects (e.g., .NET / Rust / Python) leave secondary
        // fields null — the per-field event must still satisfy the schema's
        // unresolved-with-remediation invariant.
        const remediation =
          field === 'test'
            ? UNRESOLVED_REMEDIATION
            : fieldUnresolvedRemediation(field);
        return { field, command: pick.value, source: 'unresolved', remediation };
      }
      return { field, command: pick.value, source: layerToSource(pick.layer) };
    };
    perFieldEvents = [
      buildEvent('test', testPick),
      buildEvent('typecheck', typecheckPick),
      buildEvent('install', installPick),
    ];
  }

  // Emit per-field events. Resolution succeeds even if emission fails
  // (DIM-7 resilience): we catch and warn but never propagate.
  if (options?.eventStore && options.stream) {
    const stream = options.stream;
    const store = options.eventStore;
    for (const ev of perFieldEvents) {
      try {
        const data: { field: string; command: string | null; source: ResolutionSource; repoRoot: string; remediation?: string } = {
          field: ev.field,
          command: ev.command,
          source: ev.source,
          repoRoot,
        };
        if (ev.remediation !== undefined) {
          data.remediation = ev.remediation;
        }
        const maybe = store.append(stream, { type: 'command.resolved', data });
        if (maybe && typeof (maybe as Promise<void>).then === 'function') {
          (maybe as Promise<void>).catch((err: unknown) => {
            resolverLogger.warn(
              { err: (err as Error)?.message ?? String(err) },
              'command.resolved emission failed',
            );
          });
        }
      } catch (err) {
        resolverLogger.warn(
          { err: (err as Error)?.message ?? String(err) },
          'command.resolved emission failed',
        );
      }
    }
  }

  return result;
}
