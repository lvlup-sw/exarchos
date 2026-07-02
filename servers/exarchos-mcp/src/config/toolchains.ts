// ─── Toolchain Registry — Single Source of Truth ────────────────────────────
//
// One declarative registry of toolchain IDENTITY: which file markers detect a
// toolchain, its human `projectType` label, and its resolver-canonical commands.
//
// This module exists so detection lives in ONE place. Before it, the same
// marker knowledge was duplicated across `test-runtime-resolver.detect()` and
// `static-analysis.detectProjectType()` — which is how `.slnx` came to be
// recognized in some sites but not others (#1507).
//
// The consuming surfaces share DETECTION (markers → toolchain). They do NOT
// share commands: the resolver wants a test-runner command and static-analysis
// wants a build/lint check, so each consumes detection and keeps its own
// command perspective. (The retired `new-project` scaffolder also consumed a
// per-toolchain scaffold token-map; that surface and its `scaffold` field were
// removed in DR-3/DR-5 — task 017/018.)
//
// Node package-manager nuance (npm/pnpm/yarn/bun) is resolved separately from
// the vendored lockfile table (see resolve-node-runtime, T2) — the node entry's
// static `commands` are the npm baseline only.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';

/**
 * Structured contract-verification commands for a schema boundary.
 *
 * `codegen` regenerates client/server bindings from the schema artifact;
 * `diff` runs a breaking-change check against the baseline. Both are null-able
 * because the resolver may attach only one leg (e.g. an OpenAPI artifact with a
 * diff tool but no codegen wired). See {@link ToolchainCommands.contract}.
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
  /** Mutation-testing runner (e.g. `npx stryker run`, `cargo mutants --in-diff`). */
  readonly mutation: string | null;
  /** Lint / static-style command (e.g. `cargo clippy`, `go vet ./...`). */
  readonly lint: string | null;
  /**
   * Contract-verification commands, structured as `{ codegen, diff }`. `null`
   * for language toolchains: contracts are keyed on schema ARTIFACTS (proto /
   * OpenAPI / GraphQL), not on the language alone — the resolver attaches the
   * artifact-keyed commands per-boundary (tasks 017/022), keeping this module
   * the toolchain-IDENTITY source of truth, not a schema-tool registry.
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

// Priority-ordered. node first preserves prior resolver/static-analysis behavior
// (package.json wins). Entries below the original five (node, dotnet, rust, go,
// python) are additive: repos that previously resolved to "no toolchain" now
// detect — never overriding an existing match.
export const BUILTIN_TOOLCHAINS: readonly Toolchain[] = [
  {
    id: 'node',
    projectType: 'Node.js',
    markers: ['package.json'],
    // Baseline only — the resolver computes node commands package-manager-aware.
    // lint is null: a node repo's linter is project-script-specific (eslint /
    // biome / oxlint), with no single conventional invocation to seed.
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
  readonly projectType?: string;
  readonly markers: readonly string[];
  readonly commands: {
    readonly test?: string;
    readonly typecheck?: string;
    readonly install?: string;
    readonly mutation?: string;
    readonly lint?: string;
    readonly contract?: {
      readonly codegen?: string;
      readonly diff?: string;
    };
  };
}

/**
 * Convert a user-declared `.exarchos.yml` toolchain into a registry
 * {@link Toolchain}. `projectType` defaults to the id; absent commands become
 * `null`. Pass the result as `detectToolchain(repoRoot, extra)` so user entries
 * are matched before the built-ins.
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

function markerMatches(
  marker: string,
  repoRoot: string,
  listDir: () => readonly string[] | null,
): boolean {
  // Extension globs (`*.csproj`) need a directory listing; exact filenames use
  // a direct existsSync probe — the natural "is this file here" check, and the
  // access pattern callers' fs mocks already expect.
  if (marker.startsWith('*.')) {
    const entries = listDir();
    if (!entries) return false;
    const ext = marker.slice(1); // '*.csproj' → '.csproj'
    return entries.some((e) => e.endsWith(ext));
  }
  return existsSync(toPosix(path.join(repoRoot, marker)));
}

/**
 * Detect the toolchain at a repo root by its markers, in priority order.
 *
 * `extra` entries (e.g. user-declared `.exarchos.yml` `toolchains:`) are checked
 * BEFORE the built-ins, so a user can override or extend detection. Exact-name
 * markers are probed with `existsSync`; the directory is listed (lazily, once)
 * only when an extension-glob marker is evaluated. Returns `undefined` when no
 * marker matches.
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

// ─── Test-file layout by toolchain (FIX-3) ──────────────────────────────────

/**
 * Test-file globs by toolchain id, for ecosystems whose test layout is NOT the
 * co-located `*.test.*` convention (the splitHunks default). Co-located with
 * the toolchain registry so consumers (test-adequacy probe) hold no independent
 * layout table — same SoT discipline as commands/markers.
 *
 * Semantics: a returned set REPLACES the co-located defaults (the toolchain is
 * authoritative about what a "test file" is for that project — see
 * `SplitHunksOptions.testGlobs`). Toolchains absent from this map (node, cmake,
 * …) return null → callers fall back to `DEFAULT_TEST_GLOBS`.
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

// ─── Mutation diff-scope augmentation (R5 / #1520, design §4.2) ──────────────
//
// How to scope a resolved mutation command to a diff base, keyed by toolchain
// id. This is per-toolchain command KNOWLEDGE, so it belongs in this SoT module
// alongside the runner commands themselves — consumers (the mutation-adequacy
// action) stay runner-agnostic and never re-declare a `--since`/`--in-diff`
// table. The resolver returns a tagged DESCRIPTOR; the handler applies it to the
// resolved command without knowing one runner's flag from another's.
//
// Why a descriptor and not a rewritten string: diff-scoping splits into shapes
// that compose differently against the command —
//   - append a flag (Stryker `--since`, PIT `-DtargetClasses`),
//   - do nothing because the runner is already diff-native (cargo-mutants
//     `--in-diff` — appending a second scope would double-scope),
//   - restrict the run to the changed paths (mutmut, which has no diff flag),
//   - or none of the above → run unscoped WITH a warning so the `< minutes`
//     acceptance is never silently violated (never silently full-tree).

/**
 * A resolved diff-scope augmentation for one toolchain's mutation runner.
 *
 * - `append-flag`     — append `flag` to the resolved command (`--since=<base>`,
 *                       `-DtargetClasses=...`). `tokenized` is false when the
 *                       value rides the flag (`--since=<base>`) and true when it
 *                       is a separate argv token (`--since <base>`), so the
 *                       applier can shell-quote correctly.
 * - `already-native`  — the runner already diff-scopes itself (cargo-mutants
 *                       `--in-diff`); the applier appends nothing.
 * - `path-restricted` — restrict the run to the diff's changed paths (mutmut's
 *                       `--paths-to-mutate`); `flag` carries a `<changed>`
 *                       placeholder the applier fills with the diff's changed
 *                       paths (the same applier-resolves-placeholder pattern as
 *                       PIT's `-DtargetClasses=<changed>` append-flag).
 * - `unscoped-warning`— no known augmentation; run unscoped and surface
 *                       `warning` (the Task-seam note), never silently full.
 */
