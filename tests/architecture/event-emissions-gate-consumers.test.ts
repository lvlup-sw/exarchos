/**
 * No shipped module decides anything from the verdict of the emission gate.
 *
 * @oracle-sources: ../../src/verbs/gates/check-event-emissions.ts
 *
 * `check_event_emissions` appends a `gate.executed` row with the gate name
 * `event-emissions` and returns hints. The gate stays advisory only while no
 * reader compares `gateName` with that literal. This suite requires that the
 * literal appears only in the allowed modules.
 *
 * The scan is textual because a reader compares `gateName` with a literal. It
 * does not find a reader that folds every gate into a decision and names none.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_ROOT = join(REPO_ROOT, 'src');

/**
 * Matches the gate name as a quoted string literal. An import path such as
 * `./gates/check-event-emissions.js` does not match, because a hyphen comes
 * before the words and not a quote.
 */
const GATE_NAME_LITERAL = /(['"`])event-emissions\1/;

/** Modules allowed to name the gate: the gate itself, and nothing else. */
const ALLOWED: readonly string[] = ['src/verbs/gates/check-event-emissions.ts'];

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield path;
  }
}

/** Takes a map from path to source, so the live tree and a seeded reader use the same scan. */
function modulesNamingTheGate(sources: ReadonlyMap<string, string>): readonly string[] {
  return [...sources]
    .filter(([, text]) => GATE_NAME_LITERAL.test(text))
    .map(([path]) => path)
    .sort();
}

function liveSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const file of sourceFiles(SOURCE_ROOT)) {
    sources.set(relative(REPO_ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8'));
  }
  return sources;
}

describe('EventEmissionsGate — nothing shipped decides on its verdict', () => {
  /**
   * The size assertion is the denominator, because a scan that reads nothing
   * finds nothing. The gate names itself, so the allowlist is also the minimum.
   */
  it(
    'EventEmissionsGate_GateNameLiteral_AppearsOnlyInTheGateModule',
    () => {
      const sources = liveSources();
      expect(sources.size).toBeGreaterThan(100);
      for (const allowed of ALLOWED) expect(sources.has(allowed), allowed).toBe(true);
      expect(modulesNamingTheGate(sources)).toEqual([...ALLOWED].sort());
    },
    20_000,
  );

  it('EventEmissionsGate_SeededReaderDiscriminatingOnTheName_IsNamedAndAnImportIsNot', () => {
    const seeded = new Map<string, string>([
      [
        'src/verbs/gates/check-event-emissions.ts',
        "requireGateEvent(store, streamId, 'event-emissions', 'observability', complete, carrier)",
      ],
      [
        'src/projections/views/seeded-readiness-view.ts',
        "if (row.data.gateName === 'event-emissions' && !row.data.passed) blockers.push('emissions');",
      ],
      [
        'src/verbs/composite.ts',
        "import { handleCheckEventEmissions } from './gates/check-event-emissions.js';",
      ],
    ]);
    expect(modulesNamingTheGate(seeded)).toEqual([
      'src/projections/views/seeded-readiness-view.ts',
      'src/verbs/gates/check-event-emissions.ts',
    ]);
  });
});
