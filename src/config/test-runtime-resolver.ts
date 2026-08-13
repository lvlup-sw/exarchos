// ─── Unified Test Runtime Resolver ──────────────────────────────────────────
//
// Owns resolution of test/typecheck/install commands for a repository as a
// layered, per-field precedence (highest first):
//   override > .exarchos.yml direct > user `toolchains:` (tier 3) >
//   task-runner (tier 4) > built-in toolchain registry (tier 5) > unresolved.
// Toolchain identity + markers come from the shared registry (./toolchains.ts);
// the language-agnostic task-runner tier from ./task-runners.ts. Returns a typed
// ResolvedRuntime describing which commands to run plus the source per field.
//
// This module is the authoritative source for runtime resolution.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';

/** POSIX-normalized path.join — marker paths are compared against config
 *  keys, so they must be separator-agnostic on Windows (#1620). */
const pjoin = (...segments: string[]): string => toPosix(path.join(...segments));
import { logger } from '../logger.js';
import { loadExarchosConfig, type LoadResult } from './load-exarchos-config.js';
import { detectToolchain, toolchainFromConfig, type ContractCommands, type Toolchain } from './toolchains.js';
import { resolveTaskRunner } from './task-runners.js';
import { LOCKS, INSTALL_METADATA } from './vendor/package-manager-detector/lockfiles.generated.js';

const resolverLogger = logger.child({ subsystem: 'test-runtime-resolver' });

// Detection sub-tiers of the layered resolver, in precedence order:
//   override > config (.exarchos.yml direct) > toolchain-config (user
//   .exarchos.yml `toolchains:`) > task-runner (Taskfile/just/mise/Makefile) >
//   detection (built-in registry) > unresolved.
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
  /** Present when the resolver could not determine commands and no override was supplied. */
  remediation?: string;
}

/**
 * The widened verification runtime (task 017). Carries the legacy
 * test/typecheck/install fields PLUS the verification-ladder additions:
 * `mutation`, `lint`, and structured `contract`. Resolved via the same
 * per-field layered precedence as {@link ResolvedRuntime}.
 *
 * `source` is the aggregate label of the highest-precedence layer that
 * contributed any non-null field across the legacy three (preserving the exact
 * `resolveTestRuntime` semantics the alias delegates to). The widened fields
 * resolve independently per the same tier order.
 */
