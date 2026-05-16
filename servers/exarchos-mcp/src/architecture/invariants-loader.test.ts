import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadInvariants, type InvariantEntry } from './invariants-loader.js';

/**
 * Repo root resolution: invariants-loader.test.ts lives at
 *   servers/exarchos-mcp/src/architecture/invariants-loader.test.ts
 * Repo root is four directories up from this file.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const INVARIANTS_DOC = path.join(REPO_ROOT, 'docs/architecture/invariants.md');

const REQUIRED_INVARIANT_IDS = [
  'INV-1',
  'INV-2',
  'INV-3',
  'INV-4',
  'INV-5a',
  'INV-5b',
  'INV-5c',
  'INV-5d',
  'INV-6',
] as const;

const REQUIRED_DIMENSION_IDS = [
  'DIM-1',
  'DIM-2',
  'DIM-3',
  'DIM-4',
  'DIM-5',
  'DIM-6',
  'DIM-7',
  'DIM-8',
] as const;

describe('invariants-loader', () => {
  it('Invariants_StructuredFrontmatter_ParsesAllRequiredFields', () => {
    const entries = loadInvariants(INVARIANTS_DOC);
    expect(entries.length).toBeGreaterThan(0);

    const ids = entries.map((e) => e.id);

    // All required INV-* and DIM-* must be present.
    for (const id of REQUIRED_INVARIANT_IDS) {
      expect(ids).toContain(id);
    }
    for (const id of REQUIRED_DIMENSION_IDS) {
      expect(ids).toContain(id);
    }

    // Basileus boundary entry must be present.
    expect(ids).toContain('basileus-boundary');

    // Each entry must carry the required fields.
    for (const entry of entries) {
      expect(typeof entry.id).toBe('string');
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.dimension).toBe('string');
      expect(Array.isArray(entry.appliesTo)).toBe(true);
      expect(entry.appliesTo.length).toBeGreaterThan(0);
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.references)).toBe(true);
      expect(entry.references.length).toBeGreaterThan(0);
    }
  });

  it('Invariants_TypedEntries_HaveStableShape', () => {
    const entries = loadInvariants(INVARIANTS_DOC);
    const inv5a = entries.find((e: InvariantEntry) => e.id === 'INV-5a');
    expect(inv5a).toBeDefined();
    expect(inv5a!.dimension.toLowerCase()).toContain('input');
    // INV-5a references should point at the design-invariants skill reference file.
    const hasInv5aRef = inv5a!.references.some((r) => r.includes('INV-5a'));
    expect(hasInv5aRef).toBe(true);
  });

  it('InvariantsLoader_DuplicateIds_ThrowsWithIdInMessage', () => {
    // Construct a frontmatter fixture with two entries sharing the same id
    // (`INV-1`). The loader must reject this at load time so a silent
    // duplicate cannot shadow the legitimate entry.
    const fixture = `---
invariants:
  - id: INV-1
    dimension: event-sourcing integrity
    applies-to:
      - servers/exarchos-mcp/src/event-store
    summary: First copy of INV-1.
    references:
      - docs/architecture/invariants.md
  - id: INV-1
    dimension: duplicate
    applies-to:
      - servers/exarchos-mcp/src/event-store
    summary: Second copy of INV-1 — should be rejected.
    references:
      - docs/architecture/invariants.md
---

# Fixture
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invariants-dup-'));
    const tmpFile = path.join(tmpDir, 'invariants.md');
    fs.writeFileSync(tmpFile, fixture, 'utf8');
    try {
      expect(() => loadInvariants(tmpFile)).toThrow(/INV-1/);
      expect(() => loadInvariants(tmpFile)).toThrow(/Duplicate invariant ID/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
