import { describe, it, expect, expectTypeOf } from 'vitest';
import * as ts from 'typescript';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectionReducer } from '../../../src/projections/types.js';

describe('ProjectionReducer', () => {
  it('ProjectionReducer_TypeShape_Compiles', () => {
    const reducer: ProjectionReducer<{ count: number }, { type: 'inc' }> = {
      id: 'test@v1',
      version: 1,
      scope: 'stream',
      initial: { count: 0 },
      apply: (s, _e) => ({ count: s.count + 1 }),
    };
    expectTypeOf(reducer).toMatchTypeOf<
      ProjectionReducer<{ count: number }, { type: 'inc' }>
    >();
    // Runtime sanity so vitest records a pass
    expect(reducer.apply(reducer.initial, { type: 'inc' })).toEqual({ count: 1 });
  });
});

// ─── ProjectionScope is a compile-time guard ────────────────────────────────

/**
 * Pins the reducer-scope guarantee stated in `projections/types.ts` — see the
 * `scope` field's docstring there for the rule and its exact limits. This file
 * does not restate them; it tests them.
 *
 * The guarantee is a compile-time one, so it needs a test that actually
 * consults the compiler. Two facts make a plain `expectTypeOf` useless here:
 *
 *  1. `tsconfig.json` EXCLUDES every `.test.ts` file, so
 *     `npm run typecheck` never sees this file.
 *  2. Vitest's `typecheck` mode is not enabled in `vitest.config.ts`, so
 *     `expectTypeOf` erases to a runtime no-op and would pass vacuously.
 *
 * So the probe below drives the TypeScript compiler API directly over an
 * in-memory source file that imports the REAL `./types.js`, and asserts that
 * authoring `scope: 'global'` produces a diagnostic. The `'stream'` control
 * case asserts the harness reports a CLEAN compile for valid input — without
 * it, a broken probe (bad path, bad options) would "pass" by erroring on
 * everything.
 *
 * If `ProjectionScope` is ever re-widened, the negative case stops erroring
 * and this test goes red.
 */
const PROJECTIONS_DIR = path.dirname(fileURLToPath(import.meta.url));

const PROBE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  types: [],
};

/**
 * Type-check `source` as if it were a file sitting next to `types.ts`, so its
 * relative `./types.js` import resolves to the real module under test. The
 * probe file is virtual — nothing is written to disk.
 */
function typecheckProbe(source: string): readonly ts.Diagnostic[] {
  const probePath = path.join(PROJECTIONS_DIR, '../../../src/projections/__scope_probe__.ts');
  const isProbe = (fileName: string): boolean =>
    path.resolve(fileName) === path.resolve(probePath);

  const host = ts.createCompilerHost(PROBE_COMPILER_OPTIONS, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (isProbe(fileName)) {
      return ts.createSourceFile(fileName, source, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) =>
    isProbe(fileName) ? true : ts.sys.fileExists(fileName);
  host.readFile = (fileName) =>
    isProbe(fileName) ? source : ts.sys.readFile(fileName);

  const program = ts.createProgram([probePath], PROBE_COMPILER_OPTIONS, host);
  return ts.getPreEmitDiagnostics(program);
}

/** Build a reducer-authoring probe source stamped with the given scope. */
function reducerSource(scope: string): string {
  return `
import type { ProjectionReducer } from './types.js';

export const probe: ProjectionReducer<{ n: number }, { type: string }> = {
  id: 'probe@v1',
  version: 1,
  scope: '${scope}',
  initial: { n: 0 },
  apply: (s) => s,
};
`;
}

describe('ProjectionScope — compile-time scope guard', () => {
  it('ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck', () => {
    // Control: the only representable scope compiles clean. This proves the
    // probe harness resolves `./types.js` and reports real diagnostics —
    // without it the negative assertion below could pass for the wrong reason.
    const streamDiagnostics = typecheckProbe(reducerSource('stream'));
    expect(
      streamDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, ' '),
      ),
    ).toEqual([]);

    // A reducer authored as `scope: 'global'` must not compile. This probe pins
    // the narrow claim (unauthorable in typechecked code), not a broader one —
    // the exact guarantee and its limit are stated once, in the `scope`
    // docstring in `types.ts`.
    const globalDiagnostics = typecheckProbe(reducerSource('global'));
    const messages = globalDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, ' '),
    );

    expect(globalDiagnostics.length).toBeGreaterThan(0);
    // TS2322: Type '"global"' is not assignable to type '"stream"'.
    expect(globalDiagnostics.some((d) => d.code === 2322)).toBe(true);
    expect(messages.join('\n')).toMatch(/"global"[\s\S]*not assignable[\s\S]*"stream"/);
  });
});
