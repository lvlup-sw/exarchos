// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.4 (T4.4)
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../../helpers/hermetic.js';
import { runCli } from '../../helpers/cli-runner.js';
import { spawnMcpClient } from '../../helpers/mcp-client.js';

describe('exarchos schema', () => {
  it('schema_default_outputsToolList', async () => {
    await withHermeticEnv(async () => {
      // `exarchos schema` (no args) prints a human-readable listing of
      // tools and actions (cli.ts §"Schema introspection command"). It is
      // NOT JSON. JSON is only emitted when a ref is supplied. Smoke that
      // it exits zero and emits the visible top-level tool names.
      const result = await runCli({ args: ['schema'] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^exarchos_workflow:/m);
      expect(result.stdout).toMatch(/^exarchos_event:/m);
    });
  });

  it('schema_ref_outputsValidJson', async () => {
    await withHermeticEnv(async () => {
      // `exarchos schema <tool>.<action>` resolves to a single JSON Schema.
      const result = await runCli({ args: ['schema', 'workflow.init'] });
      expect(result.exitCode).toBe(0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ type: 'object' });
    });
  });

  it('schema_toolsCoverMcpToolsList_complete', async () => {
    await withHermeticEnv(async () => {
      // Capture all tools (incl. hidden) from `schema` text output. The CLI
      // command exposes the FULL registry — including `hidden: true` tools
      // like `exarchos_sync` — for introspection convenience. The MCP
      // adapter (mcp.ts §"if (tool.hidden) continue") filters hidden tools
      // out of `tools/list` so model-side surface stays curated.
      //
      // Deviation from spec §4.4: the spec asks for set equality, but the
      // CLI/MCP surfaces are intentionally asymmetric here. The smoke test
      // therefore asserts the weaker (and true) invariant: every MCP tool
      // is a subset of the schema listing — i.e. nothing leaks past CLI
      // introspection that MCP exposes.
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
