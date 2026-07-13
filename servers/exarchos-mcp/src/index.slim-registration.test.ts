// ─── DR-6 / Task 015: slim tools/list registration (INV-5a) ────────────────
//
// These integration tests drive the PRODUCTION server factory
// (`createServer` in index.ts — the site of the `slimRegistration: true`
// flip) through the SDK's in-memory transport and assert the two DR-6
// acceptance criteria against the *actual* `tools/list` payload the wire
// carries:
//
//   1. `toolsList_SlimRegistration_MeasuresUnder3800Tokens` — the serialized
//      registration descriptions stay under the DR-6 budget (baseline ~7,851
//      tok/session with the full base+all-signatures descriptions).
//   2. `toolsList_SlimDescriptions_RetainWhenNotToUseClause` — INV-5a: each
//      visible tool's slim description still points at the `describe` action
//      (the on-demand alternative), and the per-action "Do NOT use for …"
//      negative-space guidance is RETAINED — reachable via `describe`, not
//      dropped by the flip.
//
// Because both tests exercise `createServer` (which builds the production
// DispatchContext), reverting the index.ts flip flips the descriptions back
// to their full base+signatures form and the token budget test goes red —
// the kill-probe guarantee.

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { estimateTokens } from './architecture/description-budget.js';
import { TOOL_REGISTRY } from './registry.js';

// The DR-6 acceptance ceiling for the serialized registration descriptions.
const SLIM_REGISTRATION_TOKEN_BUDGET = 3_800;

interface ToolEntry {
  name: string;
  description?: string;
}

interface CallToolTextResult {
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/**
 * Boot the production server factory against a throwaway state dir and return
 * a connected in-memory MCP client. Registers teardown in the module-level
 * cleanup stack so a failed assertion never leaks a transport or tmp dir.
 */
async function bootProductionClient(): Promise<Client> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slim-registration-'));
  // createServer is the production DispatchContext factory — the site of the
  // DR-6 `slimRegistration: true` flip. Driving the test through it (rather
  // than a hand-built ctx) is what ties these assertions to the flip.
  const server = await createServer(tmpDir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'slim-registration-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return client;
}

describe('DR-6 slim tools/list registration', () => {
  it('toolsList_SlimRegistration_MeasuresUnder3800Tokens', async () => {
    const client = await bootProductionClient();
    const { tools } = await client.listTools();

    // Measure exactly what the wire carries: the sum of the registered tool
    // description strings the model pays for on every tools/list. Slim
    // registration replaces the ~4,500-tok base+all-signatures blurb (worst
    // case: exarchos_orchestrate folds 60+ action signatures) with the
    // one-line slimDescription.
    const descriptionTokens = (tools as ToolEntry[]).reduce(
      (sum, t) => sum + estimateTokens(t.description ?? ''),
      0,
    );

    expect(
      descriptionTokens,
      `slim tools/list registration descriptions measured ${descriptionTokens} tok — over the DR-6 ${SLIM_REGISTRATION_TOKEN_BUDGET} budget (full-description baseline is ~7,851)`,
    ).toBeLessThanOrEqual(SLIM_REGISTRATION_TOKEN_BUDGET);
  });

  it('toolsList_SlimDescriptions_RetainWhenNotToUseClause', async () => {
    const client = await bootProductionClient();
    const { tools } = await client.listTools();

    const advertised = tools as ToolEntry[];
    const visibleNames = TOOL_REGISTRY.filter((t) => !t.hidden).map((t) => t.name);

    // INV-5a: a slim tool description omits per-action detail by design, so it
    // MUST carry the pointer to the alternative — the `describe` action — where
    // that detail (schemas AND negative-space "Do NOT use for …" guidance)
    // lives. Every visible tool advertised on tools/list keeps that pointer.
    for (const name of visibleNames) {
      const entry = advertised.find((t) => t.name === name);
      expect(entry, `${name} missing from tools/list`).toBeDefined();
      expect(
        entry!.description,
        `${name} slim description dropped the describe() pointer (INV-5a)`,
      ).toContain('describe');
    }

    // The concrete "when NOT to use" clause the audit pins (merge_orchestrate's
    // "Do NOT use for …" with pointers to merge_pr / verify_worktree /
    // request_synthesize) is NOT inlined into the slim registration — it is
    // RETAINED on the on-demand `describe` path. Prove it survives the flip:
    // call describe and assert the negative-space clause comes back.
    const result = (await client.callTool({
      name: 'exarchos_orchestrate',
      arguments: { action: 'describe', actions: ['merge_orchestrate'] },
    })) as CallToolTextResult;

    expect(Array.isArray(result.content)).toBe(true);
    const describeText = result.content!.map((c) => c.text).join('\n');
    expect(
      describeText,
      'describe(merge_orchestrate) did not return the "Do NOT use for" clause — slim registration dropped the negative-space guidance (INV-5a)',
    ).toContain('Do NOT use for');
    // The pointer to the correct alternative must survive too, not just the "no".
    expect(describeText).toContain('merge_pr');
  });
});
