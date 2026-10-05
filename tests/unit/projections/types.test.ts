import { describe, it, expect, expectTypeOf } from 'vitest';
import * as ts from 'typescript';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectionReducer } from '../../../src/projections/types.js';

describe('ProjectionReducer', () => {
  /** `expectTypeOf` does nothing at run time here, so the last assertion gives the test a runtime check. */
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
    expect(reducer.apply(reducer.initial, { type: 'inc' })).toEqual({ count: 1 });
  });
});

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
 * Typechecks `source` as a virtual file next to `types.ts`, so its `./types.js`
 * import resolves to the real module. The probe writes nothing to disk.
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

/**
 * This suite pins the compile-time rule in the `scope` docstring of `src/projections/types.ts`.
 * `tsconfig.json` excludes test files, and vitest does not run its typecheck mode.
 * As a result, `expectTypeOf` proves nothing here, so the probe calls the TypeScript compiler API.
 */
describe('ProjectionScope — compile-time scope guard', () => {
  /**
   * The `'stream'` control must compile with no diagnostic. The control proves that
   * the probe resolves `./types.js` and reports real diagnostics. Without it, the
   * `'global'` case can pass for a wrong reason.
   * TS2322 is the "not assignable" diagnostic.
   */
  it('ProjectionScope_ReducerAuthoredGlobal_FailsTypecheck', () => {
    const streamDiagnostics = typecheckProbe(reducerSource('stream'));
    expect(
      streamDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, ' '),
      ),
    ).toEqual([]);

    const globalDiagnostics = typecheckProbe(reducerSource('global'));
    const messages = globalDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, ' '),
    );

    expect(globalDiagnostics.length).toBeGreaterThan(0);
    expect(globalDiagnostics.some((d) => d.code === 2322)).toBe(true);
    expect(messages.join('\n')).toMatch(/"global"[\s\S]*not assignable[\s\S]*"stream"/);
  });
});
