/**
 * Tests for the slim `tools/list` registration that `createServer` turns on.
 * They drive the production server factory through the in-memory transport of the SDK.
 * The registered descriptions must stay in the token budget.
 * Each slim description must name the `describe` action, and `describe` must still return the "Do NOT use for" guidance.
 * If `createServer` turns slim registration off, the full descriptions come back and the budget test fails.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createV2Client,
  createV2LinkedTransportPair,
  connectV2Client,
  connectV2Server,
  type V2Client,
} from '../../src/contract/sdk/seam.js';
import { createServer } from '../../src/index.js';
import { estimateTokens } from '../../tools/conformance/src/description-budget.js';
import { TOOL_REGISTRY } from '../../src/registry.js';
import { rmrf, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** The home variables of the run. The file restores them after its last test. */
const ORIGINAL_HOME: Readonly<Record<'HOME' | 'USERPROFILE', string | undefined>> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

/** The scratch home of this file. No test of this file reads or writes the real home. */
let scratchHome = '';

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), 'create-server-home-'));
  process.env.HOME = scratchHome;
  process.env.USERPROFILE = scratchHome;
});

afterAll(() => {
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    const value = ORIGINAL_HOME[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmrf(scratchHome);
});

/** The token ceiling for the sum of the registered tool descriptions. */
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

/**
 * Telemetry is off, so the `describe` dispatch does not open the SQLite database in the temporary directory.
 * `createServer` returns no store handle that the test can close.
 * On Windows, an open handle blocks the removal of the directory with `EBUSY`.
 */
beforeEach(() => {
  vi.stubEnv('EXARCHOS_TELEMETRY', 'false');
});

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  vi.unstubAllEnvs();
});

/**
 * Boots `createServer` on a temporary state directory and returns a connected in-memory MCP client.
 * `createServer` builds the production context that turns slim registration on, so a hand-built context proves nothing here.
 * The cleanup stack closes the client and removes the directory, also after a failed assertion.
 */
async function bootProductionClient(): Promise<V2Client> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slim-registration-'));
  const server = await createServer(tmpDir);
  const [clientTransport, serverTransport] = createV2LinkedTransportPair();
  const client = createV2Client({ name: 'slim-registration-test', version: '1.0.0' }, { capabilities: {} });
  await Promise.all([
    connectV2Server(server, serverTransport),
    connectV2Client(client, clientTransport),
  ]);
  cleanups.push(async () => {
    try {
      await client.close();
    } catch {
    }
    await rmrfAsync(tmpDir);
  });
  return client;
}

describe('DR-6 slim tools/list registration', () => {
  /** `createServer` reads no file under `os.homedir()`. The home of this file is still its scratch home and never the real one. */
  it('CreateServer_HomeDirectory_IsTheScratchHomeOfThisFile', () => {
    expect(homedir()).toBe(scratchHome);
    expect(scratchHome).not.toBe(ORIGINAL_HOME.HOME);
  });
  /** The measure is the sum of the registered tool descriptions, which the model pays for on each `tools/list` call. */
  it('toolsList_SlimRegistration_MeasuresUnder3800Tokens', async () => {
    const client = await bootProductionClient();
    const { tools } = await client.listTools();

    const descriptionTokens = (tools as ToolEntry[]).reduce(
      (sum, t) => sum + estimateTokens(t.description ?? ''),
      0,
    );

    expect(
      descriptionTokens,
      `slim tools/list registration descriptions measured ${descriptionTokens} tok — over the DR-6 ${SLIM_REGISTRATION_TOKEN_BUDGET} budget (full-description baseline is ~7,851)`,
    ).toBeLessThanOrEqual(SLIM_REGISTRATION_TOKEN_BUDGET);
  });

  /**
   * A slim description leaves out the detail of each action, so it must name the `describe` action.
   * `describe` must still return the "Do NOT use for" clause of `merge_orchestrate`, together with the `merge_pr` alternative.
   */
  it('toolsList_SlimDescriptions_RetainWhenNotToUseClause', async () => {
    const client = await bootProductionClient();
    const { tools } = await client.listTools();

    const advertised = tools as ToolEntry[];
    const visibleNames = TOOL_REGISTRY.filter((t) => !t.hidden).map((t) => t.name);

    for (const name of visibleNames) {
      const entry = advertised.find((t) => t.name === name);
      expect(entry, `${name} missing from tools/list`).toBeDefined();
      expect(
        entry!.description,
        `${name} slim description dropped the describe() pointer (INV-5a)`,
      ).toContain('describe');
    }

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
    expect(describeText).toContain('merge_pr');
  });
});
