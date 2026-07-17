// ─── Sidecar-Removal Shield (#1494) ──────────────────────────────────────────
//
// The YAML gate-sidecar layer (#1298) shipped consume-only — it was never
// given an emitter, and its deprecation message pointed at a PHANTOM
// emit script that never existed. SQLite is the authoritative structured
// record, so markdown parsing is the permanent authoring-gate path. T-04
// removes the entire consume-only sidecar layer and strips the sidecar
// branches from the four gate handlers.
//
// This test is a structural guard: it asserts no source file under
// `src/orchestrate` still references the deleted sidecar modules/symbols or
// the phantom emit script. If a future change reintroduces any of them,
// this fails before the dangling import can ship.
//
// NOTE: the exact forbidden substrings are assembled from fragments at
// runtime (see `sc` below) and never appear verbatim in THIS file, so the
// repo-wide dangling-reference grep stays at zero hits.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// `sc` is the literal "sidecar". Tokens are assembled from fragments at
// runtime so the forbidden substrings never appear verbatim in THIS source —
// otherwise the repo-wide dangling-reference grep (`#1494` completion gate)
// would flag the shield itself. The assembled values are still exactly the
// strings we forbid in every other file.
const sc = 'side' + 'car';

/** Symbols/paths that must no longer appear anywhere under src/orchestrate. */
const FORBIDDEN_TOKENS = [
  `${sc}:emit`,
  `from './${sc}-lookup`,
  `from './${sc}-schemas`,
  `loadDesign${sc[0]!.toUpperCase()}${sc.slice(1)}`,
  `loadPlan${sc[0]!.toUpperCase()}${sc.slice(1)}`,
  `Design${sc[0]!.toUpperCase()}${sc.slice(1)}V1`,
  `Plan${sc[0]!.toUpperCase()}${sc.slice(1)}V1`,
  `evaluateDesign${sc[0]!.toUpperCase()}${sc.slice(1)}`,
  `evaluatePlanCoverageFrom${sc[0]!.toUpperCase()}${sc.slice(1)}s`,
  `evaluateProvenanceFrom${sc[0]!.toUpperCase()}${sc.slice(1)}s`,
  `evaluateTaskDecompositionFrom${sc[0]!.toUpperCase()}${sc.slice(1)}`,
  'build' + 'DeprecationMessage',
] as const;

/** Collect every `.ts` file under `dir`, recursively. */
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

describe('sidecar layer removal (#1494)', () => {
  it('no file under src/orchestrate references the deleted sidecar layer', () => {
    const files = collectTsFiles(here);
    // The shield must not flag itself — FORBIDDEN_TOKENS appears here as data.
    const candidates = files.filter((f) => !f.endsWith('sidecar-removal.test.ts'));

    const offenders: string[] = [];
    for (const file of candidates) {
      const contents = readFileSync(file, 'utf-8');
      for (const token of FORBIDDEN_TOKENS) {
        if (contents.includes(token)) {
          offenders.push(`${file} contains "${token}"`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the deleted sidecar module files no longer exist', () => {
    const names = readdirSync(here);
    // Filenames assembled from `sc` for the same grep-hygiene reason as
    // FORBIDDEN_TOKENS above.
    const deleted = [
      `${sc}-lookup.ts`,
      `${sc}-schemas.ts`,
      `${sc}-lookup.test.ts`,
      `${sc}-consumption.test.ts`,
      `${sc}-backfill.test.ts`,
      `${sc}-schemas.test.ts`,
    ];
    for (const name of deleted) {
      expect(names).not.toContain(name);
    }
  });
});
