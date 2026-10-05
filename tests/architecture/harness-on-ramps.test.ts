/**
 * The harness on-ramps are authored content under `content/harness/`: the
 * runtime maps, the hooks template and the binding directive.
 *
 * The codegen that embeds the runtime maps in the binary must find its inputs
 * there. A runner must also collect the test of the hand-authored git hook in
 * `tools/git-hooks/`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const HARNESS_ROOT = join(REPO_ROOT, 'content/harness');

describe('HarnessOnRamps', () => {
  /**
   * `embedded.ts` is the only output of the codegen, and it names each runtime
   * that it embeds. The comparison proves that the codegen read these maps.
   */
  it('AfterMove_RuntimeCodegenStillResolves', () => {
    const runtimesDir = join(HARNESS_ROOT, 'runtimes');
    expect(existsSync(runtimesDir)).toBe(true);

    const maps = readdirSync(runtimesDir).filter((f) => f.endsWith('.yaml'));
    expect(maps.length, 'no runtime maps under the harness root').toBeGreaterThan(0);

    const embedded = readFileSync(
      join(REPO_ROOT, 'src/install/runtimes/embedded.ts'),
      'utf8',
    );
    for (const map of maps) {
      const id = map.replace(/\.yaml$/, '');
      expect(embedded, `embedded.ts does not carry runtime '${id}'`).toContain(
        `"name": "${id}"`,
      );
    }
  });

  /**
   * The plugin root keeps the generated `hooks.json`, because a harness loads
   * hooks from a fixed location. Only the source is under the harness root.
   */
  it('AfterMove_HooksAndBindingSourcesResolve', () => {
    expect(existsSync(join(HARNESS_ROOT, 'hooks/hooks.json'))).toBe(true);
    expect(existsSync(join(HARNESS_ROOT, 'binding/binding.md'))).toBe(true);

    expect(existsSync(join(REPO_ROOT, 'hooks/hooks.json'))).toBe(true);
  });

  /** A retired root that stays on disk invites an edit of a copy that nothing reads. */
  it('RetiredSourceRoots_AreGone', () => {
    for (const stale of ['runtimes', 'hooks-src', 'binding-src']) {
      expect(existsSync(join(REPO_ROOT, stale)), `${stale}/ still exists`).toBe(false);
    }
  });
});

describe('GitHookSample', () => {
  const HOOK_DIR = join(REPO_ROOT, 'tools/git-hooks');

  /**
   * A test that no vitest project collects passes because it never runs. This
   * test asks the runner what it collects and does not trust the config.
   */
  it('AfterRelocation_IsStillCollectedAndPasses', async () => {
    const sample = join(HOOK_DIR, 'pre-push.ship-gate.sample');
    const test = join(HOOK_DIR, 'pre-push.test.ts');
    expect(existsSync(sample), 'the shipped hook sample is missing').toBe(true);
    expect(existsSync(test), 'the hook test is missing').toBe(true);

    const listed = await execFileAsync(
      'npx',
      ['vitest', 'list', '--filesOnly', 'tools/git-hooks/pre-push.test.ts'],
      { cwd: REPO_ROOT, timeout: 120_000 },
    );
    expect(String(listed), 'no vitest project collects the relocated hook test').toContain(
      'pre-push.test.ts',
    );
  });

  /** The hook sample is hand-authored, so it does not belong in the generated `hooks/` tree. */
  it('IsNotPublishedAsPartOfTheGeneratedHooksTree', () => {
    const shippedHooks = readdirSync(join(REPO_ROOT, 'hooks'));
    expect(shippedHooks).not.toContain('pre-push.ship-gate.sample');
    expect(shippedHooks).not.toContain('pre-push.test.ts');
  });
});