export type MutationDiffScope =
  | { readonly kind: 'append-flag'; readonly flag: string; readonly tokenized: boolean; readonly warning?: undefined }
  | { readonly kind: 'already-native'; readonly warning?: undefined }
  | { readonly kind: 'path-restricted'; readonly flag: string; readonly warning?: undefined }
  | { readonly kind: 'unscoped-warning'; readonly warning: string };

/**
 * Strategy for scoping a toolchain's mutation runner to a diff. Keyed by
 * toolchain id (the same ids as {@link BUILTIN_TOOLCHAINS}). A `base`-templated
 * builder so the value-placement nuance (`--since=<base>` vs `--since <base>`)
 * lives next to the runner knowledge, not in the consumer. A toolchain absent
 * from this table — or present in the registry with `mutation: null` (no runner
 * to scope) — resolves to the unscoped-warning arm.
 */
const MUTATION_DIFF_SCOPE: Readonly<Record<string, (base: string) => MutationDiffScope>> = {
  // Stryker (JS): value rides the flag.
  node: (base) => ({ kind: 'append-flag', flag: `--since=${base}`, tokenized: false }),
  // Stryker (.NET): value is a separate token.
  dotnet: (base) => ({ kind: 'append-flag', flag: `--since ${base}`, tokenized: true }),
  // cargo-mutants is already `--in-diff` — do not double-scope.
  rust: () => ({ kind: 'already-native' }),
  // mutmut has no `--since`; restrict the run to the changed paths via
  // `--paths-to-mutate` (the applier fills `<changed>` with the diff's .py paths).
  python: () => ({ kind: 'path-restricted', flag: '--paths-to-mutate=<changed>' }),
  // PIT scopes via -DtargetClasses=<changed>; same strategy for both Java build
  // tools (the changed-class glob is computed by the applier from `base`).
  'java-maven': () => ({ kind: 'append-flag', flag: '-DtargetClasses=<changed>', tokenized: false }),
  'java-gradle': () => ({ kind: 'append-flag', flag: '-DtargetClasses=<changed>', tokenized: false }),
};

