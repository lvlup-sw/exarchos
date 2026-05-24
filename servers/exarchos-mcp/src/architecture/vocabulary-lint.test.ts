import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile, scanPaths, scanCoverageClosure } from './vocabulary-lint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs/architecture/invariants.md');

/**
 * Pass an explicit `enabled` config so the test fixture is decoupled
 * from the state of the repo's actual `.exarchos.yml`. The Wave B3
 * commit declares the flag in the root file; this constant keeps the
 * tests stable independent of that landing order. See Wave B2 in
 * docs/proposals/2026-05-20-invariants-catalog-v2-spec.md §4.0.
 */
const ENABLED_CONFIG = { invariants: { devCatalog: 'enabled' as const } };

describe('vocabulary-lint', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-lint-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('VocabularyLint_UnknownInvariantReference_Fails', () => {
    const fixture = path.join(tmpDir, 'unknown-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-99 which does not exist.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBeGreaterThan(0);
    const inv99 = findings.find((f) => f.token === 'INV-99');
    expect(inv99).toBeDefined();
    expect(inv99!.kind).toBe('unknown-invariant');
  });

  it('VocabularyLint_KnownInvariantReference_Passes', () => {
    const fixture = path.join(tmpDir, 'known-ref.md');
    fs.writeFileSync(
      fixture,
      'Some prose referencing INV-1 which is documented.\n',
    );
    const findings = scanFile(fixture, {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings).toEqual([]);
  });

  it('VocabularyLint_MultipleFileScan_AggregatesFindings', () => {
    const subDir = path.join(tmpDir, 'multi');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'a.md'), 'Prose with INV-1 and INV-77.\n');
    fs.writeFileSync(path.join(subDir, 'b.md'), 'Prose with DIM-3 and DIM-42.\n');
    const findings = scanPaths([subDir], {
      invariantsDoc: INVARIANTS_DOC,
      config: ENABLED_CONFIG,
    });
    expect(findings.length).toBe(2);
    const tokens = findings.map((f) => f.token).sort();
    expect(tokens).toEqual(['DIM-42', 'INV-77']);
    // Each finding carries file + line.
    for (const f of findings) {
      expect(typeof f.file).toBe('string');
      expect(typeof f.line).toBe('number');
      expect(f.line).toBeGreaterThan(0);
    }
  });

  /**
   * Coverage-closure check (DR-8). Every `DIM-*` entry in the catalog must
   * either be specialized by at least one `INV-*` whose `axiom_overlap`
   * points at it, OR carry an explicit N/A marker. The N/A convention is the
   * least-invasive option: a frontmatter field `coverage: n/a` on the DIM
   * entry. A `DIM-*` with neither is a coverage-gap finding.
   *
   * Uses a synthetic fixture catalog written to disk so the assertion is
   * decoupled from the live catalog's closure state (which may legitimately
   * change as INV/DIM entries are added).
   */
  it('VocabularyLint_DimWithoutSpecializingInv_EmitsCoverageGap', () => {
    const fixture = path.join(tmpDir, 'coverage-fixture.md');
    fs.writeFileSync(
      fixture,
      [
        '---',
        'schema-version: 2',
        'invariants:',
        // DIM-901: NOT referenced by any INV, no N/A marker → coverage gap.
        '  - id: DIM-901',
        '    dimension: gap-dimension',
        '    axis: substrate',
        '    cost-of-load: reference-only',
        '    applies-to: [some-module]',
        '    summary: A dimension with no specializing invariant and no N/A marker.',
        '    references: [docs/architecture/invariants.md]',
        // DIM-902: referenced by INV-100 via axiom_overlap → no gap.
        '  - id: DIM-902',
        '    dimension: covered-dimension',
        '    axis: substrate',
        '    cost-of-load: reference-only',
        '    applies-to: [other-module]',
        '    summary: A dimension specialized by an invariant.',
        '    references: [docs/architecture/invariants.md]',
        // DIM-903: no specializing INV, but carries the explicit N/A marker.
        '  - id: DIM-903',
        '    dimension: exempt-dimension',
        '    axis: substrate',
        '    cost-of-load: reference-only',
        '    coverage: n/a',
        '    applies-to: [third-module]',
        '    summary: A dimension explicitly marked not-applicable for closure.',
        '    references: [docs/architecture/invariants.md]',
        // INV-100 specializes DIM-902.
        '  - id: INV-100',
        '    dimension: an-invariant',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    axiom_overlap: DIM-902',
        '    applies-to: [other-module]',
        '    summary: An invariant that specializes DIM-902.',
        '    references: [docs/architecture/invariants.md]',
        '---',
        '',
        '# Synthetic coverage fixture',
        '',
      ].join('\n'),
    );

    const findings = scanCoverageClosure({
      invariantsDoc: fixture,
      config: ENABLED_CONFIG,
    });

    // DIM-901 is the only gap: neither a specializing INV nor the marker.
    const gapTokens = findings.map((f) => f.token).sort();
    expect(gapTokens).toEqual(['DIM-901']);
    const gap = findings.find((f) => f.token === 'DIM-901');
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe('coverage-gap');

    // DIM-902 (covered by INV) and DIM-903 (N/A marker) must NOT surface.
    expect(findings.some((f) => f.token === 'DIM-902')).toBe(false);
    expect(findings.some((f) => f.token === 'DIM-903')).toBe(false);
  });

  /**
   * DR-8 closure is specifically `INV-* -> axiom_overlap -> DIM-*`. Only an
   * INV-* entry may close a DIM gap. A non-INV-* entry (here an SDLC-* one)
   * that carries `axiom_overlap` pointing at a DIM must NOT be counted as a
   * specialization — otherwise it would mask a genuine coverage gap.
   */
  it('VocabularyLint_NonInvAxiomOverlap_DoesNotCloseGap', () => {
    const fixture = path.join(tmpDir, 'coverage-non-inv-fixture.md');
    fs.writeFileSync(
      fixture,
      [
        '---',
        'schema-version: 3',
        'invariants:',
        // DIM-910: the only would-be specializer is a non-INV-* entry, so this
        // dimension is still an uncovered gap.
        '  - id: DIM-910',
        '    dimension: masked-dimension',
        '    axis: substrate',
        '    cost-of-load: reference-only',
        '    applies-to: [some-module]',
        '    summary: A dimension a non-INV entry falsely claims to specialize.',
        '    references: [docs/architecture/invariants.md]',
        // SDLC-50: carries axiom_overlap: DIM-910 but is NOT an INV-* — it must
        // not close DIM-910.
        '  - id: SDLC-50',
        '    dimension: a-consumer-invariant',
        '    axis: substrate',
        '    cost-of-load: always-load',
        '    axiom_overlap: DIM-910',
        '    applies-to: [some-module]',
        '    summary: A consumer-tier invariant that is not an INV-*.',
        '    references: [docs/architecture/invariants.md]',
        '---',
        '',
        '# Non-INV specialization fixture',
        '',
      ].join('\n'),
    );

    const findings = scanCoverageClosure({
      invariantsDoc: fixture,
      config: ENABLED_CONFIG,
    });

    // DIM-910 remains a gap: the SDLC-* overlap does not count.
    const gap = findings.find((f) => f.token === 'DIM-910');
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe('coverage-gap');
  });
});
