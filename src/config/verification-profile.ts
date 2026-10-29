/**
 * The resolver of the verification profile: each term that a gate runs or classifies with, read from the repository.
 * Each term takes its highest layer. The layers are a `verification:` key, a top-level key, a user toolchain, a task runner and the registry seed.
 * The seeds live in `toolchains.ts` and `task-runners.ts`, so this module holds no table of a language.
 *
 * The resolver reads the config once, and it gives that read to each resolver below it.
 * Each term stays within the bound of its schema. A value outside its bound gives an unresolved term with a reason.
 */

import { DEFAULT_FIRST_PARTY_GLOBS } from './exarchos-config-schema.js';
import { loadExarchosConfigOutcome, type ExarchosConfigOutcome } from './load-exarchos-config.js';
import { resolveTaskRunner, taskRunnerProbeRow } from './task-runners.js';
import {
  packageScriptCommand,
  resolveScopedTestCommand,
  resolveVerificationRuntime,
  type ResolvedVerificationRuntime,
} from './test-runtime-resolver.js';
import { tokenizeCommand } from './tokenize-command.js';
import {
  BUILTIN_TOOLCHAINS,
  DEFAULT_TEST_FAILURE_EXIT_CODES,
  DEFAULT_TEST_GLOBS,
  DEFAULT_TEST_SUPPORT_SEGMENTS,
  detectToolchains,
  testFailureExitCodesFor,
  toolchainFromConfig,
  type StaticAnalysisCheckName,
  type StaticAnalysisSeed,
  type Toolchain,
} from './toolchains.js';
import type { FullExarchosConfig } from './yaml-schema.js';
import {
  PROFILE_SOURCES,
  VerificationProfileSchema,
  type VerificationProfile,
} from '../workflow/verification/profile.js';

/** The layer that a resolved term comes from. */
type ProfileSource = (typeof PROFILE_SOURCES)[number];

/** A command term: a resolved argv, or an unresolved term with its reason. */
type CommandTerm = VerificationProfile['integration']['command'];

/** A term that the profile does not resolve. */
type UnresolvedTerm = Extract<CommandTerm, { state: 'unresolved' }>;

/** The probe term of the profile. */
type ProbeTerm = VerificationProfile['tests']['probe'];

/** The form in which a probe command takes its test files. */
type ProbeFileForm = ProbeTerm['files'];

/** A list of red exit codes with its source. */
type FailureExitCodes = ProbeTerm['failureExitCodes'];

/** The static-analysis term of the profile. */
type StaticAnalysisTerm = VerificationProfile['staticAnalysis'];

/** One check of a resolved static-analysis term. */
type StaticAnalysisCheck = Extract<StaticAnalysisTerm, { state: 'resolved' }>['checks'][number];

/**
 * The schema of one command term of the profile. The resolver checks each command against it.
 * Thus a command whose token leaves the safe-command class, or whose argv leaves its bound, cannot reach the profile.
 */
const COMMAND_TERM = VerificationProfileSchema.shape.integration.shape.command;

/** The schema of the `firstParty` term of the profile. The resolver checks each `ownership.firstParty` glob against it. */
const FIRST_PARTY_TERM = VerificationProfileSchema.shape.firstParty;

/** The maximum length of one reason. It is the bound of a reason of the profile schema. */
const MAX_REASON_LENGTH = 320;

/** The mark at the end of a reason that the resolver cuts to {@link MAX_REASON_LENGTH}. */
const CUT_MARK = '...';

/** The maximum number of toolchain ids in the provenance term. It is the bound of the profile schema. */
const MAX_TOOLCHAIN_IDS = 16;

/** The maximum number of tokens in one argv. It is the bound of the profile schema. */
const MAX_ARGV_TOKENS = 64;

/** The maximum number of `ownership.firstParty` globs. It is the bound of the profile schema. */
const MAX_FIRST_PARTY_GLOBS = 64;

/** The static-analysis checks that a layer other than the `verification.staticAnalysis` block can set. */
const CHECK_NAMES: readonly StaticAnalysisCheckName[] = ['lint', 'typecheck'];

