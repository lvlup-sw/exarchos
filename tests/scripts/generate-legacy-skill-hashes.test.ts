/**
 * Tests for the multi-release legacy-render hash manifest generator
 * (Task 023, DR-8).
 *
 * The manifest (`tools/migrations/legacy-skill-render-hashes.json`) records the
 * newline-normalized content hash of every per-runtime skill render across
 * immutable release tags (>= v2.9.0) — release tags ONLY, never a drifting
 * HEAD pseudo-release — so a later `cleanStaleFiles` pass can prove a
 * consumer's on-disk skill file provably came from us before deleting it.
 * Two properties are load-bearing and pinned here:
 *
 *   1. The hash is newline-normalized (CRLF and LF content hash identically),
 *      so a consumer whose install differs only by line endings still matches.
 *   2. The generator reads GIT OBJECTS, never the working tree — mutating or
 *      removing worktree `skills/` files must not change its output. This is
 *      what keeps a concurrent skills-regeneration deletion from orphaning a
 *      legitimately-installed render.
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
  // The generator is ESM `.mjs`; vitest resolves it fine from a `.ts` test.
  // No declarations for the plain-JS generator; `allowJs` infers them.
} from '../../tools/release/generate-legacy-skill-hashes.mjs';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

/** Numeric compare of `[maj,min,patch]` against MIN_RELEASE. */
function baseAtLeastMin(tag: string): boolean {
  const v = parseVersionTag(tag);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    const got = v.base[i];
    const want = MIN_RELEASE[i];
    // A tuple shorter than three positions is a malformed input, not a version
    // that sorts low — saying so beats comparing against `undefined`. The `as`
    // this replaces asserted the length rather than checking it.
    if (got === undefined || want === undefined) {
      throw new Error(`version tuple has no position ${i}: ${tag}`);
    }
    if (got !== want) return got > want;
  }
  return true;
}

describe('generate-legacy-skill-hashes (Task 023, DR-8)', () => {
  it('legacyHashManifest_CoversAllReleaseTags', () => {
    // Every enumerated release ref that carries skill renders must appear in
    // the manifest. We enumerate independently, drop refs with no renders
    // (per the acceptance wording "that had skill renders"), and assert
    // coverage against a freshly-built manifest.
    const refs = enumerateReleaseRefs() as string[];

    // Sanity: enumeration is release tags ONLY — no HEAD pseudo-release —
    // and honors the >= v2.9.0 floor, so every ref is a qualifying v2.* tag.
    // (A HEAD entry would drift on every tree change and churn the committed
    // manifest, which is why the owner decision dropped it.)
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

    // The committed manifest on disk is the deliverable — it must also cover
    // every render-bearing ref (the generator is byte-idempotent, so the
    // committed file equals a fresh build).
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

  it('legacyHashManifest_HashesAreNewlineNormalized', () => {
    // A render that differs only by CRLF vs LF must hash identically, so a
    // consumer install with Windows line endings still matches our record.
    const lf = 'line one\nline two\nline three\n';
    const crlf = 'line one\r\nline two\r\nline three\r\n';
    const mixed = 'line one\r\nline two\nline three\r\n';

    expect(normalizeAndHash(crlf)).toBe(normalizeAndHash(lf));
    expect(normalizeAndHash(mixed)).toBe(normalizeAndHash(lf));
    // Buffer input (as read from git) normalizes the same way.
    expect(normalizeAndHash(Buffer.from(crlf, 'utf8'))).toBe(
      normalizeAndHash(lf),
    );
    // Content that genuinely differs must NOT collide.
    expect(normalizeAndHash('line one\nline two\n')).not.toBe(
      normalizeAndHash(lf),
    );
    // Digest shape.
    expect(normalizeAndHash(lf)).toMatch(/^[0-9a-f]{64}$/u);
  });

  /**
   * The generator reads git objects, never the working tree. A sandbox git
   * repository holds one committed render in the layout the generator lists.
   * The test overwrites that file and adds an untracked render beside it, and
   * the manifest must not change (#2030). The manifest must name the render
   * first, so the comparison cannot pass on two empty manifests.
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

  it('legacyHashManifest_ExcludesReleasesAtOrAboveMaxBound', async () => {
    // The legacy window is frozen at [MIN_RELEASE, MAX_RELEASE_EXCLUSIVE): the
    // rename release (v2.12.0) and everything after carry no old-name per-runtime
    // renders, and — critically — an unbounded set makes a fresh buildManifest()
    // diverge from the committed manifest the instant a v2.12.x tag exists, so a
    // future release (or any CI run after it) would red the byte-equality check.
    // Enumerate against a synthetic tag set spanning both bounds; only in-window
    // tags survive (lightweight tags need no trees — enumeration is `git tag` only).
    const repo = mkdtempSync(path.join(tmpdir(), 'legacy-hash-bound-'));
    const g = (...args: string[]) =>
      execFileAsync('git', args, { cwd: repo });
    try {
      await g('init', '-q');
      await g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed');
      for (const t of [
        'v2.8.9', // below MIN — excluded
        'v2.11.0-rc.1', // in-window prerelease
        'v2.11.0', // in-window release
        'v2.12.0-preview.1', // == MAX base — excluded (the rename release)
        'v2.13.5', // above MAX — excluded
      ]) {
        await g('tag', t);
      }

      const refs = enumerateReleaseRefs({ cwd: repo }) as string[];

      // Ascending, prerelease before release, bounded on BOTH sides.
      expect(refs).toEqual(['v2.11.0-rc.1', 'v2.11.0']);
      expect(refs).not.toContain('v2.8.9');
      expect(refs).not.toContain('v2.12.0-preview.1');
      expect(refs).not.toContain('v2.13.5');
    } finally {
      rmrf(repo);
    }
  });

  it('MAX_RELEASE_EXCLUSIVE_IsTheRenameBoundaryAboveMin', () => {
    // Guards the constants themselves: the window is non-empty and the upper bound
    // is the rename release the spec ships (v2.12.0).
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

  it('release enumeration is version-ordered with prereleases before release', () => {
    // Guards the comparator the manifest ordering depends on.
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
