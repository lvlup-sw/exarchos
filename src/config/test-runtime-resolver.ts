/**
 * Resolves the test, typecheck and install commands of a repository, one field at a time.
 * The layer order, highest first: override > `.exarchos.yml` direct > user `toolchains:` > task runner > built-in registry > unresolved.
 * Toolchain identity and markers come from `./toolchains.ts`. The task-runner layer comes from `./task-runners.ts`.
 * The result is a {@link ResolvedRuntime} with the commands and the highest layer that supplied one.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';

/** A `path.join` with POSIX separators. Marker paths are compared with config keys, so the separator must be the same on Windows. */
const pjoin = (...segments: string[]): string => toPosix(path.join(...segments));
import { logger } from '../logger.js';
import { loadExarchosConfig, type LoadResult } from './load-exarchos-config.js';
import { detectToolchain, toolchainFromConfig, type ContractCommands, type Toolchain } from './toolchains.js';
import { resolveTaskRunner } from './task-runners.js';
import { splitCommand } from './tokenize-command.js';
import { LOCKS, INSTALL_METADATA } from './vendor/package-manager-detector/lockfiles.generated.js';

const resolverLogger = logger.child({ subsystem: 'test-runtime-resolver' });

/**
 * The layer that supplied a command. `config` is `.exarchos.yml` direct, and `toolchain-config` is a user `toolchains:` entry.
 * `task-runner` is a committed Taskfile, justfile, mise or Makefile target. `detection` is the built-in registry.
 */
export type ResolutionSource =
  | 'override'
  | 'config'
  | 'toolchain-config'
  | 'task-runner'
  | 'detection'
  | 'unresolved';

export interface ResolvedRuntime {
  test: string | null;
  typecheck: string | null;
  install: string | null;
  source: ResolutionSource;
  /** The fix text. It is present when `source` is `unresolved`. */
  remediation?: string;
}

/**
 * The verification runtime: the {@link ResolvedRuntime} fields plus `mutation`, `lint` and a structured `contract`.
 * `source` comes from {@link resolveTestRuntime} and covers only test, typecheck and install.
 */
export interface ResolvedVerificationRuntime extends ResolvedRuntime {
  mutation: string | null;
  lint: string | null;
  /** Structured contract commands `{ codegen, diff }`, or null when no tool resolves. */
  contract: ContractCommands | null;
  /**
   * True when `mutation` came from an override, `.exarchos.yml` direct, or a user toolchain, and not from a task runner or detection.
   * It is optional, so an injected test runtime reads as "not declared". That is the safe reading for a consumer that gates on it.
   */
  mutationProjectDeclared?: boolean;
}

export interface ResolveOptions {
  override?: {
    test?: string;
    typecheck?: string;
    install?: string;
    mutation?: string;
    lint?: string;
    contract?: { codegen?: string; diff?: string };
  };
  /** A config loader for tests. The default is `loadExarchosConfig`. */
  loadConfig?: (worktreePath: string) => LoadResult | null;

  /**
   * The store for `command.resolved` events. With a store, each call appends three events, one for each field.
   * Without a store, the resolver appends nothing, so CLI tools that run before init can resolve commands.
   * The resolver must not create or look up an EventStore itself.
   */
  eventStore?: {
    append: (
      stream: string,
      event: { type: string; data: unknown },
    ) => void | Promise<void>;
  };

  /** The stream for the events. It is required with `eventStore`. Usually it is the featureId of the active workflow. */
  stream?: string;
}

/**
 * The allowlist for command overrides. It rejects shell metacharacters and control whitespace, and allows a plain space between tokens.
 * It is equal to `SAFE_COMMAND_REGEX` in `exarchos-config-schema.ts`.
 */
