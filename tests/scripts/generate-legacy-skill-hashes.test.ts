/**
 * Tests for the generator of `tools/migrations/legacy-skill-render-hashes.json`.
 *
 * The manifest holds the newline-normalized hash of each per-runtime skill render
 * at each release tag in the legacy window. A cleanup pass can then prove that
 * a skill file on disk came from a release before it deletes the file.
 * The tests pin two properties:
 *   1. CRLF and LF content hash to the same value, so an install that differs
 *      only by line endings still matches.
 *   2. The generator reads git objects and never the working tree. A concurrent
 *      skills regeneration then cannot change its output.
 *
 * The generator is a plain `.mjs` module without a declaration file. `allowJs` infers its types.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { makeRepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';
import {
  buildManifest,
  enumerateReleaseRefs,
  listSkillRenderPaths,
  normalizeAndHash,
  serializeManifest,
  MANIFEST_PATH,
  MIN_RELEASE,
  MAX_RELEASE_EXCLUSIVE,
  parseVersionTag,
  compareVersionTags,
} from '../../tools/release/generate-legacy-skill-hashes.mjs';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

/**
 * Returns whether the `[major, minor, patch]` base of `tag` is at least `MIN_RELEASE`.
 * A tuple with fewer than three positions is malformed input, so the function throws.
 */
function baseAtLeastMin(tag: string): boolean {
  const v = parseVersionTag(tag);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    const got = v.base[i];
    const want = MIN_RELEASE[i];
    if (got === undefined || want === undefined) {
      throw new Error(`version tuple has no position ${i}: ${tag}`);
    }
    if (got !== want) return got > want;
  }
  return true;
}

