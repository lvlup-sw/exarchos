// The verification note of the implementer prompt scales with the risk of the task.
// `renderImplementerPrompt` reads `riskTier` and `boundaryTouching` from the delegation stamp, and
// never branches on the workflow type.
//
//   - low: a static-analysis note of at most 3 lines, with no kill-probe
//   - medium: scoped tests and the `check_test_adequacy` kill-probe
//   - high: the medium note and the integration-suite rung
//   - boundary: adds the steer on mocks of a dependency that the task does not own
//
// A long prompt costs tokens and accuracy, so a low-risk task gets the short note.

import { describe, it, expect } from 'vitest';
import { renderImplementerPrompt } from '../../../../src/runtime/agents/definitions.js';

/** Returns the `## Verification` section of the prompt, up to the next `## ` heading or the end. */
function verificationNoteOf(prompt: string): string {
  const start = prompt.indexOf('## Verification');
  expect(start, 'rendered prompt must contain a "## Verification" section').toBeGreaterThan(-1);
  const rest = prompt.slice(start + '## Verification'.length);
  const nextSection = rest.indexOf('\n## ');
  return nextSection === -1
    ? prompt.slice(start)
    : prompt.slice(start, start + '## Verification'.length + nextSection);
}

describe('renderImplementerPrompt — tier-conditional verification note', () => {
  /** The line count leaves out the `## Verification` heading line and each blank line. */
  it('RenderImplementerPrompt_LowTier_EmitsThreeLineVerificationNote', () => {
    const prompt = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    const note = verificationNoteOf(prompt);

    const bodyLines = note
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(
      bodyLines.length,
      `low-tier verification note must be at most 3 lines, got ${bodyLines.length}:\n${note}`,
    ).toBeLessThanOrEqual(3);

    expect(note).not.toMatch(/RED/);
    expect(note).not.toMatch(/GREEN/);
    expect(note).not.toMatch(/REFACTOR/);
    expect(note).not.toMatch(/check_test_adequacy/);

    expect(note.toLowerCase()).toMatch(/static analysis/);
  });

  /**
   * The medium and high notes judge adequacy by outcome and accept test-after. They name no
   * `REFACTOR` step. The `check_test_adequacy` kill-probe proves that a test can fail.
   */
  it('RenderImplementerPrompt_MediumHighTier_EmitsAdequacyBlock_TestAfter', () => {
    for (const riskTier of ['medium', 'high'] as const) {
      const prompt = renderImplementerPrompt({ riskTier, boundaryTouching: false });
      const note = verificationNoteOf(prompt);

      expect(note, `${riskTier} note must not impose RGR ordering`).not.toMatch(/REFACTOR/);
      expect(note.toLowerCase(), `${riskTier} note must frame test-after`).toContain('test-after');

      expect(
        note,
        `${riskTier} verification block must name the check_test_adequacy kill-probe`,
      ).toMatch(/check_test_adequacy/);
    }
  });

  /**
   * The steer tells the agent to use a hermetic fixture or a contract-verified stub for a
   * dependency that it does not own.
   */
  it('RenderImplementerPrompt_BoundaryTag_AppendsMockSteer', () => {
    const withBoundary = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: true });
    const withoutBoundary = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });

    expect(withBoundary.toLowerCase()).toContain('mock only what you own');
    expect(withoutBoundary.toLowerCase()).not.toContain('mock only what you own');

    expect(withBoundary.toLowerCase()).toMatch(/hermetic fixture|contract-verified stub/);
  });

  /** The rendered length grows with the tier: low < medium <= high. */
  it('RenderImplementerPrompt_Length_ScalesWithTier', () => {
    const low = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    const medium = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });
    const high = renderImplementerPrompt({ riskTier: 'high', boundaryTouching: false });

    expect(low.length, 'low-tier prompt must be shorter than medium').toBeLessThan(medium.length);
    expect(medium.length, 'medium-tier prompt must be no longer than high').toBeLessThanOrEqual(
      high.length,
    );
  });
});

import { IMPLEMENTER } from '../../../../src/runtime/agents/definitions.js';

/**
 * The low tier carries no universal test-first contract, because such a contract blocks a doc or
 * config task. The prompt framing is tier-neutral, and the verification note of each tier holds the
 * test discipline. The `pre-write` test rule applies only to the medium and high tiers.
 */
describe('implementer contract is tier-conditional (CR-1)', () => {
  it('RenderImplementerPrompt_LowTier_NoUniversalTddFraming', () => {
    const low = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    expect(low).not.toContain('TDD implementer');
    expect(low.toLowerCase()).not.toContain('witness it fail');
  });

  it('RenderImplementerPrompt_MediumTier_CarriesAdequacyDisciplineInNote', () => {
    const medium = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });
    expect(medium).toContain('check_test_adequacy');
    expect(medium.toLowerCase()).toContain('test-after');
  });

  /**
   * The implementer has two `pre-write` rules, and one is the worktree-boundary guard. The test
   * selects the kill-probe rule, which must exempt the low tier.
   */
  it('ImplementerSpec_PreWriteRule_ScopedToKillProbeTiers', () => {
    const preWrite = IMPLEMENTER.validationRules
      ?.filter((r) => r.trigger === 'pre-write')
      .find((r) => /check_test_adequacy|medium\/high/.test(r.rule));
    expect(preWrite).toBeDefined();
    expect(preWrite!.rule).toMatch(/check_test_adequacy|medium\/high/);
    expect(preWrite!.rule.toLowerCase()).toContain('low');
  });
});
