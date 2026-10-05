/**
 * Static scan: no production file under `src/` builds an `InMemoryTaskStore`.
 *
 * The SDK `InMemoryTaskStore` loses all data on restart. Production code must build
 * `EventSourcedTaskStore`, so the task lifecycle state is durable. A second test makes sure
 * that the MCP server composer, `adapters/mcp/mcp.ts`, builds that store.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the repository `src/` directory. */
const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../src');

/** Lists the source files under `dir`. It skips `node_modules` and `dist`, so the SDK copy stays out of the scan. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** True for a test file, a path under `__tests__` or a fixture path. */
function isTestFile(filePath: string): boolean {
  return (
    /\.test\.[mc]?[jt]sx?$/.test(filePath) ||
    /\b__tests__\b/.test(filePath) ||
    /\.fixture\.[mc]?[jt]sx?$/.test(filePath) ||
    /\bfixtures\b/.test(filePath)
  );
}

describe('Production wiring — no InMemoryTaskStore (#1272)', () => {
  /** `stat` rejects when `SRC_DIR` does not exist, so a wrong path cannot give an empty scan. */
  it('Production_NoInMemoryTaskStore_Instances', async () => {
    await stat(SRC_DIR);
    const files = await walk(SRC_DIR);
    const productionFiles = files.filter((f) => !isTestFile(f));

    const offenders: string[] = [];
    for (const file of productionFiles) {
      const text = await readFile(file, 'utf8');
      if (/\bnew\s+InMemoryTaskStore\s*\(/.test(text)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }

    expect(
      offenders,
      `InMemoryTaskStore must NOT appear in production code paths. Found in: ${offenders.join(', ')}. Replace with EventSourcedTaskStore.`,
    ).toEqual([]);
  });

  /** A text check only: the composer source must name and build `EventSourcedTaskStore`. */
  it('EventSourcedTaskStore_IsWiredAtCanonicalSite', async () => {
    const composerPath = path.join(SRC_DIR, 'adapters', 'mcp', 'mcp.ts');
    const text = await readFile(composerPath, 'utf8');
    expect(
      text,
      `${path.relative(SRC_DIR, composerPath)} must import EventSourcedTaskStore`,
    ).toMatch(/EventSourcedTaskStore/);
    expect(
      text,
      `${path.relative(SRC_DIR, composerPath)} must instantiate EventSourcedTaskStore`,
    ).toMatch(/new\s+EventSourcedTaskStore\s*\(/);
  });
});
