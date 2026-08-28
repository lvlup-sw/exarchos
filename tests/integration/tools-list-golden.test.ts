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
// ── THE MIGRATION HAPPENED, AND THE GOLDEN MOVED BY EXACTLY ONE FIELD ───────
//
// This golden is now produced by the **v2** adapter. Its previous revision said
// a diff here "must be reviewed rather than regenerated reflexively". It was
// reviewed; this is the review.
//
// MEASURED, not eyeballed: with the `execution` block removed from both sides,
// the old and new goldens are byte-identical — same four tools, same order,
// same descriptions, same `inputSchema`, `outputSchema` and `annotations`. The
// ONLY delta across the whole `tools/list` surface is that every tool lost
//
//     "execution": { "taskSupport": "forbidden" }
//
// WHY IT IS NOT RECOVERABLE, rather than merely not recovered. v2's
// `registerTool` config accepts `title`, `description`, `inputSchema`,
// `outputSchema`, `annotations`, `icons` and `_meta` — and no `execution`
// member at all. The field was never ours to declare: under v1 the SDK
// SYNTHESISED it from the `taskStore` wiring, and v2 ships no server-side Tasks
// runtime to synthesise it from. `@modelcontextprotocol/server@2.0.0` groups
// `execution.taskSupport` with `capabilities.tasks` as one "known deleted-field
// set", which is the same surface operator decision D10 accepted the loss of.
//
// So this is D10's accepted cost showing up one layer out from where D10 named
// it. D10 said `tasks/*` answers a typed `-32601`; the same deletion also
// removes the per-tool advertisement of task support. Recorded here explicitly
// because DR-0's acceptance criterion is "byte-identical `tools/list`", and
// that criterion now holds with exactly one named, structurally-forced
// exception rather than absolutely.
//
// The test's job is unchanged and undiminished: any FURTHER diff is the
// migration changing the contract, and must be reviewed rather than regenerated
// reflexively.
//
// ── SECOND REVIEWED MOVE: the `featureId` alias on the three task verbs ─────
//
// MEASURED, not eyeballed: normalising both goldens and diffing yields exactly
// TWO changed lines — the `exarchos_orchestrate` tool description, before and
// after. The whole delta is the three task-verb signatures:
//
//     task_claim(taskId, agentId, streamId)              → (…, streamId?, featureId?)
//     task_complete(taskId, result?, evidence?, streamId) → (…, streamId?, featureId?)
//     task_fail(taskId, error, diagnostics?, streamId)    → (…, streamId?, featureId?)
//
// This is a WIDENING and therefore not a compatibility break: `streamId` went
// required → optional and `featureId` was added optional, so every call that
// was valid before is still valid and still resolves to the same stream
// (`resolveStreamIdentity` prefers `streamId` when both are present — pinned by
// `TaskVerbs_StreamIdWins_WhenBothSpellingsDisagree`). No tool was added or
// removed, no order changed, and no other tool's schema moved.
//
// The change exists because requiring only the internal spelling made agents
// ASK the operator for a value they already held: the workflow stream id IS the
// bare featureId, which is the name every workflow surface uses.
//
// ── Two more compilable intents on `execute_intent` ────────────────────────
//
// MEASURED, not eyeballed: normalising both goldens and diffing yields exactly
// ONE changed line — the `exarchos_orchestrate` tool description — and within
// it, one changed action signature line plus the schema digest that line feeds.
// The whole delta is `execute_intent`'s description, which now names the three
// compilable intents instead of one:
//
//     'task-completion'                → + 'quality-evaluation', 'plan-closeout'
//
// This is a WIDENING and therefore not a compatibility break: the request
// schema is unchanged (`intent`, `args`, subject identity, `operationId`), no
// action or tool was added or removed, no order changed, and no other action's
// schema moved. `intent` was always a free-form runbook id; two more ids now
// compile instead of being refused as not-compilable.
//
// The description also SHRANK to fit the per-action description budget, which
// is why sentences moved rather than only accumulated. The reasons that left
// the description live on the intents' argument schemas, where a caller reading
// the refusal message meets them.
//
// Regenerate deliberately (and review the diff) with:
//   UPDATE_TOOLS_LIST_GOLDEN=1 npx vitest run src/__tests__/integration/tools-list-golden.test.ts

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