const SAFE_COMMAND_PATTERN = /^[a-zA-Z0-9_\- :.=\/+,@"'\\]+$/;

/** The fix text when no project marker is found. It gives a minimal `.exarchos.yml` example and points to the checkpoint skill. */
const UNRESOLVED_REMEDIATION =
  'No project markers detected. Add a .exarchos.yml at the repo root, ' +
  'for example: `test: pytest`, `typecheck: pyright`, `install: pip install -e .`. ' +
  'See content/continuity/skills/checkpoint/SKILL.md for the full configuration reference, ' +
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
   * Set when the project markers are present but `package.json` is malformed or has no test script.
   * The resolver then returns an `unresolved` source with this text.
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
  const pjPath = pjoin(repoRoot, 'package.json');
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
 * Detects the Node package manager of a project from its lockfile. The default is npm.
 * The lockfile map is the vendored `package-manager-detector` `LOCKS` table, most specific first.
 * With no lockfile, it checks the installed-state markers in `INSTALL_METADATA`, as upstream does.
 * It returns `null` when there is no `package.json`, so a stray lockfile does not make a tree a Node project.
 */
function detectNodePackageManager(
  repoRoot: string,
): 'bun' | 'pnpm' | 'yarn' | 'npm' | null {
  if (!existsSync(pjoin(repoRoot, 'package.json'))) {
    return null;
  }
  for (const [lockfile, agent] of Object.entries(LOCKS)) {
    if (NODE_PACKAGE_MANAGERS.has(agent) && existsSync(pjoin(repoRoot, lockfile))) {
      return agent as 'bun' | 'pnpm' | 'yarn' | 'npm';
    }
  }
  for (const [marker, agent] of Object.entries(INSTALL_METADATA)) {
    if (NODE_PACKAGE_MANAGERS.has(agent) && existsSync(pjoin(repoRoot, marker))) {
      return agent as 'bun' | 'pnpm' | 'yarn' | 'npm';
    }
  }
  return 'npm';
}

/**
 * Returns true for Yarn Berry (v2+), which uses `yarn install --immutable`. Yarn Classic (v1) rejects that flag.
 * The signals are `.yarnrc.yml`, `.yarn/releases/`, or a `packageManager` field of `yarn@2` or later. With no signal, the project is Yarn Classic.
 */
function isYarnBerry(repoRoot: string, pkg: PackageJsonShape | null): boolean {
  if (existsSync(pjoin(repoRoot, '.yarnrc.yml'))) return true;
  if (existsSync(pjoin(repoRoot, '.yarn', 'releases'))) return true;
  const declared = pkg?.['packageManager'];
  if (typeof declared === 'string' && /^yarn@(?:[2-9]|\d{2,})\b/.test(declared)) {
    return true;
  }
  return false;
}

/**
 * Script profiles for pnpm, yarn and npm. `detect` handles bun separately, because `bun test` needs no `scripts.test` entry.
 * `testScript` is the script that must exist for a runnable `test` command. `install` is a function, so yarn can select the flag for Berry or Classic.
 * These commands refine the package-manager-blind node entry in `toolchains.ts`. They are not a second toolchain list.
 */
const NODE_SCRIPT_PROFILES: Record<
  'pnpm' | 'yarn' | 'npm',
  {
    testScript: string;
    test: string;
    typecheck: string;
    install: (repoRoot: string, pkg: PackageJsonShape | null) => string;
  }
> = {
  pnpm: {
    testScript: 'test',
    test: 'pnpm test',
    typecheck: 'pnpm run typecheck',
    install: () => 'pnpm install --frozen-lockfile',
  },
  yarn: {
    testScript: 'test',
    test: 'yarn test',
    typecheck: 'yarn run typecheck',
    install: (repoRoot, pkg) =>
      isYarnBerry(repoRoot, pkg) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
  },
  npm: {
    testScript: 'test:run',
    test: 'npm run test:run',
    typecheck: 'npm run typecheck',
    install: () => 'npm install',
  },
};

/**
 * Runs the built-in detection. Node comes first, with package-manager and script checks. Then the registry detects the other toolchains in priority order.
 * A bun repo uses `bun run test:run` when that script exists, because `bun test` runs the Bun runner over vitest files and not the real suite.
 * Without that script, it uses `bun test`, which needs no `scripts.test` entry.
 * For pnpm, yarn and npm, a missing test script gives an unresolved test that still carries an install command.
 */
function detect(repoRoot: string): DetectionResult {
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
      return {
        test: hasScript(pkg, 'test:run') ? 'bun run test:run' : 'bun test',
        typecheck: hasScript(pkg, 'typecheck') ? 'bun run typecheck' : 'tsc --noEmit',
        install: 'bun install',
        detected: true,
      };
    }
    const profile = NODE_SCRIPT_PROFILES[pm];
    const install = profile.install(repoRoot, pkg);
    if (!hasScript(pkg, profile.testScript)) {
      return {
        test: null,
        typecheck: null,
        install,
        detected: true,
        unresolvedReason:
          `package.json is missing a "${profile.testScript}" script. Add a "${profile.testScript}" entry under scripts ` +
          `(e.g., "${profile.testScript}": "vitest run") or define test/typecheck commands in .exarchos.yml.`,
      };
    }
    return {
      test: profile.test,
      typecheck: hasScript(pkg, 'typecheck') ? profile.typecheck : 'tsc --noEmit',
      install,
      detected: true,
    };
  }

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

