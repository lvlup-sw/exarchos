/**
 * Tests for the refusals of `tools/test-helpers/run-test-files.mjs`, the script behind
 * `npm run test:files`.
 *
 * Without a file argument, `vitest run` starts the whole root suite, and that suite deletes the
 * worktree that it runs in. These tests hold that the script refuses before vitest starts.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'test-helpers', 'run-test-files.mjs');

/** The exit code of a refusal. */
const REFUSED = 2;

/** Runs the script from the repository root with the given arguments. */
function runScript(args: readonly string[]): ReturnType<typeof spawnAsync> {
  return spawnAsync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, timeout: 30_000 });
}

describe('run-test-files refusals', () => {
  it('RunTestFiles_NoFileArgument_RefusesBeforeVitestStarts', async () => {
    const result = await runScript([]);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
    expect(result.stdout).not.toContain('Test Files');
  });

  it('RunTestFiles_OnlyTheSeparator_RefusesBeforeVitestStarts', async () => {
    const result = await runScript(['--']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
  });

  it('RunTestFiles_ADirectoryArgument_IsRefusedAsNotAFile', async () => {
    const result = await runScript(['tests']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('not files: tests');
  });

  it('RunTestFiles_OnlyAnOption_RefusesBeforeVitestStarts', async () => {
    const result = await runScript(['--project=unit']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
  });
});
