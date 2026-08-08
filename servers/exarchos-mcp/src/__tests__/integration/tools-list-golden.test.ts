// ─── DR-0 — tools/list wire golden ─────────────────────────────────────────
//
// DR-0 adds the v2 MCP SDK packages (`@modelcontextprotocol/{core,server}`)
// ALONGSIDE the pinned v1 `@modelcontextprotocol/sdk`. The load-bearing
// promise of that step is that **nothing changes on the wire**: v2 speaks the
// 2025-era protocol until an explicit era opt-in, so adding it — and later
// migrating modules onto it — must leave `tools/list` byte-identical.
//
// The existing `tools-list.test.ts` pins the manifest's *shape* (every entry
// carries an outputSchema, annotations are populated, hidden tools are
// absent). Shape assertions cannot catch a byte-level drift: a renamed
// property, a reordered `required` array, a changed `$schema` URL or a
// re-worded description all satisfy every shape check while changing what a
// model-side agent actually receives.
//
// So this test pins the BYTES. It canonicalises the full `tools/list` result
// (recursively key-sorted, tools ordered by name) and compares it against a
// committed golden file.
//
// HONEST SCOPE NOTE (task 049): the golden is currently produced by the **v1**
// adapter, because the source migration is blocked — v2 2.0.0 removed the
// experimental Tasks *store* seam (`ServerOptions.taskStore`, and the
// `TaskStore` / `CreateTaskOptions` / `isTerminal` interface module) that
// `adapters/mcp.ts` and `EventSourcedTaskStore` are built on. Until that is
// redesigned, this golden does two jobs:
//
//   1. NOW — proves that adding the v2 packages alongside v1 perturbed no
//      wire bytes (an additive dependency change must be inert).
//   2. LATER — is the exact artifact the migration must reproduce. When
//      `adapters/mcp.ts` moves to v2, this test passing unchanged IS the
//      byte-identity proof. A diff here is the migration changing the
//      contract, and must be reviewed rather than regenerated reflexively.
//
// Regenerate deliberately (and review the diff) with:
//   UPDATE_TOOLS_LIST_GOLDEN=1 npx vitest run src/__tests__/integration/tools-list-golden.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createV1Client,
  createV1LinkedTransportPair,
  connectV1Client,
  connectV1Server,
  type V1Client,
} from '../../sdk/seam.js';
import { createMcpServer } from '../../adapters/mcp.js';
import { EventStore } from '../../event-store/store.js';
import type { DispatchContext } from '../../core/dispatch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(here, '__goldens__', 'tools-list.golden.json');

/**
 * Recursively sort object keys so the serialisation is independent of
 * property insertion order. Arrays keep their order — element order IS part
 * of the contract (e.g. a schema's `required` list, `anyOf` branches).
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = canonicalise(v);
    return out;
  }
  return value;
}

describe('DR-0 — tools/list wire golden', () => {
  let tmpDir: string;
  let client: V1Client;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-list-golden-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore,
      enableTelemetry: false,
    };

    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = createV1LinkedTransportPair();
    client = createV1Client(
      { name: 'tools-list-golden', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      connectV1Server(server, serverTransport),
      connectV1Client(client, clientTransport),
    ]);
  });

  afterEach(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ToolsList_AfterV2Migration_ByteIdenticalToGolden', async () => {
    const { tools } = await client.listTools();

    // Order the manifest by tool name so a registry reordering does not
    // masquerade as a wire change (and vice versa — a genuine rename still
    // shows up).
    const ordered = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const actual = `${JSON.stringify(canonicalise({ tools: ordered }), null, 2)}\n`;

    if (process.env.UPDATE_TOOLS_LIST_GOLDEN === '1') {
      await fs.mkdir(path.dirname(goldenPath), { recursive: true });
      await fs.writeFile(goldenPath, actual, 'utf8');
    }

    let expected: string;
    try {
      expected = await fs.readFile(goldenPath, 'utf8');
    } catch {
      throw new Error(
        `Missing tools/list golden at ${goldenPath}. ` +
          'Regenerate with UPDATE_TOOLS_LIST_GOLDEN=1 and review the diff before committing.',
      );
    }

    // Byte-for-byte. Any difference — a renamed field, a reordered `required`
    // array, a changed $schema URL, a re-worded tool description — fails here.
    expect(actual).toBe(expected);

    // Guard against a vacuous golden: an empty manifest would compare equal to
    // an empty golden and silently prove nothing.
    expect(ordered.length).toBeGreaterThan(0);
  });
});
