/**
 * Derives the checked-in capsule JSON Schema from the authored Zod source.
 * The output is canonical JSON with recursively sorted keys and a trailing newline, so repeated
 * generation is byte-identical. A diff on the artifact thus means a contract change.
 * A drift guard under `tests/unit/contract/capsule/` fails when the artifact and a fresh generation differ.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../request-context.js';
import { exarchosCapsuleJsonSchema } from './exarchos-capsule.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The checked-in generated-artifact directory for the capsule contract. */
export const CAPSULE_GENERATED_DIR = path.resolve(HERE, 'generated');

/** The checked-in capsule JSON Schema artifact. */
export const CAPSULE_SCHEMA_FILE = path.resolve(
  CAPSULE_GENERATED_DIR,
  'exarchos-capsule.schema.json',
);

/** The canonical, byte-stable serialization of the capsule JSON Schema on disk. */
export function serializeExarchosCapsuleJsonSchema(): string {
  return canonicalJson(exarchosCapsuleJsonSchema()) + '\n';
}
