/**
 * The registry of toolchain identity: the file markers that detect a toolchain, its `projectType` label, and its resolver commands.
 * Detection lives only here. The resolver and static analysis share detection, but each keeps its own commands.
 * The node entry holds the npm baseline. The resolver selects the package-manager commands from the vendored lockfile table.
 *
 * Each row also seeds the verification profile: its test globs, its probe file form and its static-analysis checks.
 * The module also holds the co-located test globs, the test-support segments, the mutation diff-scope table and the hermetic doubles.
 */

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';
import type { VerificationProfile } from '../workflow/verification/profile.js';

/** The form in which a probe command takes its test files. */
type ProbeFileForm = VerificationProfile['tests']['probe']['files'];

/** The name of a static-analysis check that a registry row can seed. */
export type StaticAnalysisCheckName = 'lint' | 'typecheck';

/**
 * One static-analysis check that a registry row seeds. `command` is the command of the check.
 * `packageScript` names a package script, which the resolver runs with the package manager of the root.
 */
export type StaticAnalysisSeed =
  | { readonly name: StaticAnalysisCheckName; readonly command: string }
  | { readonly name: StaticAnalysisCheckName; readonly packageScript: string };

/** A probe file form for each test command that starts with `argv`. It replaces the file form of the row for that command. */
export interface ProbeFileException {
  readonly argv: readonly string[];
  readonly files: ProbeFileForm;
}

/**
 * The contract commands for a schema boundary. `codegen` regenerates the bindings from the schema artifact. `diff` checks for breaking changes against the baseline.
 * Each one can be null, because the resolver can attach only one of them.
 */
export interface ContractCommands {
  readonly codegen: string | null;
  readonly diff: string | null;
}

/** Resolver-canonical commands for a toolchain. Mirrors ResolvedRuntime fields. */
export interface ToolchainCommands {
  readonly test: string | null;
  readonly typecheck: string | null;
  readonly install: string | null;
  /** The mutation-testing runner, for example `cargo mutants --in-diff`. */
  readonly mutation: string | null;
  /** The lint command, for example `cargo clippy`. */
  readonly lint: string | null;
  /**
   * The contract commands. Every built-in toolchain has `null`, because contracts are keyed on schema artifacts such as proto, OpenAPI or GraphQL, not on the language.
   */
  readonly contract: ContractCommands | null;
}

export interface Toolchain {
  /** Stable id (`node`, `dotnet`, `rust`, …). */
  readonly id: string;
  /** Human label surfaced by static-analysis (`Node.js`, `.NET`, `Rust`, …). */
  readonly projectType: string;
  /**
   * Detection markers. Each is an exact root filename (`package.json`, `go.mod`)
   * or an extension glob (`*.csproj`). A toolchain matches if ANY marker is present.
   * Cross-toolchain priority is the order of {@link BUILTIN_TOOLCHAINS}.
   */
  readonly markers: readonly string[];
  /** Resolver-canonical commands (test-runner perspective). */
  readonly commands: ToolchainCommands;
  /**
   * The exit codes of a test run with a failing test, or with a test that does not load after a compile or import error.
   * An absent field means {@link DEFAULT_TEST_FAILURE_EXIT_CODES}. Set the field for each runner that uses a different code.
   * The kill probe reads exit 0 as green, these codes as red, and every other end of a run as no verdict.
   *
   * Only the built-in registry sets the field. A `.exarchos.yml` toolchain entry has no key for it, so it gets the default.
   */
  readonly testFailureExitCodes?: readonly number[];
  /**
   * The test-file globs of the toolchain, for an ecosystem that does not use the co-located `*.test.*` layout.
   * An absent field means that the toolchain uses the co-located globs. Only the built-in registry sets the field.
   */
  readonly testGlobs?: readonly string[];
  /**
   * The programs of the test commands of the row. The resolver finds the seed row of a probe command by its first token.
   * An absent field means the first token of the `test` command of the row.
   */
  readonly testPrograms?: readonly string[];
  /** The form in which the test command of the row takes the test files. An absent field means `after-separator`. */
  readonly probeFiles?: ProbeFileForm;
  /** The file forms of the test commands of the row that do not take the form of the row. */
  readonly probeFileExceptions?: readonly ProbeFileException[];
  /** The static-analysis checks that the row seeds, in the order that they run. An absent field seeds no check. */
  readonly staticAnalysisSeeds?: readonly StaticAnalysisSeed[];
}

