/**
 * Proves that the binary from `tools/release/build-binary.ts` runs `exarchos mcp` over a real
 * stdio transport. The binary must complete the MCP handshake and dispatch a workflow action.
 *
 * - Each test uses a fresh temporary `WORKFLOW_STATE_DIR`, so feature ids do not collide.
 * - `EXARCHOS_PLUGIN_ROOT` is the repository root, so the binary resolves plugin paths in the
 *   checkout.
 * - `StdioClientTransport` ends the child process when the client closes.
 *
 * `./_helpers.ts` holds the shared setup.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION } from '../../../src/index.js';
import {
  findRepoRoot,
  ensureBinaryBuilt,
  openFixture,
  closeFixture,
} from './_helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = findRepoRoot(__dirname);

let BINARY_PATH: string;

beforeAll(async () => {
  const { binaryPath } = await ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
}, 120_000);

describe('Compiled binary MCP integration (task 1.6)', () => {
  /**
   * The name and the version must equal `SERVER_NAME` and `SERVER_VERSION` from `src/index.ts`.
   * `src/adapters/mcp/mcp.ts` holds its own copy of both constants, and this test finds a drift.
   */
  it('CompiledBinary_McpSubcommand_HandshakesSuccessfully', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const info = fx.client.getServerVersion();
      expect(info).toBeDefined();
      expect(info!.name).toBe(SERVER_NAME);
      expect(info!.version).toBe(SERVER_VERSION);
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);

  /**
   * The result content must be an array whose first entry is text that parses to a successful
   * result. The final `cancel` call makes a second dispatch, and the test does not assert its
   * result.
   */
  it('CompiledBinary_McpWorkflowInit_ReturnsExpectedShape', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    const featureId = 'test-1-6-compiled';
    try {
      const result = await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', featureId, workflowType: 'oneshot' },
      });

      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);
      const first = content[0];
      if (!first) throw new Error('the envelope carried no content block');
      expect(first.type).toBe('text');
      expect(typeof first.text).toBe('string');

      const parsed = JSON.parse(first.text) as {
        success: boolean;
        data?: { featureId?: string };
      };
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
      expect(parsed.data!.featureId).toBe(featureId);

      await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'cancel', featureId },
      });
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);
});
