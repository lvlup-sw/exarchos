import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The harness on-ramps — runtime maps, the hooks template and the binding
 * directive — are authored content, and they moved under `content/harness/`
 * with the rest of the authoring tree.
 *
 * Two things have to survive that move: the codegen that bakes the runtime
 * maps into the binary must still find its inputs, and the shipped git hook
 * lifted out of the generated `hooks/` tree must still be collected by a
 * runner. Both had a path anchored somewhere that the move invalidated.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');
const HARNESS_ROOT = join(REPO_ROOT, 'content/harness');

describe('HarnessOnRamps', () => {
  it('AfterMove_RuntimeCodegenStillResolves', () => {
    const runtimesDir = join(HARNESS_ROOT, 'runtimes');
    expect(existsSync(runtimesDir)).toBe(true);

    const maps = readdirSync(runtimesDir).filter((f) => f.endsWith('.yaml'));
    expect(maps.length, 'no runtime maps under the harness root').toBeGreaterThan(0);

    // The generated module is the codegen's only output, and it names each
    // runtime it embedded. Comparing the two proves the codegen read THESE
    // files, rather than merely that both happen to exist.
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

  it('AfterMove_HooksAndBindingSourcesResolve', () => {
    expect(existsSync(join(HARNESS_ROOT, 'hooks/hooks.json'))).toBe(true);
    expect(existsSync(join(HARNESS_ROOT, 'binding/binding.md'))).toBe(true);

    // The plugin root keeps its generated `hooks.json`: a harness loads hooks
    // from a fixed location, so only the SOURCE moved.
    expect(existsSync(join(REPO_ROOT, 'hooks/hooks.json'))).toBe(true);
  });

  it('RetiredSourceRoots_AreGone', () => {
    // A move that leaves the old root behind invites a reader to edit the copy
    // nothing reads.
    for (const stale of ['runtimes', 'hooks-src', 'binding-src']) {
      expect(existsSync(join(REPO_ROOT, stale)), `${stale}/ still exists`).toBe(false);
    }
  });
});

describe('GitHookSample', () => {
  const HOOK_DIR = join(REPO_ROOT, 'tools/git-hooks');

  it('AfterRelocation_IsStillCollectedAndPasses', () => {
    const sample = join(HOOK_DIR, 'pre-push.ship-gate.sample');
    const test = join(HOOK_DIR, 'pre-push.test.ts');
    expect(existsSync(sample), 'the shipped hook sample is missing').toBe(true);
    expect(existsSync(test), 'the hook test is missing').toBe(true);

    // Collection is the actual risk. The runner include for this test pointed
    // at the old `hooks/` root, and a test that no project collects passes by
    // never running — so ask the runner what it collects rather than trusting
    // the config to be current.
    const listed = execFileSync(
      'npx',
      ['vitest', 'list', '--filesOnly', 'tools/git-hooks/pre-push.test.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
    );
    expect(listed, 'no vitest project collects the relocated hook test').toContain(
      'pre-push.test.ts',
    );
  });

  it('IsNotPublishedAsPartOfTheGeneratedHooksTree', () => {
    // It left `hooks/` precisely because it is hand-authored; finding it back
    // there would mean the move was undone or the file was re-added.
    const shippedHooks = readdirSync(join(REPO_ROOT, 'hooks'));
    expect(shippedHooks).not.toContain('pre-push.ship-gate.sample');
    expect(shippedHooks).not.toContain('pre-push.test.ts');
  });
});
