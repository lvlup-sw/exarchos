/**
 * Tests for the golden-fixture PR-body marker check (task T053, DR-15).
 *
 * Phase progression: RED (import fails — script does not yet exist) →
 * GREEN (`scripts/check-golden-fixture-note.mjs` implemented, exporting the
 * pure `checkGoldenFixtureNote` function; a thin CLI main is also provided
 * but not exercised here — CLI shape is covered via the contract of the
 * exported function).
 *
 * DR-15 requires that any change to a file under
 * `servers/exarchos-mcp/tests/fixtures/load-bearing/**` be acknowledged in
 * the PR body with the exact marker `GOLDEN-FIXTURE-UPDATE:` so that
 * accidental or silent edits to load-bearing golden fixtures cannot land
 * without an explicit human note. The tests below encode that rule:
 *
 *   - fixture changed + no marker → fail
 *   - fixture changed + marker    → pass
 *   - no fixture change           → pass (regardless of body)
 */
import { describe, it, expect } from 'vitest';

// The script is authored as ESM `.mjs`; NodeNext resolution requires the
// explicit extension at import time. The module exports a single pure
// function `checkGoldenFixtureNote`.
// @ts-expect-error — no .d.ts for this .mjs script; structural contract is
// asserted by the tests in this file.
import { checkGoldenFixtureNote } from './check-golden-fixture-note.mjs';

const LOAD_BEARING_FILE =
  'servers/exarchos-mcp/tests/fixtures/load-bearing/rehydrate-demo.events.jsonl';

describe('checkGoldenFixtureNote', () => {
  it('PrBodyCheck_FixtureChangedWithoutNote_Fails', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [LOAD_BEARING_FILE],
      prBody: 'No marker here',
    });

    expect(result.passed).toBe(false);
    expect(typeof result.reason).toBe('string');
    expect(result.reason).toMatch(/GOLDEN-FIXTURE-UPDATE/);
  });

  it('PrBodyCheck_FixtureChangedWithNote_Passes', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [LOAD_BEARING_FILE],
      prBody:
        '## Summary\nUpdated golden fixture.\n\nGOLDEN-FIXTURE-UPDATE: added edge case event\n',
    });

    expect(result.passed).toBe(true);
  });

  it('PrBodyCheck_NoFixtureChange_Passes', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [
        'src/foo.ts',
        'servers/exarchos-mcp/src/workflow/rehydrate.ts',
        'README.md',
      ],
      prBody: 'No marker here and that is fine',
    });

    expect(result.passed).toBe(true);
  });

  it('PrBodyCheck_FixtureChangedWithMarkerMidLine_Passes', () => {
    // The rule allows the marker as a leading token on a line — a common
    // case is "GOLDEN-FIXTURE-UPDATE: <reason>" at the start of a body line.
    const result = checkGoldenFixtureNote({
      changedFiles: [
        'servers/exarchos-mcp/tests/fixtures/load-bearing/rehydrate-demo.expected-document.json',
      ],
      prBody: 'GOLDEN-FIXTURE-UPDATE: regenerated document after snapshot change',
    });

    expect(result.passed).toBe(true);
  });

  it('PrBodyCheck_OnlyUnrelatedFixtureTouched_Passes', () => {
    // Fixtures outside `load-bearing/` are not governed by this rule.
    const result = checkGoldenFixtureNote({
      changedFiles: ['servers/exarchos-mcp/tests/fixtures/other/sample.json'],
      prBody: '',
    });

    expect(result.passed).toBe(true);
  });

  it('PrBodyCheck_FixtureChangedWithBareMarker_Fails', () => {
    // DR-15 requires reviewer context after the marker. A bare
    // `GOLDEN-FIXTURE-UPDATE:` line — or one followed only by whitespace —
    // has no reason and must NOT satisfy the gate.
    for (const bare of [
      'GOLDEN-FIXTURE-UPDATE:',
      'GOLDEN-FIXTURE-UPDATE: ',
      '  GOLDEN-FIXTURE-UPDATE:   \n',
    ]) {
      const result = checkGoldenFixtureNote({
        changedFiles: [LOAD_BEARING_FILE],
        prBody: bare,
      });

      expect(result.passed, `bare marker variant should fail: ${JSON.stringify(bare)}`).toBe(false);
      expect(result.reason).toMatch(/GOLDEN-FIXTURE-UPDATE/);
    }
  });
});
