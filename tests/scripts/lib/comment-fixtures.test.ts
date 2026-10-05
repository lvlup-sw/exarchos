import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, isExempt } from '../../../tools/audit/lib/comment-policy.mjs';
import { extractComments } from '../../../tools/audit/lib/comment-prose.mjs';
import { classifyComment } from '../../../tools/audit/lib/comment-classifier.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURES = path.join(REPO_ROOT, 'tools/audit/__fixtures__/comment-hygiene');
const policy = loadPolicy(path.join(REPO_ROOT, '.exarchos/comment-policy.json'));

function findingsFor(fixture: string) {
  const rel = `tools/audit/__fixtures__/comment-hygiene/${fixture}`;
  const source = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return extractComments(source, rel).flatMap((comment) => classifyComment(comment, policy));
}

describe('kill fixtures', () => {
  /** Some comments in the fixture are prose about it, so the test asserts a floor on the finding count. */
  it('Fixtures_EveryOffender_IsRejected', () => {
    const findings = findingsFor('offenders.ts');

    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  /** One greedy pattern can satisfy a bare count, so the test requires each pattern id. */
  it('Fixtures_MeasuredOffenders_EachCaughtAtItsOwnLine', () => {
    const byPattern = new Set(findingsFor('offenders.ts').map((f) => f.patternId));

    expect(byPattern).toContain('design-requirement');
    expect(byPattern).toContain('task-shorthand-padded');
    expect(byPattern).toContain('task-ordinal');
    expect(byPattern).toContain('invariant-ordinal');
    expect(byPattern).toContain('epic-ordinal');
    expect(byPattern).toContain('wave-ordinal');
    expect(byPattern).toContain('slice-ordinal');
    expect(byPattern).toContain('planning-artifact-path');
    expect(byPattern).toContain('used-to-be');
    expect(byPattern).toContain('formerly');
    expect(byPattern).toContain('previously-narration');
  });

  /**
   * This comment states its constraint, and only its leading ordinal makes it an offender.
   * A bulk delete of such comments also deletes the reasoning.
   */
  it('Fixtures_AtomicWriteComment_IsAnOffenderInItsCommittedForm', () => {
    const findings = findingsFor('offenders.ts').filter((f) => f.match === 'DR-16');

    expect(findings).toHaveLength(1);
  });

  it('Fixtures_EveryPermittedCase_IsClean', () => {
    const findings = findingsFor('permitted.ts');

    expect(
      findings.map((f) => `${f.line}: [${f.match}] ${f.patternId}`),
      'permitted fixture produced findings',
    ).toEqual([]);
  });

  /** A guard that flags its own kill fixtures cannot be tested. */
  it('Fixtures_Directory_IsStructurallyExempt', () => {
    expect(isExempt(policy, 'tools/audit/__fixtures__/comment-hygiene/offenders.ts', 'comment-content')).toBe(true);
    expect(isExempt(policy, 'tools/audit/__fixtures__/comment-hygiene/permitted.ts', 'comment-content')).toBe(true);
  });

  /** The fixtures are real TypeScript, so the extractor takes the same path as it takes for the tree. */
  it('Fixtures_BothCorpora_Parse', () => {
    expect(() => findingsFor('offenders.ts')).not.toThrow();
    expect(() => findingsFor('permitted.ts')).not.toThrow();
  });
});
