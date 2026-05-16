/**
 * Production wiring grep — no `InMemoryTaskStore` outside test fixtures (#1272).
 *
 * INV-1 acceptance: the SDK's `InMemoryTaskStore` is demo-only ("not
 * suitable for production use as all data is lost on restart" — see
 * `node_modules/@modelcontextprotocol/sdk/.../in-memory.js`). Production
 * code paths must instantiate `EventSourcedTaskStore` instead so task
 * lifecycle state is durable and event-sourced.
 *
 * This is a static-analysis test: it walks the `src/` tree and asserts
 * that `new InMemoryTaskStore(` appears nowhere outside test fixtures.
 * Pair test: `EventSourcedTaskStore_IsWiredAtCanonicalSite` asserts the
 * production composer (`adapters/mcp.ts:createMcpServer`) imports +
 * instantiates the event-sourced variant.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

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

function isTestFile(filePath: string): boolean {
  // Vitest convention: `.test.ts`, `__tests__/` directories, and fixture
  // suffixes. The InMemoryTaskStore reference inside the SDK's
  // `node_modules/` is excluded by the `node_modules` skip in `walk`.
  return (
    /\.test\.[mc]?[jt]sx?$/.test(filePath) ||
    /\b__tests__\b/.test(filePath) ||
    /\.fixture\.[mc]?[jt]sx?$/.test(filePath) ||
    /\bfixtures\b/.test(filePath)
  );
}

describe('Production wiring — no InMemoryTaskStore (#1272)', () => {
  it('Production_NoInMemoryTaskStore_Instances', async () => {
    await stat(SRC_DIR); // sanity: SRC_DIR exists
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

  it('EventSourcedTaskStore_IsWiredAtCanonicalSite', async () => {
    // The MCP server composer is the canonical wiring point — every
    // production MCP server constructed via `createMcpServer` must
    // receive an `EventSourcedTaskStore` instance backed by
    // `ctx.eventStore`. Asserted as a textual presence-check (the
    // composer's runtime behavior is exercised end-to-end by
    // `adapters/mcp.test.ts`).
    const composerPath = path.join(SRC_DIR, 'adapters', 'mcp.ts');
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
