import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkArtifactAgreement,
  assertArtifactsAgree,
  ArtifactDisagreementError,
  digestText,
  type Artifact,
  type DigestEntry,
} from './artifact-agreement.js';
import { renderBindingBlock, BINDING_SOURCE_FILE } from './binding.js';
import { buildAllSkills } from './build-skills.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Read every file under `root` into POSIX-relative `DigestEntry`s. */
function readTree(root: string): DigestEntry[] {
  const out: DigestEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else {
        out.push({
          path: relative(root, full).replace(/\\/g, '/'),
          content: readFileSync(full, 'utf8'),
        });
      }
    }
  }
  return out;
}

// ─── Pure agreement semantics ────────────────────────────────────────────────

describe('checkArtifactAgreement', () => {
  it('identical copies agree', () => {
    const artifact: Artifact = {
      name: 'demo',
      copies: [
        { dimension: 'source', kind: 'text', text: 'hello\n' },
        { dimension: 'package', kind: 'text', text: 'hello' }, // trailing-newline-insensitive
        { dimension: 'install', kind: 'text', text: 'hello\r\n' }, // CRLF-insensitive
      ],
    };
    const result = checkArtifactAgreement(artifact);
    expect(result.agree).toBe(true);
    expect(result.disagreements).toEqual([]);
  });

  // Exit proof (b): a seeded disagreement FAILS and names the diverging copy.
  it('ArtifactAgreement_SeededDisagreement_Fails', () => {
    const artifact: Artifact = {
      name: 'demo',
      copies: [
        { dimension: 'source', kind: 'text', text: 'hello' },
        { dimension: 'cache', kind: 'text', text: 'hello — tampered' },
      ],
    };
    const result = checkArtifactAgreement(artifact);
    expect(result.agree).toBe(false);
    expect(result.disagreements.map((d) => d.dimension)).toEqual(['cache']);
  });

  it('tree copies agree order-independently and across path separators', () => {
    const artifact: Artifact = {
      name: 'tree',
      copies: [
        {
          dimension: 'source',
          kind: 'tree',
          entries: [
            { path: 'a/one.md', content: 'x\n' },
            { path: 'b/two.md', content: 'y\n' },
          ],
        },
        {
          dimension: 'install',
          kind: 'tree',
          entries: [
            { path: 'b\\two.md', content: 'y\r\n' }, // reordered + CRLF + backslash
            { path: 'a\\one.md', content: 'x\n' },
          ],
        },
      ],
    };
    expect(checkArtifactAgreement(artifact).agree).toBe(true);
  });

  it('tree seeded disagreement fails', () => {
    const artifact: Artifact = {
      name: 'tree',
      copies: [
        { dimension: 'source', kind: 'tree', entries: [{ path: 'a.md', content: 'x' }] },
        { dimension: 'install', kind: 'tree', entries: [{ path: 'a.md', content: 'DIFFERENT' }] },
      ],
    };
    expect(checkArtifactAgreement(artifact).agree).toBe(false);
  });

  it('single copy trivially agrees', () => {
    expect(
      checkArtifactAgreement({
        name: 'lonely',
        copies: [{ dimension: 'source', kind: 'text', text: 'x' }],
      }).agree,
    ).toBe(true);
  });

  it('duplicate dimension throws', () => {
    expect(() =>
      checkArtifactAgreement({
        name: 'dup',
        copies: [
          { dimension: 'source', kind: 'text', text: 'a' },
          { dimension: 'source', kind: 'text', text: 'b' },
        ],
      }),
    ).toThrow(/duplicate dimension/);
  });
});