/** The exit codes of a failing test run when the toolchain sets none, or when no toolchain is known. */
export const DEFAULT_TEST_FAILURE_EXIT_CODES: readonly number[] = [1];

/** Returns the exit codes of a failing test run for a toolchain. No toolchain, or no field, gives {@link DEFAULT_TEST_FAILURE_EXIT_CODES}. */
export function testFailureExitCodesFor(toolchain: Toolchain | undefined): readonly number[] {
  return toolchain?.testFailureExitCodes ?? DEFAULT_TEST_FAILURE_EXIT_CODES;
}

/**
 * The built-in toolchains in priority order. `node` is first, so `package.json` wins over other markers.
 * The node commands are a baseline. Node `lint` is null, because each repo picks its own linter script.
 */
export const BUILTIN_TOOLCHAINS: readonly Toolchain[] = [
  {
    id: 'node',
    projectType: 'Node.js',
    markers: ['package.json'],
    commands: {
      test: 'npm run test:run',
      typecheck: 'tsc --noEmit',
      install: 'npm install',
      mutation: 'npx stryker run',
      lint: null,
      contract: null,
    },
    testPrograms: ['npm', 'pnpm', 'yarn', 'bun'],
    probeFiles: 'after-separator',
    /** `bun test` is the Bun runner. It takes the test files as arguments, with no separator. */
    probeFileExceptions: [{ argv: ['bun', 'test'], files: 'as-arguments' }],
    staticAnalysisSeeds: [
      { name: 'lint', packageScript: 'lint' },
      { name: 'typecheck', packageScript: 'typecheck' },
    ],
  },
  {
    id: 'dotnet',
    projectType: '.NET',
    markers: ['*.csproj', '*.sln', '*.slnx'],
    commands: {
      test: 'dotnet test',
      typecheck: null,
      install: null,
      mutation: 'dotnet stryker',
      lint: null,
      contract: null,
    },
    /**
     * `dotnet test` exits 1 when the build fails or when a VSTest run has a failing test.
     * A Microsoft.Testing.Platform run exits 2 when a test fails.
     */
    testFailureExitCodes: [1, 2],
    testGlobs: ['**/*Tests/**', '**/*.Tests/**', '**/*Tests.cs', '**/*Test.cs'],
    /** On Microsoft.Testing.Platform, `dotnet test -- <file>` reads no path filter. So the probe runs the whole command. */
    probeFiles: 'none',
    /** The project decides its strictness. A repository that wants `--no-restore -warnaserror` sets them in `typecheck:`. */
    staticAnalysisSeeds: [{ name: 'typecheck', command: 'dotnet build' }],
  },
  {
    id: 'rust',
    projectType: 'Rust',
    markers: ['Cargo.toml'],
    commands: {
      test: 'cargo test',
      typecheck: null,
      install: null,
      mutation: 'cargo mutants --in-diff',
      lint: 'cargo clippy',
      contract: null,
    },
    /** `cargo test` exits 101 when a test fails. */
    testFailureExitCodes: [101],
    testGlobs: ['tests/**'],
    /** `cargo test -- <path>` reads each path as a name filter, so the probe runs the whole command. */
    probeFiles: 'none',
    staticAnalysisSeeds: [
      { name: 'typecheck', command: 'cargo check' },
      { name: 'lint', command: 'cargo clippy' },
    ],
  },
  {
    id: 'go',
    projectType: 'Go',
    markers: ['go.mod'],
    commands: {
      test: 'go test ./...',
      typecheck: null,
      install: null,
      mutation: null,
      lint: 'go vet ./...',
      contract: null,
    },
    testGlobs: ['**/*_test.go'],
    probeFiles: 'none',
    staticAnalysisSeeds: [{ name: 'lint', command: 'go vet ./...' }],
  },
  {
    id: 'python',
    projectType: 'Python',
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'tox.ini'],
    commands: {
      test: 'pytest',
      typecheck: null,
      install: null,
      mutation: 'mutmut run',
      lint: 'ruff check',
      contract: null,
    },
    /**
     * `pytest` exits 1 when a test fails, and 2 when a test module does not import, such as after the revert removes a function.
     * Exit 2 also follows an interrupt, and the probe sends none. A `conftest.py` that does not import exits 4, which gives no verdict.
     */
    testFailureExitCodes: [1, 2],
    testGlobs: ['tests/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'],
    probeFiles: 'after-separator',
    staticAnalysisSeeds: [{ name: 'lint', command: 'ruff check' }],
  },
  {
    id: 'java-gradle',
    projectType: 'Java',
    markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    commands: {
      test: './gradlew test',
      typecheck: null,
      install: null,
      mutation: './gradlew pitest',
      lint: null,
      contract: null,
    },
    testGlobs: ['src/test/**', '**/src/test/**'],
    probeFiles: 'none',
  },
  {
    id: 'java-maven',
    projectType: 'Java',
    markers: ['pom.xml'],
    commands: {
      test: 'mvn test',
      typecheck: null,
      install: null,
      mutation: 'mvn org.pitest:pitest-maven:mutationCoverage',
      lint: null,
      contract: null,
    },
    testGlobs: ['src/test/**', '**/src/test/**'],
    probeFiles: 'none',
  },
  {
    id: 'ruby',
    projectType: 'Ruby',
    markers: ['Gemfile'],
    commands: {
      test: 'bundle exec rake test',
      typecheck: null,
      install: null,
      mutation: 'bundle exec mutant run',
      lint: 'bundle exec rubocop',
      contract: null,
    },
    testGlobs: ['spec/**', 'test/**'],
    /** rake reads each argument after `--` as a task name, so the probe runs the whole command. */
    probeFiles: 'none',
    staticAnalysisSeeds: [{ name: 'lint', command: 'bundle exec rubocop' }],
  },
  {
    id: 'php',
    projectType: 'PHP',
    markers: ['composer.json'],
    commands: {
      test: 'composer test',
      typecheck: null,
      install: null,
      mutation: 'vendor/bin/infection',
      lint: null,
      contract: null,
    },
    /**
     * PHPUnit exits 1 when a test fails, and 2 when a test has an error, such as a call to a removed function.
     * Composer passes the exit code of the `test` script through.
     */
    testFailureExitCodes: [1, 2],
    testGlobs: ['tests/**', '**/*Test.php'],
    probeFiles: 'after-separator',
  },
  {
    id: 'elixir',
    projectType: 'Elixir',
    markers: ['mix.exs'],
    commands: {
      test: 'mix test',
      typecheck: null,
      install: null,
      mutation: 'mix muzak',
      lint: 'mix credo',
      contract: null,
    },
    /** `mix test` exits 2 when a test fails, which is the default of `--exit-status`. A compile error exits 1. */
    testFailureExitCodes: [1, 2],
    testGlobs: ['test/**'],
    probeFiles: 'as-arguments',
    staticAnalysisSeeds: [{ name: 'lint', command: 'mix credo' }],
  },
  {
    id: 'swift',
    projectType: 'Swift',
    markers: ['Package.swift'],
    commands: {
      test: 'swift test',
      typecheck: null,
      install: null,
      mutation: null,
      lint: null,
      contract: null,
    },
    testGlobs: ['Tests/**'],
    probeFiles: 'none',
  },
  {
    id: 'cmake',
    projectType: 'C/C++',
    markers: ['CMakeLists.txt'],
    commands: {
      test: 'ctest',
      typecheck: null,
      install: null,
      mutation: null,
      lint: null,
      contract: null,
    },
    /** `ctest` exits 8 when a test fails or does not run. */
    testFailureExitCodes: [8],
    /** `ctest -- <files>` can give a green run that tests nothing, so the probe runs the whole command. */
    probeFiles: 'none',
  },
];

