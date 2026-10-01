// The single import site for the deterministic contract compiler.
// It also exports the drift guard (`observeRuntimeSurface`, `auditMetaModel`, `classifyContractDrift`).
// The guard sits on the same surface as the code it guards, so callers can reach it.

export * from './meta-model.js';
export * from './descriptors.js';
export * from './fixtures.js';
export * from './compile.js';
export * from './runtime-authority.js';
