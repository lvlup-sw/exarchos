/**
 * Pins the coupling between `measured-premises-derive.ts`'s `event-types-total`
 * derivation and the premise document meant to consume it.
 *
 * The derivation at `tools/audit/gates/measured-premises-derive.ts` reads
 * `EventTypes.length` off the live catalog rather than a typed literal, so a
 * value of 175 today becomes whatever the catalog holds tomorrow with no edit
 * required here. The premise document that would annotate a claim as
 * `<!-- measured: event-types-total -->N<!-- /measured -->` — and the change
 * that arms `check-measured-premises.mjs`'s fail-closed comparison against it
 * — is created by a sibling re-scope spec that has not landed in this
 * worktree. This suite therefore does not assume that document exists: the
 * first test proves the derivation agrees with the live catalog directly and
 * checks every document `check-measured-premises.mjs` already scans for the
 * annotation, agreeing with it if (and only if) one is present; the second
 * proves the coupling fails closed on both ends — the derivation itself
 * refuses an untrustworthy catalog, and the comparison mechanism rejects a
 * stale literal — independent of whether the document exists yet.
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

  it('MeasuredPremises_EventTypesTotal_MatchesTheLiveCatalog', () => {
    const derived = deriveTsPremises();
    expect(derived['event-types-total']).toBe(EventTypes.length);

    // The coupling's document side, checked against whatever
    // `check-measured-premises.mjs` actually scans (`DEFAULT_DOCUMENTS`), not
    // a guessed filename for the not-yet-landed premise document. A document
    // that is absent (the common case today — the sibling spec has not
    // created it) or that carries no `event-types-total` annotation is
    // skipped rather than treated as a failure or asserted on vacuously; a
    // document that IS present and DOES carry the annotation must already
    // agree with the live derivation. The moment the sibling spec creates the
    // premise document, this loop starts exercising real agreement with no
    // change to this test.
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

  it('MeasuredPremises_StaleTotal_FailsClosed', async () => {
    // Half 1 — the derivation itself. An `EventTypes` census it cannot stand
    // behind (seeded here as empty, standing in for a broken or shadowed
    // import) must not silently report a number; it fails closed instead of
    // handing the checker a value nothing backs.
    vi.resetModules();
    vi.doMock('../../../src/events/schemas.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../src/events/schemas.js')>();
      return { ...actual, EventTypes: [] as readonly string[] };
    });
    const { deriveTsPremises: deriveFromStaleCatalog } = await import(
      '../../../tools/audit/gates/measured-premises-derive.js'
    );
    expect(() => deriveFromStaleCatalog()).toThrow(/event-types-total/i);

    // Positive control: without the seeded staleness the identical call
    // succeeds and agrees with the live catalog, so the throw above is
    // evidence the guard fired — not that the function always throws.
    vi.doUnmock('../../../src/events/schemas.js');
    vi.resetModules();
    const { deriveTsPremises: deriveLive } = await import(
      '../../../tools/audit/gates/measured-premises-derive.js'
    );
    const live = deriveLive();
    expect(live['event-types-total']).toBe(EventTypes.length);

    // Half 2 — the coupling's other end. Once the sibling spec's premise
    // document exists and carries a stale literal, `check-measured-premises
    // .mjs`'s comparison must reject it rather than pass clean. Proven here
    // with a synthetic document standing in for the real one, fed the live
    // derivation so the staleness is measured against today's catalog rather
    // than a number typed into this test.
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
