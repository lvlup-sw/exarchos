import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';

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
  /** The installed binary must print the `version` of the root `package.json`. */
  it('version_default_matchesPackageJsonVersion', async () => {
    const expected = readPackageVersion();

    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['--version'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    });
  });

  /**
   * `--version` must print before the backend opens, so no `exarchos.db` exists afterwards.
   * A backend open costs start time, and concurrent opens can race on WAL recovery (`SQLITE_BUSY_RECOVERY`).
   */
  it('version_doesNotInitializeSqliteBackend', async () => {
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
  /**
   * The `version` subcommand prints the same string as the `--version` flag.
   * The process-suite preflight reads the binary version from this subcommand.
   */
  it('versionSubcommand_default_matchesPackageJsonVersion', async () => {
    const expected = readPackageVersion();

    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['version'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(expected);
    });
  });

  /**
   * The plain `version` subcommand must also print before the backend opens.
   * When concurrent preflight workers open the backend, they race on WAL recovery and exit 1 with empty stderr.
   */
  it('versionSubcommand_doesNotInitializeSqliteBackend', async () => {
    await withHermeticEnv(async ({ stateDir }) => {
      const result = await runCli({ args: ['version'] });
      expect(result.exitCode).toBe(0);
      expect(existsSync(path.join(stateDir, 'exarchos.db'))).toBe(false);
    });
  });
});
