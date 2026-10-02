// dependency-cruiser configuration for the import-boundary rules.
//
// The static-analysis gate (`runBoundaryLint` in src/verbs/pure/static-analysis.ts)
// finds this file at the repo root and runs `npx depcruise --validate`. A non-zero
// exit fails the gate. Without this file, the leg reports SKIP and does not block.
//
// A boundary rule names a `from` path and a `to` path that `from` must not import.
// Both are regexes relative to the repo root.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /**
     * Runtime import cycles. The severity is `warn` on purpose. `runBoundaryLint` fails
     * on any non-zero exit, and `depcruise --validate` exits non-zero only for `error`
     * violations. The blocking ratchet is tools/audit/cycle-gate.ts.
     * With the default `tsPreCompilationDeps: false`, depcruise drops `import type`
     * edges and keeps dynamic `import()` edges.
     */
    {
      name: 'no-circular',
      comment:
        'Runtime import cycles are forbidden (DR-4). `warn` here so the dogfooded ' +
        'runBoundaryLint (`depcruise --validate`) stays green; the blocking ratchet ' +
        'is tools/audit/cycle-gate.ts over the depcruise JSON graph.',
      severity: 'warn',
      from: {},
      to: {
        circular: true,
      },
    },
    {
      name: 'no-domain-core-to-io-adapters',
      comment:
        'Domain core (events, workflow) must not import the IO facade ' +
        '(adapters/). Route transport/CLI/MCP concerns through the orchestrate ' +
        'handlers instead of reaching into adapters from the core.',
      severity: 'error',
      /**
       * The `from` path has no `pathNot` for tests, because no test file matches it.
       * The test `DepcruiseRule_FromSet_HoldsNoTestFile` asserts this.
       */
      from: {
        path: '^src/(events|workflow)/',
      },
      to: {
        path: '^src/adapters/',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    /**
     * Imports use `.js` specifiers that resolve to `.ts` sources. These extensions let
     * the resolver map each specifier to its `.ts` file, so the rules match real modules.
     */
    enhancedResolveOptions: {
      extensions: ['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
