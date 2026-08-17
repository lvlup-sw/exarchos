// ─── The Exarchos tool registry — published module path ─────────────────────
//
// The declarations live in `registry/`, split along the seams described in
// `registry/index.ts`. This file is the path every consumer already imports, so
// it stays the module's published identity: `./registry.js` resolves here and
// the decomposition is invisible to callers.
//
// Nothing is declared here. Add an action to the appropriate list under
// `registry/actions/` and export any new public symbol from
// `registry/index.ts`; a symbol re-exported from here but declared here is the
// one thing this file is meant to prevent.

export * from './registry/index.js';
