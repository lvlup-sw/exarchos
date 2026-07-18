import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSeamComments } from './contract-seam.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(here, 'invariant-schema.ts');

describe('lintSeamComments', () => {
  // The real schema module has a `// contract-shaped:` comment above every
  // top-level exported schema, so the lint yields no findings.
  it('SeamLint_RealSchema_NoFindings', () => {
    const findings = lintSeamComments(SCHEMA_PATH);
    expect(findings).toEqual([]);
  });

  // A source whose exported schema lacks the seam comment yields a finding
  // naming the offending export.
  it('SeamLint_V3TypeMissingSeamComment_Fails', () => {
    const source = [
      "import { z } from 'zod';",
      '',
      '// contract-shaped: Good',
      'export const GoodSchema = z.object({ a: z.string() });',
      '',
      'export const BadSchema = z.object({ b: z.string() });',
    ].join('\n');

    const findings = lintSeamComments(SCHEMA_PATH, source);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain('BadSchema');
  });
});
