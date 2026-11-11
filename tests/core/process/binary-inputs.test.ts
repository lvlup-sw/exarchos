/**
 * Tests the input scan of `ensureBinaryBuilt` in `_helpers.ts`. The built-in workflow definitions
 * are `.json` files under `src`, and the bundle holds them. So a `.json` input that is newer than
 * the binary makes the binary stale.
 *
 * The case builds a temporary repository tree and injects a fake build step. It runs no `bun` and
 * reads no real `dist/bin` binary.
 *
 * @oracle-sources: ./_helpers.ts, the temporary repository tree and the fake build in this file
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureBinaryBuilt, hostBinaryPath } from './_helpers.js';
import { makeTempDir, rmrf } from '../../../tools/test-helpers/temp-dir.js';

/** The temporary repository roots of the current test. */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmrf(dir);
});

/** Sets the access and modification time of a file to a number of seconds before now. */
function ageFile(file: string, nowSeconds: number, secondsAgo: number): void {
  fs.utimesSync(file, nowSeconds - secondsAgo, nowSeconds - secondsAgo);
}

describe('the input scan of the compiled binary', () => {
  /**
   * A tree with a source file and a definition file older than the binary needs no build. When the
   * definition file becomes newer than the binary, the next call builds once and puts the new binary in place.
   */
  it('EnsureBinaryBuilt_AJsonInputNewerThanTheBinary_RebuildsTheBinary', async () => {
    const repoRoot = makeTempDir('exarchos-binary-inputs-');
    tempDirs.push(repoRoot);
    const source = path.join(repoRoot, 'src', 'workflow', 'state-machine.ts');
    const definition = path.join(repoRoot, 'src', 'workflow', 'definitions', 'feature.workflow.json');
    const binaryPath = hostBinaryPath(repoRoot);
    fs.mkdirSync(path.dirname(definition), { recursive: true });
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(source, 'export {};\n');
    fs.writeFileSync(definition, '{}\n');
    fs.writeFileSync(binaryPath, 'old binary');

    const now = Math.floor(Date.now() / 1000);
    ageFile(source, now, 300);
    ageFile(definition, now, 250);
    ageFile(binaryPath, now, 200);

    const builds: string[] = [];
    const runBuild = (_repoRoot: string, outDir: string): void => {
      builds.push(outDir);
      fs.writeFileSync(path.join(outDir, path.basename(binaryPath)), 'new binary');
    };

    const fresh = await ensureBinaryBuilt(repoRoot, { runBuild });
    expect(fresh).toEqual({ binaryPath, rebuilt: false });
    expect(builds).toEqual([]);

    ageFile(definition, now, 100);
    const stale = await ensureBinaryBuilt(repoRoot, { runBuild });
    expect(stale).toEqual({ binaryPath, rebuilt: true });
    expect(builds).toHaveLength(1);
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe('new binary');
  });
});
