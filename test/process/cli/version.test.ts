// Source: docs/designs/2026-05-05-e2e-v29-revisited.md §4.4 (T4.1)
import { readFileSync } from 'node:fs';
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
});
