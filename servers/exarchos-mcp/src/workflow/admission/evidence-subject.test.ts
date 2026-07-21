import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EvidenceSubjectValidationError,
  canonicalizeEvidenceSubject,
  createEvidenceSubject,
  normalizeEvidenceSubjectContent,
  verifyEvidenceSubject,
} from './evidence-subject.js';

const identityCases = [
  { kind: 'workflow', workflowId: 'shared-001' },
  { kind: 'phase-attempt', phaseAttemptId: 'shared-001' },
  { kind: 'wave', waveId: 'shared-001' },
  { kind: 'task', taskId: 'shared-001' },
  { kind: 'commit', commitId: 'shared-001' },
  { kind: 'diff', diffId: 'shared-001' },
  { kind: 'artifact', artifactId: 'shared-001' },
] as const;

describe('canonical evidence subjects', () => {
  it('EvidenceSubject_ContentChange_ChangesDigest', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => {
        const before = createEvidenceSubject(
          { kind: 'task', taskId: 'task-004' },
          { value },
        );
        const after = createEvidenceSubject(
          { kind: 'task', taskId: 'task-004' },
          { value: `${value}!` },
        );

        expect(after.digest.value).not.toBe(before.digest.value);
        expect(() => verifyEvidenceSubject(before, { value: `${value}!` })).toThrow(
          expect.objectContaining({ code: 'DIGEST_MISMATCH' }),
        );
      }),
    );
  });

  it('EvidenceSubject_Canonicalization_IsDeterministic', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
          { maxKeys: 12 },
        ),
        (entries) => {
          const reversed = Object.fromEntries(Object.entries(entries).reverse());
          const identity = { kind: 'artifact', artifactId: 'artifact-001' } as const;

          const first = createEvidenceSubject(identity, entries);
          const replayed = createEvidenceSubject(identity, reversed);
          expect(replayed).toEqual(first);

          const canonical = canonicalizeEvidenceSubject(identity, entries);
          expect(first.digest.value).toBe(
            createHash('sha256').update(canonical, 'utf8').digest('hex'),
          );
        },
      ),
    );

    expect(
      canonicalizeEvidenceSubject(
        { kind: 'artifact', artifactId: 'artifact-001' },
        { z: 'last\r\nline', a: { y: 2, x: 1 } },
      ),
    ).toBe(
      '{"contractVersion":"1.0","kind":"artifact","artifactId":"artifact-001","content":{"a":{"x":1,"y":2},"z":"last\\nline"}}',
    );
  });

  it('EvidenceSubject_Normalization_IsIdempotent', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const once = normalizeEvidenceSubjectContent(value);
        const twice = normalizeEvidenceSubjectContent(once);
        expect(twice).toEqual(once);
      }),
    );

    const decomposed = { text: 'Cafe\u0301\r\nline', nested: { b: 2, a: 1 } };
    const normalized = { nested: { a: 1, b: 2 }, text: 'Café\nline' };
    expect(
      createEvidenceSubject({ kind: 'diff', diffId: 'diff-001' }, decomposed),
    ).toEqual(createEvidenceSubject({ kind: 'diff', diffId: 'diff-001' }, normalized));
  });

  it('EvidenceSubject_Variants_AreDomainSeparatedAndImmutable', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (content) => {
        const subjects = identityCases.map((identity) =>
          createEvidenceSubject(identity, content),
        );
        expect(new Set(subjects.map((subject) => subject.digest.value))).toHaveLength(
          identityCases.length,
        );
      }),
    );

    const subjects = identityCases.map((identity) =>
      createEvidenceSubject(identity, { same: 'content' }),
    );
    expect(subjects.map((subject) => subject.kind)).toEqual([
      'workflow',
      'phase-attempt',
      'wave',
      'task',
      'commit',
      'diff',
      'artifact',
    ]);
    for (const subject of subjects) {
      expect(Object.isFrozen(subject)).toBe(true);
      expect(Object.isFrozen(subject.digest)).toBe(true);
      expect(verifyEvidenceSubject(subject, { same: 'content' })).toEqual(subject);
    }
  });

  it('EvidenceSubject_MalformedOrUnsupportedInput_IsRejectedExplicitly', () => {
    const valid = createEvidenceSubject(
      { kind: 'workflow', workflowId: 'workflow-001' },
      { revision: 1 },
    );
    const malformed: Array<{
      candidate: unknown;
      code: EvidenceSubjectValidationError['code'];
    }> = [
      {
        candidate: {
          ...valid,
          digest: { algorithm: 'sha512', value: valid.digest.value },
        },
        code: 'UNSUPPORTED_DIGEST_ALGORITHM',
      },
      {
        candidate: {
          ...valid,
          digest: { algorithm: 'sha256', value: valid.digest.value.toUpperCase() },
        },
        code: 'MALFORMED_DIGEST',
      },
      {
        candidate: { kind: 'workflow', digest: valid.digest },
        code: 'MISSING_SUBJECT_COMPONENT',
      },
      {
        candidate: { ...valid, workflowId: undefined },
        code: 'MISSING_SUBJECT_COMPONENT',
      },
      {
        candidate: { ...valid, digest: { value: valid.digest.value } },
        code: 'MISSING_DIGEST_COMPONENT',
      },
      {
        candidate: { kind: 'workflow', workflowId: 'workflow-001' },
        code: 'MISSING_DIGEST_COMPONENT',
      },
    ];

    for (const { candidate, code } of malformed) {
      expect(() => verifyEvidenceSubject(candidate, { revision: 1 })).toThrow(
        expect.objectContaining({ code }),
      );
    }

    expect(() =>
      createEvidenceSubject(
        { kind: 'commit', commitId: 'commit-001' },
        { invalid: Number.NaN },
      ),
    ).toThrow(expect.objectContaining({ code: 'MALFORMED_CONTENT' }));

    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() =>
      createEvidenceSubject(
        { kind: 'commit', commitId: 'commit-001' },
        sparse,
      ),
    ).toThrow(expect.objectContaining({ code: 'MALFORMED_CONTENT' }));
  });

  it('EvidenceSubject_MalformedDigestEncodings_AreRejected', () => {
    fc.assert(
      fc.property(
        fc
          .string()
          .filter((value) => !/^[a-f0-9]{64}$/.test(value)),
        (value) => {
          expect(() =>
            verifyEvidenceSubject(
              {
                kind: 'wave',
                waveId: 'wave-001',
                digest: { algorithm: 'sha256', value },
              },
              { revision: 1 },
            ),
          ).toThrow(expect.objectContaining({ code: 'MALFORMED_DIGEST' }));
        },
      ),
    );
  });
});
