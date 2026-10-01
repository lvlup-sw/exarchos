/**
 * The public API of the reachability graph and its closure gate. The graph traces the path of
 * each public action from ActionId to packaged fixture. The gate requires exactly one path per action.
 *
 * Each hop resolves against an authority other than the contract compile. `HOP_AUTHORITIES` in
 * `graph.ts` names the authority of each hop.
 */

export * from './graph.js';
export * from './providers.js';
export * from './dispatch-routes.js';
export * from './shipped-artifacts.js';
export * from './collect.js';
export * from './generate.js';