describe('generate-legacy-skill-hashes (Task 023, DR-8)', () => {
  /**
   * Each release ref that holds skill renders must appear in a new manifest and
   * in the committed manifest. The refs are release tags only, at or above
   * `MIN_RELEASE`. A `HEAD` entry changes with each tree change and churns the
   * committed manifest. The committed file must equal a new build byte for byte.
   */
  it('legacyHashManifest_CoversAllReleaseTags', () => {
    const refs = enumerateReleaseRefs() as string[];

    expect(refs).not.toContain('HEAD');
    expect(refs.length).toBeGreaterThan(0);
    for (const t of refs) {
      expect(baseAtLeastMin(t), `${t} should be >= v2.9.0`).toBe(true);
    }

    const refsWithRenders = refs.filter(
      (ref) => (listSkillRenderPaths(ref) as string[]).length > 0,
    );
    expect(refsWithRenders.length).toBeGreaterThan(0);

    const manifest = buildManifest();
    const covered = new Set(manifest.releases as string[]);
    for (const ref of refsWithRenders) {
      expect(
        covered.has(ref),
        `manifest is missing release ${ref}`,
      ).toBe(true);
      const n = manifest.entries.filter(
        (e: { release: string }) => e.release === ref,
      ).length;
      expect(n, `release ${ref} has no entries`).toBeGreaterThan(0);
    }

    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const committedReleases = new Set(committed.releases as string[]);
    for (const ref of refsWithRenders) {
      expect(
        committedReleases.has(ref),
        `committed manifest is missing release ${ref}`,
      ).toBe(true);
    }
    expect(serializeManifest(manifest)).toBe(readFileSync(MANIFEST_PATH, 'utf8'));
  });

  /**
   * Content that differs only by CRLF and LF must hash to the same value, as a
   * string and as a `Buffer`. An install with Windows line endings then still
   * matches the record. Content with different text must not collide.
   */
  it('legacyHashManifest_HashesAreNewlineNormalized', () => {
    const lf = 'line one\nline two\nline three\n';
    const crlf = 'line one\r\nline two\r\nline three\r\n';
    const mixed = 'line one\r\nline two\nline three\r\n';

    expect(normalizeAndHash(crlf)).toBe(normalizeAndHash(lf));
    expect(normalizeAndHash(mixed)).toBe(normalizeAndHash(lf));
    expect(normalizeAndHash(Buffer.from(crlf, 'utf8'))).toBe(
      normalizeAndHash(lf),
    );
    expect(normalizeAndHash('line one\nline two\n')).not.toBe(
      normalizeAndHash(lf),
    );
    expect(normalizeAndHash(lf)).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * The generator reads git objects, never the working tree. A sandbox git
   * repository holds one committed render in the layout that the generator lists.
   * The test overwrites that file and adds an untracked render beside it, and
   * the manifest must not change. The manifest must name the render first, so
   * the comparison cannot pass on two empty manifests.
   */
  it('legacyHashGenerator_WorktreeStateIrrelevant_SameOutput', async () => {
    const render = 'skills/claude/ideate/SKILL.md';
    const sandbox = await makeRepoSandbox({
      prefix: 'legacy-hash-worktree',
      files: { [render]: '# ideate\n\ncommitted render\n' },
      git: true,
    });
    try {
      const before = serializeManifest(buildManifest({ refs: ['HEAD'], cwd: sandbox.root }));
      expect(before).toContain(render);

      sandbox.write(render, 'GARBAGE — worktree mutated by test\n');
      sandbox.write('skills/claude/__wt_probe__/SKILL.md', 'untracked probe render\n');
      expect(await sandbox.git('status', '--porcelain', '--untracked-files=all')).toContain('__wt_probe__');

      const after = serializeManifest(buildManifest({ refs: ['HEAD'], cwd: sandbox.root }));
      expect(after).toBe(before);
      expect(after).not.toContain('__wt_probe__');
    } finally {
      sandbox.remove();
    }
  });

  /**
   * The legacy window is `[MIN_RELEASE, MAX_RELEASE_EXCLUSIVE)`. Without the upper
   * bound, a new `v2.12.x` tag makes a new manifest differ from the committed one.
   * The synthetic tags span both bounds, and `v2.12.0-preview.1` has the base of
   * the upper bound. Enumeration reads only `git tag`, so lightweight tags on an
   * empty commit are sufficient.
   * The result is in ascending order, with the prerelease before its release.
   */
  it('legacyHashManifest_ExcludesReleasesAtOrAboveMaxBound', async () => {
    const repo = mkdtempSync(path.join(tmpdir(), 'legacy-hash-bound-'));
    const g = (...args: string[]) =>
      execFileAsync('git', args, { cwd: repo });
    try {
      await g('init', '-q');
      await g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed');
      for (const t of [
        'v2.8.9',
        'v2.11.0-rc.1',
        'v2.11.0',
        'v2.12.0-preview.1',
        'v2.13.5',
      ]) {
        await g('tag', t);
      }

      const refs = enumerateReleaseRefs({ cwd: repo }) as string[];

      expect(refs).toEqual(['v2.11.0-rc.1', 'v2.11.0']);
      expect(refs).not.toContain('v2.8.9');
      expect(refs).not.toContain('v2.12.0-preview.1');
      expect(refs).not.toContain('v2.13.5');
    } finally {
      rmrf(repo);
    }
  });

  /** Pins the constants: the upper bound is the rename release `v2.12.0`, and the window is not empty. */
  it('MAX_RELEASE_EXCLUSIVE_IsTheRenameBoundaryAboveMin', () => {
    expect(MAX_RELEASE_EXCLUSIVE).toEqual([2, 12, 0]);
    const [maxMajor, maxMinor] = MAX_RELEASE_EXCLUSIVE;
    const [minMajor, minMinor] = MIN_RELEASE;
    if (
      maxMajor === undefined ||
      maxMinor === undefined ||
      minMajor === undefined ||
      minMinor === undefined
    ) {
      throw new Error('each release bound must carry a major and a minor');
    }
    expect(maxMajor > minMajor || (maxMajor === minMajor && maxMinor > minMinor)).toBe(true);
  });

  /** Pins `compareVersionTags`, which sets the order of the manifest. */
  it('release enumeration is version-ordered with prereleases before release', () => {
    const sample = [
      'v2.10.0',
      'v2.9.0-rc.1',
      'v2.9.0',
      'v2.10.0-preview.2',
      'v2.10.0-rc.1',
      'v2.9.0-rc.2',
    ];
    const sorted = [...sample].sort(compareVersionTags);
    expect(sorted).toEqual([
      'v2.9.0-rc.1',
      'v2.9.0-rc.2',
      'v2.9.0',
      'v2.10.0-preview.2',
      'v2.10.0-rc.1',
      'v2.10.0',
    ]);
  });
});
