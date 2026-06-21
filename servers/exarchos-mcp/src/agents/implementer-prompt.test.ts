// ─── Tier-Conditional Implementer Prompt Tests (vls1-b5, task 028, R7 #1522) ──
//
// The implementer prompt's verification guidance must SCALE WITH the task's
// risk profile, not impose strict RED-GREEN-REFACTOR ceremony on every task.
// `renderImplementerPrompt` reads the delegation-record stamp (`riskTier`,
// `boundaryTouching`) — pure DATA inputs, never a workflow-type branch (INV-6)
// — and selects the tier-appropriate verification note:
//
//   • low      → a ≤3-line static-analysis note (no ceremony, no kill-probe)
//   • medium   → full verification block + `check_test_adequacy` kill-probe
//   • high     → full verification block + kill-probe (deepest ladder rung)
//   • boundary → appends the mock-of-unowned-dependency steer on top
//
// Evidence basis (TDAD): cutting a skill 107→20 lines quadrupled resolution —
// prompt bloat is a token AND an accuracy cost. Low-risk tasks must NOT carry
// the high-tier ceremony.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { renderImplementerPrompt } from './definitions.js';

/** Extract the rendered verification note section only. */
function verificationNoteOf(prompt: string): string {
  const start = prompt.indexOf('## Verification');
  expect(start, 'rendered prompt must contain a "## Verification" section').toBeGreaterThan(-1);
  // The note runs to the next top-level section or end of prompt.
  const rest = prompt.slice(start + '## Verification'.length);
  const nextSection = rest.indexOf('\n## ');
  return nextSection === -1
    ? prompt.slice(start)
    : prompt.slice(start, start + '## Verification'.length + nextSection);
}

describe('renderImplementerPrompt — tier-conditional verification note', () => {
  it('RenderImplementerPrompt_LowTier_EmitsThreeLineVerificationNote', () => {
    const prompt = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    const note = verificationNoteOf(prompt);

    // The note body (excluding the section header line) must be AT MOST 3
    // non-empty content lines — a terse static-analysis steer.
    const bodyLines = note
      .split('\n')
      .slice(1) // drop the "## Verification ..." header line
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(
      bodyLines.length,
      `low-tier verification note must be at most 3 lines, got ${bodyLines.length}:\n${note}`,
    ).toBeLessThanOrEqual(3);

    // No RED-GREEN ceremony, no kill-probe text on the cheap tier.
    expect(note).not.toMatch(/RED/);
    expect(note).not.toMatch(/GREEN/);
    expect(note).not.toMatch(/REFACTOR/);
    expect(note).not.toMatch(/check_test_adequacy/);

    // Low tier leans on static analysis.
    expect(note.toLowerCase()).toMatch(/static analysis/);
  });

  it('RenderImplementerPrompt_MediumHighTier_EmitsFullBlockWithKillProbe', () => {
    for (const riskTier of ['medium', 'high'] as const) {
      const prompt = renderImplementerPrompt({ riskTier, boundaryTouching: false });
      const note = verificationNoteOf(prompt);

      // Full verification block: RED-GREEN-REFACTOR discipline is present.
      expect(note, `${riskTier} note missing RED`).toMatch(/RED/);
      expect(note, `${riskTier} note missing GREEN`).toMatch(/GREEN/);

      // The kill-probe expectation: check_test_adequacy recaptures test-first's
      // unique guarantee at lower cost.
      expect(
        note,
        `${riskTier} verification block must name the check_test_adequacy kill-probe`,
      ).toMatch(/check_test_adequacy/);
    }
  });

  it('RenderImplementerPrompt_BoundaryTag_AppendsMockSteer', () => {
    const withBoundary = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: true });
    const withoutBoundary = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });

    // Boundary-touching adds the mock-of-unowned-dependency steer; non-boundary
    // does not.
    expect(withBoundary.toLowerCase()).toContain('mock only what you own');
    expect(withoutBoundary.toLowerCase()).not.toContain('mock only what you own');

    // The steer prescribes a hermetic fixture / contract-verified stub for
    // dependencies you do NOT own.
    expect(withBoundary.toLowerCase()).toMatch(/hermetic fixture|contract-verified stub/);
  });

  it('RenderImplementerPrompt_Length_ScalesWithTier', () => {
    const low = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    const medium = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });
    const high = renderImplementerPrompt({ riskTier: 'high', boundaryTouching: false });

    // Rendered length grows monotonically with risk depth: low < medium <= high.
    expect(low.length, 'low-tier prompt must be shorter than medium').toBeLessThan(medium.length);
    expect(medium.length, 'medium-tier prompt must be no longer than high').toBeLessThanOrEqual(
      high.length,
    );
  });
});

// ─── PR #1535 CodeRabbit CR-1: no universal TDD contract on low tier ─────────
//
// The HEAD framed every dispatch as "a TDD implementer agent" and the static
// pre-write validation rule unconditionally required a test file before any
// implementation write — both contradict the low tier (static analysis
// suffices) and could block doc/config tasks from satisfying the contract.
// The framing is tier-neutral; TDD discipline lives in the tier-selected
// verification note; the pre-write rule scopes itself to dispatches whose
// stamped sequence includes the kill-probe (medium/high).

import { IMPLEMENTER } from './definitions.js';

describe('implementer contract is tier-conditional (CR-1)', () => {
  it('RenderImplementerPrompt_LowTier_NoUniversalTddFraming', () => {
    const low = renderImplementerPrompt({ riskTier: 'low', boundaryTouching: false });
    expect(low).not.toContain('TDD implementer');
    // The low tier never demands a failing test first.
    expect(low.toLowerCase()).not.toContain('witness it fail');
  });

  it('RenderImplementerPrompt_MediumTier_CarriesTddDisciplineInNote', () => {
    const medium = renderImplementerPrompt({ riskTier: 'medium', boundaryTouching: false });
    expect(medium).toContain('RED');
    expect(medium.toLowerCase()).toContain('witness it fail');
  });

  it('ImplementerSpec_PreWriteRule_ScopedToKillProbeTiers', () => {
    // There are now two `pre-write` rules (the #1301 worktree-boundary guard is
    // also pre-write); target the TDD/kill-probe one specifically.
    const preWrite = IMPLEMENTER.validationRules
      ?.filter((r) => r.trigger === 'pre-write')
      .find((r) => /check_test_adequacy|medium\/high/.test(r.rule));
    expect(preWrite).toBeDefined();
    // The rule must self-scope to the stamped verification sequence rather
    // than demanding a test file on every dispatch.
    expect(preWrite!.rule).toMatch(/check_test_adequacy|medium\/high/);
    expect(preWrite!.rule.toLowerCase()).toContain('low');
  });
});
