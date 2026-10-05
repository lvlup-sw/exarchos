// @oracle-sources: the live `src/adapters/` tree walked off disk, and the invariant as
// stated in `.exarchos/invariants.md`. The subject is the shipped directory layout, so the test
// uses no fixture corpus and no recorded baseline.
//
// The invariant: the contract is the invocation surface, and the CLI is a client of the contract.
// `adapters/mcp/` is the wire contract and `adapters/cli/` is the presentation client.
//
// The direction is one-way. `cli/` can import `mcp/`, and `cli.ts` does. An import of `cli/` from
// `mcp/` makes the contract depend on one of its clients.
//
// The layering census also forbids the import from `adapters/mcp` to `adapters/cli`. This file
// is the focused kill probe: it plants a reverse edge and does not use the allowance table.

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
 * The function resolves each specifier against the directory of the importing file. A substring
 * test is not sufficient: `'../cli/cli.js'` and `'./cli.js'` name the same module from different
 * depths.
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

  /** A detector that finds nothing also makes the first test pass. This test proves that the detector finds an edge. */
  it('the detector REJECTS a planted mcp -> cli import', () => {
    const planted = "import { runCli } from '../cli/cli.js';\nrunCli();\n";
    const found = edgesIntoCli(join(ADAPTERS, 'mcp', 'planted.ts'), planted);
    expect(found).toEqual(['../cli/cli.js']);
  });

  /** The rule is one-way. A detector that also flags this edge is a rule against adapter cohesion. */
  it('the allowed direction — cli/ importing mcp/ — is NOT flagged', () => {
    const client = "import { createServer } from '../mcp/mcp.js';\n";
    const found = edgesIntoCli(join(ADAPTERS, 'cli', 'client.ts'), client);
    expect(found).toEqual([]);
  });

  /** If no shipped `cli/` module imports `mcp/`, the direction rule is vacuously true. */
  it('the live cli/ surface DOES call into mcp/ (the rule has a real subject)', () => {
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
