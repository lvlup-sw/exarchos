/**
 * Regenerates the checked-in JSON Schema artifact of the shared admission IR from its Zod source.
 * After an intentional schema change, the drift guard fails. Run this CLI, review the diff, and
 * commit the artifact.
 *
 * Usage, from the repository root: `npx tsx src/contract/ir/admission-ir-schema-cli.ts`
 *
 * The write runs only when the file is invoked directly, never on import.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ADMISSION_IR_SCHEMA_FILE,
  IR_GENERATED_DIR,
  serializeAdmissionIrJsonSchema,
} from './admission-ir-schema.js';

/** Regenerate + write the checked-in shared-IR JSON Schema artifact. */
export function generateAdmissionIrSchemaArtifact(): { readonly schemaFile: string } {
  fs.mkdirSync(IR_GENERATED_DIR, { recursive: true });
  fs.writeFileSync(ADMISSION_IR_SCHEMA_FILE, serializeAdmissionIrJsonSchema(), 'utf8');
  return { schemaFile: ADMISSION_IR_SCHEMA_FILE };
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
  const { schemaFile } = generateAdmissionIrSchemaArtifact();
  process.stdout.write(`wrote shared admission IR JSON Schema: ${schemaFile}\n`);
}
