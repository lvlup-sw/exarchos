/**
 * Unit tests for the projection-containment verifier core (P05-03; ART-008).
 *
 * These exercise the PURE model with synthetic, in-memory layers so every rule
 * — presence-by-digest, selection-by-resolution-order, the typed diagnostics,
 * and the shipped-`files` coverage proof — is pinned without touching the real
 * repo. The real-tree acceptance + the genuine packaging finding live in
 * `projection-containment.packaging.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { digestText } from '../../../src/install/artifact-agreement.js';
import {
  PROJECTION_KINDS,
  PROJECTION_ROOT_SPECS,
  ProjectionContainmentError,
  ShippedCoverageError,
  assertContainment,
  assertShippedCoverage,
  checkShippedCoverage,
  enumerateProjections,
  resolveWinningLayer,
  verifyContainment,
  type ProjectionKind,
  type ProjectionLayer,
  type ProjectionRootSpec,
  type RequiredProjection,
  type RepoReadFs,
} from '../../../src/install/projection-containment.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function layer(
  name: string,
  packaged: boolean,
  entries: ReadonlyArray<readonly [string, string]>,
): ProjectionLayer {
  return { name, packaged, files: new Map(entries.map(([k, v]) => [k, v])) };
}

function required(kind: ProjectionKind, path: string, content: string): RequiredProjection {
  return { id: `${kind}:${path}`, kind, path, digest: digestText(content) };
}

// ─── PROJECTION_KINDS / spec coverage ────────────────────────────────────────

describe('projection kinds & spec coverage', () => {
  it('enumerates exactly the seven governed kinds, uniquely', () => {
    expect([...PROJECTION_KINDS].sort()).toEqual(
      ['agent', 'alias', 'hook', 'instruction', 'manifest', 'runtime', 'skill'],
    );
    expect(new Set(PROJECTION_KINDS).size).toBe(PROJECTION_KINDS.length);
  });

  it('the governed root spec covers every projection kind at least once', () => {
    const covered = new Set(PROJECTION_ROOT_SPECS.map((s) => s.kind));
    for (const kind of PROJECTION_KINDS) {
      expect(covered.has(kind), `no PROJECTION_ROOT_SPECS entry for kind '${kind}'`).toBe(true);
    }
  });
});

// ─── resolveWinningLayer ─────────────────────────────────────────────────────

describe('resolveWinningLayer', () => {
  it('returns the first (highest-priority) layer carrying the path', () => {
    const a = layer('a', false, [['x', 'A']]);
    const b = layer('b', true, [['x', 'B']]);
    expect(resolveWinningLayer('x', [a, b])?.name).toBe('a');
    expect(resolveWinningLayer('x', [b, a])?.name).toBe('b');
  });

  it('returns undefined when no layer has the path', () => {
    expect(resolveWinningLayer('missing', [layer('a', true, [['x', 'A']])])).toBeUndefined();
  });
});

// ─── verifyContainment: structural guards ────────────────────────────────────

describe('verifyContainment structural guards', () => {
  const r = required('skill', 'skills/s/SKILL.md', 'body');

  it('throws when no layer is flagged packaged', () => {
    expect(() =>
      verifyContainment({ required: [r], layers: [layer('src', false, [['skills/s/SKILL.md', 'body']])] }),
    ).toThrow(/no layer is flagged `packaged`/);
  });

  it('throws when more than one layer is flagged packaged', () => {
    expect(() =>
      verifyContainment({
        required: [r],
        layers: [layer('p1', true, []), layer('p2', true, [])],
      }),
    ).toThrow(/exactly one authoritative packaged root/);
  });

  it('throws on duplicate layer names', () => {
    expect(() =>
      verifyContainment({
        required: [r],
        layers: [layer('dup', true, []), layer('dup', false, [])],
      }),
    ).toThrow(/duplicate layer name/);
  });

  it('throws on duplicate required-projection ids', () => {
    expect(() =>
      verifyContainment({
        required: [r, r],
        layers: [layer('packaged', true, [['skills/s/SKILL.md', 'body']])],
      }),
    ).toThrow(/duplicate required-projection id/);
  });
});

// ─── Exit-proof matrix, per kind, over synthetic layers ──────────────────────

describe.each(PROJECTION_KINDS)('exit-proof (synthetic): %s projection', (kind) => {
  const path = `synthetic/${kind}/example`;
  const authored = `authored ${kind} projection content\n`;
  const req = [required(kind, path, authored)];
  const packagedGood = (): ProjectionLayer => layer('packaged', true, [[path, authored]]);

  it('(a) the faithful packaged copy passes', () => {
    const res = verifyContainment({ required: req, layers: [packagedGood()] });
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(1);
    expect(res.violations).toHaveLength(0);
  });

  it('(b) a seeded REMOVAL fails closed with a `missing` diagnostic naming the projection', () => {
    const layers = [layer('packaged', true, [])];
    const res = verifyContainment({ required: req, layers });
    expect(res.ok).toBe(false);
    const v = res.violations.find((x) => x.kind === 'missing');
    expect(v?.projection).toBe(kind);
    expect(v?.path).toBe(path);
    // The assertion helper throws a typed error naming the projection kind + id.
    let thrown: unknown;
    try {
      assertContainment({ required: req, layers });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProjectionContainmentError);
    expect((thrown as ProjectionContainmentError).message).toContain(kind);
    expect((thrown as ProjectionContainmentError).message).toContain(path);
  });

  it('(c) a seeded REPLACEMENT (same path, different bytes) fails with `content-mismatch`', () => {
    const layers = [layer('packaged', true, [[path, `TAMPERED ${kind} bytes\n`]])];
    const res = verifyContainment({ required: req, layers });
    expect(res.ok).toBe(false);
    const v = res.violations.find((x) => x.kind === 'content-mismatch');
    expect(v?.projection).toBe(kind);
    expect(v?.id).toBe(`${kind}:${path}`);
  });

  it('(d) selection resolves the packaged copy; a LOWER-priority stale duplicate does not win', () => {
    const stale = layer('source-fallback', false, [[path, `STALE ${kind}\n`]]);
    const res = verifyContainment({ required: req, layers: [packagedGood(), stale] });
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('(d) a HIGHER-priority stale duplicate shadows the packaged copy → `not-selected`', () => {
    const stale = layer('stale-cache', false, [[path, `STALE ${kind}\n`]]);
    const res = verifyContainment({ required: req, layers: [stale, packagedGood()] });
    const v = res.violations.find((x) => x.kind === 'not-selected');
    expect(v?.projection).toBe(kind);
    expect(v?.detail).toContain('stale-cache');
  });

  it('(d) removing the packaged copy falls through to the stale duplicate → missing + not-selected', () => {
    const stale = layer('source-fallback', false, [[path, `STALE ${kind}\n`]]);
    const res = verifyContainment({ required: req, layers: [layer('packaged', true, []), stale] });
    expect(res.violations.some((x) => x.kind === 'missing')).toBe(true);
    expect(res.violations.some((x) => x.kind === 'not-selected')).toBe(true);
  });
});

// ─── enumerateProjections (I/O adapter over an injected fs) ───────────────────

describe('enumerateProjections (injected fs)', () => {
  const REPO = 'C:/repo';

  function fakeFs(posixFiles: Readonly<Record<string, string>>): RepoReadFs {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const keys = Object.keys(posixFiles);
    return {
      readFile: (abs) => {
        const c = posixFiles[norm(abs)];
        if (c === undefined) throw new Error(`fakeFs: no file ${abs}`);
        return c;
      },
      listFilesRecursive: (absDir) => {
        const d = `${norm(absDir)}/`;
        return keys.filter((k) => k.startsWith(d));
      },
      exists: (abs) => {
        const n = norm(abs);
        return posixFiles[n] !== undefined || keys.some((k) => k.startsWith(`${n}/`));
      },
      isDirectory: (abs) => {
        const n = norm(abs);
        return keys.some((k) => k.startsWith(`${n}/`));
      },
    };
  }

  const specs: readonly ProjectionRootSpec[] = [
    {
      kind: 'skill',
      root: 'skills',
      rootKind: 'dir',
      include: (rel) => rel.startsWith('skills/') && rel.endsWith('.md'),
      shipped: { via: 'npm-files', entry: 'skills' },
    },
    {
      kind: 'instruction',
      root: 'AGENTS.md',
      rootKind: 'file',
      shipped: { via: 'npm-files', entry: 'AGENTS.md' },
    },
  ];

  it('derives required projections with digests from the authored bytes', () => {
    const fs = fakeFs({
      'C:/repo/skills/std/plan/SKILL.md': 'plan body\n',
      'C:/repo/skills/std/plan/references/x.md': 'ref\n',
      'C:/repo/skills/std/plan/notes.txt': 'not a projection', // excluded by include
      'C:/repo/AGENTS.md': 'orientation\n',
    });
    const { projections, contents } = enumerateProjections(REPO, specs, fs);

    const paths = projections.map((p) => p.path).sort();
    expect(paths).toEqual(['AGENTS.md', 'skills/std/plan/SKILL.md', 'skills/std/plan/references/x.md']);

    const plan = projections.find((p) => p.path === 'skills/std/plan/SKILL.md');
    expect(plan?.kind).toBe('skill');
    expect(plan?.digest).toBe(digestText('plan body\n'));
    expect(contents.get('AGENTS.md')).toBe('orientation\n');
  });

  it('throws when a required FILE projection is missing', () => {
    const fs = fakeFs({ 'C:/repo/skills/std/plan/SKILL.md': 'x\n' });
    expect(() => enumerateProjections(REPO, specs, fs)).toThrow(/instruction projection file 'AGENTS.md' is missing/);
  });

  it('throws when a required DIR root matches zero projection files (empty render)', () => {
    const fs = fakeFs({
      'C:/repo/skills/std/plan/notes.txt': 'nope', // present dir, but nothing matches include
      'C:/repo/AGENTS.md': 'a\n',
    });
    expect(() => enumerateProjections(REPO, specs, fs)).toThrow(/skill root 'skills' matched zero projection files/);
  });
});

// ─── Shipped-`files` coverage proof ──────────────────────────────────────────

describe('checkShippedCoverage', () => {
  // A files[] set that ships every kind's root (the desired end state).
  const complete = [
    'dist/bin',
    'agents',
    'commands',
    'skills',
    'rendered',
    'hooks',
    '.claude-plugin',
    'AGENTS.md',
    '!**/*.test.ts',
  ];

  it('passes when every projection root is declared in files[]', () => {
    const res = checkShippedCoverage(complete);
    expect(res.ok).toBe(true);
    expect(res.violations).toHaveLength(0);
  });

  it('fails, naming the kind, when a projection root is absent from files[]', () => {
    const withoutAliases = complete.filter((e) => e !== 'rendered');
    const res = checkShippedCoverage(withoutAliases);
    expect(res.ok).toBe(false);
    const v = res.violations.find((x) => x.kind === 'alias');
    expect(v?.entry).toBe('rendered');
    expect(v?.detail).toContain('shipped/installed artifact');
  });

  it('ignores files[] negation entries (they never satisfy a root)', () => {
    // A negation that happens to mention a root name must not count as shipping it.
    const res = checkShippedCoverage(['skills', 'agents', 'hooks', '.claude-plugin', 'AGENTS.md', 'dist/bin', '!command-aliases']);
    expect(res.violations.some((v) => v.kind === 'alias')).toBe(true);
  });

  it('assertShippedCoverage throws a typed ShippedCoverageError naming the gap', () => {
    let thrown: unknown;
    try {
      assertShippedCoverage(complete.filter((e) => e !== 'hooks'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ShippedCoverageError);
    expect((thrown as ShippedCoverageError).message).toContain('hook');
  });
});
