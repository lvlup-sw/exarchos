/**
 * A `RESERVED(issue, owner, expires)` header declares the intent of a module with no production
 * importer. The module-intent gate reads the header only on such a module. Thus a header on a live
 * module is stale, and nothing else reports it.
 *
 * The suite reads every module under `src/` and finds each header. It then checks that no module
 * outside the reserved set imports a reserved module. An import from another reserved module is
 * permitted, because both modules wait for the same decision.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';
import { lexModule } from '../../tools/test-helpers/module-lexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

/** The header form that the module-intent gate parses. It is the first line of the module. */
const RESERVED_HEADER = /^\/\/ RESERVED\(issue: #\d+, owner: [^,]+, expires: \d{4}-\d{2}-\d{2}\)/;

/** The tracked production modules under `src/`, with their source text. */
async function sourceModules(): Promise<Map<string, string>> {
  const modules = (await execFileAsync('git', ['ls-files', '-z', 'src'], { cwd: REPO_ROOT }))
    .split('\0')
    .filter((rel) => /\.(ts|mts)$/.test(rel) && !rel.endsWith('.d.ts'));
  return new Map(modules.map((rel) => [rel, readFileSync(path.join(REPO_ROOT, rel), 'utf8')]));
}

/** The repository-relative module that a relative specifier names, or undefined for a package. */
function resolveRelative(fromRel: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  return joined.replace(/\.m?js$/, (ext) => (ext === '.mjs' ? '.mts' : '.ts'));
}

/**
 * Each reserved module with its importers outside the reserved set, as `module <- importers`.
 * The check and its kill probe both call this function.
 */
function staleReservations(sources: ReadonlyMap<string, string>): string[] {
  const reserved = new Set([...sources].filter(([, source]) => RESERVED_HEADER.test(source)).map(([rel]) => rel));
  const importers = new Map<string, string[]>([...reserved].map((rel) => [rel, []]));
  for (const [rel, source] of sources) {
    if (reserved.has(rel)) continue;
    for (const ref of lexModule(source, rel).imports) {
      const target = resolveRelative(rel, ref.specifier);
      if (target !== undefined && reserved.has(target)) importers.get(target)?.push(rel);
    }
  }
  return [...importers]
    .filter(([, from]) => from.length > 0)
    .map(([rel, from]) => `${rel} <- ${from.join(', ')}`);
}

describe('reserved module headers', () => {
  it('ReservedModules_AreFound_TheScanIsNotEmpty', async () => {
    const sources = await sourceModules();

    expect([...sources.values()].filter((source) => RESERVED_HEADER.test(source)).length).toBeGreaterThan(0);
  });

  it('ReservedModule_HasNoImporterOutsideTheReservedSet', async () => {
    expect(staleReservations(await sourceModules()), 'a RESERVED header sits on a module that production code imports')
      .toEqual([]);
  });

  /** The kill probe. A seeded header on the live Git observation reader must show in the check. */
  it('SeededHeaderOnALiveModule_IsReported', async () => {
    const sources = new Map(await sourceModules());
    const live = 'src/utils/git-observer.ts';
    const original = sources.get(live);
    expect(original, 'the probe module is gone').toBeDefined();
    sources.set(live, `// RESERVED(issue: #1, owner: exarchos, expires: 2099-01-01) — probe\n${original ?? ''}`);

    const stale = staleReservations(sources);

    expect(stale.some((line) => line.startsWith(`${live} <- `))).toBe(true);
  });
});
