// Kill fixture for the lexer port of this site.
//
// `maskLiteralsAndComments` reads its masked source from a module lexer. The retired character
// walk stays verbatim in `test-helpers/superseded-site-lexers.ts`, and this file wraps it as a
// lexer. A port that never differs from the walk is not shown to be necessary. Thus this file runs
// both instruments over the same inputs and asserts both answers.
//
// The inputs come from the shared table in `test-helpers/adversarial-lexer-inputs.ts`, and a site
// must not add its own table. Only the payload is specific to this site: a hidden `node:fs`
// import cannot kill a gate that finds silent swallows.
// @oracle-sources: ./delivery-safety.ts, ../../test-helpers/superseded-site-lexers.ts

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  findSilentSwallows,
  maskLiteralsAndComments,
  resolveRequiredDeliveryModules,
  DELIVERY_CONTRACT_MODULE,
} from './delivery-safety.js';
import type { ModuleLexer } from '../../../src/architecture/effect-ledger.js';
import { lexModule } from '../../test-helpers/module-lexer.js';
import { supersededMaskLiteralsAndComments } from '../../test-helpers/superseded-site-lexers.js';
import { ADVERSARIAL_INPUTS } from '../../test-helpers/adversarial-lexer-inputs.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

/**
 * The gate with the retired mask: the same swallow rules, driven by the retired walk.
 *
 * `imports` is empty because the retired walk did not answer that question. The population
 * derivation used a separate raw-source regex. Nothing in this file reads `imports`.
 */
const SUPERSEDED_LEXER: ModuleLexer = (source: string) => ({
  imports: [],
  maskedSource: supersededMaskLiteralsAndComments(source),
});

/**
 * The payload this site looks for, placed by each construct where its defect can
 * act on it: a real, unhandled `catch {}`.
 */
const PAYLOAD = 'try { await send(); } catch {}';

/** What each instrument answers for {@link PAYLOAD} carried by each construct. */
const EXPECTATIONS: readonly {
  readonly name: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}[] = Object.freeze([
  {
    name: 'a `//` comment opener inside a string literal',
    parse: ['empty-catch'],
    heuristic: ['empty-catch'],
  },
  {
    name: 'an unbalanced `/* */` pair split across two template literals',
    parse: ['empty-catch'],
    heuristic: ['empty-catch'],
  },
  /**
   * Kill, in the dangerous direction for a delivery gate. The walk has no regex-literal state, so
   * the lone `'` in `/['"]/` opens a string that does not close on its line. The mask then blanks
   * the real `catch {}` below it, and a module that discards a delivery failure scans clean.
   */
  {
    name: "a regex literal containing a ' quote, in operand position",
    parse: ['empty-catch'],
    heuristic: [],
  },
  /**
   * Kill, in the same direction by a different route. The backtick in the regex opens a phantom
   * template that runs to the end of the file.
   */
  {
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: ['empty-catch'],
    heuristic: [],
  },
  /**
   * Kill, in the other direction. The walk masked a template literal whole, so its state inverted
   * on the nested template and unmasked its body. The reported `catch {}` exists only as template
   * text.
   */
  {
    name: 'a nested template literal inside a `${…}` substitution',
    parse: [],
    heuristic: ['empty-catch'],
  },
]);

const kindsUnder = (lex: ModuleLexer, source: string): string[] =>
  findSilentSwallows(source, lex).map((finding) => finding.kind);

