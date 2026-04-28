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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadExarchosConfig, type LoadResult } from './load-exarchos-config.js';

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

/** Allowlist pattern for command overrides. Rejects shell metacharacters (;|&$`(){}!<>). */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\-\s:.=\/+,@"'\\]+$/;

const UNRESOLVED_REMEDIATION =
  'No project markers detected. Add a .exarchos.yml with test/typecheck/install commands or pass an override.';

function assertSafe(label: string, value: string): void {
  if (!SAFE_COMMAND_PATTERN.test(value)) {
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

/**
 * Detect the Node-ecosystem package manager in use for a project.
 *
 * Returns the package manager based on lockfile presence, in priority order:
 *   bun > pnpm > yarn > npm (default).
 *
 * Lockfiles only matter when a `package.json` declares the project — a stray
 * `bun.lockb` from a partial git checkout should not promote a non-Node tree
 * to Node detection. Returns `null` when no `package.json` is present.
 */
function detectNodePackageManager(
  repoRoot: string,
): 'bun' | 'pnpm' | 'yarn' | 'npm' | null {
  if (!existsSync(path.join(repoRoot, 'package.json'))) {
    return null;
  }
  if (existsSync(path.join(repoRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
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
      if (!hasScript(pkg, 'test')) {
        return {
          test: null,
          typecheck: null,
          install: 'yarn install --immutable',
          detected: true,
          unresolvedReason:
            'package.json is missing a "test" script. Add a "test" entry under scripts (e.g., "test": "vitest run") or define test/typecheck commands in .exarchos.yml.',
        };
      }
      return {
        test: 'yarn test',
        typecheck: hasScript(pkg, 'typecheck') ? 'yarn run typecheck' : 'tsc --noEmit',
        install: 'yarn install --immutable',
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

  try {
    const entries = readdirSync(repoRoot);
    if (entries.some((f) => f.endsWith('.csproj'))) {
      return { test: 'dotnet test', typecheck: null, install: null, detected: true };
    }
  } catch {
    /* directory unreadable — fall through */
  }

  if (existsSync(path.join(repoRoot, 'Cargo.toml'))) {
    return { test: 'cargo test', typecheck: null, install: null, detected: true };
  }

  if (existsSync(path.join(repoRoot, 'pyproject.toml'))) {
    return { test: 'pytest', typecheck: null, install: null, detected: true };
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
  // Per-field event source/command for emission. Derived from the same layer
  // tracking that drives the aggregate, but unresolved fields are emitted
  // with source: 'unresolved' rather than null.
  let perFieldEvents: { field: 'test' | 'typecheck' | 'install'; command: string | null; source: ResolutionSource }[];
  let eventRemediation: string | undefined;

  if (
    det.unresolvedReason &&
    testPick.layer !== 'override' &&
    testPick.layer !== 'config'
  ) {
    result = {
      test: det.test,
      typecheck: det.typecheck,
      install: det.install,
      source: 'unresolved',
      remediation: det.unresolvedReason,
    };
    eventRemediation = det.unresolvedReason;
    // For the partial-detection case, every field is reported as 'unresolved'
    // on the audit log — the project is not safely runnable.
    perFieldEvents = [
      { field: 'test', command: result.test, source: 'unresolved' },
      { field: 'typecheck', command: result.typecheck, source: 'unresolved' },
      { field: 'install', command: result.install, source: 'unresolved' },
    ];
  } else if (source === 'unresolved') {
    result = {
      test: null,
      typecheck: null,
      install: null,
      source: 'unresolved',
      remediation: UNRESOLVED_REMEDIATION,
    };
    eventRemediation = UNRESOLVED_REMEDIATION;
    perFieldEvents = [
      { field: 'test', command: null, source: 'unresolved' },
      { field: 'typecheck', command: null, source: 'unresolved' },
      { field: 'install', command: null, source: 'unresolved' },
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
    perFieldEvents = [
      { field: 'test', command: testPick.value, source: layerToSource(testPick.layer) },
      { field: 'typecheck', command: typecheckPick.value, source: layerToSource(typecheckPick.layer) },
      { field: 'install', command: installPick.value, source: layerToSource(installPick.layer) },
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
        if (eventRemediation !== undefined) {
          data.remediation = eventRemediation;
        }
        const maybe = store.append(stream, { type: 'command.resolved', data });
        if (maybe && typeof (maybe as Promise<void>).then === 'function') {
          (maybe as Promise<void>).catch((err: unknown) => {
            console.warn(
              `[test-runtime-resolver] command.resolved emission failed: ${String((err as Error)?.message ?? err)}`,
            );
          });
        }
      } catch (err) {
        console.warn(
          `[test-runtime-resolver] command.resolved emission failed: ${String((err as Error)?.message ?? err)}`,
        );
      }
    }
  }

  return result;
}
