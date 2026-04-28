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

  const det = detect(repoRoot);

  if (override && (override.test || override.typecheck || override.install)) {
    return {
      test: override.test ?? det.test,
      typecheck: override.typecheck ?? det.typecheck,
      install: override.install ?? det.install,
      source: 'override',
    };
  }

  if (!det.detected) {
    return {
      test: null,
      typecheck: null,
      install: null,
      source: 'unresolved',
      remediation: UNRESOLVED_REMEDIATION,
    };
  }

  if (det.unresolvedReason) {
    return {
      test: det.test,
      typecheck: det.typecheck,
      install: det.install,
      source: 'unresolved',
      remediation: det.unresolvedReason,
    };
  }

  return {
    test: det.test,
    typecheck: det.typecheck,
    install: det.install,
    source: 'detection',
  };
}