describe('DR-2 kill fixture — delivery-safety.maskLiteralsAndComments, both instruments', () => {
  /**
   * The expectation table must match the shared input table, so a row dropped from either side
   * fails. The test also asserts which rows disagree. If the two instruments never differ, the
   * port changed nothing here.
   */
  it('DeliverySafety_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    expect(ADVERSARIAL_INPUTS.length).toBeGreaterThan(0);
    expect(EXPECTATIONS.map((row) => row.name)).toEqual(
      ADVERSARIAL_INPUTS.map((input) => input.name),
    );

    const disagreeing: string[] = [];
    for (const [index, input] of ADVERSARIAL_INPUTS.entries()) {
      const row = EXPECTATIONS[index];
      if (row === undefined) throw new Error(`no expectation for "${input.name}"`);
      const source = input.withPayload(PAYLOAD);
      const parsed = kindsUnder(lexModule, source);
      const heuristic = kindsUnder(SUPERSEDED_LEXER, source);
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

  /**
   * The false negative, which is the direction that matters. The module discards a delivery
   * failure, and the retired mask blanks the evidence.
   */
  it('DeliverySafety_RegexHoldingABacktick_HidesARealSilentSwallow', () => {
    const source = ADVERSARIAL_INPUTS[3]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the backtick construct').toContain('isTick');

    expect(maskLiteralsAndComments(source, SUPERSEDED_LEXER)).not.toContain('catch');
    expect(maskLiteralsAndComments(source, lexModule)).toContain('catch');

    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(kindsUnder(lexModule, source)).toEqual(['empty-catch']);
  });

  /**
   * The false positive. The module holds no `catch` statement. The text sits inside a template
   * nested in a `${…}` substitution.
   */
  it('DeliverySafety_NestedTemplateSubstitution_InventsASwallowFromTemplateText', () => {
    const source = ADVERSARIAL_INPUTS[4]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the nested-template construct').toContain(
      '${',
    );

    expect(supersededMaskLiteralsAndComments(source)).toContain('catch');
    expect(maskLiteralsAndComments(source, lexModule)).not.toContain('catch');

    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual(['empty-catch']);
    expect(kindsUnder(lexModule, source)).toEqual([]);
  });

  /**
   * The other deliberate difference of the port, which is a widening. A `${…}` substitution is
   * code. The retired walk masked the whole template, so it did not see a swallow in a substitution.
   */
  it('DeliverySafety_SwallowInsideASubstitution_IsNowSeenRatherThanMaskedWithTheTemplate', () => {
    const source = 'export const doc = `outer ${ (() => { try { s(); } catch {} })() } end`;';
    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(kindsUnder(lexModule, source)).toEqual(['empty-catch']);
  });

  /**
   * The swallow half of the `import('p').T` type-query finding. The swallow scan counts no imports,
   * so both instruments agree. The population derivation used a raw-source regex that requires `import`
   * at line start and a `from`. A type query has neither, so that regex did not enlist a module
   * whose only edge to the contract is a type query. The port reports the edge and enlists the
   * module, so the sweep gets wider and not narrower.
   */
  it('DeliverySafety_ImportTypeQuery_DoesNotAffectTheSwallowScanButDoesEnlistAModule', () => {
    const swallow = ["export type H = import('node:fs').Stats;", PAYLOAD].join('\n');
    expect(kindsUnder(SUPERSEDED_LEXER, swallow)).toEqual(['empty-catch']);
    expect(kindsUnder(lexModule, swallow)).toEqual(['empty-catch']);
  });

  /**
   * A partial tree loses literal spans. A module whose `catch {}` fell out of the tree then reads
   * as clean, so the scan refuses a recovered parse.
   */
  it('DeliverySafety_RecoveredParse_IsRefusedRatherThanScannedClean', () => {
    const broken = 'try { s(); } catch {}\nexport const x = {{{;';
    expect(() => findSilentSwallows(broken, lexModule)).toThrow(/did not parse cleanly/);
  });
});

describe('DR-2 — the population derivation reads the SAME parse', () => {
  /**
   * The population half of the type-query finding, on a synthetic tree. The claim thus does not
   * depend on the shape of the live tree. The length check proves that the derivation resolved a
   * real population.
   */
  it('DeliveryPopulation_TypeQueryEdge_IsEnlistedByTheParseAndWasMissedByTheRegex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'exarchos-delivery-typequery-'));
    try {
      await mkdir(join(root, dirname(DELIVERY_CONTRACT_MODULE)), { recursive: true });
      await writeFile(join(root, DELIVERY_CONTRACT_MODULE), 'export const deliver = () => {};\n');
      await writeFile(
        join(root, 'typequery.ts'),
        "export type D = import('./events/channel/delivery.js').Deliver;\nexport const x = 1;\n",
      );

      const modules = await resolveRequiredDeliveryModules(root, lexModule);
      expect(modules).toEqual([DELIVERY_CONTRACT_MODULE, 'typequery.ts']);

      expect(modules.length).toBeGreaterThan(0);
    } finally {
      await rmrfAsync(root);
    }
  });
});
