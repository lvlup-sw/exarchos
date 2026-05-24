import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFile, scanPaths } from './vocabulary-lint.js';

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
});
