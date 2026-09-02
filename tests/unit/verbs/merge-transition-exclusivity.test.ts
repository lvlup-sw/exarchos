// ─── Merge-transition exclusivity shield (#1305 T15) ───────────────────────
//
// INVARIANT: the merge-orchestrator's `merge-pending` entry/exit phase
// transitions MUST go through the canonical HSM transition primitive
// (`handleSet({ phase })` → `hsmTransitionGuard.attempt` → a single
// `workflow.transition` event). They MUST NOT bypass the event log with a
// direct top-level-phase mutation (`set({ phase: 'merge-pending' })` or
// `set({ phase: 'delegate' })`), which would desync the projection from the
// event store (the SQLite event store is the authoritative existence/phase
// record — see CLAUDE.md "State surfaces").
//
// This is a structural guard: it scans every `.ts` source file under
// `src/verbs/` and asserts no merge-transition code path applies a
// bare top-level phase-set for a merge-pending entry/exit. The merge
// orchestrator is permitted to write its OWN sub-state (`mergeOrchestrator.
// phase`, an internal pending/executing/completed/rolled-back/aborted
// marker) — that is NOT the top-level workflow HSM phase and does NOT bypass
// the transition primitive.
//
// NOTE: the forbidden substrings are assembled from fragments at runtime
// (see `setCall` / `mp` / `dlg` below) so they never appear verbatim in THIS
// source — otherwise the scan would flag the shield itself.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = fileURLToPath(new URL('../../../src/verbs/', import.meta.url));

// Fragments assembled at runtime so the forbidden literals never appear
// verbatim in THIS file (otherwise this shield would flag itself, and the
// repo-wide scan would have a false positive on its own guard).
const setCall = 'set' + '({ ';
const setCallTight = 'set' + '({';
const phaseKey = 'phase';
const mp = 'merge' + '-pending';
const dlg = 'delegate';

/**
 * Forbidden patterns: a direct top-level workflow-phase mutation routing a
 * merge-pending entry or exit transition. Each entry is the source substring
 * that, if present in any orchestrate source file, indicates a transition
 * that bypassed the `workflow.transition` primitive.
 *
 * We cover both spacings (`set({ phase` and `set({phase`) and both the
 * entry (`-> merge-pending`) and exit (`-> delegate`) targets a merge
 * transition would set.
 */
const FORBIDDEN_PATTERNS: readonly string[] = [
  `${setCall}${phaseKey}: '${mp}'`,
  `${setCallTight}${phaseKey}: '${mp}'`,
  `${setCall}${phaseKey}: "${mp}"`,
  `${setCall}${phaseKey}: \`${mp}\``,
  // The exit target — a merge transition driving `merge-pending -> delegate`
  // via a bare phase-set rather than the transition primitive.
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
  it('no orchestrate source applies a bare set({ phase }) for a merge-pending entry/exit transition', () => {
    const files = collectTsFiles(here);
    // The shield must not flag itself — FORBIDDEN_PATTERNS appears here as
    // data (assembled at runtime), and test files are not production paths.
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

  it('the merge orchestrator source contains no top-level workflow phase-set call at all', () => {
    // Stronger statement scoped to the two merge-transition-emitting source
    // files: neither may contain a `set({ phase` token (any spacing). They
    // legitimately write `mergeOrchestrator: { phase: ... }` sub-state, which
    // is a DIFFERENT token (object-literal key, not a `set({ phase` call) and
    // does not match. If a future change introduces a bare top-level phase
    // mutation on the merge path, this fails before it can desync the
    // projection.
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
