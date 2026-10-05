/**
 * Regenerates the checked-in reachability graph under Node with
 * `node src/contract/reachability/regenerate.mjs`. Commit the written
 * `generated/reachability-graph.json`.
 *
 * The generator imports `bun:sqlite` transitively, and `bun:sqlite` resolves only under Bun. Vitest
 * aliases it to a Node shim, but plain Node or tsx does not. This runner adds the same alias with a
 * synchronous resolve hook. Then it registers tsx, which compiles the TypeScript generator and the
 * shim.
 */

import { registerHooks } from 'node:module';
import { register as registerTsx } from 'tsx/esm/api';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHIM = pathToFileURL(
  fileURLToPath(new URL('../../storage/__shims__/bun-sqlite-node.ts', import.meta.url)),
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'bun:sqlite') return { url: SHIM, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

registerTsx();

const { generateReachabilityArtifact } = await import('./generate.ts');
const result = generateReachabilityArtifact();
process.stdout.write(`wrote reachability graph: ${result.graphFile}\n`);
process.stdout.write(`content digest: ${result.contentDigest}\n`);
process.stdout.write(
  `closure: ${result.closedActions}/${result.totalActions} actions closed ` +
    `(fullyClosed=${result.fullyClosed})\n`,
);
