/**
 * Real-tree acceptance + packaging-declaration proof for generated projection
 * containment (P05-03; ART-008).
 *
 * Unlike the pure unit tests, this reads the ACTUAL committed repo tree, derives
 * the governed inventory from the renderers' own outputs, and proves:
 *
 *   1. every projection kind is populated (the enumeration is not vacuous);
 *   2. the real tree PASSES containment (presence + selection) — exit-proof (a);
 *   3. per kind, a seeded removal / replacement / stale-duplicate over the REAL
 *      projections fails closed — exit-proof (b)/(c)/(d);
 *   4. every projection root is actually declared in `package.json` `files[]`
 *      (or its embedded-binary carrier) — the packaging-manifest proof that
 *      surfaced the real `command-aliases` shipping gap this work package fixed.
 *
 * ### Verified vs. simulated (honesty note)
 *
 * `dist/` is not built in this worktree and there is no published package here,
 * so the "packaged layer" is a faithful in-memory MIRROR of the committed
 * generated trees (what `npm pack` would ship, per `package.json` `files[]`),
 * NOT bytes pulled from a real tarball. The presence/selection PROPERTIES are
 * genuinely exercised over that mirror; the packaging-manifest proof (#4) is a
 * genuine check of the real `package.json`.
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
} from './projection-containment.js';

// `src/` → repo root is one level up (mirrors packaging-consistency.test.ts).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Enumerate once; every test reads from this authored source of truth.
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
    // The rendered fan-out is substantial: 16 standard skills + per-runtime
    // residuals + references + aliases + agents + hooks + runtimes.
    expect(projections.length).toBeGreaterThan(40);
    // Unique ids — the inventory has no accidental duplicates.
    expect(new Set(projections.map((p) => p.id)).size).toBe(projections.length);
  });

  it('(a) the real current tree PASSES containment (present + selected)', () => {
    const packaged = packagedLayerFromContents(contents);
    const res = assertContainment({ required: projections, layers: [packaged] });
    expect(res.ok).toBe(true);
    expect(res.checked).toBe(projections.length);
  });

  it('(a) a planted stale SOURCE-FALLBACK at lower priority does not win selection', () => {
    const packaged = packagedLayerFromContents(contents);
    const staleFiles = new Map<string, string>();
    for (const [p, c] of contents) staleFiles.set(p, `${c}\n// STALE DUPLICATE`);
    const stale: ProjectionLayer = { name: 'source-fallback', packaged: false, files: staleFiles };

    // Packaged highest priority → every projection still resolves to packaged.
    expect(verifyContainment({ required: projections, layers: [packaged, stale] }).ok).toBe(true);
  });

  it('a stale layer AHEAD of the package shadows every projection (not-selected)', () => {
    const packaged = packagedLayerFromContents(contents);
    const staleFiles = new Map<string, string>();
    for (const [p, c] of contents) staleFiles.set(p, `${c}\n// STALE DUPLICATE`);
    const stale: ProjectionLayer = { name: 'stale-cache', packaged: false, files: staleFiles };

    const res = verifyContainment({ required: projections, layers: [stale, packaged] });
    expect(res.ok).toBe(false);
    // Presence is unaffected (packaged still has the right bytes); the failure is
    // purely selection — a stale copy wins the search order for every projection.
    expect(res.violations.every((v) => v.kind === 'not-selected')).toBe(true);
    expect(res.violations).toHaveLength(projections.length);
  });
});

// Exit-proof (b)/(c)/(d) against the REAL projections of each kind.
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

    // Lower priority: the packaged copy wins, no violation for this projection.
    const low = verifyContainment({ required: projections, layers: [packaged, stale] });
    expect(low.violations.filter((v) => v.id === sample.id)).toHaveLength(0);

    // Higher priority: the stale copy shadows the packaged projection.
    const high = verifyContainment({ required: projections, layers: [stale, packaged] });
    expect(high.violations.some((v) => v.kind === 'not-selected' && v.id === sample.id)).toBe(true);
  });
});

// The packaging-manifest proof — the level at which the real finding lives.
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

  it('the command-aliases projection root ships (regression for the P05-03 packaging gap)', () => {
    // `command-aliases/` is resolved at install time from the packaged root
    // (`findCommandAliasesSourceDir` probes `<pluginRoot>/command-aliases`), so
    // it MUST be in files[] or the installed opencode alias copy silently no-ops.
    expect(files).toContain('command-aliases');
  });

  it('each npm-files projection root resolves to a real path on disk', () => {
    for (const spec of PROJECTION_ROOT_SPECS) {
      if (spec.shipped.via !== 'npm-files') continue;
      expect(existsSync(join(repoRoot, spec.root)), `projection root missing on disk: ${spec.root}`).toBe(true);
    }
  });

  it('the runtime projection is carried by the codegen-embedded table (embedded-binary delivery)', () => {
    const runtimeSpec = PROJECTION_ROOT_SPECS.find((s) => s.kind === 'runtime');
    expect(runtimeSpec?.shipped.via).toBe('embedded-binary');
    // The embedded table is the shipped carrier; runtimes:guard enforces parity.
    expect(existsSync(join(repoRoot, 'src', 'runtimes', 'embedded.ts'))).toBe(true);
  });
});
