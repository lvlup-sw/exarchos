/**
 * No shipped module decides anything from the emission gate's verdict.
 *
 * @oracle-sources: ../../src/verbs/gates/check-event-emissions.ts
 *
 * `check_event_emissions` appends a `gate.executed` row under the gate name
 * `event-emissions` and returns hints. The first event-authority flip changed
 * what that verdict is a function of — the synthesize row lost
 * `stack.submitted` — and the claim that made this a small change, that the
 * gate is advisory and nothing reads its verdict to decide, was hand-traced
 * through every `gate.executed` reader. A hand trace is true on the day it is
 * made. This reads the tree instead: the gate-name literal appears in exactly
 * the modules allowed below, so a reader that starts discriminating on it is
 * named.
 *
 * The scan is textual on purpose. `gate.executed` readers compare `gateName`
 * against a literal (`=== 'review'`, `.includes('plan-coverage')`), and a
 * literal is what a source scan sees. It does not prove that no reader folds
 * every gate into a decision without naming this one — the convergence view
 * drops rows without a `dimension`, which this gate never sets — and it does
 * not claim to.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_ROOT = join(REPO_ROOT, 'src');

/**
 * The gate name as a string literal. An import path such as
 * `./gates/check-event-emissions.js` contains the words and is not one: the
 * character before them is a hyphen, not a quote.
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

/** Pure over a path→source map, so the live tree and a seeded reader go through the same scan. */
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
  it(
    'EventEmissionsGate_GateNameLiteral_AppearsOnlyInTheGateModule',
    () => {
      const sources = liveSources();
      // The denominator: a scan that read nothing would find nothing, and the
      // gate names itself, so the allowlist is also the floor.
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
