// @oracle-sources: the live `src/adapters/` tree walked off disk, and INV-2 as
// stated in `.exarchos/invariants.md` (the contract is the invocation surface;
// the CLI is a client of it). No fixture corpus and no recorded baseline — the
// subject is the shipped directory layout itself.
//
// ─── INV-2 as a directory-level fact (task 018) ──────────────────────────────
//
// The contract is the invocation surface; the CLI is a client of it. Task 018
// split `adapters/` so that statement is readable off the tree instead of
// asserted in prose: `adapters/mcp/` is the wire contract, `adapters/cli/` is
// the presentation client.
//
// The direction is one-way. `cli/` importing `mcp/` is the client calling the
// surface and is expected — `cli.ts` does exactly that. `mcp/` importing
// `cli/` would make the contract depend on one of its clients, which is the
// coupling INV-2 exists to forbid.
//
// This is a dedicated scan rather than a `LAYER_ALLOWED_IMPORTS` row because
// `layerOf()` still resolves a module to its FIRST path segment, so both
// halves read as the single layer `adapters` and the census cannot express an
// edge between them. Making the census path-aware is DR-3's own work; until it
// lands, the rule is enforced here rather than left unenforced.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ADAPTERS = fileURLToPath(new URL('../../../src/adapters/', import.meta.url));

/** Every `.ts` file under `dir`, recursively. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Relative import specifiers in `source`, in any import-like position. */
function importSpecifiers(source: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bvi\.(?:mock|doMock)\s*\(\s*)['"](\.[^'"]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1]);
}

/**
 * Specifiers in `file` that resolve into `adapters/cli/`.
 *
 * Resolution is arithmetic against the importing file's own directory, not a
 * substring test: `'../cli/cli.js'` and `'./cli.js'` name the same module from
 * different depths, and a textual check would miss one of them.
 */
function edgesIntoCli(file: string, source: string): string[] {
  const hits: string[] = [];
  for (const spec of importSpecifiers(source)) {
    const target = join(dirname(file), spec);
    const rel = relative(ADAPTERS, target).split(/[\\/]/);
    if (rel[0] === 'cli') hits.push(spec);
  }
  return hits;
}

describe('AdapterDirection_McpImportingCli_IsRejected (INV-2, task 018)', () => {
  it('no module under adapters/mcp/ imports adapters/cli/', () => {
    const offenders: string[] = [];
    for (const file of collectTsFiles(join(ADAPTERS, 'mcp'))) {
      for (const spec of edgesIntoCli(file, readFileSync(file, 'utf-8'))) {
        offenders.push(`${relative(ADAPTERS, file)} imports "${spec}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector REJECTS a planted mcp -> cli import', () => {
    // Without this the first test passes when the detector is broken — the
    // failure mode a pure "scan finds nothing" assertion cannot distinguish
    // from a clean tree.
    const planted = "import { runCli } from '../cli/cli.js';\nrunCli();\n";
    const found = edgesIntoCli(join(ADAPTERS, 'mcp', 'planted.ts'), planted);
    expect(found).toEqual(['../cli/cli.js']);
  });

  it('the allowed direction — cli/ importing mcp/ — is NOT flagged', () => {
    // The rule is one-way. A detector that flagged this too would be a rule
    // against adapter cohesion, not against INV-2's direction.
    const client = "import { createServer } from '../mcp/mcp.js';\n";
    const found = edgesIntoCli(join(ADAPTERS, 'cli', 'client.ts'), client);
    expect(found).toEqual([]);
  });

  it('the live cli/ surface DOES call into mcp/ (the rule has a real subject)', () => {
    // If the split ever left the two halves disconnected, the direction rule
    // above would be vacuously true. This pins that the client-of-the-surface
    // relationship actually exists in shipped code.
    const cliFiles = collectTsFiles(join(ADAPTERS, 'cli')).filter((f) => !f.endsWith('.test.ts'));
    const intoMcp = cliFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf-8');
      return importSpecifiers(source).filter((spec) => {
        const rel = relative(ADAPTERS, join(dirname(file), spec)).split(/[\\/]/);
        return rel[0] === 'mcp';
      });
    });
    expect(intoMcp.length).toBeGreaterThan(0);
  });
});
