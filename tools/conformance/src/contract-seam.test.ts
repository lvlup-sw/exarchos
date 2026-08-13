import { describe, it, expect } from 'vitest';
import { lintSeamComments } from './contract-seam.js';
import { fromSubjectSrc } from './subject-root.js';

// The lint MOVED here; its subject did not. `invariant-schema.ts` has production
// consumers (the `invariants_add`/`amend` verbs), so task 018a left it in the
// subject tree — this path has to cross the package boundary deliberately.
const SCHEMA_PATH = fromSubjectSrc('architecture', 'invariant-schema.ts');

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
    expect(findings[0].message).toContain('BadSchema');
  });
});
