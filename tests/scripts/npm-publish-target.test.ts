/**
 * Proves that `npm publish` sends this package to npmjs.org.
 *
 * The repository `.npmrc` maps the `@lvlup-sw` scope to GitHub Packages, and a scope
 * registry outranks `publishConfig.registry`. As a result, `publishConfig` must also map
 * the scope to npmjs.org. Without that mapping, the publish goes to GitHub Packages and
 * fails there, and the GitHub Release still ships. The test reads the registry that an
 * npm dry run reports for a copy of `package.json` and `.npmrc`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { makeTempDir, rmrf } from '../../tools/test-helpers/temp-dir.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NPMJS = 'https://registry.npmjs.org/';

let scratch: string;

beforeAll(() => {
  scratch = makeTempDir('npm-publish-target-');
  copyFileSync(join(REPO_ROOT, 'package.json'), join(scratch, 'package.json'));
  copyFileSync(join(REPO_ROOT, '.npmrc'), join(scratch, '.npmrc'));
  writeFileSync(join(scratch, 'empty-user-npmrc'), '');
  writeFileSync(join(scratch, 'empty-global-npmrc'), '');
});

afterAll(() => {
  rmrf(scratch);
});

/** The registry a dry-run publish reports, with no lifecycle scripts and no ambient npm config. */
async function dryRunPublishTarget(): Promise<string | undefined> {
  const isWin = process.platform === 'win32';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  const run = await spawnAsync(
    isWin ? 'npm.cmd' : 'npm',
    [
      'publish',
      '--dry-run',
      '--ignore-scripts',
      '--userconfig',
      join(scratch, 'empty-user-npmrc'),
      '--globalconfig',
      join(scratch, 'empty-global-npmrc'),
    ],
    { cwd: scratch, env, timeout: 60_000, shell: isWin },
  );
  expect(run.status, `${String(run.error)}\n${run.stderr}`).toBe(0);
  return /Publishing to (\S+) with tag/.exec(`${run.stdout}\n${run.stderr}`)?.[1];
}

describe('npm publish target', () => {
  it('NpmPublish_WithTheRepositoryNpmrc_TargetsNpmjs', async () => {
    expect(await dryRunPublishTarget()).toBe(NPMJS);
  }, 90_000);
});
