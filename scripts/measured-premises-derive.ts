/**
 * TS-side derivations for the DR-27 measured-premise checker.
 *
 * `scripts/check-measured-premises.mjs` is deliberately dependency-free Node so
 * it can host in the zero-dep unfiltered CI lane. Two of its derivations,
 * however, are only sound if they read the LIVE MODULE rather than its source
 * text:
 *
 *   - the `outputSchema` vacuity census walks the Zod schema OBJECT, because a
 *     named binding (`WorkflowUpdateOutputSchema`) launders the source-text
 *     grep while staying exactly as vacuous. Source text cannot answer it.
 *   - `EventTypes.length` is the array's own length, not a count of lines that
 *     look like registrations.
 *
 * This entrypoint is the seam: it imports both authorities, prints a single
 * JSON object on stdout, and the `.mjs` shells out to `tsx` exactly the way
 * `check-prefix-fingerprint.mjs` already does for the rehydration fingerprint.
 * One spawn serves every TS-backed derivation.
 *
 * FAIL-CLOSED: if the census raises ANY diagnostic (an empty registry, an
 * unreadable envelope) the numbers it produced are not trustworthy, so this
 * process exits non-zero with the diagnostics on stderr rather than printing a
 * number the checker would then compare against. A derivation that reports a
 * value it cannot stand behind is the defect DR-27 exists to remove.
 */
import { censusLiveOutputSchemas } from '../tools/conformance/src/bindings/output-schema.js';
import {
  censusLiveEventNameGrammar,
  censusLiveReportCoupling,
} from '../tools/conformance/src/bindings/events.js';
import { EventTypes } from '../src/events/schemas.js';

/** The derivation names this entrypoint answers. Keys match the annotation names. */
export interface TsDerivedValues {
  readonly 'output-schema-total': number;
  readonly 'output-schema-vacuous': number;
  readonly 'output-schema-substantive': number;
  readonly 'event-types-total': number;
  readonly 'report-coupled-events': number;
  readonly 'event-name-pattern-divergence': number;
}

export function deriveTsPremises(): TsDerivedValues {
  const census = censusLiveOutputSchemas();
  const grammar = censusLiveEventNameGrammar();

  if (!census.ok) {
    const detail = census.diagnostics
      .map((d) => `[${d.code}] ${d.message}`)
      .join('\n');
    throw new Error(
      `outputSchema census is not trustworthy — refusing to emit its counts:\n${detail}`,
    );
  }

  // Same fail-closed rule, applied to G3's census (task 013). The spec asserted "25 report-coupled
  // types" as bare prose in two places; DR-27's whole point is that a number nothing derives is an
  // unbound claim, and this census is the artifact that derives it.
  const coupling = censusLiveReportCoupling();

  if (!coupling.ok) {
    const detail = coupling.diagnostics.map((d) => `[${d.code}] ${d.message}`).join('\n');
    throw new Error(
      `report-coupling census is not trustworthy — refusing to emit its counts:\n${detail}`,
    );
  }

  return {
    'output-schema-total': census.total,
    'output-schema-vacuous': census.vacuousCount,
    'output-schema-substantive': census.substantiveCount,
    'event-types-total': EventTypes.length,
    'report-coupled-events': coupling.reportCoupledCount,
    // Task 015's measured disagreement between the two authorities that decide
    // what an event name may be: the shipped `EVENT_NAME_PATTERN` and the DR-3
    // grammar. Task 075 exists to collapse them; until it lands, the number is
    // a bound premise so the spec cannot state a stale one.
    'event-name-pattern-divergence': grammar.divergent.length,
  };
}

try {
  process.stdout.write(`${JSON.stringify(deriveTsPremises())}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`measured-premises-derive: ${message}\n`);
  process.exit(1);
}
