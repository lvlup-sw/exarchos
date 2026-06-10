// dependency-cruiser config — SIV-3 Layer A import-boundary rules.
//
// This is the worked example for the boundary-lint leg that rides the Exarchos
// static-analysis gate (servers/exarchos-mcp/src/orchestrate/pure/static-analysis.ts,
// `runBoundaryLint`). The gate detects this file at the repo root and runs
// `npx depcruise --validate` over the configured source dirs, folding the
// PASS/FAIL into the gate's report and counts. Absent this file, the leg SKIPs
// (advisory) — never a hard failure (INV-4 degrade discipline).
//
// Authors add architectural boundaries by extending the `forbidden` array
// below. Each rule names a `from` (the constrained module set) and a `to` (the
// module set it must not reach), expressed as path regexes relative to this
// repo root.
//
// The seeded rule encodes the real domain-core / IO-facade split inside the
// MCP server: the event-store and workflow domain cores must not import from
// the `adapters/` IO facade (CLI / MCP / hooks surfaces). That separation
// keeps the event-sourced core free of transport concerns. The rule is scoped
// to non-test sources — test fixtures legitimately import adapter exports to
// exercise them (e.g. event-store/schemas.test.ts pulls json-schema), so the
// `from` path excludes `*.test.ts`.

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-domain-core-to-io-adapters',
      comment:
        'Domain core (event-store, workflow) must not import the IO facade ' +
        '(adapters/). Route transport/CLI/MCP concerns through the orchestrate ' +
        'handlers instead of reaching into adapters from the core.',
      severity: 'error',
      from: {
        path: '^servers/exarchos-mcp/src/(event-store|workflow)/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^servers/exarchos-mcp/src/adapters/',
      },
    },
  ],
  options: {
    // Only walk the MCP server source tree this rule governs. Keeps the
    // validation fast and scoped to first-party code (see the `ownership`
    // manifest in .exarchos.yml, task 024).
    doNotFollow: {
      path: 'node_modules',
    },
    // The codebase is ESM/NodeNext with `.js` import specifiers that resolve to
    // `.ts` sources. dependency-cruiser's built-in TS-aware resolver maps the
    // `.js` specifier to the sibling `.ts` file via these extensions, so the
    // boundary rule matches against the real source modules. A `tsConfig`
    // reference is intentionally omitted: it would be resolved relative to the
    // gate's CWD (the repo root) rather than the MCP package, breaking the
    // tsconfig's package-relative `include` globs.
    enhancedResolveOptions: {
      extensions: ['.ts', '.cts', '.mts', '.js', '.cjs', '.mjs', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
