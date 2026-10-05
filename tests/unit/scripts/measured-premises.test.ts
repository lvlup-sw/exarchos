/**
 * Pins the `event-types-total` derivation of `measured-premises-derive.ts` to the event catalog.
 *
 * The derivation reads `EventTypes.length` from the live catalog, so this file holds no count.
 * A premise document cites the value as
 * `<!-- measured: event-types-total -->N<!-- /measured -->`. The suite does not assume that a
 * document with this annotation exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventTypes } from '../../../src/events/schemas.js';
import { deriveTsPremises } from '../../../tools/audit/gates/measured-premises-derive.js';
import {
  checkMeasuredPremises,
  DEFAULT_DOCUMENTS,
  parseClaimLiteral,
  scanMeasuredClaims,
} from '../../../tools/audit/gates/check-measured-premises.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

describe('measured-premises-derive — event-types-total coupling', () => {
  afterEach(() => {
    vi.doUnmock('../../../src/events/schemas.js');
    vi.resetModules();
  });

  /**
   * The loop reads each document in `DEFAULT_DOCUMENTS`. It skips a document that is absent or
   * that holds no `event-types-total` annotation. An annotation that is present must agree with
   * the derived value.
   */
  it('MeasuredPremises_EventTypesTotal_MatchesTheLiveCatalog', () => {
    const derived = deriveTsPremises();
    expect(derived['event-types-total']).toBe(EventTypes.length);

    for (const relative of DEFAULT_DOCUMENTS) {
      const absolute = path.join(REPO_ROOT, relative);
      if (!existsSync(absolute)) continue;
      const text = readFileSync(absolute, 'utf8');
      for (const claim of scanMeasuredClaims(text)) {
        if (claim.name !== 'event-types-total') continue;
        expect(parseClaimLiteral(claim.raw)).toBe(derived['event-types-total']);
      }
    }
  });

  /**
   * The test has three parts. First, an empty `EventTypes` catalog makes the derivation throw.
   * Second, the same call on the live catalog succeeds, which proves that the guard caused the
   * throw. Third, `checkMeasuredPremises` reports `drifted` for a synthetic document whose
   * literal is the live value plus one.
   */
  it('MeasuredPremises_StaleTotal_FailsClosed', async () => {
    vi.resetModules();
    vi.doMock('../../../src/events/schemas.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/events/schemas.js')>();
      return { ...actual, EventTypes: [] as readonly string[] };
    });
    const { deriveTsPremises: deriveFromStaleCatalog } = await import(
      '../../../tools/audit/gates/measured-premises-derive.js'
    );
    expect(() => deriveFromStaleCatalog()).toThrow(/event-types-total/i);

    vi.doUnmock('../../../src/events/schemas.js');
    vi.resetModules();
    const { deriveTsPremises: deriveLive } = await import(
      '../../../tools/audit/gates/measured-premises-derive.js'
    );
    const live = deriveLive();
    expect(live['event-types-total']).toBe(EventTypes.length);

    const staleLiteral = live['event-types-total'] + 1;
    const syntheticDocument = {
      path: 'synthetic-premise-document.md',
      text: `<!-- measured: event-types-total -->${staleLiteral}<!-- /measured -->\n`,
    };
    const report = checkMeasuredPremises({
      documents: [syntheticDocument],
      derive: (name: string) => (name === 'event-types-total' ? live['event-types-total'] : undefined),
      isKnownDerivation: (name: string) => name === 'event-types-total',
    });
    expect(report.verdict).toBe('fail');
    expect(report.claims[0]?.verdict).toBe('drifted');
  });
});
