// ─── The capsule contract — JSON Schema artifact and its drift discipline ────
//
// Derives the checked-in JSON Schema from the single authored Zod source and
// serializes it canonically: recursively key-sorted, trailing newline. That
// makes repeated generation byte-identical, and makes a CRLF working tree agree
// with an LF checkout, so the only thing a diff on the artifact can mean is
// that someone changed the contract.
//
// Running the generator CLI is the regeneration gesture. The drift guard under
// `tests/unit/contract/capsule/` goes red when the checked-in artifact and a
// fresh generation disagree — regenerate, read the diff, commit it.
// ────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../request-context.js';
import { exarchosCapsuleJsonSchema } from './exarchos-capsule.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checked-in generated-artifact directory for the capsule contract. */
export const CAPSULE_GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in capsule JSON Schema artifact (canonical JSON, trailing newline). */
export const CAPSULE_SCHEMA_FILE = path.resolve(
  CAPSULE_GENERATED_DIR,
  'exarchos-capsule.schema.json',
);

/** The canonical, byte-stable serialization of the capsule JSON Schema on disk. */
export function serializeExarchosCapsuleJsonSchema(): string {
  return canonicalJson(exarchosCapsuleJsonSchema()) + '\n';
}
