// ─── Contract compiler public API (P03-03) ───────────────────────────────────
//
// PROGRAM-03, API-003. The single import site for the deterministic contract
// compiler. Downstream packages build against this surface:
//   • P03-04 (MCP registration/bindings) — `compile`, `deriveMetaModel`,
//     `ActionDescriptor`, `SchemaBundle`.
//   • P03-05 (CLI client)                — `TypeManifest`, `deriveTypeNames`.
//   • P03-09 (independent oracle)         — `ProofFixtureBundle`,
//     `serializeProofFixtures`, `compile().output.serialized`.
// ────────────────────────────────────────────────────────────────────────────

export * from './meta-model.js';
export * from './descriptors.js';
export * from './fixtures.js';
export * from './compile.js';