export interface ResolvedVerificationRuntime extends ResolvedRuntime {
  mutation: string | null;
  lint: string | null;
  /** Structured contract commands `{ codegen, diff }`, or null when no tool resolves. */
  contract: ContractCommands | null;
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
// concrete to paste, plus a pointer to the checkpoint skill where the
// configuration story is documented end-to-end. Format chosen to render
// readably in both Markdown contexts and plain-text logs.
const UNRESOLVED_REMEDIATION =
  'No project markers detected. Add a .exarchos.yml at the repo root, ' +
  'for example: `test: pytest`, `typecheck: pyright`, `install: pip install -e .`. ' +
  'See skills-src/checkpoint/SKILL.md for the full configuration reference, ' +
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
  if (!existsSync(pjoin(repoRoot, 'package.json'))) {
    return null;
  }
  for (const [lockfile, agent] of Object.entries(LOCKS)) {
    if (NODE_PACKAGE_MANAGERS.has(agent) && existsSync(pjoin(repoRoot, lockfile))) {
      return agent as 'bun' | 'pnpm' | 'yarn' | 'npm';
    }
  }
  // No lockfile — fall back to installed-state markers (deps installed but the
  // lockfile is absent), matching upstream's two-stage detect.
  for (const [marker, agent] of Object.entries(INSTALL_METADATA)) {
    if (NODE_PACKAGE_MANAGERS.has(agent) && existsSync(pjoin(repoRoot, marker))) {
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
  if (existsSync(pjoin(repoRoot, '.yarnrc.yml'))) return true;
  if (existsSync(pjoin(repoRoot, '.yarn', 'releases'))) return true;
  const declared = pkg?.['packageManager'];
  if (typeof declared === 'string' && /^yarn@(?:[2-9]|\d{2,})\b/.test(declared)) {
    return true;
  }
  return false;
}

/**
 * Per-package-manager script profile for the Node script-existence path
 * (pnpm / yarn / npm — `bun` is handled separately since `bun test` needs no
 * `scripts.test` entry). `testScript` is the script whose presence gates a
 * runnable `test` command; `install` is a function so yarn can pick
 * `--immutable` (Berry) vs `--frozen-lockfile` (Classic). These PM-aware
 * command strings live here, not in toolchains.ts, by design: the registry's
 * node entry is a package-manager-blind baseline (see toolchains.ts), and these
 * are the refinements the resolver layers on top — not a second toolchain list.
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
    // `--immutable` is Berry-only; Classic (v1) rejects it. Pick the install
    // command from the detected version. Both versions still get the same
    // test/typecheck shape — those scripts are user-defined.
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

function detect(repoRoot: string): DetectionResult {
  // Tier 5 (built-in): node first (package-manager-aware, with script-existence
  // nuance), then any other toolchain via the shared registry's priority order.
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
      // bun ships a built-in `bun test` runner that does not require a
      // `scripts.test` entry, so a bun repo NEVER resolves unresolved-test.
      // BUT when the project defines an explicit `test:run` script (e.g. a
      // vitest-on-bun repo like servers/exarchos-mcp, which pins vitest for
      // Windows-headroom timeouts), honor it — otherwise `bun test` runs Bun's
      // native runner over vitest files instead of the project's real suite.
      // This mirrors the npm profile (`testScript: 'test:run'`) so both
      // supported workspaces (root via npm, servers/exarchos-mcp via bun)
      // resolve the SAME intended `test:run` command rather than diverging
      // onto two different runners. `typecheck` follows the same honor-script
      // rule as the npm/pnpm/yarn branch. Install stays package-manager-native.
      return {
        test: hasScript(pkg, 'test:run') ? 'bun run test:run' : 'bun test',
        typecheck: hasScript(pkg, 'typecheck') ? 'bun run typecheck' : 'tsc --noEmit',
        install: 'bun install',
        detected: true,
      };
    }
    // pnpm / yarn / npm share one script-existence shape (bun handled above): a
    // missing test script yields an unresolved-test result that still carries a
    // runnable install; otherwise test/typecheck resolve package-manager-aware.
    // The per-PM commands come from the NODE_SCRIPT_PROFILES table.
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
  const rawOverride = options?.override;

  if (rawOverride) {
    if (rawOverride.test !== undefined) assertSafe('test', rawOverride.test);
    if (rawOverride.typecheck !== undefined) assertSafe('typecheck', rawOverride.typecheck);
    if (rawOverride.install !== undefined) assertSafe('install', rawOverride.install);
  }
  // Normalize override values to their trimmed form so emitted/returned commands
  // match the trimmed `safeCommand` shape config values already use (N2).
  const override = {
    test: rawOverride?.test?.trim(),
    typecheck: rawOverride?.typecheck?.trim(),
    install: rawOverride?.install?.trim(),
  };

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

  // ── Detection sub-tiers (resolved per field, highest tier first) ──────────
  // tier 3: user-declared `.exarchos.yml` toolchains: (matched before built-ins)
  const userToolchains = (config?.toolchains ?? []).map(toolchainFromConfig);
  const userMatched = userToolchains.length > 0 ? detectToolchain(repoRoot, userToolchains) : undefined;
  const userMatch = userMatched && userToolchains.includes(userMatched) ? userMatched : undefined;

  type DetectionTier = 'toolchain-config' | 'task-runner' | 'detection';
  const resolveDetection = (
    field: 'test' | 'typecheck' | 'install',
  ): { value: string | null; tier: DetectionTier | null } => {
    // tier 3 — user toolchain command
    const userCmd = userMatch?.commands[field] ?? null;
    if (userCmd !== null) return { value: userCmd, tier: 'toolchain-config' };
    // tier 4 — committed task-runner with a matching conventional target
    const runner = resolveTaskRunner(repoRoot, field);
    if (runner) return { value: runner.command, tier: 'task-runner' };
    // tier 5 — built-in registry detection
    if (det[field] !== null) return { value: det[field], tier: 'detection' };
    return { value: null, tier: null };
  };
  const testDet = resolveDetection('test');
  const typecheckDet = resolveDetection('typecheck');
  const installDet = resolveDetection('install');

  // Per-field merge: override > config > [toolchain-config > task-runner > detection].
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

  // Aggregate source label = highest-precedence layer that contributed any
  // non-null field. override > config > toolchain-config > task-runner >
  // detection > unresolved.
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

  // Per-field event construction, table-driven over the three legacy fields in
  // order. Each field's event derives from its resolved pick: a null layer
  // (nothing contributed) emits `source: 'unresolved'` with a remediation string
  // (the schema requires one), otherwise the contributing layer becomes the
  // event source. The result-branches below differ only in which remediation an
  // unresolved field gets, so they share this one builder rather than each
  // repeating the three-element array literal.
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
    // The built-in detection flagged an unresolvable test (e.g. node missing a
    // test:run script) AND no higher tier (override / config / user toolchain /
    // task-runner) supplied one — so `test` is genuinely null. override/config
    // (and now the toolchain-config / task-runner tiers) may still have
    // contributed valid `typecheck`/`install` values — honor them per the
    // documented precedence. The aggregate source remains `unresolved` because
    // `test` is unrunnable, but per-field events keep their actual source so the
    // audit trail is accurate.
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
    // Detected projects (e.g., .NET / Rust / Python) leave secondary fields
    // null — the per-field event must still satisfy the schema's
    // unresolved-with-remediation invariant.
    perFieldEvents = buildPerFieldEvents((field) =>
      field === 'test' ? UNRESOLVED_REMEDIATION : fieldUnresolvedRemediation(field),
    );
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

// ─── Generalized Verification Runtime Resolver (task 017) ───────────────────
//
// `resolveVerificationRuntime` widens the resolver over the verification-ladder
// field set: the legacy test/typecheck/install PLUS mutation, lint, and
// structured contract. It reuses the exact same layered precedence — per field,
// highest first: override > .exarchos.yml direct > user `toolchains:` >
// task-runner > built-in registry > unresolved.
//
// Design note (single source of truth): the legacy three fields are resolved by
// delegating to `resolveTestRuntime` so its behavior — and its `command.resolved`
// emission and aggregate `source` semantics — stay byte-identical. The widened
// scalar fields (mutation, lint) resolve through the same tier order via a
// shared per-field helper; `contract` resolves structured ({ codegen, diff }).
// Contracts are keyed on schema ARTIFACTS, not the language toolchain, so the
// built-in registry contributes null contract and the resolved structured value
// comes from override / config-direct (artifact-keyed registry seeds are wired
// in task 022).

/** Resolve a single widened scalar field (mutation | lint) through the tier stack. */
function resolveScalarField(
  repoRoot: string,
  field: 'mutation' | 'lint',
  overrideVal: string | undefined,
  configVal: string | undefined,
  userMatchCommand: string | null,
  detectBuiltin: () => Toolchain | undefined,
): string | null {
  // tier 1 — override
  if (overrideVal !== undefined) return overrideVal;
  // tier 2 — .exarchos.yml direct
  if (configVal !== undefined) return configVal;
  // tier 3 — user-declared toolchain command
  if (userMatchCommand !== null) return userMatchCommand;
  // tier 4 — committed task-runner with a matching conventional target
  const runner = resolveTaskRunner(repoRoot, field);
  if (runner) return runner.command;
  // tier 5 — built-in registry detection (memoised by the caller so the
  // filesystem probe runs at most once across all widened fields).
  const detectedCmd = detectBuiltin()?.commands[field] ?? null;
  if (detectedCmd !== null) return detectedCmd;
  return null;
}

/**
 * Resolve the widened verification runtime for a repository.
 *
 * The legacy test/typecheck/install fields (and the returned `source`) are
 * delegated to {@link resolveTestRuntime} verbatim — same emission, same
 * aggregate-source semantics. The widened fields resolve independently per the
 * documented per-field precedence.
 */
export function resolveVerificationRuntime(
  repoRoot: string,
  options?: ResolveOptions,
): ResolvedVerificationRuntime {
  const rawOverride = options?.override;
  // Validate the widened override values with the same allowlist the legacy
  // fields use (resolveTestRuntime already validates test/typecheck/install).
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

  // Legacy three — byte-identical to resolveTestRuntime (incl. emission).
  const base = resolveTestRuntime(repoRoot, options);

  // Load config once for the widened fields (mirrors resolveTestRuntime's loader
  // seam; a throw here would already have surfaced from the base call above).
  const loadConfig = options?.loadConfig ?? loadExarchosConfig;
  const configResult = loadConfig(repoRoot);
  const config = configResult?.config;

  // tier 3 — user-declared `.exarchos.yml` toolchains, matched before built-ins.
  const userToolchains = (config?.toolchains ?? []).map(toolchainFromConfig);
  const userMatched =
    userToolchains.length > 0 ? detectToolchain(repoRoot, userToolchains) : undefined;
  const userMatch =
    userMatched && userToolchains.includes(userMatched) ? userMatched : undefined;

  // Built-in detection is filesystem-backed (existsSync/readdirSync) — memoise
  // it so the probe runs at most once across mutation + lint (LOW: it ran once
  // per field, on top of resolveTestRuntime's own detection).
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

  // Contract — structured { codegen, diff }. Per-field within the structure:
  // override leg > config leg > user-toolchain leg. The built-in registry seeds
  // null contract (artifact-keyed seeds are wired in task 022), so detection
  // contributes nothing here today.
  const contract = resolveContract(rawOverride?.contract, config?.contract, userMatch?.commands.contract ?? null);

  return {
    ...base,
    mutation,
    lint,
    contract,
  };
}

/**
 * Resolve the structured contract field, leg by leg (codegen + diff each follow
 * override > config > user-toolchain). Returns null when no leg resolves on
 * either side — the "no contract tool" signal task 022's gate degrades on.
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
