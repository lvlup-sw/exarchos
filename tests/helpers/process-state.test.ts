// Tests for the file-boundary reset (#2030). One test checks the env restore alone.
// The other runs vitest with two test files that share one worker process.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepoSandbox, type RepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { restoreEnv } from './process-state.js';

const RESET_SETUP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reset-process-state.ts');
const VITEST_CLI = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');

/**
 * One probe file. Each copy checks that it starts clean, then leaves an env
 * variable, a `vi.stubEnv` stub over its own value, and a changed working
 * directory behind. Two copies run in one worker, so the second one sees the
 * first one's state unless the reset ran between them. Its own
 * `vi.unstubAllEnvs()` call shows a stub record carried over from the first.
 */
function probeFile(root: string): string {
  return [
    "import os from 'node:os';",
    "it('starts clean and leaves state behind', () => {",
    '  vi.unstubAllEnvs();',
    '  expect(process.env.EXARCHOS_FILE_BOUNDARY_PROBE).toBeUndefined();',
    '  expect(process.env.EXARCHOS_FILE_BOUNDARY_STUB).toBeUndefined();',
    `  expect(process.cwd()).toBe(${JSON.stringify(root)});`,
    "  process.env.EXARCHOS_FILE_BOUNDARY_PROBE = 'leaked';",
    "  process.env.EXARCHOS_FILE_BOUNDARY_STUB = 'own';",
    "  vi.stubEnv('EXARCHOS_FILE_BOUNDARY_STUB', 'stubbed');",
    '  process.chdir(os.tmpdir());',
    '});',
    '',
  ].join('\n');
}

function vitestConfig(setupFiles: readonly string[]): string {
  const test = {
    include: ['probe-*.test.mjs'],
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: setupFiles.map((file) => file.split(path.sep).join('/')),
  };
  return `export default ${JSON.stringify({ test }, null, 2)};\n`;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('VITEST') && !key.startsWith('EXARCHOS_FILE_BOUNDARY_')) env[key] = value;
  }
  return env;
}

interface NestedRun {
  readonly status: number | null;
  readonly passed: number;
  readonly failed: number;
  readonly output: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runs the two probe files in one forked worker with the given setup files. */
async function runTwoProbeFiles(
  sandbox: RepoSandbox,
  name: string,
  setupFiles: readonly string[],
): Promise<NestedRun> {
  const config = sandbox.write(`${name}/vitest.config.mjs`, vitestConfig(setupFiles));
  const root = path.dirname(config);
  sandbox.write(`${name}/probe-a.test.mjs`, probeFile(root));
  sandbox.write(`${name}/probe-b.test.mjs`, probeFile(root));
  const report = path.join(root, 'report.json');
  const run = await spawnAsync(
    process.execPath,
    [VITEST_CLI, 'run', '--config', config, '--reporter=json', `--outputFile=${report}`],
    { cwd: root, env: childEnv(), timeout: 90_000 },
  );
  const parsed: unknown = JSON.parse(readFileSync(report, 'utf8'));
  const passed = isRecord(parsed) && typeof parsed['numPassedTests'] === 'number' ? parsed['numPassedTests'] : -1;
  const failed = isRecord(parsed) && typeof parsed['numFailedTests'] === 'number' ? parsed['numFailedTests'] : -1;
  return { status: run.status, passed, failed, output: `${run.stdout}\n${run.stderr}` };
}

describe('process-state reset (#2030)', () => {
  /** Added keys go, changed and deleted keys come back, equal keys stay. */
  it('RestoreEnv_MakesTheTargetEqualTheSnapshot', () => {
    const target: NodeJS.ProcessEnv = { KEEP: 'same', CHANGED: 'new', ADDED: 'x' };

    restoreEnv(target, { KEEP: 'same', CHANGED: 'old', DELETED: 'back' });

    expect(target).toEqual({ KEEP: 'same', CHANGED: 'old', DELETED: 'back' });
  });

  /**
   * The real boundary: two files in one worker. Without the reset, the second file sees
   * the state of the first file, which proves that the probe can see a leak.
   * With the reset, both files start clean.
   */
  it('ResetSetupFile_TwoFilesInOneWorker_SecondFileStartsClean', async () => {
    const sandbox = await makeRepoSandbox({ prefix: 'file-boundary' });
    try {
      const without = await runTwoProbeFiles(sandbox, 'without-reset', []);
      expect({ passed: without.passed, failed: without.failed }, without.output).toEqual({ passed: 1, failed: 1 });

      const withReset = await runTwoProbeFiles(sandbox, 'with-reset', [RESET_SETUP_FILE]);
      expect({ status: withReset.status, passed: withReset.passed, failed: withReset.failed }, withReset.output).toEqual({
        status: 0,
        passed: 2,
        failed: 0,
      });
    } finally {
      sandbox.remove();
    }
  }, 180_000);
});
