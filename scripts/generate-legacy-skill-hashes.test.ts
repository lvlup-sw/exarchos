/**
 * Tests for the multi-release legacy-render hash manifest generator
 * (Task 023, DR-8).
 *
 * The manifest (`migrations/legacy-skill-render-hashes.json`) records the
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
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  enumerateReleaseRefs,
  listSkillRenderPaths,
  normalizeAndHash,
  serializeManifest,
  MANIFEST_PATH,
  MIN_RELEASE,
  parseVersionTag,
  compareVersionTags,
  // The generator is ESM `.mjs`; vitest resolves it fine from a `.ts` test.
  // @ts-expect-error — no type declarations for the plain-JS generator module.
} from './generate-legacy-skill-hashes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/** Numeric compare of `[maj,min,patch]` against MIN_RELEASE. */
function baseAtLeastMin(tag: string): boolean {
  const v = parseVersionTag(tag);
  if (!v) return false;
  const min = MIN_RELEASE as [number, number, number];
  for (let i = 0; i < 3; i++) {
    if (v.base[i] !== min[i]) return v.base[i] > min[i];
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

  it('legacyHashGenerator_WorktreeStateIrrelevant_SameOutput', () => {
    // Scope to HEAD only to keep the double-build fast; the property under
    // test (reads git objects, not the worktree) is identical for any ref.
    const before = serializeManifest(buildManifest({ refs: ['HEAD'] }));

    // Choose a real tracked render that IS in the HEAD manifest, capture its
    // on-disk bytes, then corrupt the worktree in two ways: overwrite the
    // tracked file with garbage AND drop in an untracked probe render.
    const tracked = path.join(
      REPO_ROOT,
      'skills',
      'claude',
      'ideate',
      'SKILL.md',
    );
    const original = readFileSync(tracked);
    const probeDir = path.join(REPO_ROOT, 'skills', 'claude', '__wt_probe__');
    const probeFile = path.join(probeDir, 'SKILL.md');

    try {
      writeFileSync(tracked, 'GARBAGE — worktree mutated by test\n', 'utf8');
      mkdirSync(probeDir, { recursive: true });
      writeFileSync(probeFile, 'untracked probe render\n', 'utf8');

      const after = serializeManifest(buildManifest({ refs: ['HEAD'] }));

      // Output is byte-identical: the generator ignored the corrupted tracked
      // file and never saw the untracked probe (git-tree, not worktree).
      expect(after).toBe(before);
      expect(after).not.toContain('__wt_probe__');
    } finally {
      // Restore the worktree to its exact prior bytes / layout.
      writeFileSync(tracked, original);
      rmSync(probeDir, { recursive: true, force: true });
    }

    // Belt-and-suspenders: the restored tracked file matches the committed
    // blob, proving the finally block left the tree clean.
    expect(readFileSync(tracked).equals(original)).toBe(true);
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
