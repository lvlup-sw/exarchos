// ─── Shared admission IR — JSON Schema generator CLI (P03-06) ────────────────
//
// PROGRAM-03, API-007. Regenerates the checked-in shared-IR JSON Schema artifact
// from the single authored Zod source. Running this IS the regeneration gesture
// (mirrors P03-01's `authority-lock-cli.ts` and P03-03's `compiler/generate.ts`):
// after an intentional change to the authored schema the drift guard goes red;
// run this, review the diff, and commit the regenerated artifact.
//
// Usage (from servers/exarchos-mcp):
//   npx tsx src/contract/ir/admission-ir-schema-cli.ts
//
// The write side effect runs ONLY when invoked directly, never on import, so a
// test importing the serialization helpers has no filesystem side effect.
// ────────────────────────────────────────────────────────────────────────────

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
