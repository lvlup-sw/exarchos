/**
 * Derives the checked-in JSON Schema artifact of the shared admission IR from its Zod source in
 * `admission-ir.ts`. The serialization is canonical, key-sorted JSON with a trailing newline. The
 * artifact is then byte-identical across repeated generation and across CRLF and LF checkouts.
 *
 * A run of `admission-ir-schema-cli.ts` regenerates the artifact. The drift guard under
 * `tests/unit/contract/ir/` fails when the artifact differs from a fresh generation.
 */

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
 * The canonical serialization of the shared-IR JSON Schema on disk: recursive key sort and a
 * trailing newline, so repeated generation gives the same bytes.
 */
export function serializeAdmissionIrJsonSchema(): string {
  return canonicalJson(admissionIrJsonSchema()) + '\n';
}