/** True when the built-in registry declares a mutation runner for this id. */
function hasMutationRunner(toolchainId: string): boolean {
  const tc = BUILTIN_TOOLCHAINS.find((t) => t.id === toolchainId);
  return tc !== undefined && tc.commands.mutation !== null;
}

/**
 * Resolve how to scope a toolchain's mutation runner to the diff `base`.
 *
 * Returns a tagged {@link MutationDiffScope}. Unknown ids — and known ids whose
 * registry entry has no mutation runner (go/swift/cmake) — return the
 * `unscoped-warning` arm: there is nothing to scope, so we never pretend a
 * scope and never silently run full-tree.
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

// ─── Hermetic-double resolution (SIV-5 / #1531) ──────────────────────────────
//
// The CONSTRUCTIVE half of SIV-4 (#1530): SIV-4 detects an agent-authored mock
// of an UNOWNED dependency and steers away from it; SIV-5 says what to use
// INSTEAD. Banning a practice without supplying the alternative just produces
// friction, so this resolver maps a detected unowned-dependency CLASS to its
// preferred high-fidelity double.
//
// Shape rationale: hermetic doubles key on the DEPENDENCY's class (a DB vs a
// cloud API vs an owned interface), NOT on the project's language toolchain —
// the exact reason `contract` is keyed on schema ARTIFACTS and is `null` on
// every BUILTIN_TOOLCHAINS entry. So this is a SIBLING resolver (like
// MUTATION_DIFF_SCOPE / resolveMutationDiffScope above), not a per-toolchain
// `ToolchainCommands` field. It emits a RESOLUTION descriptor — a named
// strategy with its fidelity/cadence/caveat — never a baked command or literal
// (INV-4 gen-time-placeholder trap): the consumer inspects the descriptor and
// decides, it does not receive a hardcoded "use Testcontainers" string.
//
// Fidelity order is Google's canonical real > fake > stub/mock. The honesty
// caveats are first-class fields, not prose: an emulator (LocalStack) is itself
// a FAKE of the cloud (a higher-fidelity failure mode, not a guarantee), and a
// container-backed real double costs real wall-clock ⇒ boundary/offline
// cadence, never the inner loop.

/** The class of an unowned dependency, for hermetic-double resolution. */
export type HermeticDependencyClass =
  | 'database'
  | 'cloud-api'
  | 'message-broker'
  | 'third-party-http'
  | 'owned-interface';

/** Google's canonical test-double fidelity order: real > fake > stub. */
export type HermeticFidelity = 'real' | 'fake' | 'stub';

/**
 * A resolved hermetic double for one dependency class. A DESCRIPTOR, not a
 * baked command: `double` names the strategy; `fidelity`/`cadence`/`caveat`
 * carry the honesty the consumer needs to place it correctly.
 */
export interface HermeticDouble {
  readonly depClass: HermeticDependencyClass;
  /** The resolved double strategy (a name, not a command or literal). */
  readonly double: string;
  readonly fidelity: HermeticFidelity;
  /**
   * `boundary-offline` for container-backed doubles (real wall-clock cost) —
   * never the inner loop; `inner-loop` for cheap in-process doubles.
   */
  readonly cadence: 'inner-loop' | 'boundary-offline';
  /** Honesty caveat (e.g. an emulator is itself a fake of the cloud). */
  readonly caveat?: string;
}

/** Dep-class → preferred double. The resolution table (resolve, don't bake). */
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
 * Signatures mapping a well-known dependency specifier to its class. Bare
 * package specifiers only (the unowned-mock targets SIV-4 surfaces). A specifier
 * matching no signature stays UNCLASSIFIED (the resolver returns null rather
 * than guess a double — resolve, don't bake).
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
 * Classify an unowned dependency specifier into a {@link HermeticDependencyClass}
 * by well-known package signatures, or `null` when no signature matches. The
 * null arm is load-bearing: an unrecognized dependency gets the generic hermetic
 * menu, never a guessed-wrong concrete double.
 */
export function classifyHermeticDependency(specifier: string): HermeticDependencyClass | null {
  const match = HERMETIC_CLASS_SIGNATURES.find((s) => s.test.test(specifier));
  return match ? match.depClass : null;
}

/**
 * Resolve a dependency class to its preferred hermetic double (the descriptor).
 * Total over the class union — every class has a resolution.
 */
export function resolveHermeticDouble(depClass: HermeticDependencyClass): HermeticDouble {
  return HERMETIC_RESOLUTION[depClass];
}