/**
 * The co-located test globs: `*.test.*`, `*.spec.*`, and each file under a `__tests__/` directory.
 * Each matches the whole repo-relative path. Every root takes them, also beside the globs of a toolchain.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
];

/**
 * The directory names that mark test support, such as a helper, a mock or a fixture.
 * A changed file that is not a test file and has a directory segment with one of these names is test support.
 * The probe does not revert test support. A reverted helper can make a test fail to load, and such a red run proves no kill.
 *
 * The table is a deliberate subset of the names that projects use for test support, such as `testdata` or `spec`.
 * Each name keeps more files out of the revert, so the owner chose a short table. `verification.tests.support` replaces it.
 */
export const DEFAULT_TEST_SUPPORT_SEGMENTS: readonly string[] = [
  'tests',
  'test',
  '__tests__',
  '__mocks__',
  '__fixtures__',
  'fixtures',
  'test-helpers',
];

/** Shape of a `.exarchos.yml` `toolchains:` entry (see exarchos-config-schema). */
export interface ConfigToolchain {
  readonly id: string;
  readonly projectType?: string | undefined;
  readonly markers: readonly string[];
  readonly commands: {
    readonly test?: string | undefined;
    readonly typecheck?: string | undefined;
    readonly install?: string | undefined;
    readonly mutation?: string | undefined;
    readonly lint?: string | undefined;
    readonly contract?: {
      readonly codegen?: string | undefined;
      readonly diff?: string | undefined;
    } | undefined;
  };
}

