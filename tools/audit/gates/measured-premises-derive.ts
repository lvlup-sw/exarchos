/**
 * TS-side derivations for the DR-27 measured-premise checker.
 *
 * `tools/audit/gates/check-measured-premises.mjs` is deliberately dependency-free Node so
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
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { censusLiveOutputSchemas } from '../../conformance/src/bindings/output-schema.js';
import {
  censusLiveEventNameGrammar,
  censusLiveReportCoupling,
} from '../../conformance/src/bindings/events.js';
import { EventTypes } from '../../../src/events/schemas.js';

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
  // `event-types-total` couples to a premise document that does not exist in
  // this tree yet: the sibling re-scope spec is the change that both creates
  // it and arms `check-measured-premises.mjs` to scan it, by adding it to
  // `DEFAULT_DOCUMENTS` (or annotating `.exarchos/invariants.md`, which is
  // already in scope). Until then nothing in the repo asserts
  // `<!-- measured: event-types-total -->N<!-- /measured -->`, so this
  // derivation is the only place the value is bound to the live catalog —
  // recording that binding here, against `EventTypes.length` rather than a
  // typed number, is what keeps the eventual annotation from being able to go
  // stale the moment the catalog grows again.
  //
  // Checked first and fails closed the same way the two census values below
  // already do: a derivation that reports a number it cannot stand behind is
  // the defect this entrypoint exists to remove, and an empty `EventTypes` —
  // a broken import, a shadowed module, a resolution that silently returned
  // nothing — is exactly that. `EventTypes.length` is never legitimately zero
  // on a working tree, so refusing to emit one is the honest response. It has
  // to run before the census calls below: both of them default their own
  // parameters from this same `EventTypes` binding, so an emptied catalog
  // would otherwise surface as one of THEIR diagnostics instead of naming the
  // value that actually went stale.
  // Widened to `number`: `EventTypes` is `as const`, so `.length` is typed as
  // the literal count on the live tree and `tsc` (rightly) flags a literal-vs-
  // 0 comparison as unreachable. The guard exists for the case the type system
  // cannot see — a mocked or otherwise degenerate import — so the runtime
  // value has to be treated as the `number` it actually is at that seam.
  const eventTypesTotal: number = EventTypes.length;
  if (eventTypesTotal === 0) {
    throw new Error(
      'event-types-total census is not trustworthy — EventTypes resolved to 0 ' +
        'entries. Refusing to emit a value the premise document coupling could ' +
        'not stand behind.',
    );
  }

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
    'event-types-total': eventTypesTotal,
    'report-coupled-events': coupling.reportCoupledCount,
    // Task 015's measured disagreement between the two authorities that decide
    // what an event name may be: the shipped `EVENT_NAME_PATTERN` and the DR-3
    // grammar. Task 075 exists to collapse them; until it lands, the number is
    // a bound premise so the spec cannot state a stale one.
    'event-name-pattern-divergence': grammar.divergent.length,
  };
}

/**
 * True only when this module is `tsx`'s entry script, following the same
 * check `check-measured-premises.mjs` already makes on itself. Without it,
 * importing this module for `deriveTsPremises` alone — the seam a unit test
 * needs to exercise the fail-closed guard above without shelling out — would
 * also run the CLI's stdout/exit side effects on every import, including the
 * `process.exit(1)` branch, which would tear down the importing process
 * rather than let a test observe the thrown error.
 */
const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) {
  try {
    process.stdout.write(`${JSON.stringify(deriveTsPremises())}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`measured-premises-derive: ${message}\n`);
    process.exit(1);
  }
}
