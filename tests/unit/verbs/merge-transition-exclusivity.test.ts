/**
 * Structural guard: a `merge-pending` entry or exit must use the HSM transition primitive.
 * That path is `handleSet({ phase })`, then `hsmTransitionGuard.attempt`, then one `workflow.transition` event.
 * A direct top-level phase mutation bypasses the event log and desyncs the projection from the event store.
 *
 * The scan reads every `.ts` source file under `src/verbs/`. The retired merge orchestrator wrote only its own sub-state,
 * `mergeOrchestrator.phase`, and no module under `src/verbs/` writes the top-level workflow phase for the detour now.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = fileURLToPath(new URL('../../../src/verbs/', import.meta.url));

/**
 * Fragments of the forbidden literals. The code builds the patterns from them at runtime, so no
 * forbidden literal appears in this file.
 */
const setCall = 'set' + '({ ';
const setCallTight = 'set' + '({';
const phaseKey = 'phase';
const mp = 'merge' + '-pending';
const dlg = 'delegate';

/**
 * Source substrings of a direct top-level phase-set for a merge-pending entry or exit.
 * Each one marks a transition that bypasses the `workflow.transition` primitive.
 */
const FORBIDDEN_PATTERNS: readonly string[] = [
  `${setCall}${phaseKey}: '${mp}'`,
  `${setCallTight}${phaseKey}: '${mp}'`,
  `${setCall}${phaseKey}: "${mp}"`,
  `${setCall}${phaseKey}: \`${mp}\``,
  /** The exit target: a bare phase-set for `merge-pending -> delegate`. */
  `${setCall}${phaseKey}: '${dlg}', // merge`,
];

/** Collect every `.ts` source file under `dir`, recursively. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Orchestrate_NoSetPhaseCalls_ForMergeTransitions (#1305 T15)', () => {
  /** Test files under `src/verbs/` are not production paths, so the scan skips them. */
  it('no orchestrate source applies a bare set({ phase }) for a merge-pending entry/exit transition', () => {
    const files = collectTsFiles(here);
    const candidates = files.filter(
      (f) => !f.endsWith('.test.ts') && !f.endsWith('.characterization.test.ts'),
    );

    const offenders: string[] = [];
    for (const file of candidates) {
      const contents = readFileSync(file, 'utf-8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (contents.includes(pattern)) {
          offenders.push(`${file} contains forbidden bare phase-set "${pattern}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