/**
 * Converts a `.exarchos.yml` toolchain entry into a {@link Toolchain}. `projectType` defaults to the id, and an absent command becomes `null`.
 * Pass the result as the `extra` argument of {@link detectToolchain}, so user entries match before the built-ins.
 */
export function toolchainFromConfig(entry: ConfigToolchain): Toolchain {
  const contract = entry.commands.contract;
  return {
    id: entry.id,
    projectType: entry.projectType ?? entry.id,
    markers: [...entry.markers],
    commands: {
      test: entry.commands.test ?? null,
      typecheck: entry.commands.typecheck ?? null,
      install: entry.commands.install ?? null,
      mutation: entry.commands.mutation ?? null,
      lint: entry.commands.lint ?? null,
      contract:
        contract === undefined
          ? null
          : {
              codegen: contract.codegen ?? null,
              diff: contract.diff ?? null,
            },
    },
  };
}

/**
 * Returns true when a marker is present. An extension glob (`*.csproj`) needs the directory listing.
 * An exact filename uses `existsSync`, which is the access pattern that the fs mocks of callers expect.
 */
function markerMatches(
  marker: string,
  repoRoot: string,
  listDir: () => readonly string[] | null,
): boolean {
  if (marker.startsWith('*.')) {
    const entries = listDir();
    if (!entries) return false;
    const ext = marker.slice(1);
    return entries.some((e) => e.endsWith(ext));
  }
  return existsSync(toPosix(path.join(repoRoot, marker)));
}

/**
 * Returns at most `limit` toolchains whose markers match at the repo root, in priority order, user entries first.
 * It lists the directory once, and only when it evaluates an extension-glob marker.
 */
function matchToolchains(repoRoot: string, extra: readonly Toolchain[], limit: number): Toolchain[] {
  let cached: readonly string[] | null | undefined;
  const listDir = (): readonly string[] | null => {
    if (cached === undefined) {
      try {
        cached = readdirSync(repoRoot);
      } catch {
        cached = null;
      }
    }
    return cached;
  };
  const matched: Toolchain[] = [];
  for (const tc of [...extra, ...BUILTIN_TOOLCHAINS]) {
    if (matched.length >= limit) break;
    if (tc.markers.some((m) => markerMatches(m, repoRoot, listDir))) matched.push(tc);
  }
  return matched;
}

/**
 * Detects each toolchain at a repo root by its markers, in priority order. It returns `[]` when no marker matches.
 * The `extra` entries come before the built-ins, so a user toolchain comes before a built-in one for the same marker.
 */
export function detectToolchains(repoRoot: string, extra: readonly Toolchain[] = []): Toolchain[] {
  return matchToolchains(repoRoot, extra, Number.POSITIVE_INFINITY);
}

/**
 * Detects the first toolchain at a repo root, the first entry of {@link detectToolchains}. It returns `undefined` when no marker matches.
 * It stops at the first match, so it checks no marker of a later toolchain.
 */
export function detectToolchain(
  repoRoot: string,
  extra: readonly Toolchain[] = [],
): Toolchain | undefined {
  return matchToolchains(repoRoot, extra, 1)[0];
}

/**
 * The test-file globs of a built-in toolchain, or null when the toolchain uses the co-located globs or is unknown.
 * A returned set replaces the defaults (see `SplitHunksOptions.testGlobs`).
 */
export function testGlobsForToolchain(toolchainId: string): readonly string[] | null {
  return BUILTIN_TOOLCHAINS.find((tc) => tc.id === toolchainId)?.testGlobs ?? null;
}

