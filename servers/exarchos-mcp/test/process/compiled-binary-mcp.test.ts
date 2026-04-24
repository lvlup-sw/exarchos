/**
 * Task 1.6 — Compiled-binary MCP integration test.
 *
 * Phase progression: RED asserted 2.4.0 vs observed 1.1.0 drift in adapters/mcp.ts;
 * GREEN synced the duplicated SERVER_VERSION and the integration tests now pass.
 *
 * Proves the artifact produced by `scripts/build-binary.ts` (task 1.4) actually
 * runs `exarchos mcp` in real stdio-transport mode and handles MCP tool calls
 * end-to-end. This is the PR1 integration gate for the v2.9 install rewrite —
 * earlier tests (1.1, 1.2) cover the build script's structural invariants,
 * but nothing yet proves the resulting binary can complete a real MCP
 * handshake + dispatch a workflow action end-to-end. Task 3.6 removed the
 * companion JS bundle (`dist/exarchos.js`); the binary is now the sole
 * distribution artifact this test exercises.
 *
 * Hermeticity:
 *   - Each test uses a fresh temp `WORKFLOW_STATE_DIR` so feature IDs never
 *     collide across runs and cleanup is trivial.
 *   - `EXARCHOS_PLUGIN_ROOT` is set to the repo root so the spawned binary
 *     resolves plugin-scoped paths without touching the developer's
 *     `~/.claude` or `~/.exarchos` state.
 *   - The child process is spawned via `StdioClientTransport`, which
 *     terminates when the `Client` is closed — tests cannot leak processes.
 *
 * Shared setup lives in `./_helpers.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_NAME, SERVER_VERSION } from '../../src/index.js';
import {
  findRepoRoot,
  ensureBinaryBuilt,
  openFixture,
  closeFixture,
} from './_helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = findRepoRoot(__dirname);

// ─── Build once, share across both test cases ───────────────────────────────

let BINARY_PATH: string;

beforeAll(() => {
  const { binaryPath } = ensureBinaryBuilt(REPO_ROOT);
  BINARY_PATH = binaryPath;
}, 120_000);

// ─── Test cases ─────────────────────────────────────────────────────────────

describe('Compiled binary MCP integration (task 1.6)', () => {
  it('CompiledBinary_McpSubcommand_HandshakesSuccessfully', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    try {
      const info = fx.client.getServerVersion();
      expect(info).toBeDefined();
      // Name must match the canonical constant exported by src/index.ts.
      // A divergence here indicates a drift in the server-identity block of
      // src/adapters/mcp.ts relative to the source-of-truth export.
      expect(info!.name).toBe(SERVER_NAME);
      // The compiled binary's advertised version must equal the canonical
      // SERVER_VERSION from src/index.ts. This is the TDD gate: the JS
      // adapter historically hardcoded its own constant which drifted from
      // the root export, so this assertion catches that drift in CI.
      expect(info!.version).toBe(SERVER_VERSION);
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);

  it('CompiledBinary_McpWorkflowInit_ReturnsExpectedShape', async () => {
    const fx = await openFixture(BINARY_PATH, REPO_ROOT);
    const featureId = 'test-1-6-compiled';
    try {
      const result = await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', featureId, workflowType: 'oneshot' },
      });

      // Wire-format assertions: content is an array with a text entry, and
      // that text entry parses back to a ToolResult with success=true.
      expect(Array.isArray(result.content)).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content.length).toBeGreaterThan(0);
      const first = content[0];
      expect(first.type).toBe('text');
      expect(typeof first.text).toBe('string');

      const parsed = JSON.parse(first.text) as {
        success: boolean;
        data?: { featureId?: string };
      };
      expect(parsed.success).toBe(true);
      expect(parsed.data).toBeDefined();
      expect(parsed.data!.featureId).toBe(featureId);

      // Cleanup — cancel the workflow so repeated runs do not leak state.
      // (Temp stateDir is also nuked in the finally block, but an explicit
      // cancel matches the task spec and exercises a second dispatch.)
      await fx.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'cancel', featureId },
      });
    } finally {
      await closeFixture(fx);
    }
  }, 30_000);
});
