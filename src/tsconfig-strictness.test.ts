// DR-14 (Task 024): `noUncheckedIndexedAccess` ratchet — regression guards.
//
// These suite tests guard the *durable* facts the fix wave established:
//   (1) the flag stays enabled on the root project, and
//   (2) the fix wave did not smuggle in escape hatches beyond a declared budget.
//
// The "typecheck green" half of the acceptance bar is enforced by CI's dedicated
// `npm run typecheck` (root) and `cd servers/exarchos-mcp && npm run typecheck`
// (server) steps — the root typecheck does NOT cover the nested server package,
// so both run. Re-spawning `tsc` from inside the suite would duplicate that CI
// step and tax every `test:run`; no test in this repo does so. This guard fails
// fast — in the unit suite, before the slow CI typecheck — if the flag is ever
// silently removed, which is what would make the tree stop typechecking green.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { countCasts, type CastCounts } from '../scripts/tsconfig-strictness/count-casts.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a compilerOptions flag from a (comment-tolerant) tsconfig JSON. */
function readCompilerFlag(tsconfigPath: string, flag: string): unknown {
  const raw = readFileSync(tsconfigPath, 'utf8');
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const parsed = JSON.parse(stripped) as {
    compilerOptions?: Record<string, unknown>;
  };
  return parsed.compilerOptions?.[flag];
}

describe('DR-14: noUncheckedIndexedAccess ratchet (root)', () => {
  it('TsconfigRoot_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    // The flag is ON and cannot be silently removed. Combined with CI's
    // `npm run typecheck`, this pins "the root tree typechecks green UNDER the
    // flag" — the tree is proven clean at 0 errors with the flag enabled.
    expect(
      readCompilerFlag(resolve(REPO_ROOT, 'tsconfig.json'), 'noUncheckedIndexedAccess'),
    ).toBe(true);
  });

  // Pre-wave escape-hatch census across BOTH typed src trees, measured on the
  // integration tip immediately before this wave landed (root/src +
  // servers/exarchos-mcp/src, test/bench/fixture files excluded — see
  // count-casts.ts). The wave prefers real narrowing (guards, `?.`, `??`,
  // destructuring defaults) over `!`/`as`, so the introduced delta is tiny and
  // `as any` is barred outright.
  const BASELINE: CastCounts = { nonNull: 84, asCast: 2674, asAny: 3 };
  // Declared budget = MAX escape-hatch sites this wave (and near-term follow-ups
  // before a re-baseline) may introduce over the baseline. Justified in the PR
  // body; `as any` may never grow.
  const DELTA_BUDGET: CastCounts = { nonNull: 20, asCast: 5, asAny: 0 };

  it('FixWave_CastBudget_MeasuredAndWithinDeclaredLimit', () => {
    const counts = countCasts([
      { dir: resolve(REPO_ROOT, 'src') },
      { dir: resolve(REPO_ROOT, 'servers/exarchos-mcp/src') },
    ]);
    const delta = {
      nonNull: counts.nonNull - BASELINE.nonNull,
      asCast: counts.asCast - BASELINE.asCast,
      asAny: counts.asAny - BASELINE.asAny,
    };
    // `as any` is barred outright — the wave introduces none.
    expect(delta.asAny).toBeLessThanOrEqual(DELTA_BUDGET.asAny);
    // Non-null assertions and `as` casts stay within the declared budget.
    expect(delta.nonNull).toBeLessThanOrEqual(DELTA_BUDGET.nonNull);
    expect(delta.asCast).toBeLessThanOrEqual(DELTA_BUDGET.asCast);
    // The counts never fall BELOW baseline without a re-baseline (guards against
    // a stale baseline silently masking a future regression).
    expect(counts.nonNull).toBeGreaterThanOrEqual(BASELINE.nonNull);
  });
});