/** The options of {@link resolveVerificationProfile}. */
export interface ResolveProfileOptions {
  /**
   * The config loader. The default is `loadExarchosConfigOutcome`, which can spawn git to find the repository root.
   * A call that passes a loader spawns nothing.
   */
  readonly loadConfig?: (worktreePath: string) => ExarchosConfigOutcome;
}

/** What the resolver knows about the root: the config, the matched toolchains and the user toolchain that matches first. */
interface ProfileContext {
  readonly checkout: string;
  readonly config: FullExarchosConfig | undefined;
  /** Each matched toolchain in priority order, user entries first. */
  readonly matched: readonly Toolchain[];
  /** Each matched built-in toolchain in priority order. */
  readonly builtins: readonly Toolchain[];
  readonly userMatch: Toolchain | undefined;
  /** True when more than one built-in toolchain matches at the root. */
  readonly polyglot: boolean;
}

/** One command string, the layer that it comes from, and the key that a reason names for it. */
interface CommandOrigin {
  readonly command: string;
  readonly source: ProfileSource;
  readonly key: string;
}

/**
 * The seed row of a probe command: the built-in toolchain or the task runner whose program is the first token of the command.
 * A command whose program has no row gets `none`.
 */
type SeedRow =
  | { readonly kind: 'toolchain'; readonly toolchain: Toolchain }
  | { readonly kind: 'task-runner'; readonly files: ProbeFileForm; readonly codes: readonly number[] }
  | { readonly kind: 'none' };

/**
 * Resolves the verification profile of `checkout`. Each term resolves on its own, highest layer first.
 * The config is read once through `options.loadConfig`. A config that does not load gives each command term and each glob term unresolved,
 * and each such reason holds the load error.
 */
export function resolveVerificationProfile(checkout: string, options?: ResolveProfileOptions): VerificationProfile {
  const loadConfig = options?.loadConfig ?? loadExarchosConfigOutcome;
  const outcome = loadConfig(checkout);
  const loaded = outcome.kind === 'loaded' ? outcome.result : null;
  const runtime = resolveVerificationRuntime(checkout, { loadConfig: () => loaded });
  const scopedTest = resolveScopedTestCommand(checkout, { loadConfig: () => loaded });
  const profile = profileOf(contextOf(checkout, loaded?.config), runtime, scopedTest?.command ?? null);
  return outcome.kind === 'invalid' ? withLoadError(profile, outcome.message) : profile;
}

/**
 * The static-analysis term that a root gives with no config: its task-runner targets, then the seeds of its first built-in toolchain.
 * It reads files only, so it spawns nothing. A gate function that gets no term from its caller takes this term.
 */
export function staticAnalysisSeedsAt(root: string): StaticAnalysisTerm {
  return staticAnalysisTerm(contextOf(root, undefined));
}

/**
 * The argv of one probe run. `after-separator` puts the files after `--`, `as-arguments` puts them after the argv,
 * and `none` gives the argv with no file.
 */
export function probeArgv(form: ProbeFileForm, argv: readonly string[], files: readonly string[]): string[] {
  switch (form) {
    case 'after-separator':
      return [...argv, '--', ...files];
    case 'as-arguments':
      return [...argv, ...files];
    case 'none':
      return [...argv];
  }
}

/**
 * True when `glob` names a test by the name of its file: its last segment holds a `*` and is not `**`.
 * So a glob that ends in `*.test.*`, `*Tests.cs` or `test_*.py` is a test-name glob. `tests/**` and a glob that ends in `conftest.py` are not.
 * The rule reads only the shape of a glob, so it holds no fact of a language.
 */
export function isTestNameGlob(glob: string): boolean {
  const last = glob.split('/').pop() ?? '';
  return last.includes('*') && last !== '**';
}

/**
 * True when a test-name glob of `globs` matches the repo-relative path `file`. Each other glob of `globs` is ignored.
 * A `*` at the end of the last segment matches no `.`, so it matches one extension. Thus a glob that ends in `*.test.*` does not match `a.test.ts.snap`.
 */