/**
 * Resolves the test globs for the probe from the globs that a detected toolchain prescribes.
 * With only the toolchain globs, a polyglot repo (python at the root, `*.test.ts` beside the source) classifies each co-located test as source.
 * So the result is the union of the defaults and the toolchain globs, deduplicated, with the defaults first.
 * A test misclassified as source gives a false pass, so the union errs in the safe direction.
 */
export function resolveProbeTestGlobs(
  toolchainGlobs: readonly string[] | null | undefined,
): readonly string[] {
  if (!toolchainGlobs || toolchainGlobs.length === 0) return DEFAULT_TEST_GLOBS;
  const merged = [...DEFAULT_TEST_GLOBS];
  for (const glob of toolchainGlobs) {
    if (!merged.includes(glob)) merged.push(glob);
  }
  return merged;
}

/**
 * How to scope the mutation runner of a toolchain to a diff. The handler applies it with no knowledge of runner flags.
 * - `append-flag`: append `flag` to the command. `tokenized` is true when the value is a separate argv token, so the applier can quote it.
 * - `already-native`: the runner scopes itself to the diff, so the applier appends nothing.
 * - `path-restricted`: restrict the run to the changed paths. The applier fills the `<changed>` placeholder in `flag`.
 * - `unscoped-warning`: no scope is known. The run is unscoped and shows `warning`, so a full-tree run is never silent.
 */
export type MutationDiffScope =
  | { readonly kind: 'append-flag'; readonly flag: string; readonly tokenized: boolean; readonly warning?: undefined }
  | { readonly kind: 'already-native'; readonly warning?: undefined }
  | { readonly kind: 'path-restricted'; readonly flag: string; readonly warning?: undefined }
  | { readonly kind: 'unscoped-warning'; readonly warning: string };

/**
 * The diff-scope builder for each toolchain id. A toolchain that is not in this table resolves to `unscoped-warning`.
 */
const MUTATION_DIFF_SCOPE: Readonly<Record<string, (base: string) => MutationDiffScope>> = {
  /**
   * StrykerJS has no `--since` option. In this repo the node mutation command is `tools/audit/core/stryker-adapter.mjs`.
   * The adapter converts `--since=<base>` into a StrykerJS `--mutate` list of the changed `src/**` files.
   */
  node: (base) => ({ kind: 'append-flag', flag: `--since=${base}`, tokenized: false }),
  /** Stryker.NET takes the value as a separate token. */
  dotnet: (base) => ({ kind: 'append-flag', flag: `--since ${base}`, tokenized: true }),
  /** The cargo-mutants command already has `--in-diff`. A second scope is wrong. */
  rust: () => ({ kind: 'already-native' }),
  /** mutmut has no diff flag, so the run uses `--paths-to-mutate` on the changed paths. */
  python: () => ({ kind: 'path-restricted', flag: '--paths-to-mutate=<changed>' }),
  /** PIT uses `-DtargetClasses`. The applier computes the changed classes from `base`. */
  'java-maven': () => ({ kind: 'append-flag', flag: '-DtargetClasses=<changed>', tokenized: false }),
  'java-gradle': () => ({ kind: 'append-flag', flag: '-DtargetClasses=<changed>', tokenized: false }),
};

/** True when the built-in registry declares a mutation runner for this id. */
function hasMutationRunner(toolchainId: string): boolean {
  const tc = BUILTIN_TOOLCHAINS.find((t) => t.id === toolchainId);
  return tc !== undefined && tc.commands.mutation !== null;
}

/**
 * Resolves how to scope the mutation runner of a toolchain to the diff `base`.
 * An id with no table entry returns `unscoped-warning`. The warning text tells a known runner apart from a toolchain with no runner.
 */
export function resolveMutationDiffScope(toolchainId: string, base: string): MutationDiffScope {
  const build = MUTATION_DIFF_SCOPE[toolchainId];
  if (build) {
    return build(base);
  }
  const reason = hasMutationRunner(toolchainId)
    ? `no diff-scope augmentation is known for toolchain '${toolchainId}'; its mutation run is unscoped (full-tree) — consider deferring to a nightly/full run (R10/v2.12)`
    : `toolchain '${toolchainId}' has no resolved mutation runner to diff-scope; the mutation run is unscoped`;
  return { kind: 'unscoped-warning', warning: reason };
}

/**
 * The class of an unowned dependency, for hermetic-double resolution.
 * The double depends on the class of the dependency, not on the language toolchain. Thus it is a separate resolver and not a `ToolchainCommands` field.
 */