describe('assertArtifactsAgree', () => {
  it('throws ArtifactDisagreementError on divergence', () => {
    expect(() =>
      assertArtifactsAgree([
        {
          name: 'x',
          copies: [
            { dimension: 'source', kind: 'text', text: 'a' },
            { dimension: 'install', kind: 'text', text: 'b' },
          ],
        },
      ]),
    ).toThrow(ArtifactDisagreementError);
  });

  it('returns per-artifact agreement on success', () => {
    const results = assertArtifactsAgree([
      { name: 'x', copies: [{ dimension: 'source', kind: 'text', text: 'a' }] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.agree).toBe(true);
  });
});

// ─── Real-repo agreement (exit proof a) ──────────────────────────────────────

describe('standard artifacts agree — real repo (exit proof a)', () => {
  it('BindingBlock_SourceRenderAndEmitted_Agree', () => {
    const directive = readFileSync(
      join(REPO_ROOT, 'binding-src', BINDING_SOURCE_FILE),
      'utf8',
    );
    const artifact: Artifact = {
      name: 'binding-block',
      copies: [
        // source: re-rendered from the single authored directive.
        { dimension: 'source', kind: 'text', text: renderBindingBlock(directive) },
        // emitted: the committed block the package/install/cache carry.
        {
          dimension: 'emitted',
          kind: 'text',
          text: readFileSync(join(REPO_ROOT, 'binding', 'standard', 'block.md'), 'utf8'),
        },
      ],
    };
    const result = checkArtifactAgreement(artifact);
    expect(result.disagreements).toEqual([]);
    expect(result.agree).toBe(true);
  });

  it('SkillTree_SourceRenderAndEmitted_Agree', () => {
    // Render the authored skills-src into a throwaway tree, then digest it
    // against the committed skills/ tree that flows into package/install/cache.
    const outDir = mkdtempSync(join(tmpdir(), 'p0307-skills-'));
    mkdirSync(outDir, { recursive: true });
    buildAllSkills({
      srcDir: join(REPO_ROOT, 'skills-src'),
      outDir,
      runtimesDir: join(REPO_ROOT, 'runtimes'),
    });

    // The committed `skills/` tree carries NON-generated auxiliary files
    // (`test-fixtures/`, `trigger-tests/`, loose `*.sh` validators) alongside
    // the rendered output. The agreement is scoped to the GENERATED surface —
    // the top-level subtrees the renderer actually writes (`standard/` + one
    // per runtime) — derived from the fresh render, not hard-coded.
    const source = readTree(outDir);
    const generatedRoots = new Set(source.map((e) => e.path.split('/')[0]));
    const emitted = readTree(join(REPO_ROOT, 'skills')).filter((e) =>
      generatedRoots.has(e.path.split('/')[0]),
    );

    const artifact: Artifact = {
      name: 'skill-tree',
      copies: [
        { dimension: 'source', kind: 'tree', entries: source },
        { dimension: 'emitted', kind: 'tree', entries: emitted },
      ],
    };
    const result = checkArtifactAgreement(artifact);
    expect(result.disagreements).toEqual([]);
    expect(result.agree).toBe(true);
  }, 30000);

  // Exit proof (b) on real data: a tampered emitted copy is caught.
  it('SkillTree_TamperedEmittedCopy_Disagrees', () => {
    const committed = readTree(join(REPO_ROOT, 'skills'));
    expect(committed.length).toBeGreaterThan(0);
    const tampered = committed.map((e, i) =>
      i === 0 ? { path: e.path, content: e.content + '\n<!-- drift -->' } : e,
    );
    const result = checkArtifactAgreement({
      name: 'skill-tree',
      copies: [
        { dimension: 'source', kind: 'tree', entries: committed },
        { dimension: 'cache', kind: 'tree', entries: tampered },
      ],
    });
    expect(result.agree).toBe(false);
    expect(result.disagreements.map((d) => d.dimension)).toEqual(['cache']);
  });
});

// ─── Sanity on the digest primitive ──────────────────────────────────────────

describe('digestText', () => {
  it('is line-ending and trailing-newline stable', () => {
    expect(digestText('a\r\nb\n')).toBe(digestText('a\nb'));
  });
  it('is content sensitive', () => {
    expect(digestText('a')).not.toBe(digestText('b'));
  });
});
