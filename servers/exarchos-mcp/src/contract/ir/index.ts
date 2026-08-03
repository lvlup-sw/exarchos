// ─── Shared admission IR — public surface (P03-06) ───────────────────────────
//
// PROGRAM-03, API-007. Aggregation entry point for the shared admission IR:
// the authored wire model + runtime validators (`admission-ir.ts`), the JSON
// Schema artifact discipline (`admission-ir-schema.ts`), the dangling-reference
// resolver (`references.ts`), and the builder lowering + consumer validator
// (`builder.ts`). Downstream consumers (and the later P07-03 decision-parity
// package) import from here.
// ────────────────────────────────────────────────────────────────────────────

export * from './admission-ir.js';
export * from './admission-ir-schema.js';
export * from './references.js';
export * from './builder.js';
