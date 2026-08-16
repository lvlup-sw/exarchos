// ────────────────────────────────────────────────────────────────────────────
// DR-2 / task 072 — the kill fixture for THIS site's lexer port.
//
// `extractImportSpecifiers` was a hand-rolled character walk until task 072, and
// the weakest of the four in this package: it carried no regex-literal state at
// all. A port that is never shown to DIFFER from what it replaced has not been
// shown to be needed, so the retired walk is kept verbatim in
// `test-helpers/superseded-site-lexers.ts`, assembled here into a lexer, and
// both instruments are run over the SAME inputs with BOTH answers asserted.
//
// The inputs are task 065's, read from the one shared table
// (`test-helpers/adversarial-lexer-inputs.ts`) — DR-2 forbids a fourth. This
// site needs no payload substitution: the constructs already carry `node:fs` and
// `node:child_process`, which are FORBIDDEN_IMPORT_MARKERS, so each input is
// already a module this census must judge.
// @oracle-sources: ./remediation-purity.ts, ../../test-helpers/superseded-site-lexers.ts
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  auditRemediationPurity,
  extractImportSpecifiers,
  type ImportLexer,
} from '../../../../../src/workflow/admission/remediation-purity.js';
import { lexModule } from '../../../../../tools/test-helpers/module-lexer.js';
import { supersededExtractImportSpecifiers } from '../../../../../tools/test-helpers/superseded-site-lexers.js';
import { ADVERSARIAL_INPUTS } from '../../../../../tools/test-helpers/adversarial-lexer-inputs.js';

/**
 * The census as it behaved BEFORE task 072.
 *
 * The retired walk answered only VALUE imports, so every specifier it reported
 * is re-tagged `typeOnly: false` here — which is precisely the miscount the last
 * test in this file pins: it had no way to say otherwise.
 */
const SUPERSEDED_LEXER: ImportLexer = (source: string) => ({
  imports: supersededExtractImportSpecifiers(source).map((specifier) => ({
    specifier,
    typeOnly: false,
  })),
});

/** What each instrument answers for each shared construct. */
const EXPECTATIONS: readonly {
  readonly name: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}[] = Object.freeze([
  {
    name: 'a `//` comment opener inside a string literal',
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    name: 'an unbalanced `/* */` pair split across two template literals',
    parse: ['node:fs'],
    heuristic: ['node:fs'],
  },
  {
    // KILL. This walk has NO regex-literal state and NO line-bounded-quote rule,
    // so the lone `'` inside `/['"]/` opens a string that runs on until the next
    // `'` — the opening quote of the real specifier — and the import vanishes.
    // The two walks task 065 retired both survived this input; this one does not.
    name: "a regex literal containing a ' quote, in operand position",
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    // KILL — the same direction by a different route. The backtick inside the
    // regex opens a phantom template that runs to EOF.
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    // KILL — the other direction. The walk toggles on every backtick, so the
    // nested template's body reads as code and its text is scanned for imports.
    // The module imports nothing at all.
    name: 'a nested template literal inside a `${…}` substitution',
    parse: [],
    heuristic: ['node:child_process'],
  },
]);

