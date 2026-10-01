/**
 * Regenerates the checked-in capsule JSON Schema from the Zod source. Run it after an intentional
 * schema change makes the drift guard fail. The change then shows as a diff that a person reads.
 *
 * Usage, from the repository root:
 *   npx tsx src/contract/capsule/exarchos-capsule-schema-cli.ts
 *
 * The file write occurs only on direct invocation, not on import.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CAPSULE_GENERATED_DIR,
  CAPSULE_SCHEMA_FILE,
  serializeExarchosCapsuleJsonSchema,
} from './exarchos-capsule-schema.js';

/** Regenerate and write the checked-in capsule JSON Schema artifact. */
export function generateExarchosCapsuleSchemaArtifact(): { readonly schemaFile: string } {
  fs.mkdirSync(CAPSULE_GENERATED_DIR, { recursive: true });
  fs.writeFileSync(CAPSULE_SCHEMA_FILE, serializeExarchosCapsuleJsonSchema(), 'utf8');
  return { schemaFile: CAPSULE_SCHEMA_FILE };
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { schemaFile } = generateExarchosCapsuleSchemaArtifact();
  process.stdout.write(`wrote Exarchos capsule JSON Schema: ${schemaFile}\n`);
}
