import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, isExempt } from './comment-policy.mjs';
import { extractComments } from './comment-prose.mjs';
import { classifyComment } from './comment-classifier.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'scripts/__fixtures__/comment-hygiene');
const policy = loadPolicy(path.join(REPO_ROOT, '.exarchos/comment-policy.json'));

function findingsFor(fixture: string) {
  const rel = `scripts/__fixtures__/comment-hygiene/${fixture}`;
  const source = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  return extractComments(source, rel).flatMap((comment) => classifyComment(comment, policy));
}

describe('kill fixtures', () => {
  it('Fixtures_EveryOffender_IsRejected', () => {
    const findings = findingsFor('offenders.ts');

    // The header block is prose about the fixture, so assert on the count of
    // DISTINCT comment lines caught rather than requiring every comment to trip.
    expect(findings.length).toBeGreaterThanOrEqual(10);
  });

  it('Fixtures_MeasuredOffenders_EachCaughtAtItsOwnLine', () => {
    // Each measured offender is verified individually: a single greedy pattern
    // catching everything would satisfy a bare count while leaving real classes
    // unenforced.
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

  it('Fixtures_AtomicWriteComment_IsAnOffenderInItsCommittedForm', () => {
    // The comment states its constraint and would survive on content alone. It
    // is an offender only because it opens with a bare ordinal — which is the
    // case that makes bulk stripping wrong, since the reasoning would go too.
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

  it('Fixtures_Directory_IsStructurallyExempt', () => {
    // A guard that flagged its own kill fixtures could not be tested.
    expect(isExempt(policy, 'scripts/__fixtures__/comment-hygiene/offenders.ts')).toBe(true);
    expect(isExempt(policy, 'scripts/__fixtures__/comment-hygiene/permitted.ts')).toBe(true);
  });

  it('Fixtures_BothCorpora_Parse', () => {
    // They are real TypeScript, so the extractor exercises the same path it
    // takes over the tree rather than a string-literal shortcut.
    expect(() => findingsFor('offenders.ts')).not.toThrow();
    expect(() => findingsFor('permitted.ts')).not.toThrow();
  });
});
