/**
 * The registry of toolchain identity: the file markers that detect a toolchain, its `projectType` label, and its resolver commands.
 * Detection lives only here. The resolver and static analysis share detection, but each keeps its own commands.
 * The node entry holds the npm baseline. The resolver selects the package-manager commands from the vendored lockfile table.
 * The module also holds the test globs, the mutation diff-scope table, and the hermetic-double resolver for each toolchain.
 */

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';

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
  },
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
 * Detects the toolchain at a repo root by its markers, in priority order. It returns `undefined` when no marker matches.
 * The `extra` entries come before the built-ins, so a user toolchain can override or extend detection.
 * The function lists the directory once, and only when it evaluates an extension-glob marker.
 */
export function detectToolchain(
  repoRoot: string,
  extra: readonly Toolchain[] = [],
): Toolchain | undefined {
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
  for (const tc of [...extra, ...BUILTIN_TOOLCHAINS]) {
    if (tc.markers.some((m) => markerMatches(m, repoRoot, listDir))) {
      return tc;
    }
  }
  return undefined;
}

/**
 * Test-file globs by toolchain id, for ecosystems that do not use the co-located `*.test.*` layout.
 * A returned set replaces the defaults (see `SplitHunksOptions.testGlobs`). For a toolchain that is not in the map, callers use `DEFAULT_TEST_GLOBS`.
 */
const TOOLCHAIN_TEST_GLOBS: Readonly<Record<string, readonly string[]>> = {
  python: ['tests/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'],
  go: ['**/*_test.go'],
  rust: ['tests/**'],
  'java-maven': ['src/test/**', '**/src/test/**'],
  'java-gradle': ['src/test/**', '**/src/test/**'],
  dotnet: ['**/*Tests/**', '**/*.Tests/**', '**/*Tests.cs', '**/*Test.cs'],
  ruby: ['spec/**', 'test/**'],
  php: ['tests/**', '**/*Test.php'],
  elixir: ['test/**'],
  swift: ['Tests/**'],
};

/**
 * The test-file globs a toolchain prescribes, or null when the toolchain uses
 * the co-located default convention (or is unknown).
 */
export function testGlobsForToolchain(toolchainId: string): readonly string[] | null {
  return TOOLCHAIN_TEST_GLOBS[toolchainId] ?? null;
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
