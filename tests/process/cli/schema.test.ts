import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';
import { spawnMcpClient } from '../../helpers/mcp-client.js';

describe('exarchos schema', () => {
  /** Without a ref, `schema` prints a text listing of tools and actions, not JSON. */
  it('schema_default_outputsToolList', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['schema'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^exarchos_workflow:/m);
      expect(result.stdout).toMatch(/^exarchos_event:/m);
    });
  });

  /** With a `<tool>.<action>` ref, `schema` prints the JSON Schema of that action. */
  it('schema_ref_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      const result = await runCli({ args: ['schema', 'workflow.init'] });
      expect(result.exitCode).toBe(0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ type: 'object' });
    });
  });

  /**
   * The `schema` listing holds the full registry, and the MCP adapter keeps hidden tools out of `tools/list`.
   * Thus the two surfaces are not equal sets, and the test asserts only a subset.
   * Each MCP tool name must be a tool line of the `schema` listing.
   */
  it('schema_toolsCoverMcpToolsList_complete', async () => {
    await withHermeticEnv(async () => {
      const cliResult = await runCli({ args: ['schema'] });
      expect(cliResult.exitCode).toBe(0);
      const cliTools = new Set(
        Array.from(cliResult.stdout.matchAll(/^([a-z_]+):$/gm)).map(
          (m) => m[1] as string,
        ),
      );

      const handle = await spawnMcpClient();
      try {
        const mcpResp = await handle.client.listTools();
        const mcpTools = mcpResp.tools.map((t) => t.name);
        expect(mcpTools.length).toBeGreaterThan(0);
        for (const name of mcpTools) {
          expect(cliTools.has(name)).toBe(true);
        }
      } finally {
        await handle.terminate();
      }
    });
  });
});
