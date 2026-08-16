// ────────────────────────────────────────────────────────────────────────────
// DR-2 / task 072 — the kill fixture for THIS site's lexer port.
//
// `maskLiteralsAndComments` was a hand-rolled character walk until task 072. A
// port that is never shown to DIFFER from what it replaced has not been shown to
// be needed, so the retired walk is kept verbatim in
// `test-helpers/superseded-site-lexers.ts`, assembled here into a lexer, and
// both instruments are run over the SAME inputs with BOTH answers asserted.
//
// The inputs are task 065's, read from the one shared table
// (`test-helpers/adversarial-lexer-inputs.ts`) — DR-2 forbids a fourth. Only the
// PAYLOAD is this site's: a gate that hunts silent swallows cannot be killed by
// a hidden `node:fs` import.
// @oracle-sources: ./delivery-safety.ts, ../test-helpers/superseded-site-lexers.ts
// ────────────────────────────────────────────────────────────────────────────

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
 * The gate as it behaved BEFORE task 072: the same swallow rules, driven by the
 * retired mask.
 *
 * `imports` is empty because the retired walk answered no such question — the
 * population derivation used a SECOND instrument, a raw-source regex, which is
 * the drift the port removes. Nothing in this file reads it.
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
  {
    // KILL — the dangerous direction for a delivery gate. This walk has no
    // regex-literal state, so the lone `'` inside `/['"]/` opens a string that
    // never closes on its line and the mask blanks the real `catch {}` below it.
    // A module that discards a required-delivery failure scans CLEAN.
    name: "a regex literal containing a ' quote, in operand position",
    parse: ['empty-catch'],
    heuristic: [],
  },
  {
    // KILL — same direction, different route: the backtick inside the regex
    // opens a phantom template that runs to EOF.
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: ['empty-catch'],
    heuristic: [],
  },
  {
    // KILL — the other direction. The walk masked a template literal whole,
    // which inverted its state on the nested one and un-masked its body. The
    // `catch {}` reported here exists only as template TEXT.
    name: 'a nested template literal inside a `${…}` substitution',
    parse: [],
    heuristic: ['empty-catch'],
  },
]);

const kindsUnder = (lex: ModuleLexer, source: string): string[] =>
  findSilentSwallows(source, lex).map((finding) => finding.kind);

describe('DR-2 kill fixture — delivery-safety.maskLiteralsAndComments, both instruments', () => {
  it('DeliverySafety_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
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
      const source = input.withPayload(PAYLOAD);
      const parsed = kindsUnder(lexModule, source);
      const heuristic = kindsUnder(SUPERSEDED_LEXER, source);
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

  it('DeliverySafety_RegexHoldingABacktick_HidesARealSilentSwallow', () => {
    // The FALSE NEGATIVE, which is the direction that matters: the module really
    // does discard a delivery failure, and the retired mask blanked the evidence.
    const source = ADVERSARIAL_INPUTS[3]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the backtick construct').toContain('isTick');

    expect(maskLiteralsAndComments(source, SUPERSEDED_LEXER)).not.toContain('catch');
    expect(maskLiteralsAndComments(source, lexModule)).toContain('catch');

    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(kindsUnder(lexModule, source)).toEqual(['empty-catch']);
  });

  it('DeliverySafety_NestedTemplateSubstitution_InventsASwallowFromTemplateText', () => {
    // The FALSE POSITIVE. The module contains no `catch` statement at all; the
    // text sits inside a template nested in a `${…}` substitution.
    const source = ADVERSARIAL_INPUTS[4]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the nested-template construct').toContain(
      '${',
    );

    expect(supersededMaskLiteralsAndComments(source)).toContain('catch');
    expect(maskLiteralsAndComments(source, lexModule)).not.toContain('catch');

    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual(['empty-catch']);
    expect(kindsUnder(lexModule, source)).toEqual([]);
  });

  it('DeliverySafety_SwallowInsideASubstitution_IsNowSeenRatherThanMaskedWithTheTemplate', () => {
    // The port's other deliberate difference, and it is a widening: a `${…}`
    // substitution IS code. The retired walk masked the whole template, so a
    // real swallow written inside a substitution was invisible.
    const source = 'export const doc = `outer ${ (() => { try { s(); } catch {} })() } end`;';
    expect(kindsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(kindsUnder(lexModule, source)).toEqual(['empty-catch']);
  });

  it('DeliverySafety_ImportTypeQuery_DoesNotAffectTheSwallowScanButDoesEnlistAModule', () => {
    // Task 065 flagged `import('p').T` miscounting as likely present in all three
    // surviving sites. Measured here it splits in two:
    //
    //   • the SWALLOW scan counts no imports at all, so the miscount cannot
    //     arise — both instruments agree;
    //   • the POPULATION derivation did count imports, with a raw-source regex
    //     requiring `import` at line start and a `from`. A type query has
    //     neither, so a module whose only edge to the contract is a type query
    //     was never enlisted and never scanned.
    //
    // The port reports the edge, so it is now enlisted. That is the fail-closed
    // direction: the sweep gets wider, never narrower.
    const swallow = ["export type H = import('node:fs').Stats;", PAYLOAD].join('\n');
    expect(kindsUnder(SUPERSEDED_LEXER, swallow)).toEqual(['empty-catch']);
    expect(kindsUnder(lexModule, swallow)).toEqual(['empty-catch']);
  });

  it('DeliverySafety_RecoveredParse_IsRefusedRatherThanScannedClean', () => {
    // Inherited from the port. A partial tree loses literal spans, so a module
    // whose `catch {}` fell out of the tree reads as clean and PASSES.
    const broken = 'try { s(); } catch {}\nexport const x = {{{;';
    expect(() => findSilentSwallows(broken, lexModule)).toThrow(/did not parse cleanly/);
  });
});

describe('DR-2 — the population derivation reads the SAME parse', () => {
  it('DeliveryPopulation_TypeQueryEdge_IsEnlistedByTheParseAndWasMissedByTheRegex', async () => {
    // The population half of the `import('p').T` finding, on a synthetic tree so
    // the claim does not depend on the live tree's shape.
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

      // NON-EMPTY DENOMINATOR: the derivation resolved a real population, so the
      // membership claim above is not an artefact of an empty sweep.
      expect(modules.length).toBeGreaterThan(0);
    } finally {
      await rmrfAsync(root);
    }
  });
});
