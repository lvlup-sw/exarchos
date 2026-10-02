/**
 * TypeScript derivations for the measured-premise checker.
 * `check-measured-premises.mjs` is dependency-free Node, so it shells out to `tsx` for the values
 * that only the live module can give. The `outputSchema` vacuity census walks the Zod schema
 * objects, because a named binding hides a vacuous schema from a text search. `EventTypes.length`
 * is the length of the array, not a count of lines.
 *
 * The entrypoint prints one JSON object on stdout. When a census reports a diagnostic, it exits 1
 * with the diagnostics on stderr and prints no number.
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

/**
 * Derives the live values, and throws when one of them is not trustworthy.
 * The `EventTypes` check runs first, because the event censuses default their parameters from the event catalog.
 * An empty catalog then names `event-types-total` and not a census diagnostic.
 * `eventTypesTotal` is typed `number`, because `EventTypes` is `as const` and `tsc` rejects a compare of its literal length with 0.
 * `event-name-pattern-divergence` counts the names on which `EVENT_NAME_PATTERN` and the event-name grammar disagree.
 */
export function deriveTsPremises(): TsDerivedValues {
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
    'event-name-pattern-divergence': grammar.divergent.length,
  };
}

/**
 * True only when this module is the entry script of `tsx`.
 * Without this check, a test that imports `deriveTsPremises` also runs the CLI side effects, and `process.exit(1)` stops the test process.
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
