// DR-14 (Task 024): `noUncheckedIndexedAccess` ratchet — server-package guard.
//
// The root `tsconfig.json` does NOT cover this nested package, so the server
// project carries its own flag and its own CI typecheck (`cd
// servers/exarchos-mcp && npm run typecheck`). This guard fails fast — in the
// server suite, before the slow CI typecheck — if the flag is ever silently
// removed, which is what would make this tree stop typechecking green.
//
// The cast-budget half of the acceptance bar lives in the ROOT test
// (`src/tsconfig-strictness.test.ts`), which measures both trees at once.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

describe('DR-14: noUncheckedIndexedAccess ratchet (server)', () => {
  it('TsconfigServer_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    // The flag is ON and cannot be silently removed. Combined with CI's server
    // `npm run typecheck`, this pins "the server tree typechecks green UNDER the
    // flag" — proven clean at 0 errors with the flag enabled.
    expect(
      readCompilerFlag(resolve(SERVER_ROOT, 'tsconfig.json'), 'noUncheckedIndexedAccess'),
    ).toBe(true);
  });

  it('TsconfigServer_ExactOptionalPropertyTypesEnabled_TypecheckGreen', () => {
    // DR-14 task 025 — second strict flag on the nested server project. Proven
    // clean at 0 errors under it via CI's server `npm run typecheck`.
    expect(
      readCompilerFlag(resolve(SERVER_ROOT, 'tsconfig.json'), 'exactOptionalPropertyTypes'),
    ).toBe(true);
  });
});

describe('DR-14: strict-flag ratchet (DR-3 eval workspace)', () => {
  // DR-14 requires BOTH strict flags in EVERY tsconfig, including the opt-in
  // eval workspace DR-3 creates (`evals-pkg/`) — a tsconfig that program named
  // as "a strict-flag hole this program opened itself." Its single `src/index.ts`
  // is proven clean under both flags via `evals-pkg` `npm run typecheck`
  // (`tsc --noEmit`); this guard fails fast if either flag is ever dropped so the
  // hole cannot silently reopen.
  const EVAL_PKG_TSCONFIG = resolve(SERVER_ROOT, 'evals-pkg/tsconfig.json');

  it('TsconfigEvalPkg_NoUncheckedIndexedAccessEnabled_TypecheckGreen', () => {
    expect(readCompilerFlag(EVAL_PKG_TSCONFIG, 'noUncheckedIndexedAccess')).toBe(true);
  });

  it('TsconfigEvalPkg_ExactOptionalPropertyTypesEnabled_TypecheckGreen', () => {
    expect(readCompilerFlag(EVAL_PKG_TSCONFIG, 'exactOptionalPropertyTypes')).toBe(true);
  });
});
