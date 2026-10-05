// The wire golden of `tools/list`.
//
// `tools-list.test.ts` pins the shape of the manifest. A shape assertion cannot see a byte-level
// drift: a renamed property, a reordered `required` array, a changed `$schema` URL or a reworded
// description. This test pins the bytes. It canonicalises the full `tools/list` result (sorted
// keys, tools in name order) and compares it with a committed golden file.
//
// A diff is a change of the wire contract: it changes what a model-side agent receives. Do not
// regenerate the golden only to make the test pass. Regenerate it with this command, then do the
// review that the description of `goldenPath` gives, before you commit:
//   UPDATE_TOOLS_LIST_GOLDEN=1 npx vitest run --project core tests/integration/tools-list-golden.test.ts
//
// No tool entry holds an `execution` block. The v2 `registerTool` config has no `execution`
// member, so the adapter cannot advertise `taskSupport`.

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
/**
 * The committed golden. Each tool description in it holds one signature line and one contract
 * digest row for each action. Thus a change of an action signature, an action description or a
 * contract declaration moves the golden, also when no JSON schema moves.
 *
 * Before you commit a new golden, parse the old golden and the new golden, and compare them for
 * each tool and each field. A line diff is not sufficient, because a description is one JSON line
 * and the diff cannot tell an addition from a rewrite. Each changed field must come from the
 * change that you made. Make sure that no other tool, action, order, schema or digest moved. A
 * change that refuses a call that was valid must be deliberate.
 */
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
   * The test puts the tools in name order, so a reorder of the registry does not show as a diff. A
   * renamed tool still shows. With `UPDATE_TOOLS_LIST_GOLDEN=1`, the test writes the golden before
   * the comparison, so that run always passes. The comparison is byte for byte. The last assertion
   * rejects an empty manifest, which equals an empty golden and proves nothing.
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
