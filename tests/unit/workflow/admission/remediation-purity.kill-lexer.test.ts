// Kill fixture for the lexer port in `remediation-purity.ts`.
//
// The retired character walk for `extractImportSpecifiers` had no regex-literal state.
// `test-helpers/superseded-site-lexers.ts` keeps that walk. The tests run it and the port over the same inputs and assert both answers.
//
// The inputs come from the shared table in `test-helpers/adversarial-lexer-inputs.ts`.
// They already import `node:fs` and `node:child_process`, which are forbidden import markers, so this file changes no input.
// @oracle-sources: ../../../../src/workflow/admission/remediation-purity.ts, ../../../../tools/test-helpers/superseded-site-lexers.ts

import { describe, it, expect } from 'vitest';
import {
  auditRemediationPurity,
  extractImportSpecifiers,
  type ImportLexer,
} from '../../../../src/workflow/admission/remediation-purity.js';
import { lexModule } from '../../../../tools/test-helpers/module-lexer.js';
import { supersededExtractImportSpecifiers } from '../../../../tools/test-helpers/superseded-site-lexers.js';
import { ADVERSARIAL_INPUTS } from '../../../../tools/test-helpers/adversarial-lexer-inputs.js';

/**
 * The census with the retired walk as its lexer.
 * The walk reported only value imports, so each specifier gets `typeOnly: false`.
 * The import-type test pins this miscount.
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
    /**
     * The walk has no regex-literal state and no line-bounded quote rule.
     * The lone `'` inside `/['"]/` opens a string that runs to the opening quote of the real specifier, so the import disappears.
     */
    name: "a regex literal containing a ' quote, in operand position",
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    /** The backtick inside the regex opens a phantom template that runs to the end of the file. */
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: ['node:fs'],
    heuristic: [],
  },
  {
    /** The walk toggles on each backtick, so it scans the body of the nested template as code. The module imports nothing. */
    name: 'a nested template literal inside a `${…}` substitution',
    parse: [],
    heuristic: ['node:child_process'],
  },
]);

describe('DR-2 kill fixture — remediation-purity.extractImportSpecifiers, both instruments', () => {
  /**
   * The expectation table must match the shared input table, so a dropped row fails the test.
   * The two instruments must disagree on three inputs. Otherwise the port changes nothing here.
   */
  it('RemediationPurity_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
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

    expect(disagreeing).toEqual([
      "a regex literal containing a ' quote, in operand position",
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  /** The retired walk reports no imports, so the census passes a module that imports `node:fs`. The port fails that module. */
  it('RemediationPurity_RegexHoldingABacktick_PassedAModuleThatImportsNodeFs', () => {
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

  /** The module imports nothing, but the retired walk reports a `node:child_process` import and fails the module. */
  it('RemediationPurity_NestedTemplateSubstitution_InventedAForbiddenImport', () => {
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

  /**
   * A type query is erased at emit, but the retired walk matched the `import(` token and failed the module.
   * The port tags the edge as erased, and the census drops erased forms. The same specifier as a value import still fails.
   */
  it('RemediationPurity_ImportTypeQuery_WasChargedAsAValueImport', () => {
    const source = [
      "export type Handle = import('node:fs').Stats | null;",
      'export const zero = 0;',
    ].join('\n');

    expect(extractImportSpecifiers(source, SUPERSEDED_LEXER)).toEqual(['node:fs']);
    expect(extractImportSpecifiers(source, lexModule)).toEqual([]);

    expect(auditRemediationPurity('remediation.ts', source, SUPERSEDED_LEXER).ok).toBe(false);
    expect(auditRemediationPurity('remediation.ts', source, lexModule).ok).toBe(true);

    const valueImport = "import { readFile } from 'node:fs';\nexport const r = readFile;";
    expect(extractImportSpecifiers(valueImport, lexModule)).toEqual(['node:fs']);
    expect(auditRemediationPurity('remediation.ts', valueImport, lexModule).ok).toBe(false);
  });

  /** An under-count is the dangerous direction for this census. A module whose imports disappear in a partial tree reads as pure, so a recovered parse throws. */
  it('RemediationPurity_RecoveredParse_IsRefusedRatherThanUnderReported', () => {
    const broken = "import { readFile } from 'node:fs'\nexport const x = {{{;";
    expect(() => extractImportSpecifiers(broken, lexModule)).toThrow(/did not parse cleanly/);
    expect(() => auditRemediationPurity('remediation.ts', broken, lexModule)).toThrow(
      /did not parse cleanly/,
    );
  });
});
