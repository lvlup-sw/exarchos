/**
 * The public surface of the shared admission IR. It exports the wire model and validators, the
 * JSON Schema artifact, the dangling-reference resolver, and the builder lowering.
 */

export * from './admission-ir.js';
export * from './admission-ir-schema.js';
export * from './references.js';
export * from './builder.js';