export function matchesTestName(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => isTestNameGlob(glob) && testNameRegExp(glob).test(file));
}

/**
 * Translates one test-name glob into a RegExp that is anchored to the whole path.
 * `**` followed by `/` matches any number of directories, and `*` matches a run of characters that holds no `/`.
 * A `*` at the end of the glob also matches no `.`. Each other character matches itself.
 */
function testNameRegExp(glob: string): RegExp {
  const finalStar = glob.endsWith('*') ? glob.length - 1 : -1;
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? '';
    if (ch === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (ch === '*') {
      out += i === finalStar ? '[^/.]*' : '[^/]*';
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/** The context of a root: the user toolchains of `config`, each matched toolchain, and the built-in toolchains among them. */
function contextOf(checkout: string, config: FullExarchosConfig | undefined): ProfileContext {
  const userToolchains = (config?.toolchains ?? []).map(toolchainFromConfig);
  const matched = detectToolchains(checkout, userToolchains);
  const builtins = matched.filter((toolchain) => BUILTIN_TOOLCHAINS.includes(toolchain));
  const first = matched[0];
  const userMatch = first !== undefined && userToolchains.includes(first) ? first : undefined;
  return { checkout, config, matched, builtins, userMatch, polyglot: builtins.length > 1 };
}

/**
 * Builds each term of the profile from the context and the commands of the resolvers below.
 * The profile pins no boundary check yet. The boundary adapters still live in the static-analysis gate.
 */
function profileOf(
  ctx: ProfileContext,
  runtime: ResolvedVerificationRuntime,
  scopedTest: string | null,
): VerificationProfile {
  return {
    toolchains: ctx.matched.slice(0, MAX_TOOLCHAIN_IDS).map((toolchain) => toolchain.id),
    tests: {
      globs: testGlobsTerm(ctx),
      support: testSupportTerm(ctx),
      probe: probeTerm(ctx, runtime, scopedTest),
    },
    staticAnalysis: staticAnalysisTerm(ctx),
    integration: integrationTerm(ctx, runtime),
    contract: contractTerm(ctx, runtime),
    boundaryChecks: [],
    firstParty: firstPartyTerm(ctx),
  };
}

/**
 * The profile of a config that does not load. Each command term and each glob term is unresolved, and each reason holds the load error.
 * The test-support segments and the file forms keep their seeds, because they have no unresolved state.
 */
function withLoadError(profile: VerificationProfile, message: string): VerificationProfile {
  const term = (path: string): UnresolvedTerm =>
    unresolved(path, `.exarchos.yml does not load, so its keys cannot be read. Fix the file. ${message}`);
  return {
    ...profile,
    tests: {
      ...profile.tests,
      globs: term('tests.globs'),
      probe: { ...profile.tests.probe, command: term('tests.probe.command') },
    },
    staticAnalysis: term('staticAnalysis'),
    integration: { ...profile.integration, command: term('integration.command') },
    contract: { codegen: term('contract.codegen'), diff: term('contract.diff'), typecheck: term('contract.typecheck') },
    firstParty: term('firstParty'),
  };
}

/**
 * An unresolved term whose reason is `<term path>: <remediation>`. A reason past its bound is cut, and it ends with `...`.
 * The path and the remediation come first, so the cut removes only the end of a load error.
 */
function unresolved(path: string, remediation: string): UnresolvedTerm {
  const reason = `${path}: ${remediation}`;
  if (reason.length <= MAX_REASON_LENGTH) return { state: 'unresolved', reason };
  return { state: 'unresolved', reason: `${reason.slice(0, MAX_REASON_LENGTH - CUT_MARK.length)}${CUT_MARK}` };
}

/** The tokens of a command string, or undefined when the string does not split. */
function argvOf(command: string): readonly string[] | undefined {
  try {
    return tokenizeCommand(command);
  } catch {
    return undefined;
  }
}

/**
 * The command term of one command string. Its argv must fit the command term of the profile schema.
 * A string that does not split, or whose argv does not fit, gives an unresolved term that names the key of the string.
 */
function commandTerm(path: string, origin: CommandOrigin): CommandTerm {
  let argv: readonly string[];
  try {
    argv = tokenizeCommand(origin.command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unresolved(path, `the command of ${origin.key} does not split into tokens. Fix the command. ${message}`);
  }
  const parsed = COMMAND_TERM.safeParse({ state: 'resolved', argv: [...argv], source: origin.source });
  if (parsed.success) return parsed.data;
  if (argv.length > MAX_ARGV_TOKENS) {
    return unresolved(
      path,
      `the command of ${origin.key} has ${argv.length} tokens, more than the bound of ${MAX_ARGV_TOKENS}. Shorten the command.`,
    );
  }
  if (argv.length === 0) return unresolved(path, `the command of ${origin.key} is empty. Set a command there.`);
  return unresolved(path, `a token of the command of ${origin.key} is outside the safe-command class. Fix the command.`);
}

/**
 * The command of `field` from the first layer that sets it: the top-level key, the user toolchain, then the task-runner target.
 * It returns undefined when no such layer sets it, and the caller then takes the seed.
 */
function layeredCommand(ctx: ProfileContext, field: 'test' | StaticAnalysisCheckName): CommandOrigin | undefined {
  const configured = ctx.config?.[field];
  if (configured !== undefined) return { command: configured, source: 'config', key: `${field}:` };
  const user = ctx.userMatch?.commands[field] ?? null;
  if (user !== null && ctx.userMatch !== undefined) {
    return { command: user, source: 'toolchain-config', key: `toolchains[${ctx.userMatch.id}].commands.${field}` };
  }
  const runner = resolveTaskRunner(ctx.checkout, field);
  if (runner !== undefined) {
    return { command: runner.command, source: 'task-runner', key: `the ${runner.runner} target ${runner.target}` };
  }
  return undefined;
}

/** The origin of a command that a resolver below gives for `field`: the layer that sets the field, else the registry seed. */
function fieldOrigin(ctx: ProfileContext, field: 'test' | 'typecheck', command: string): CommandOrigin {
  const layer = layeredCommand(ctx, field);
  return { command, source: layer?.source ?? 'detection', key: layer?.key ?? `the detected ${field} command` };
}

/** The programs of the test commands of a row: its declared programs, else the first token of its `test` command. */
function programsOf(toolchain: Toolchain): readonly string[] {
  if (toolchain.testPrograms !== undefined) return toolchain.testPrograms;
  const program = toolchain.commands.test === null ? undefined : argvOf(toolchain.commands.test)?.[0];
  return program === undefined ? [] : [program];
}

/** The seed row of a command by its program. A built-in toolchain comes before a task runner. */
function seedRowOf(argv: readonly string[] | undefined): SeedRow {
  const program = argv?.[0];
  if (program === undefined) return { kind: 'none' };
  const toolchain = BUILTIN_TOOLCHAINS.find((candidate) => programsOf(candidate).includes(program));
  if (toolchain !== undefined) return { kind: 'toolchain', toolchain };
  const runner = taskRunnerProbeRow(program);
  if (runner !== undefined) return { kind: 'task-runner', files: runner.files, codes: runner.testFailureExitCodes };
  return { kind: 'none' };
}

/** The file form of a command from its seed row. A command of no row takes `after-separator`. */
function fileFormOf(row: SeedRow, argv: readonly string[]): ProbeFileForm {
  if (row.kind === 'task-runner') return row.files;
  if (row.kind === 'none') return 'after-separator';
  const exception = row.toolchain.probeFileExceptions?.find((entry) =>
    entry.argv.every((token, index) => argv[index] === token),
  );
  return exception?.files ?? row.toolchain.probeFiles ?? 'after-separator';
}

/** The red exit codes of a command from its seed row. A command of no row reads only exit 1 as red. */
function failureCodesOf(row: SeedRow): FailureExitCodes {
  if (row.kind === 'task-runner') return { codes: [...row.codes], source: 'task-runner' };
  const codes = row.kind === 'toolchain' ? testFailureExitCodesFor(row.toolchain) : DEFAULT_TEST_FAILURE_EXIT_CODES;
  return { codes: [...codes], source: 'detection' };
}

/**
 * The globs of the test files that a probe command runs. A toolchain row gives its own glob row, also when it does not match at the root.
 * A task-runner row and a command of no row take the glob row of the first matched built-in toolchain.
 * A toolchain with no glob row, and a root where no built-in toolchain matches, give the co-located globs.
 */
function probeGlobsOf(row: SeedRow, ctx: ProfileContext): string[] {
  const toolchain = row.kind === 'toolchain' ? row.toolchain : ctx.builtins[0];
  return [...(toolchain?.testGlobs ?? DEFAULT_TEST_GLOBS)];
}

/**
 * The seeded test globs. They are the co-located globs and each glob of the first matched built-in toolchain.
 * From each other matched built-in toolchain they take only the test-name globs. They are deduplicated, co-located first.
 */
function seededTestGlobs(builtins: readonly Toolchain[]): string[] {
  const [first, ...others] = builtins;
  const globs = [
    ...DEFAULT_TEST_GLOBS,
    ...(first?.testGlobs ?? []),
    ...others.flatMap((toolchain) => (toolchain.testGlobs ?? []).filter(isTestNameGlob)),
  ];
  return [...new Set(globs)];
}

/**
 * The test-glob term. `verification.tests.globs` replaces every seed, and an empty list is unresolved.
 * In a root where more than one built-in toolchain matches, the configured term keeps the test-name globs of the seeds as `replacedSeeds`.
 */
function testGlobsTerm(ctx: ProfileContext): VerificationProfile['tests']['globs'] {
  const seeds = seededTestGlobs(ctx.builtins);
  const configured = ctx.config?.verification?.tests?.globs;
  if (configured === undefined) return { state: 'resolved', globs: seeds, source: 'detection' };
  if (configured.length === 0) {
    return unresolved(
      'tests.globs',
      'verification.tests.globs is empty, so no changed file is a test. Set at least one glob, or remove the key to use the seeds.',
    );
  }
  const replacedSeeds = ctx.polyglot ? seeds.filter(isTestNameGlob) : [];
  return {
    state: 'resolved',
    globs: [...configured],
    source: 'config',
    ...(replacedSeeds.length > 0 ? { replacedSeeds } : {}),
  };
}

/** The test-support term. `verification.tests.support` replaces the seeded segments. */
function testSupportTerm(ctx: ProfileContext): VerificationProfile['tests']['support'] {
  const configured = ctx.config?.verification?.tests?.support;
  if (configured === undefined) return { segments: [...DEFAULT_TEST_SUPPORT_SEGMENTS], source: 'detection' };
  return { segments: [...configured], source: 'config' };
}

/**
 * The origin of the seeded probe command. The `test:files` script of `resolveScopedTestCommand` is a registry seed.
 * Each other command is the `test` field, from the layer that sets it.
 */
function seededProbeOrigin(
  ctx: ProfileContext,
  runtime: ResolvedVerificationRuntime,
  scopedTest: string | null,
): CommandOrigin | undefined {
  if (scopedTest === null) return undefined;
  if (scopedTest !== runtime.test) return { command: scopedTest, source: 'detection', key: 'the test:files script' };
  return fieldOrigin(ctx, 'test', scopedTest);
}

/** The remediation of a term that needs a test command when none resolves. It ends with the remediation of the resolver. */
function noTestCommand(key: string, runtime: ResolvedVerificationRuntime): string {
  return `no test command resolves at the checkout. Set ${key} or test:. ${runtime.remediation ?? ''}`.trimEnd();
}

/**
 * The probe term. `verification.tests.probe` replaces the seed. Each field that no key sets comes from the seed row of the program.
 * In a root where more than one built-in toolchain matches, a configured probe needs `verification.tests.globs`, else it is unresolved.
 * With configured test globs, the probe has no globs of its own, so it runs each file of the test globs.
 */
function probeTerm(ctx: ProfileContext, runtime: ResolvedVerificationRuntime, scopedTest: string | null): ProbeTerm {
  const configured = ctx.config?.verification?.tests?.probe;
  const configuredGlobs = ctx.config?.verification?.tests?.globs !== undefined;
  const origin: CommandOrigin | undefined =
    configured === undefined
      ? seededProbeOrigin(ctx, runtime, scopedTest)
      : { command: configured.command, source: 'config', key: 'verification.tests.probe.command' };
  const argv = origin === undefined ? undefined : argvOf(origin.command);
  const row = seedRowOf(argv);
  let command: CommandTerm;
  if (origin === undefined) {
    command = unresolved('tests.probe.command', noTestCommand('verification.tests.probe.command', runtime));
  } else if (configured !== undefined && ctx.polyglot && !configuredGlobs) {
    command = unresolved(
      'tests.probe.command',
      'in a root where more than one toolchain matches, verification.tests.probe needs verification.tests.globs beside it. ' +
        'Set verification.tests.globs to the test files that the probe command runs. One probe for each toolchain is #1629.',
    );
  } else {
    command = commandTerm('tests.probe.command', origin);
  }
  const files = configured?.files ?? fileFormOf(row, argv ?? []);
  const failureExitCodes: FailureExitCodes =
    configured?.failureExitCodes === undefined
      ? failureCodesOf(row)
      : { codes: [...configured.failureExitCodes], source: 'config' };
  if (configuredGlobs) return { command, files, failureExitCodes };
  return { command, files, failureExitCodes, globs: probeGlobsOf(row, ctx) };
}

/**
 * The integration term. `verification.integration` replaces the seed. Else the term is the resolved `test` command,
 * with the `exit-code` report and the red codes of the seed row of its program.
 */
function integrationTerm(ctx: ProfileContext, runtime: ResolvedVerificationRuntime): VerificationProfile['integration'] {
  const configured = ctx.config?.verification?.integration;
  let origin: CommandOrigin | undefined;
  if (configured !== undefined) {
    origin = { command: configured.command, source: 'config', key: 'verification.integration.command' };
  } else if (runtime.test !== null) {
    origin = fieldOrigin(ctx, 'test', runtime.test);
  }
  const command =
    origin === undefined
      ? unresolved('integration.command', noTestCommand('verification.integration.command', runtime))
      : commandTerm('integration.command', origin);
  const failureExitCodes: FailureExitCodes =
    configured?.failureExitCodes === undefined
      ? failureCodesOf(seedRowOf(origin === undefined ? undefined : argvOf(origin.command)))
      : { codes: [...configured.failureExitCodes], source: 'config' };
  return { command, report: configured?.report ?? 'exit-code', failureExitCodes };
}

/** The command of one seeded check. A package-script seed whose script is absent is an unresolved check that names its keys. */
function seedCheckCommand(checkout: string, seed: StaticAnalysisSeed): CommandTerm {
  const path = `staticAnalysis.${seed.name}`;
  if ('command' in seed) return commandTerm(path, { command: seed.command, source: 'detection', key: `the ${seed.name} seed` });
  const command = packageScriptCommand(checkout, seed.packageScript);
  if (command === null) {
    return unresolved(
      path,
      `no '${seed.packageScript}' script in package.json. Add the script, or set verification.staticAnalysis.${seed.name} or the top-level ${seed.name}: key.`,
    );
  }
  return commandTerm(path, { command, source: 'detection', key: `the ${seed.packageScript} script` });
}

/**
 * The static-analysis term. `verification.staticAnalysis` replaces every seed, in key order, and `{}` is unresolved.
 * Else each of `lint` and `typecheck` comes from its highest layer: the top-level key, the user toolchain, the task-runner target, then the seed.
 * The seed order of the first matched built-in toolchain comes first. A name that no layer sets is no check.
 */
function staticAnalysisTerm(ctx: ProfileContext): StaticAnalysisTerm {
  const block = ctx.config?.verification?.staticAnalysis;
  if (block !== undefined) {
    const configured = Object.entries(block).map(([name, command]) => ({
      name,
      command: commandTerm(`staticAnalysis.${name}`, { command, source: 'config', key: `verification.staticAnalysis.${name}` }),
    }));
    if (configured.length === 0) {
      return unresolved(
        'staticAnalysis',
        'verification.staticAnalysis is empty, so no check runs. Add a check, or remove the block to use the seeds.',
      );
    }
    return { state: 'resolved', checks: configured, source: 'config' };
  }
  const seeds = ctx.builtins[0]?.staticAnalysisSeeds ?? [];
  const seededNames = seeds.map((seed) => seed.name);
  const order = [...seededNames, ...CHECK_NAMES.filter((name) => !seededNames.includes(name))];
  const checks: StaticAnalysisCheck[] = [];
  const sources: ProfileSource[] = [];
  for (const name of order) {
    const layer = layeredCommand(ctx, name);
    const seed = seeds.find((candidate) => candidate.name === name);
    if (layer !== undefined) {
      checks.push({ name, command: commandTerm(`staticAnalysis.${name}`, layer) });
      sources.push(layer.source);
    } else if (seed !== undefined) {
      checks.push({ name, command: seedCheckCommand(ctx.checkout, seed) });
      sources.push('detection');
    }
  }
  if (checks.length === 0) {
    return unresolved(
      'staticAnalysis',
      'no layer sets a lint or typecheck check. Set verification.staticAnalysis, or the top-level lint: or typecheck: key.',
    );
  }
  return { state: 'resolved', checks, source: PROFILE_SOURCES.find((source) => sources.includes(source)) ?? 'detection' };
}

/** The contract term: the contract commands and the `typecheck` of `resolveVerificationRuntime`. */
function contractTerm(ctx: ProfileContext, runtime: ResolvedVerificationRuntime): VerificationProfile['contract'] {
  const leg = (name: 'codegen' | 'diff'): CommandTerm => {
    const command = runtime.contract?.[name] ?? null;
    if (command === null) return unresolved(`contract.${name}`, `no contract command resolves. Set contract.${name} in .exarchos.yml.`);
    const configured = ctx.config?.contract?.[name] !== undefined;
    return commandTerm(`contract.${name}`, {
      command,
      source: configured ? 'config' : 'toolchain-config',
      key: configured ? `contract.${name}` : `the toolchain contract.${name}`,
    });
  };
  const typecheck =
    runtime.typecheck === null
      ? unresolved('contract.typecheck', 'no typecheck command resolves. Set typecheck: in .exarchos.yml.')
      : commandTerm('contract.typecheck', fieldOrigin(ctx, 'typecheck', runtime.typecheck));
  return { codegen: leg('codegen'), diff: leg('diff'), typecheck };
}

/**
 * The `firstParty` term from `ownership.firstParty`. `[]` resolves to no glob.
 * More than 64 globs, or a glob that is not a relative path with no `..` segment, gives an unresolved term.
 */
function firstPartyTerm(ctx: ProfileContext): VerificationProfile['firstParty'] {
  const globs = ctx.config?.ownership.firstParty ?? DEFAULT_FIRST_PARTY_GLOBS;
  const isDefault = globs.length === DEFAULT_FIRST_PARTY_GLOBS.length && globs.every((glob, i) => glob === DEFAULT_FIRST_PARTY_GLOBS[i]);
  const source: ProfileSource = ctx.config !== undefined && !isDefault ? 'config' : 'detection';
  if (globs.length > MAX_FIRST_PARTY_GLOBS) {
    return unresolved(
      'firstParty',
      `ownership.firstParty holds ${globs.length} globs, more than the bound of ${MAX_FIRST_PARTY_GLOBS}. Keep at most ${MAX_FIRST_PARTY_GLOBS} globs.`,
    );
  }
  const outside = globs.find((glob) => !FIRST_PARTY_TERM.safeParse({ state: 'resolved', globs: [glob], source }).success);
  if (outside !== undefined) {
    return unresolved(
      'firstParty',
      `ownership.firstParty holds the glob '${outside}', which leaves the root. Each glob is a relative path with no '..' segment.`,
    );
  }
  return { state: 'resolved', globs: [...globs], source };
}
