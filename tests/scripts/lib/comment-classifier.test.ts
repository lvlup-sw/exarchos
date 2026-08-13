import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadPolicy } from '../../../scripts/lib/comment-policy.mjs';
import { classifyText, classifyComment, isRejected } from '../../../scripts/lib/comment-classifier.mjs';
import { extractComments } from '../../../scripts/lib/comment-prose.mjs';

const policy = loadPolicy(path.resolve(import.meta.dirname, '../../../.exarchos/comment-policy.json'));

const idsFor = (text: string): string[] => classifyText(text, policy).map((f) => f.patternId);

describe('forbidden ordinals', () => {
  it('Classify_SpecOrdinal_Rejected', () => {
    expect(idsFor('DR-7: the bytes are fsync\'d')).toContain('design-requirement');
  });

  it('Classify_InvOrdinal_Rejected', () => {
    // No carve-out. A resolution check proves an entry exists, not that the
    // citation is still true, and catalog entries are rewritten in place.
    expect(idsFor('holds INV-2 across the seam')).toContain('invariant-ordinal');
    expect(idsFor('see INV-5b for the carrier shape')).toContain('invariant-ordinal');
  });

  it('Classify_TaskOrdinal_Rejected', () => {
    expect(idsFor('added in task 014')).toContain('task-ordinal');
    expect(idsFor('added in task-014')).toContain('task-ordinal');
  });

  it('Classify_TaskShorthand_Rejected', () => {
    expect(idsFor('follows T-35 exactly')).toContain('task-shorthand');
  });

  it('Classify_PaddedTaskShorthand_Rejected', () => {
    // The tree's dominant form is unhyphenated and zero-padded — `T034`, not
    // `T-34`. Requiring three digits keeps it clear of type parameters.
    expect(idsFor('checkpoint materializes the projection (T034)')).toContain(
      'task-shorthand-padded',
    );
    expect(idsFor('reuses the helper extracted in T031')).toContain('task-shorthand-padded');
  });

  it('Classify_WaveAndSliceOrdinals_Rejected', () => {
    expect(idsFor('landed in wave 3')).toContain('wave-ordinal');
    expect(idsFor('deferred to slice 2')).toContain('slice-ordinal');
  });

  it('Classify_EpicOrdinal_Rejected', () => {
    expect(idsFor('tracked under epic #1763')).toContain('epic-ordinal');
  });

  it('Classify_PlanningArtifactPath_Rejected', () => {
    expect(idsFor('see docs/specs/2026-08-11-comment-hygiene.md for why')).toContain(
      'planning-artifact-path',
    );
    expect(idsFor('per docs/designs/old-thing.md')).toContain('planning-artifact-path');
  });

  it('Classify_PhaseOrdinal_NotRejected', () => {
    // Product vocabulary, not a citation: the workflow machine and the append
    // path both have numbered phases. Treating these as ordinals produced 45
    // false positives on the measured tree.
    expect(idsFor('the append is locked during phase 1')).toEqual([]);
    expect(idsFor('phase 0 runs before anything moves')).toEqual([]);
  });

  it('Classify_ConstraintStatedInWords_NotRejected', () => {
    expect(
      idsFor('the bytes are fsync\'d before the rename, so a crash cannot expose a partial file'),
    ).toEqual([]);
  });

  it('Classify_GenericTypeParameter_NotClassifiedAsOrdinal', () => {
    // The hyphenated shorthand is used precisely so a bare `T1`/`T0` cannot
    // collide with type parameters, template tags or timing notation.
    expect(idsFor('returns Map<T1, T2> for the caller')).toEqual([]);
    expect(idsFor('measured from T0 to first byte')).toEqual([]);
    expect(idsFor('{@link T2} names the second parameter')).toEqual([]);
  });

  it('Classify_EveryGeneratedOrdinal_Rejected', () => {
    // Stands in for a generative property: the declared shapes across a wide
    // numeric range, each of which must be caught.
    const shapes = [
      (n: number) => `DR-${n}`,
      (n: number) => `task ${n}`,
      (n: number) => `T-${n}`,
      (n: number) => `wave ${n}`,
      (n: number) => `slice ${n}`,
      (n: number) => `epic #${n}`,
      (n: number) => `INV-${n}`,
    ];
    const numbers = [0, 1, 2, 7, 9, 10, 42, 99, 100, 999, 1763];

    const missed: string[] = [];
    for (const shape of shapes) {
      for (const n of numbers) {
        const text = `guard ${shape(n)} applies here`;
        if (!isRejected(text, policy)) missed.push(text);
      }
    }

    expect(missed).toEqual([]);
  });

  it('Classify_OrdinalAnywhereInProse_Rejected', () => {
    expect(isRejected('trailing mention of DR-3', policy)).toBe(true);
    expect(isRejected('DR-3 leads the sentence', policy)).toBe(true);
  });
});

