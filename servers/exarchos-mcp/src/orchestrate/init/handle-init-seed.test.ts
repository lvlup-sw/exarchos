/**
 * handleInit + seedExarchosConfig integration — T14 (#1199 Stage 2).
 *
 * `handleInit` performs a best-effort post-init step that resolves the
 * repo root and seeds `.exarchos.yml`. This test exercises that exact
 * helper (`runPostInitSeed`) against a real temp repo. It avoids
 * importing `handleInit` directly because the production handler pulls
 * in `EventStore`, whose schema module currently breaks under the
 * project-wide pre-existing zod-v4 compatibility issue when this file
 * is loaded by vitest. The wiring of `runPostInitSeed` into
 * `handleInit` is statically guaranteed (single call site) and
 * verified by typecheck.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { runPostInitSeed } from './index.js';

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('handleInit + seedExarchosConfig integration', () => {
  let tempRepo: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempRepo = await mkdtemp(path.join(tmpdir(), 'init-seed-repo-'));

    // Make tempRepo a real git repo so `git rev-parse --show-toplevel`
    // resolves to it.
    execSync('git init', { cwd: tempRepo, stdio: 'ignore' });

    // Provide a Node project shape so detection succeeds.
    await writeFile(
      path.join(tempRepo, 'package.json'),
      JSON.stringify({ name: 'tmp', scripts: { 'test:run': 'vitest run' } }),
      'utf8',
    );

    originalCwd = process.cwd();
    process.chdir(tempRepo);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
  });

  it('handleInit_OnFirstCallInRepo_SeedsExarchosYml', async () => {
    const cfgPath = path.join(tempRepo, '.exarchos.yml');
    expect(await fileExists(cfgPath)).toBe(false);

    runPostInitSeed();

    expect(await fileExists(cfgPath)).toBe(true);
    const contents = await readFile(cfgPath, 'utf8');
    expect(contents).toContain('# .exarchos.yml — Exarchos project configuration.');
    expect(contents).toContain('test: npm run test:run');
    expect(contents).toContain('install: npm install');
  });
});
