// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.1)
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../fixtures/hermetic.js';
import { runCli } from '../../fixtures/cli-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

interface PackageJson {
  version: string;
}

function readPackageVersion(): string {
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as PackageJson;
  return pkg.version;
}

describe('exarchos --version', () => {
  it('version_default_matchesPackageJsonVersion', async () => {
    const expected = readPackageVersion();

    await withHermeticEnv(async () => {
      // Commander registers `--version` at the program level (cli.ts §"version")
      // and emits the value passed to `.version()`. The literal version string
      // tracked there is kept in lockstep with package.json by the release
      // tooling, so this assertion guards both the binary and the manifest.
      const result = await runCli({ args: ['--version'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    });
  });

  it('version_doesNotInitializeSqliteBackend', async () => {
    // Regression guard: printing the version is stateless and must short-circuit
    // before backend init. Initializing the SQLite event store here wastes
    // cold-start budget and, under concurrent invocations, races on WAL recovery
    // (SQLITE_BUSY_RECOVERY). The fast path in index.ts:main() must return before
    // any state-dir / `exarchos.db` creation.
    await withHermeticEnv(async ({ stateDir }) => {
      const result = await runCli({ args: ['--version'] });
      expect(result.exitCode).toBe(0);
      expect(existsSync(path.join(stateDir, 'exarchos.db'))).toBe(false);
    });
  });

  it('version_unknownFlag_exitsNonZero', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['--definitely-unknown-flag'] });
      expect(result.exitCode).not.toBe(0);
    });
  });
});

describe('exarchos version (subcommand)', () => {
  it('versionSubcommand_default_matchesPackageJsonVersion', async () => {
    const expected = readPackageVersion();

    await withHermeticEnv(async () => {
      // The `version` subcommand (distinct from the `--version` flag) prints the
      // same string sourced from package.json (cli.ts §"Top-level version
      // command", bug #1216). The E2E preflight resolves the binary version via
      // this surface, so it must stay in lockstep with the manifest.
      const result = await runCli({ args: ['version'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    });
  });

  it('versionSubcommand_doesNotInitializeSqliteBackend', async () => {
    // Regression guard for the E2E-preflight flake: `exarchos version` is
    // stateless and must short-circuit before backend init, exactly like the
    // `--version` flag. Previously only the flag was fast-pathed; the
    // subcommand fell through to initializeBackend(), which under concurrent
    // worker invocation races on WAL recovery (SQLITE_BUSY_RECOVERY) and exits
    // 1 with empty stderr. index.ts:main() must return before any state-dir /
    // `exarchos.db` creation for the plain subcommand form.
    await withHermeticEnv(async ({ stateDir }) => {
      const result = await runCli({ args: ['version'] });
      expect(result.exitCode).toBe(0);
      expect(existsSync(path.join(stateDir, 'exarchos.db'))).toBe(false);
    });
  });
});