describe('allowed references take precedence', () => {
  it('Classify_ForbiddenOrdinalInsideUrl_Permitted', () => {
    // A permalink legitimately carries a fragment that looks like an ordinal;
    // reporting it would punish the citation style the policy encourages.
    expect(
      idsFor('background: https://github.com/lvlup-sw/exarchos/blob/main/x.md#DR-7'),
    ).toEqual([]);
  });

  it('Classify_IssueReference_Permitted', () => {
    expect(idsFor('fixed upstream in lvlup-sw/exarchos#1755')).toEqual([]);
  });

  it('Classify_CveAndRfc_Permitted', () => {
    expect(idsFor('mitigates CVE-2026-11111')).toEqual([]);
    expect(idsFor('per RFC 9110 section 9.3.1')).toEqual([]);
  });

  it('Classify_OrdinalOutsideTheUrl_StillRejected', () => {
    // Precedence is scoped to the span, not the whole comment: an allowed
    // reference must not launder an unrelated ordinal sitting beside it.
    const findings = idsFor('DR-7 applies; see https://example.com/x#DR-9 for context');

    expect(findings).toEqual(['design-requirement']);
  });

  it('Classify_UrlWithoutOrdinal_Permitted', () => {
    expect(idsFor('see https://example.com/reasoning')).toEqual([]);
  });
});

describe('rejection messages', () => {
  it('Classify_Rejection_MessageNamesRemedy', () => {
    // The message text is asserted, not only the verdict: remediation here is
    // judged rather than mechanical, so the wording is the deliverable.
    const [finding] = classifyText('DR-7: fsync before rename', policy);

    expect(finding?.message).toContain('DR-7');
    expect(finding?.message).toContain('cannot resolve');
    expect(finding?.message).toMatch(/State the constraint/i);
  });

  it('Classify_InvariantRejection_MessageExplainsWhyResolutionIsNotEnough', () => {
    const [finding] = classifyText('preserves INV-2 here', policy);

    expect(finding?.message).toMatch(/stale citation|rewritten and renumbered|substance/i);
  });

  it('Classify_ChangelogRejection_MessageNamesPresentBehavior', () => {
    const [finding] = classifyText('this used to be a map', policy);

    expect(finding?.message).toMatch(/present behavior/i);
    expect(finding?.message).toMatch(/narrates a change/i);
  });
});

describe('changelog narration', () => {
  it('Classify_PassiveChangeVerb_Rejected', () => {
    // Measured at 84% on the tree, so it ships disabled — but the pattern must
    // still catch what it claims to, or the narrowing that enables it later
    // would be building on an unverified rule.
    const withPassiveEnabled = {
      ...policy,
      changelogPatterns: policy.changelogPatterns.map((p) =>
        p.id === 'passive-change-verb' ? { ...p, enabled: true } : p,
      ),
    };
    const ids = (text: string): string[] =>
      classifyText(text, withPassiveEnabled).map((f) => f.patternId);

    expect(ids('the field was renamed during the merge')).toContain('passive-change-verb');
    expect(ids('the helper was replaced by the resolver')).toContain('passive-change-verb');
    expect(ids('the shim was removed')).toContain('passive-change-verb');
  });

  it('Classify_PassiveChangeVerb_NotRejectedWhileDisabled', () => {
    // The shipped policy has it off. Its false positives are conditional and
    // diagnostic uses, which are common enough here to fail the floor.
    expect(idsFor('the field was renamed during the merge')).toEqual([]);
  });

  it('Classify_BarePreviously_NotRejected', () => {
    // Only the narrating form trips. A bare `previously` frequently describes
    // present or conditional behavior.
    expect(idsFor('previously computed values are reused when the hash matches')).toEqual([]);
  });

  it('Classify_PreviouslyNarration_Rejected', () => {
    expect(idsFor('previously this returned null')).toContain('previously-narration');
  });

  it('Classify_UsedToBeAndFormerly_Rejected', () => {
    expect(idsFor('this used to be a map')).toContain('used-to-be');
    expect(idsFor('formerly the CLI owned this')).toContain('formerly');
  });

  it('Classify_NoLonger_NotRejectedWhileDisabled', () => {
    // Ships disabled pending measurement: 321 matches on the tree, many
    // describing present or conditional behavior.
    expect(idsFor('the lease is no longer held once the merge lands')).toEqual([]);
  });

  it('Classify_PastTenseDescribingBehavior_NotRejected', () => {
    expect(idsFor('the caller was already holding the lock when this runs')).toEqual([]);
  });
});

describe('classifyComment', () => {
  it('ClassifyComment_Finding_CarriesTheCommentPosition', () => {
    const source = ['const a = 1;', '', '// DR-7: fsync before rename'].join('\n');
    const [comment] = extractComments(source, 'a.ts');

    const [finding] = classifyComment(comment!, policy);

    expect(finding?.line).toBe(3);
    expect(finding?.column).toBe(1);
    expect(finding?.patternId).toBe('design-requirement');
  });

  it('ClassifyComment_CleanComment_ReturnsNoFindings', () => {
    const [comment] = extractComments('// the retry budget is fixed at three\n', 'a.ts');

    expect(classifyComment(comment!, policy)).toEqual([]);
  });

  it('ClassifyComment_WrappedBlock_FindsOrdinalAcrossTheLineBreak', () => {
    // Marker-stripping joins lines, so an ordinal split by wrapping is still
    // one token by the time it is classified.
    const source = ['/**', ' * governed by', ' * DR-12 at the seam', ' */'].join('\n');
    const [comment] = extractComments(source, 'a.ts');

    expect(classifyComment(comment!, policy).map((f) => f.patternId)).toContain(
      'design-requirement',
    );
  });
});

describe('disabled patterns', () => {
  it('Classify_DisabledPattern_NeverReports', () => {
    const withDisabled = {
      ...policy,
      forbiddenOrdinals: policy.forbiddenOrdinals.map((p) => ({ ...p, enabled: false })),
    };

    expect(classifyText('DR-7 and INV-2 and task 014', withDisabled)).toEqual([]);
  });
});
