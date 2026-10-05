/**
 * Tests for `checkGoldenFixtureNote` in `tools/audit/gates/check-golden-fixture-note.mjs`.
 * A change under `tests/core/fixtures/load-bearing/` needs a PR-body line that starts with
 * `GOLDEN-FIXTURE-UPDATE:` and gives a reason. The tests do not run the CLI of the script.
 * NodeNext resolution needs the `.mjs` extension in the import, and `allowJs` infers the types.
 */
import { describe, it, expect } from 'vitest';

import { checkGoldenFixtureNote } from '../../tools/audit/gates/check-golden-fixture-note.mjs';

const LOAD_BEARING_FILE =
  'tests/core/fixtures/load-bearing/rehydrate-demo.events.jsonl';

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
        'src/workflow/rehydrate.ts',
        'README.md',
      ],
      prBody: 'No marker here and that is fine',
    });

    expect(result.passed).toBe(true);
  });

  it('PrBodyCheck_FixtureChangedWithMarkerLeadingToken_Passes', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [
        'tests/core/fixtures/load-bearing/rehydrate-demo.expected-document.json',
      ],
      prBody: 'GOLDEN-FIXTURE-UPDATE: regenerated document after snapshot change',
    });

    expect(result.passed).toBe(true);
  });

  /** The check ignores leading whitespace, so an indented marker line passes. */
  it('PrBodyCheck_FixtureChangedWithMarkerInQuotedBlock_Passes', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [
        'tests/core/fixtures/load-bearing/rehydrate-demo.expected-document.json',
      ],
      prBody:
        'Some context paragraph.\n\n  GOLDEN-FIXTURE-UPDATE: indented under a quoted block\n\nAnd more notes.',
    });

    expect(result.passed).toBe(true);
  });

  /** The marker counts only at the start of a line, so an author cannot hide it in prose. */
  it('PrBodyCheck_FixtureChangedWithMarkerMidSentence_Fails', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: [
        'tests/core/fixtures/load-bearing/rehydrate-demo.expected-document.json',
      ],
      prBody:
        'See note GOLDEN-FIXTURE-UPDATE: regenerated — this should not count.',
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/GOLDEN-FIXTURE-UPDATE/);
  });

  /** The rule covers only the fixtures under `load-bearing/`. */
  it('PrBodyCheck_OnlyUnrelatedFixtureTouched_Passes', () => {
    const result = checkGoldenFixtureNote({
      changedFiles: ['tests/core/fixtures/other/sample.json'],
      prBody: '',
    });

    expect(result.passed).toBe(true);
  });

  /** The reason is the context for the reviewer, so a marker with only whitespace after it fails. */
  it('PrBodyCheck_FixtureChangedWithBareMarker_Fails', () => {
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
