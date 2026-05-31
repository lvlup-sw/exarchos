// ─── Toolchain Registry — Single Source of Truth ────────────────────────────
//
// One declarative registry of toolchain IDENTITY: which file markers detect a
// toolchain, its human `projectType` label, its resolver-canonical commands,
// and (for scaffoldable toolchains) its scaffold token-map.
//
// This module exists so detection lives in ONE place. Before it, the same
// marker knowledge was duplicated across `test-runtime-resolver.detect()`,
// `static-analysis.detectProjectType()`, and `new-project`'s string-rewrite —
// which is how `.slnx` came to be recognized in some sites but not others
// (#1507) and how npm became the canonical scaffold toolchain (#1508).
//
// The three surfaces share DETECTION (markers → toolchain). They do NOT share
// commands: the resolver wants a test-runner command, static-analysis wants a
// build/lint check, and the scaffolder wants template-token fills. So commands
// are modelled per-perspective: `commands` (resolver) + `scaffold` (new-project).
// static-analysis consumes detection only and keeps its own check commands.
//
// Node package-manager nuance (npm/pnpm/yarn/bun) is resolved separately from
// the vendored lockfile table (see resolve-node-runtime, T2) — the node entry's
// static `commands` are the npm baseline only.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

/** Resolver-canonical commands for a toolchain. Mirrors ResolvedRuntime fields. */
export interface ToolchainCommands {
  readonly test: string | null;
  readonly typecheck: string | null;
  readonly install: string | null;
}

/**
 * Scaffold token replacements for `new-project`. Keyed to the CLAUDE.md.template
 * canonical tokens (`npm run test:run`, `npm run test:coverage`, `npm run typecheck`).
 * Present only for toolchains `new-project` can scaffold.
 */
export interface ScaffoldCommands {
  readonly test: string;
  readonly testCoverage: string;
  readonly typecheck: string;
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
  /** Scaffold token-map; present only for scaffoldable toolchains. */
  readonly scaffold?: ScaffoldCommands;
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
    commands: { test: 'npm run test:run', typecheck: 'tsc --noEmit', install: 'npm install' },
    scaffold: {
      test: 'npm run test',
      testCoverage: 'npm run test -- --coverage',
      typecheck: 'npm run typecheck',
    },
  },
  {
    id: 'dotnet',
    projectType: '.NET',
    markers: ['*.csproj', '*.sln', '*.slnx'],
    commands: { test: 'dotnet test', typecheck: null, install: null },
    scaffold: {
      test: 'dotnet test',
      testCoverage: 'dotnet test --collect:"XPlat Code Coverage"',
      typecheck: 'dotnet build',
    },
  },
  {
    id: 'rust',
    projectType: 'Rust',
    markers: ['Cargo.toml'],
    commands: { test: 'cargo test', typecheck: null, install: null },
  },
  {
    id: 'go',
    projectType: 'Go',
    markers: ['go.mod'],
    commands: { test: 'go test ./...', typecheck: null, install: null },
  },
  {
    id: 'python',
    projectType: 'Python',
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'tox.ini'],
    commands: { test: 'pytest', typecheck: null, install: null },
  },
  {
    id: 'java-gradle',
    projectType: 'Java',
    markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    commands: { test: './gradlew test', typecheck: null, install: null },
  },
  {
    id: 'java-maven',
    projectType: 'Java',
    markers: ['pom.xml'],
    commands: { test: 'mvn test', typecheck: null, install: null },
  },
  {
    id: 'ruby',
    projectType: 'Ruby',
    markers: ['Gemfile'],
    commands: { test: 'bundle exec rake test', typecheck: null, install: null },
  },
  {
    id: 'php',
    projectType: 'PHP',
    markers: ['composer.json'],
    commands: { test: 'composer test', typecheck: null, install: null },
  },
  {
    id: 'elixir',
    projectType: 'Elixir',
    markers: ['mix.exs'],
    commands: { test: 'mix test', typecheck: null, install: null },
  },
  {
    id: 'swift',
    projectType: 'Swift',
    markers: ['Package.swift'],
    commands: { test: 'swift test', typecheck: null, install: null },
  },
  {
    id: 'cmake',
    projectType: 'C/C++',
    markers: ['CMakeLists.txt'],
    commands: { test: 'ctest', typecheck: null, install: null },
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
  };
}

/**
 * Convert a user-declared `.exarchos.yml` toolchain into a registry
 * {@link Toolchain}. `projectType` defaults to the id; absent commands become
 * `null`. Pass the result as `detectToolchain(repoRoot, extra)` so user entries
 * are matched before the built-ins.
 */
export function toolchainFromConfig(entry: ConfigToolchain): Toolchain {
  return {
    id: entry.id,
    projectType: entry.projectType ?? entry.id,
    markers: [...entry.markers],
    commands: {
      test: entry.commands.test ?? null,
      typecheck: entry.commands.typecheck ?? null,
      install: entry.commands.install ?? null,
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
  return existsSync(path.join(repoRoot, marker));
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
