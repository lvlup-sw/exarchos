// The admission decision path is a pure fold. This suite proves that Node (this vitest
// process) and Bun (`bun run` on the standalone CLI) produce the same corpus digest.
// The shipped `exarchos` binary has no command for the admission decision, so the suite
// cannot get a digest from the binary. The binary is a `bun build --compile` artifact,
// so the Bun run uses the same module resolution and standard library as the binary.

import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { execFileAsync } from '../../../test-helpers/spawn.js';
import { admissionScenarioCorpus } from './__fixtures__/admission-scenario-corpus.js';
import { corpusDigest } from './__fixtures__/admission-decision-path.js';

const CLI_PATH = fileURLToPath(
  new URL('./__fixtures__/corpus-digest-cli.ts', import.meta.url),
);

const IS_WIN = process.platform === 'win32';

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns a real bun executable, never a `.cmd` or `.ps1` shim.
 * Node refuses to `execFile` a shim without `shell: true`, and this spawn uses no shell.
 * On Windows, PATH can hold only the npm-global `bun.cmd` shim.
 * Then the real binary is at `<shim-dir>/node_modules/bun/bin/bun.exe`.
 */
async function resolveBunExecutable(): Promise<string | null> {
  const pathDirs = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  const realName = IS_WIN ? 'bun.exe' : 'bun';

  for (const dir of pathDirs) {
    const direct = join(dir, realName);
    if (isFile(direct)) return direct;
  }
  if (IS_WIN) {
    for (const dir of pathDirs) {
      if (isFile(join(dir, 'bun.cmd'))) {
        const derived = join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
        if (isFile(derived)) return derived;
      }
    }
  }
  try {
    await execFileAsync(realName, ['--version']);
    return realName;
  } catch {
    return null;
  }
}

const BUN_EXECUTABLE = await resolveBunExecutable();

async function runBunDigest(bun: string): Promise<string> {
  const stdout = await execFileAsync(bun, ['run', CLI_PATH], {
    timeout: 60_000,
  });
  const match = /DIGEST=([a-f0-9]{64})/.exec(stdout);
  if (match === null || match[1] === undefined) {
    throw new Error(`bun digest CLI produced no DIGEST line: ${stdout}`);
  }
  return match[1];
}

describe('admission decision cross-runtime parity (exit-proof d, cross-runtime leg)', () => {
  it('CorpusDigest_IsStable_AndContentAddressed_UnderNode', () => {
    const a = corpusDigest(admissionScenarioCorpus);
    const b = corpusDigest(admissionScenarioCorpus);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
  });

  /**
   * This test is the only leg that crosses a runtime boundary, so it does not skip without bun.
   * The build needs bun, and CI installs it. A missing bun is an environment defect, so the test fails.
   */
  it('CorpusDigest_MatchesAcrossNodeAndBun', async () => {
    expect(
      BUN_EXECUTABLE,
      'bun is unavailable, so the only cross-runtime leg of this parity proof cannot run. ' +
        'bun is a documented build prerequisite (npm run build shells out to it) and every CI ' +
        'lane hosting this suite installs it — its absence is an environment defect, not a ' +
        'reason to skip. Install bun (https://bun.sh) and re-run.',
    ).not.toBeNull();

    const nodeDigest = corpusDigest(admissionScenarioCorpus);
    const bunDigest = await runBunDigest(BUN_EXECUTABLE as string);
    expect(bunDigest).toBe(nodeDigest);
    expect(bunDigest).toMatch(/^[a-f0-9]{64}$/);
  }, 120_000);
});
