// ─── MCP registration & bindings public API (P03-04) ─────────────────────────
//
// PROGRAM-03, API-004. The single import site for the generated MCP registration
// and the ActionId → implementation-binding surface. Downstream packages build
// against this:
//   • P03-05 (CLI generation) — `generateRegistration`, `serializeRegistration`,
//     `RegistrationManifest` (the deterministic discovery projection).
//   • P03-09 (independent oracle) — `verifyBindings`, `BindingVerdict`,
//     `BINDING_TABLE` (re-derive + re-verify the binding claim independently).
// ────────────────────────────────────────────────────────────────────────────

export * from './binding-table.js';
export * from './generate-registration.js';
export * from './verify-bindings.js';
