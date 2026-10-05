// The wire golden of `tools/list`.
//
// `tools-list.test.ts` pins the shape of the manifest. A shape assertion cannot see a byte-level
// drift: a renamed property, a reordered `required` array, a changed `$schema` URL or a reworded
// description. This test pins the bytes. It canonicalises the full `tools/list` result (sorted
// keys, tools in name order) and compares it with a committed golden file.
//
// A diff is a change of the wire contract. Review the diff before you regenerate the golden:
//   UPDATE_TOOLS_LIST_GOLDEN=1 npx vitest run --project core tests/integration/tools-list-golden.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  type V2Client,
} from '../../src/contract/sdk/seam.js';
import { createMcpServer } from '../../src/adapters/mcp/mcp.js';
import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenPath = path.join(here, '__goldens__', 'tools-list.golden.json');

/**
 * Sorts object keys recursively, so the serialisation does not depend on the insertion order of
 * properties. Arrays keep their order, because element order is part of the contract. Examples are
 * the `required` list and the `anyOf` branches of a schema.
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
  let client: V2Client;

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
    const [clientTransport, serverTransport] = createV2LinkedTransportPair();
    client = createV2Client(
      { name: 'tools-list-golden', version: '1.0.0' },
      { capabilities: {} },
    );
    await Promise.all([
      connectV2Server(server, serverTransport),
      connectV2Client(client, clientTransport),
    ]);
  });

  /** The hook ignores a failure of `client.close()`, so it always removes the temp directory. */
  afterEach(async () => {
    try {
      await client.close();
    } catch {
    }
    await rmrfAsync(tmpDir);
  });

  /**
   * The test puts the tools in name order, so a registry reorder is not a wire change. With
   * `UPDATE_TOOLS_LIST_GOLDEN=1`, it writes the golden before the comparison. The comparison is
   * byte for byte. The last assertion rejects an empty manifest, which equals an empty golden and
   * proves nothing.
   */
  it('ToolsList_AfterV2Migration_ByteIdenticalToGolden', async () => {
    const { tools } = await client.listTools();

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

    expect(actual).toBe(expected);

    expect(ordered.length).toBeGreaterThan(0);
  });
});