describe('DR-2 kill fixture — remediation-purity.extractImportSpecifiers, both instruments', () => {
  it('RemediationPurity_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    // NON-EMPTY, DERIVED DENOMINATOR. The expectation table is checked against
    // the SHARED input table rather than trusted: a row silently dropped from
    // either side would shrink the scan without shrinking the claim.
    expect(ADVERSARIAL_INPUTS.length).toBeGreaterThan(0);
    expect(EXPECTATIONS.map((row) => row.name)).toEqual(
      ADVERSARIAL_INPUTS.map((input) => input.name),
    );

    const disagreeing: string[] = [];
    for (const [index, input] of ADVERSARIAL_INPUTS.entries()) {
      const row = EXPECTATIONS[index];
      if (row === undefined) throw new Error(`no expectation for "${input.name}"`);
      const parsed = extractImportSpecifiers(input.source, lexModule);
      const heuristic = extractImportSpecifiers(input.source, SUPERSEDED_LEXER);
      expect(parsed, `${row.name} — parse`).toEqual([...row.parse]);
      expect(heuristic, `${row.name} — heuristic`).toEqual([...row.heuristic]);
      if (JSON.stringify(parsed) !== JSON.stringify(heuristic)) disagreeing.push(row.name);
    }

    // The kill fixture's own vacuity guard. A table on which the two instruments
    // never differ would prove the port changed nothing here.
    expect(disagreeing).toEqual([
      "a regex literal containing a ' quote, in operand position",
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  it('RemediationPurity_RegexHoldingABacktick_PassedAModuleThatImportsNodeFs', () => {
    // The FALSE NEGATIVE carried all the way to the VERDICT, and this is the one
    // answer this census exists to prevent: `ok: true` — "this remediation
    // module is pure data" — for a module that reaches the filesystem. `node:fs`
    // is a FORBIDDEN_IMPORT_MARKER, and the retired walk reported no imports at
    // all.
    const source = ADVERSARIAL_INPUTS[3]?.source ?? '';
    expect(source, 'the shared table no longer holds the backtick construct').toContain('isTick');

    const heuristicVerdict = auditRemediationPurity('remediation.ts', source, SUPERSEDED_LEXER);
    const parseVerdict = auditRemediationPurity('remediation.ts', source, lexModule);

    expect(heuristicVerdict.ok).toBe(true);
    expect(heuristicVerdict.importCount).toBe(0);
    expect(heuristicVerdict.forbidden).toEqual([]);

    expect(parseVerdict.ok).toBe(false);
    expect(parseVerdict.importCount).toBe(1);
    expect(parseVerdict.forbidden).toEqual([
      { module: 'remediation.ts', specifier: 'node:fs', marker: 'node:fs' },
    ]);
  });

  it('RemediationPurity_NestedTemplateSubstitution_InventedAForbiddenImport', () => {
    // The FALSE POSITIVE. The module imports nothing; the census reported a
    // `node:child_process` import and failed a clean module.
    const source = ADVERSARIAL_INPUTS[4]?.source ?? '';
    expect(source, 'the shared table no longer holds the nested-template construct').toContain(
      '${',
    );

    const heuristicVerdict = auditRemediationPurity('remediation.ts', source, SUPERSEDED_LEXER);
    const parseVerdict = auditRemediationPurity('remediation.ts', source, lexModule);

    expect(heuristicVerdict.ok).toBe(false);
    expect(heuristicVerdict.forbidden.map((f) => f.marker)).toEqual(['node:child_process']);

    expect(parseVerdict.ok).toBe(true);
    expect(parseVerdict.importCount).toBe(0);
  });

  it('RemediationPurity_ImportTypeQuery_WasChargedAsAValueImport', () => {
    // The `import('p').T` miscount task 065 flagged as likely present in all
    // three surviving sites. It IS present here, and it is a false positive with
    // teeth: a type query is fully erased at emit, so it performs nothing, yet
    // the retired walk matched the `import(` token, never saw the type position,
    // and failed the module.
    //
    // The port reports the edge and TAGS it erased; this census drops erased
    // forms, which is the judgement it always documented and never implemented.
    const source = [
      "export type Handle = import('node:fs').Stats | null;",
      'export const zero = 0;',
    ].join('\n');

    expect(extractImportSpecifiers(source, SUPERSEDED_LEXER)).toEqual(['node:fs']);
    expect(extractImportSpecifiers(source, lexModule)).toEqual([]);

    expect(auditRemediationPurity('remediation.ts', source, SUPERSEDED_LEXER).ok).toBe(false);
    expect(auditRemediationPurity('remediation.ts', source, lexModule).ok).toBe(true);

    // …and the fail-closed half is intact: the SAME specifier as a value import
    // is still caught, so the fix narrows to what is erased rather than to what
    // is convenient.
    const valueImport = "import { readFile } from 'node:fs';\nexport const r = readFile;";
    expect(extractImportSpecifiers(valueImport, lexModule)).toEqual(['node:fs']);
    expect(auditRemediationPurity('remediation.ts', valueImport, lexModule).ok).toBe(false);
  });

  it('RemediationPurity_RecoveredParse_IsRefusedRatherThanUnderReported', () => {
    // Inherited from the port and load-bearing here: an under-count is the
    // dangerous direction for this census, and a module whose imports vanished
    // in a partial tree reads as pure and PASSES.
    const broken = "import { readFile } from 'node:fs'\nexport const x = {{{;";
    expect(() => extractImportSpecifiers(broken, lexModule)).toThrow(/did not parse cleanly/);
    expect(() => auditRemediationPurity('remediation.ts', broken, lexModule)).toThrow(
      /did not parse cleanly/,
    );
  });
});
