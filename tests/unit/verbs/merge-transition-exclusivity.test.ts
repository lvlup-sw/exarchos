/**
 * Structural guard: the `merge-pending` entry and exit transitions of the merge orchestrator must use the HSM transition primitive.
 * That path is `handleSet({ phase })`, then `hsmTransitionGuard.attempt`, then one `workflow.transition` event.
 * A direct top-level phase mutation bypasses the event log and desyncs the projection from the event store.
 *
 * The scan reads every `.ts` source file under `src/verbs/`. The merge orchestrator can write its own sub-state, `mergeOrchestrator.phase`.
 * That sub-state is not the top-level workflow phase.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = fileURLToPath(new URL('../../../src/verbs/', import.meta.url));

/** Fragments of the forbidden literals. The code builds the patterns at runtime from these fragments. */
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

  /**
   * The two merge source files must contain no top-level phase-set token, in either spacing.
   * Their `mergeOrchestrator: { phase }` sub-state is an object key, so it does not match.
   */
  it('the merge orchestrator source contains no top-level workflow phase-set call at all', () => {
    const mergeFiles = [
      join(here, 'merge', 'merge-orchestrate.ts'),
      join(here, 'merge', 'execute-merge.ts'),
    ];
    const bareSetTokens = [`${setCall}${phaseKey}`, `${setCallTight}${phaseKey}`];

    const offenders: string[] = [];
    for (const file of mergeFiles) {
      const contents = readFileSync(file, 'utf-8');
      for (const token of bareSetTokens) {
        if (contents.includes(token)) {
          offenders.push(`${file} contains "${token}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
