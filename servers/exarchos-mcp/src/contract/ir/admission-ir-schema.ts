// ─── Shared admission IR — JSON Schema artifact + drift discipline (P03-06) ──
//
// PROGRAM-03, API-007. Derives the checked-in JSON Schema artifact from the
// single authored Zod source (`admission-ir.ts`) and serializes it with the
// SAME determinism discipline as P03-03's proof-fixture baseline: canonical,
// recursively key-sorted JSON (`canonicalJson`) with a trailing newline, so the
// artifact is byte-identical across repeated generation and across a CRLF
// working tree vs. an LF CI checkout.
//
// Running the generator CLI (`admission-ir-schema-cli.ts`) is the regeneration
// gesture; the co-located `admission-ir-schema.test.ts` drift guard fails when
// the checked-in artifact diverges from a fresh generation (the same
// "regenerate + review in a diff" gesture as the authority lock).
// ────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../request-context.js';
import { admissionIrJsonSchema } from './admission-ir.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checked-in generated-artifact directory for the shared IR. */
export const IR_GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in shared-IR JSON Schema artifact (canonical JSON, trailing newline). */
export const ADMISSION_IR_SCHEMA_FILE = path.resolve(IR_GENERATED_DIR, 'admission-ir.schema.json');

/**
 * The canonical, byte-stable serialization of the shared-IR JSON Schema written
 * to disk. Reuses the P03-03 canonical-JSON discipline (recursive key sort +
 * trailing newline) so repeated generation is byte-identical.
 */
export function serializeAdmissionIrJsonSchema(): string {
  return canonicalJson(admissionIrJsonSchema()) + '\n';
}
