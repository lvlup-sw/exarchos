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
} from '../../../src/install/artifact-agreement.js';
import { renderBindingBlock, BINDING_SOURCE_FILE } from '../../../src/install/binding.js';
import { buildAllSkills } from '../../../src/install/build-skills.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

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

describe('checkArtifactAgreement', () => {
  /** A text digest ignores trailing newlines and the CRLF line ending. */
  it('identical copies agree', () => {
    const artifact: Artifact = {
      name: 'demo',
      copies: [
        { dimension: 'source', kind: 'text', text: 'hello\n' },
        { dimension: 'package', kind: 'text', text: 'hello' },
        { dimension: 'install', kind: 'text', text: 'hello\r\n' },
      ],
    };
    const result = checkArtifactAgreement(artifact);
    expect(result.agree).toBe(true);
    expect(result.disagreements).toEqual([]);
  });

  /** A disagreement fails and names the dimension of the copy that differs from the first copy. */
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

  /** The second copy has a different entry order, a CRLF line ending and backslash separators. */
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
            { path: 'b\\two.md', content: 'y\r\n' },
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

describe('standard artifacts agree — real repo (exit proof a)', () => {
  /**
   * The `source` copy is a new render of the authored directive. The `emitted` copy is the
   * committed `binding/standard/block.md`.
   */
  it('BindingBlock_SourceRenderAndEmitted_Agree', () => {
    const directive = readFileSync(
      join(REPO_ROOT, 'content/harness/binding', BINDING_SOURCE_FILE),
      'utf8',
    );
    const artifact: Artifact = {
      name: 'binding-block',
      copies: [
        { dimension: 'source', kind: 'text', text: renderBindingBlock(directive) },
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

  /**
   * Renders the authored content into a temporary tree and compares it with the committed
   * `rendered/skills` tree. The comparison keeps only the committed entries under a top-level
   * directory that the new render also writes.
   */
  it('SkillTree_SourceRenderAndEmitted_Agree', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'p0307-skills-'));
    mkdirSync(outDir, { recursive: true });
    buildAllSkills({
      srcDir: join(REPO_ROOT, 'content'),
      outDir,
      runtimesDir: join(REPO_ROOT, 'content/harness/runtimes'),
    });

    const source = readTree(outDir);
    const generatedRoots = new Set(source.map((e) => e.path.split('/')[0]));
    const emitted = readTree(join(REPO_ROOT, 'rendered/skills')).filter((e) =>
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

  /** One changed entry in a copy of the committed tree is a disagreement. */
  it('SkillTree_TamperedEmittedCopy_Disagrees', () => {
    const committed = readTree(join(REPO_ROOT, 'rendered/skills'));
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

describe('digestText', () => {
  it('is line-ending and trailing-newline stable', () => {
    expect(digestText('a\r\nb\n')).toBe(digestText('a\nb'));
  });
  it('is content sensitive', () => {
    expect(digestText('a')).not.toBe(digestText('b'));
  });
});