/**
 * Resolves the test, typecheck and install commands, one field at a time, in the layer order of the file header.
 * An override must match `SAFE_COMMAND_PATTERN`, and the resolver trims it. An `eventStore` needs a `stream`.
 * A config load error is not caught.
 *
 * The aggregate `source` is the highest layer that supplied any field.
 * If detection flags the test as unresolvable and no higher layer supplies one, `source` is `unresolved`. Typecheck and install keep their values.
 *
 * Each `command.resolved` event carries the real source of its field. An unresolved field always carries a remediation, because the event schema requires one.
 * An append failure only logs a warning, so resolution never fails because of the event store.
 */
export function resolveTestRuntime(repoRoot: string, options?: ResolveOptions): ResolvedRuntime {
  const rawOverride = options?.override;

  if (rawOverride) {
    if (rawOverride.test !== undefined) assertSafe('test', rawOverride.test);
    if (rawOverride.typecheck !== undefined) assertSafe('typecheck', rawOverride.typecheck);
    if (rawOverride.install !== undefined) assertSafe('install', rawOverride.install);
  }
  const override = {
    test: rawOverride?.test?.trim(),
    typecheck: rawOverride?.typecheck?.trim(),
    install: rawOverride?.install?.trim(),
  };

  if (options?.eventStore && (options.stream === undefined || options.stream === '')) {
    throw new Error(
      'resolveTestRuntime: stream is required when eventStore is provided',
    );
  }

  const det = detect(repoRoot);

  const loadConfig = options?.loadConfig ?? loadExarchosConfig;
  const configResult = loadConfig(repoRoot);
  const config = configResult?.config;

  const userToolchains = (config?.toolchains ?? []).map(toolchainFromConfig);
  const userMatched = userToolchains.length > 0 ? detectToolchain(repoRoot, userToolchains) : undefined;
  const userMatch = userMatched && userToolchains.includes(userMatched) ? userMatched : undefined;

  type DetectionTier = 'toolchain-config' | 'task-runner' | 'detection';
  const resolveDetection = (
    field: 'test' | 'typecheck' | 'install',
  ): { value: string | null; tier: DetectionTier | null } => {
    const userCmd = userMatch?.commands[field] ?? null;
    if (userCmd !== null) return { value: userCmd, tier: 'toolchain-config' };
    const runner = resolveTaskRunner(repoRoot, field);
    if (runner) return { value: runner.command, tier: 'task-runner' };
    if (det[field] !== null) return { value: det[field], tier: 'detection' };
    return { value: null, tier: null };
  };
  const testDet = resolveDetection('test');
  const typecheckDet = resolveDetection('typecheck');
  const installDet = resolveDetection('install');

  type Layer = 'override' | 'config' | DetectionTier;
  const pick = (
    overrideVal: string | undefined,
    configVal: string | undefined,
    detection: { value: string | null; tier: DetectionTier | null },
  ): { value: string | null; layer: Layer | null } => {
    if (overrideVal !== undefined) return { value: overrideVal, layer: 'override' };
    if (configVal !== undefined) return { value: configVal, layer: 'config' };
    if (detection.value !== null && detection.tier !== null) {
      return { value: detection.value, layer: detection.tier };
    }
    return { value: null, layer: null };
  };

  const testPick = pick(override?.test, config?.test, testDet);
  const typecheckPick = pick(override?.typecheck, config?.typecheck, typecheckDet);
  const installPick = pick(override?.install, config?.install, installDet);

  const contributingLayers = new Set<Layer>(
    [testPick.layer, typecheckPick.layer, installPick.layer].filter(
      (l): l is Layer => l !== null,
    ),
  );

  let source: ResolutionSource;
  if (contributingLayers.has('override')) {
    source = 'override';
  } else if (contributingLayers.has('config')) {
    source = 'config';
  } else if (contributingLayers.has('toolchain-config')) {
    source = 'toolchain-config';
  } else if (contributingLayers.has('task-runner')) {
    source = 'task-runner';
  } else if (contributingLayers.has('detection')) {
    source = 'detection';
  } else {
    source = 'unresolved';
  }

  let result: ResolvedRuntime;
  type PerFieldEvent = {
    field: 'test' | 'typecheck' | 'install';
    command: string | null;
    source: ResolutionSource;
    remediation?: string;
  };
  let perFieldEvents: PerFieldEvent[];

  const fieldUnresolvedRemediation = (field: 'typecheck' | 'install'): string =>
    `No ${field} command available for this project from detection. ` +
    `Add a "${field}" entry to .exarchos.yml or pass an override.`;

  const layerToSource = (layer: Layer | null): ResolutionSource =>
    layer === null ? 'unresolved' : layer;
  const fieldPicks: Record<
    'test' | 'typecheck' | 'install',
    { value: string | null; layer: Layer | null }
  > = { test: testPick, typecheck: typecheckPick, install: installPick };
  const buildPerFieldEvents = (
    remediationForNull: (field: 'test' | 'typecheck' | 'install') => string,
  ): PerFieldEvent[] =>
    (['test', 'typecheck', 'install'] as const).map((field) => {
      const p = fieldPicks[field];
      if (p.layer === null) {
        return {
          field,
          command: p.value,
          source: 'unresolved',
          remediation: remediationForNull(field),
        };
      }
      return { field, command: p.value, source: layerToSource(p.layer) };
    });

  if (det.unresolvedReason && testPick.value === null) {
    const reason = det.unresolvedReason;
    result = {
      test: null,
      typecheck: typecheckPick.value,
      install: installPick.value,
      source: 'unresolved',
      remediation: reason,
    };
    perFieldEvents = buildPerFieldEvents((field) =>
      field === 'test' ? reason : fieldUnresolvedRemediation(field),
    );
  } else if (source === 'unresolved') {
    result = {
      test: null,
      typecheck: null,
      install: null,
      source: 'unresolved',
      remediation: UNRESOLVED_REMEDIATION,
    };
    perFieldEvents = buildPerFieldEvents(() => UNRESOLVED_REMEDIATION);
  } else {
    result = {
      test: testPick.value,
      typecheck: typecheckPick.value,
      install: installPick.value,
      source,
    };
    perFieldEvents = buildPerFieldEvents((field) =>
      field === 'test' ? UNRESOLVED_REMEDIATION : fieldUnresolvedRemediation(field),
    );
  }

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

/**
 * One command field, ready for a gate to run, or the reason that it cannot run.
 * `unresolved`: the resolver found no command for the field.
 * `invalid`: resolution failed, or the resolved command does not split into a program and its arguments.
 */
export type RunnableCommand =
  | {
      readonly kind: 'runnable';
      readonly command: string;
      readonly bin: string;
      readonly args: readonly string[];
    }
  | { readonly kind: 'unresolved'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Resolves one command field for a gate that runs it. The function never throws and never guesses a
 * command. A caller that needs the leg to pass treats each result other than `runnable` as a failed leg.
 */
export function resolveRunnableCommand(
  repoRoot: string,
  field: 'test' | 'typecheck',
  options?: ResolveOptions,
): RunnableCommand {
  let runtime: ResolvedRuntime;
  try {
    runtime = resolveTestRuntime(repoRoot, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid', reason: `The toolchain resolver failed for ${repoRoot}: ${message}` };
  }
  const command = runtime[field];
  if (command === null) {
    return {
      kind: 'unresolved',
      reason:
        runtime.remediation ??
        `No ${field} command resolved for ${repoRoot}. Add a "${field}" entry to .exarchos.yml.`,
    };
  }
  let parts: { cmd: string; args: readonly string[] };
  try {
    parts = splitCommand(command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid', reason: `The resolved ${field} command "${command}" cannot be parsed: ${message}` };
  }
  if (parts.cmd.length === 0) {
    return { kind: 'invalid', reason: `The resolved ${field} command for ${repoRoot} is empty.` };
  }
  return { kind: 'runnable', command, bin: parts.cmd, args: parts.args };
}

/** Resolves `mutation` or `lint` through override, config, user toolchain, task runner, and then built-in detection. */
function resolveScalarField(
  repoRoot: string,
  field: 'mutation' | 'lint',
  overrideVal: string | undefined,
  configVal: string | undefined,
  userMatchCommand: string | null,
  detectBuiltin: () => Toolchain | undefined,
): string | null {
  if (overrideVal !== undefined) return overrideVal;
  if (configVal !== undefined) return configVal;
  if (userMatchCommand !== null) return userMatchCommand;
  const runner = resolveTaskRunner(repoRoot, field);
  if (runner) return runner.command;
  const detectedCmd = detectBuiltin()?.commands[field] ?? null;
  if (detectedCmd !== null) return detectedCmd;
  return null;
}

/**
 * Resolves the verification runtime. Test, typecheck, install and `source` come from {@link resolveTestRuntime}, with the same events.
 * `mutation` and `lint` resolve through the same layer order, and the built-in detection runs at most once for both.
 * `contract` resolves through override, config and user toolchain only, because contracts are keyed on schema artifacts.
 * The mutation gate uses `mutationProjectDeclared` to tell a declared command from an inferred one. The two command strings look the same.
 */
export function resolveVerificationRuntime(
  repoRoot: string,
  options?: ResolveOptions,
): ResolvedVerificationRuntime {
  const rawOverride = options?.override;
  if (rawOverride) {
    if (rawOverride.mutation !== undefined) assertSafe('mutation', rawOverride.mutation);
    if (rawOverride.lint !== undefined) assertSafe('lint', rawOverride.lint);
    if (rawOverride.contract?.codegen !== undefined) {
      assertSafe('contract.codegen', rawOverride.contract.codegen);
    }
    if (rawOverride.contract?.diff !== undefined) {
      assertSafe('contract.diff', rawOverride.contract.diff);
    }
  }

  const base = resolveTestRuntime(repoRoot, options);

  const loadConfig = options?.loadConfig ?? loadExarchosConfig;
  const configResult = loadConfig(repoRoot);
  const config = configResult?.config;

  const userToolchains = (config?.toolchains ?? []).map(toolchainFromConfig);
  const userMatched =
    userToolchains.length > 0 ? detectToolchain(repoRoot, userToolchains) : undefined;
  const userMatch =
    userMatched && userToolchains.includes(userMatched) ? userMatched : undefined;

  let detectedBuiltin: Toolchain | undefined;
  let detectedBuiltinRan = false;
  const detectBuiltin = (): Toolchain | undefined => {
    if (!detectedBuiltinRan) {
      detectedBuiltinRan = true;
      detectedBuiltin = detectToolchain(repoRoot);
    }
    return detectedBuiltin;
  };

  const mutation = resolveScalarField(
    repoRoot,
    'mutation',
    rawOverride?.mutation?.trim(),
    config?.mutation,
    userMatch?.commands.mutation ?? null,
    detectBuiltin,
  );
  const lint = resolveScalarField(
    repoRoot,
    'lint',
    rawOverride?.lint?.trim(),
    config?.lint,
    userMatch?.commands.lint ?? null,
    detectBuiltin,
  );

  const contract = resolveContract(rawOverride?.contract, config?.contract, userMatch?.commands.contract ?? null);

  const mutationProjectDeclared =
    rawOverride?.mutation?.trim() !== undefined ||
    config?.mutation !== undefined ||
    (userMatch?.commands.mutation ?? null) !== null;

  return {
    ...base,
    mutation,
    lint,
    contract,
    mutationProjectDeclared,
  };
}

/**
 * Resolves the contract commands. `codegen` and `diff` each take the first value from override, config, and then user toolchain.
 * It returns null when neither resolves. That null means "no contract tool".
 */
function resolveContract(
  overrideContract: { codegen?: string; diff?: string } | undefined,
  configContract: { codegen?: string | null | undefined; diff?: string | null | undefined } | undefined,
  userContract: ContractCommands | null,
): ContractCommands | null {
  const codegen =
    overrideContract?.codegen?.trim() ??
    configContract?.codegen ??
    userContract?.codegen ??
    null;
  const diff =
    overrideContract?.diff?.trim() ??
    configContract?.diff ??
    userContract?.diff ??
    null;
  if (codegen === null && diff === null) return null;
  return { codegen, diff };
}
