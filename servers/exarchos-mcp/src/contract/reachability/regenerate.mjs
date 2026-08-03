// ─── Regenerate the checked-in reachability graph under Node (P05-05) ────────
//
// `npx tsx src/contract/reachability/generate.ts` cannot run under plain Node
// because the generator pulls in `bun:sqlite` TRANSITIVELY (reachability →
// binding table → core/dispatch → the SQLite storage backend). `bun:sqlite`
// only resolves under Bun; vitest aliases it to a node shim, but a bare Node/tsx
// invocation does not. This runner reproduces that alias with a synchronous
// resolve hook, then runs the TS generator via tsx — so regeneration is a single
// committed command:
//
//   node servers/exarchos-mcp/src/contract/reachability/regenerate.mjs
//
// It writes `generated/reachability-graph.json`; commit the result. Mirrors the
// "regenerate + review" gesture of P03-01's authority lock and P03-03's
// proof-fixture baseline.
// ────────────────────────────────────────────────────────────────────────────

import { registerHooks } from 'node:module';
import { register as registerTsx } from 'tsx/esm/api';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHIM = pathToFileURL(
  fileURLToPath(new URL('../../storage/__shims__/bun-sqlite-node.ts', import.meta.url)),
).href;

// Redirect `bun:sqlite` → the node shim (mirrors the vitest.config alias).
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'bun:sqlite') return { url: SHIM, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Let tsx compile the TypeScript generator (and the shim, itself a .ts file).
registerTsx();

const { generateReachabilityArtifact } = await import('./generate.ts');
const result = generateReachabilityArtifact();
process.stdout.write(`wrote reachability graph: ${result.graphFile}\n`);
process.stdout.write(`content digest: ${result.contentDigest}\n`);
process.stdout.write(
  `closure: ${result.closedActions}/${result.totalActions} actions closed ` +
    `(fullyClosed=${result.fullyClosed})\n`,
);
