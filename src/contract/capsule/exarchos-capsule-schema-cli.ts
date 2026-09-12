// ─── The capsule contract — JSON Schema generator ───────────────────────────
//
// Regenerates the checked-in capsule JSON Schema from the authored Zod source.
// Running this IS the regeneration gesture: after an intentional change to the
// schema the drift guard goes red, and this is what makes it green again —
// through a diff someone reads, not a silent rewrite.
//
// Usage, from the repository root:
//   npx tsx src/contract/capsule/exarchos-capsule-schema-cli.ts
//
// The write happens ONLY on direct invocation, never on import, so a test that
// imports the serialization helpers has no filesystem side effect.
// ────────────────────────────────────────────────────────────────────────────

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