export type HermeticDependencyClass =
  | 'database'
  | 'cloud-api'
  | 'message-broker'
  | 'third-party-http'
  | 'owned-interface';

/** Google's canonical test-double fidelity order: real > fake > stub. */
export type HermeticFidelity = 'real' | 'fake' | 'stub';

/**
 * The hermetic double for one dependency class. It is a descriptor, not a command.
 * `double` names the strategy. `fidelity`, `cadence` and `caveat` tell the consumer where the double fits.
 */
export interface HermeticDouble {
  readonly depClass: HermeticDependencyClass;
  /** The resolved double strategy (a name, not a command or literal). */
  readonly double: string;
  readonly fidelity: HermeticFidelity;
  /** `boundary-offline` for a container-backed double, which costs real time. `inner-loop` for a cheap in-process double. */
  readonly cadence: 'inner-loop' | 'boundary-offline';
  /** A limit of the double, for example that an emulator is itself a fake of the cloud. */
  readonly caveat?: string;
}

/** The preferred double for each dependency class. */
const HERMETIC_RESOLUTION: Readonly<Record<HermeticDependencyClass, HermeticDouble>> = {
  database: {
    depClass: 'database',
    double: 'Testcontainers (the real engine in a container)',
    fidelity: 'real',
    cadence: 'boundary-offline',
    caveat:
      'Docker runtime cost (seconds-to-tens-of-seconds per suite) ⇒ boundary/offline cadence, never the inner loop',
  },
  'cloud-api': {
    depClass: 'cloud-api',
    double: 'LocalStack (an emulated cloud)',
    fidelity: 'fake',
    cadence: 'boundary-offline',
    caveat:
      'LocalStack is a FAKE of the cloud — a higher-fidelity failure mode, not a guarantee; the emulator can diverge from the real provider',
  },
  'message-broker': {
    depClass: 'message-broker',
    double: 'Testcontainers (the real broker in a container)',
    fidelity: 'real',
    cadence: 'boundary-offline',
    caveat: 'Docker runtime cost ⇒ boundary/offline cadence, never the inner loop',
  },
  'third-party-http': {
    depClass: 'third-party-http',
    double: 'a Pact-verified contract stub',
    fidelity: 'stub',
    cadence: 'inner-loop',
    caveat:
      'a stub verifies shape, not provider semantics — keep exactly one contract test for the boundary',
  },
  'owned-interface': {
    depClass: 'owned-interface',
    double: 'a hand-written fake of the owned interface',
    fidelity: 'fake',
    cadence: 'inner-loop',
  },
};

/**
 * Patterns that map a well-known bare package specifier to its dependency class. A specifier that matches no pattern stays unclassified.
 */
const HERMETIC_CLASS_SIGNATURES: ReadonlyArray<{
  readonly depClass: HermeticDependencyClass;
  readonly test: RegExp;
}> = [
  {
    depClass: 'database',
    test: /^(pg|mysql2?|sqlite3?|better-sqlite3|mongodb|mongoose|redis|ioredis|cassandra-driver|typeorm|prisma|knex|@databases\/|sequelize)/i,
  },
  {
    depClass: 'cloud-api',
    test: /^(aws-sdk|@aws-sdk\/|@azure\/|@google-cloud\/|googleapis|firebase-admin)/i,
  },
  {
    depClass: 'message-broker',
    test: /^(kafkajs|amqplib|amqp-connection-manager|nats|@nats-io\/|rhea|bullmq|bull)/i,
  },
  {
    depClass: 'third-party-http',
    test: /^(axios|node-fetch|got|undici|superagent|ky|request|phin)(\/|$)/i,
  },
];

/**
 * Classifies an unowned dependency specifier by the well-known package patterns. It returns `null` when no pattern matches.
 * The consumer then gives the generic list of hermetic options, not a wrong concrete double.
 */
export function classifyHermeticDependency(specifier: string): HermeticDependencyClass | null {
  const match = HERMETIC_CLASS_SIGNATURES.find((s) => s.test.test(specifier));
  return match ? match.depClass : null;
}

/** Returns the preferred hermetic double for a dependency class. Every class has one. */
export function resolveHermeticDouble(depClass: HermeticDependencyClass): HermeticDouble {
  return HERMETIC_RESOLUTION[depClass];
}
