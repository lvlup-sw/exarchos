/**
 * Containment checks over the committed repository tree, and the proof that
 * `package.json` ships each projection root.
 *
 *   1. Each projection kind has at least one projection.
 *   2. The tree passes containment for presence and selection.
 *   3. For each kind, a seeded removal or replacement of a real projection fails.
 *      A seeded stale duplicate fails only when it is ahead of the packaged layer.
 *   4. `package.json` `files[]` declares each projection root, or its embedded-binary carrier.
 *
 * The packaged layer is an in-memory copy of the committed generated trees, not the
 * bytes of a real tarball. It comes from the same read as the required inventory,
 * so an unchanged copy always passes. `tests/core/packaged/containment.test.ts`
 * proves containment against the bytes of a real `npm pack`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  PROJECTION_KINDS,
  PROJECTION_ROOT_SPECS,
  assertContainment,
  checkShippedCoverage,
  enumerateProjections,
  packagedLayerFromContents,
  verifyContainment,
  type ProjectionKind,
  type ProjectionLayer,
  type RequiredProjection,
} from '../../../src/install/projection-containment.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** One enumeration of the repository tree, which every test reads. */
const { projections, contents } = enumerateProjections(repoRoot);

function byKind(kind: ProjectionKind): readonly RequiredProjection[] {
  return projections.filter((p) => p.kind === kind);
}

function firstOfKind(kind: ProjectionKind): RequiredProjection {
  const p = byKind(kind)[0];
  if (p === undefined) throw new Error(`no real projection found for kind '${kind}'`);
  return p;
}

describe('generated projection containment — real tree', () => {
  it('populates every projection kind (enumeration is not vacuous)', () => {
    for (const kind of PROJECTION_KINDS) {
      expect(byKind(kind).length, `no ${kind} projections enumerated`).toBeGreaterThan(0);
    }
    expect(projections.length).toBeGreaterThan(40);
    expect(new Set(projections.map((p) => p.id)).size).toBe(projections.length);
  });

  it('(a) the real current tree PASSES containment (present + selected)', () => {
    const packaged = packagedLayerFromContents(contents);
    const res = assertContainment({ required: projections, layers: [packaged] });
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(projections.length);
  });

  /** The packaged layer has the highest priority, so each projection resolves to the packaged copy. */
  it('(a) a planted stale SOURCE-FALLBACK at lower priority does not win selection', () => {
    const packaged = packagedLayerFromContents(contents);
    const staleFiles = new Map<string, string>();
    for (const [p, c] of contents) staleFiles.set(p, `${c}\n// STALE DUPLICATE`);
    const stale: ProjectionLayer = { name: 'source-fallback', packaged: false, files: staleFiles };

    expect(verifyContainment({ required: projections, layers: [packaged, stale] }).ok).toBe(true);
  });

  /**
   * The packaged layer still holds the correct bytes, so presence passes. Each
   * violation is `not-selected`, because the stale copy wins the search order.
   */
  it('a stale layer AHEAD of the package shadows every projection (not-selected)', () => {
    const packaged = packagedLayerFromContents(contents);
    const staleFiles = new Map<string, string>();
    for (const [p, c] of contents) staleFiles.set(p, `${c}\n// STALE DUPLICATE`);
    const stale: ProjectionLayer = { name: 'stale-cache', packaged: false, files: staleFiles };

    const res = verifyContainment({ required: projections, layers: [stale, packaged] });
    expect(res.ok).toBe(false);
    expect(res.violations.every((v) => v.kind === 'not-selected')).toBe(true);
    expect(res.violations).toHaveLength(projections.length);
  });
});

/** Seeded removal, replacement and stale-duplicate cases against a real projection of each kind. */
describe.each(PROJECTION_KINDS)('exit-proof against real %s projections', (kind) => {
  it('(b) removing a real projection fails closed with `missing`', () => {
    const sample = firstOfKind(kind);
    const files = new Map(contents);
    files.delete(sample.path);
    const res = verifyContainment({
      required: projections,
      layers: [{ name: 'packaged', packaged: true, files }],
    });
    const v = res.violations.find((x) => x.kind === 'missing' && x.id === sample.id);
    expect(v, `expected a missing violation for ${sample.id}`).toBeDefined();
    expect(v?.projection).toBe(kind);
  });

  it('(c) replacing a real projection with different bytes fails with `content-mismatch`', () => {
    const sample = firstOfKind(kind);
    const original = contents.get(sample.path);
    expect(original).toBeDefined();
    const files = new Map(contents);
    files.set(sample.path, `${original}\n<!-- tampered -->`);
    const res = verifyContainment({
      required: projections,
      layers: [{ name: 'packaged', packaged: true, files }],
    });
    const v = res.violations.find((x) => x.kind === 'content-mismatch' && x.id === sample.id);
    expect(v, `expected a content-mismatch for ${sample.id}`).toBeDefined();
    expect(v?.projection).toBe(kind);
  });

  it('(d) a stale duplicate loses at lower priority but shadows at higher priority', () => {
    const sample = firstOfKind(kind);
    const original = contents.get(sample.path);
    expect(original).toBeDefined();
    const packaged = packagedLayerFromContents(contents);
    const stale: ProjectionLayer = {
      name: 'source-fallback',
      packaged: false,
      files: new Map([[sample.path, `${original}\n<!-- stale -->`]]),
    };

    const low = verifyContainment({ required: projections, layers: [packaged, stale] });
    expect(low.violations.filter((v) => v.id === sample.id)).toHaveLength(0);

    const high = verifyContainment({ required: projections, layers: [stale, packaged] });
    expect(high.violations.some((v) => v.kind === 'not-selected' && v.id === sample.id)).toBe(true);
  });
});

/** These cases read the real `package.json` and make sure that `files[]` ships each projection root. */
describe('projection roots are actually shipped (package.json files[])', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    files?: unknown;
  };
  const files: string[] = Array.isArray(pkg.files) ? pkg.files.filter((e): e is string => typeof e === 'string') : [];

  it('package.json declares a files[] allow-list', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every projection kind root is declared in files[] (or its embedded carrier)', () => {
    const res = checkShippedCoverage(files);
    expect(res.ok, `unshipped projection roots: ${res.violations.map((v) => `${v.kind}:${v.entry}`).join(', ')}`).toBe(
      true,
    );
  });

  /**
   * `findCommandAliasesSourceDir` resolves `rendered/command-aliases` at install time,
   * so `files[]` must hold the `rendered` root. Without that root, the alias install
   * copies nothing and reports no error.
   */
  it('the command-aliases projection root ships (regression for the P05-03 packaging gap)', () => {
    expect(files).toContain('rendered');
  });

  it('each npm-files projection root resolves to a real path on disk', () => {
    for (const spec of PROJECTION_ROOT_SPECS) {
      if (spec.shipped.via !== 'npm-files') continue;
      expect(existsSync(join(repoRoot, spec.root)), `projection root missing on disk: ${spec.root}`).toBe(true);
    }
  });

  /** The generated `embedded.ts` table carries the runtime projection, and `runtimes:guard` keeps it equal to the YAML sources. */
  it('the runtime projection is carried by the codegen-embedded table (embedded-binary delivery)', () => {
    const runtimeSpec = PROJECTION_ROOT_SPECS.find((s) => s.kind === 'runtime');
    expect(runtimeSpec?.shipped.via).toBe('embedded-binary');
    expect(existsSync(join(repoRoot, 'src', 'install', 'runtimes', 'embedded.ts'))).toBe(true);
  });
});
