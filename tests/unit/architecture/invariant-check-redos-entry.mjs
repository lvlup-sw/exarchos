/**
 * Synchronous resolver installed before `tsx`. It sends `bun:sqlite` to the Node shim and, when
 * the contracts package is not installed, to the local stand-in. The match itself stays in the
 * TypeScript sources `tsx` loads.
 */
import { registerHooks } from 'node:module';

const sqliteShim = new URL('../../../src/storage/__shims__/bun-sqlite-node.ts', import.meta.url).href;
const contractsStub = new URL('./strategos-contracts-stub.mjs', import.meta.url).href;

/** @param {string} specifier */
function sqliteSpecifier(specifier) {
  return specifier === 'bun:sqlite' || specifier.startsWith('bun:sqlite?');
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (sqliteSpecifier(specifier)) {
      return nextResolve(sqliteShim, context);
    }
    if (specifier === '@lvlup-sw/strategos-contracts') {
      try {
        return nextResolve(specifier, context);
      } catch {
        return { url: contractsStub, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
