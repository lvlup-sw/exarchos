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

import { existsSync, readdirSync } from 'node:fs';
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
  if (pm === 'bun') {
    return {
      test: 'bun test',
      typecheck: 'tsc --noEmit',
      install: 'bun install',
      detected: true,
    };
  }
  if (pm === 'pnpm') {
    return {
      test: 'pnpm test',
      typecheck: 'tsc --noEmit',
      install: 'pnpm install --frozen-lockfile',
      detected: true,
    };
  }
  if (pm === 'yarn') {
    return {
      test: 'yarn test',
      typecheck: 'tsc --noEmit',
      install: 'yarn install --immutable',
      detected: true,
    };
  }
  if (pm === 'npm') {
    return {
      test: 'npm run test:run',
      typecheck: 'npm run typecheck',
      install: 'npm install',
      detected: true,
    };
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

  return {
    test: det.test,
    typecheck: det.typecheck,
    install: det.install,
    source: 'detection',
  };
}
