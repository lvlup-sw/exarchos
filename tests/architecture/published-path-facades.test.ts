/**
 * The six published paths named by the hotspot split are not one shape.
 * Four are re-export barrels, one is a barrel with a CLI guard, and one
 * still holds the storage class. The inventory path is a barrel over
 * `guard-inventory/`, not the implementation.
 *
 * Classification is read off the files, not off their names.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function isReexportBarrel(source: string): boolean {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const withoutExports = stripped.replace(
    /export\s+(?:\*|\{[\s\S]*?\})\s+from\s+['"][^'"]+['"];?/g,
    '',
  );
  return withoutExports.trim() === '';
}

describe('published-path facades', () => {
  it('PublishedPathFacades_AreClassifiedByShapeNotByName', () => {
    const registry = read('src/registry.ts');
    expect(registry).toMatch(/^export \* from '\.\/registry\/index\.js';$/m);
    expect(registry).not.toMatch(/\bexport (class|function|const)\b/);

    for (const rel of ['src/workflow/tools.ts', 'src/projections/views/tools.ts'] as const) {
      expect(isReexportBarrel(read(rel)), `${rel} is not a re-export barrel`).toBe(true);
    }

    const skills = read('src/install/build-skills.ts');
    expect(skills).toMatch(/import\.meta\.url === pathToFileURL\(/);
    expect(skills).toMatch(/export \{ main \} from '\.\/build-skills\/main\.js'/);
    expect(skills).not.toMatch(/\bexport class\b/);

    const sqlite = read('src/storage/sqlite-backend.ts');
    expect(sqlite).toMatch(/export class SqliteBackend implements StorageBackend/);

    const inventory = read('tools/audit/gates/guard-inventory.ts');
    expect(inventory).toMatch(/export \{ buildGuardInventory/);
    expect(inventory).toMatch(/from '\.\/guard-inventory\//);
    expect(inventory).not.toMatch(/\bexport class\b/);
    expect(inventory).not.toMatch(/\bexport (async )?function\b/);
  });
});
