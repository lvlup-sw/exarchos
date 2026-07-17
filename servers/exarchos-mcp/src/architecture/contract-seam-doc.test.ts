import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'invariant-schema.ts');
// docs/ lives at the repo root, four levels up from src/architecture/.
const DOC_PATH = path.join(
  here,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'architecture',
  'invariants-v3-contract-seam.md',
);

/** Discover every top-level exported `*Schema` name from the source. */
function exportedSchemaNames(source: string): string[] {
  const names: string[] = [];
  const re = /^export\s+const\s+([A-Za-z0-9_]+Schema)\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) names.push(m[1]!);
  return names;
}

describe('invariants-v3 contract-seam doc', () => {
  // T-24: the doc must enumerate every exported top-level v3 schema, so the
  // hand-written → generated seam stays complete as schemas are added.
  it('ContractSeamDoc_EnumeratesEveryV3Type', () => {
    const schemaSource = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const names = exportedSchemaNames(schemaSource);
    expect(names.length).toBeGreaterThan(0);

    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    for (const name of names) {
      expect(doc, `doc must mention exported schema ${name}`).toContain(name);
    }
  });
});
