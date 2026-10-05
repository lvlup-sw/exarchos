/**
 * Parity test for the `event.query` action between the CLI and the MCP transport.
 * It writes a workflow and two `task.assigned` events through MCP, then queries the stream on both transports.
 * Both transports return the envelope `{ success, data: { events, page }, next_actions, _meta, _perf }`.
 * The `event.query` entry of `PARITY_CONTRACT` needs equal `success`, `data` and `next_actions`.
 * `_meta` and `_perf` can differ, because the `_perf` values change with each run.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { runCli } from '../helpers/cli-runner.js';
import { driveSaga } from '../helpers/saga-driver.js';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { normalize } from '../helpers/normalizers.js';
import { PARITY_CONTRACT, assertParity } from '../helpers/parity-contract.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The binary that this checkout built. The test pins the MCP server and the CLI to it.
 * The `exarchos` on PATH can come from a different checkout, and then it hides a defect of this branch.
 */
const WORKTREE_BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'bin',
  'exarchos-linux-x64',
);

describe('parity: exarchos event query — CLI ↔ MCP', () => {
  /**
   * Both transports read the same state directory, so they see the same persisted events.
   * `task.assigned` needs a `title`, or the append fails validation.
   * `driveSaga` reports only a thrown transport error, not a tool result with `success: false`.
   * Thus the test asserts exactly 3 events (`workflow.started` and two `task.assigned`) before the parity check.
   * Without that count, parity also passes on a stream that lost its appends.
   * The MCP server stops before the CLI starts, so the two processes do not open the store at the same time.
   */
  it('eventQuery_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-eventquery-${env.testId.slice(0, 8)}`;
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: env.stateDir,
      });
      try {
        const transcript = await driveSaga(mcp, [
          {
            tool: 'exarchos_workflow',
            arguments: {
              action: 'init',
              featureId,
              workflowType: 'feature',
            },
          },
          {
            tool: 'exarchos_event',
            arguments: {
              action: 'append',
              stream: featureId,
              event: {
                type: 'task.assigned',
                data: { taskId: 't1', title: 'Task 1' },
              },
            },
          },
          {
            tool: 'exarchos_event',
            arguments: {
              action: 'append',
              stream: featureId,
              event: {
                type: 'task.assigned',
                data: { taskId: 't2', title: 'Task 2' },
              },
            },
          },
        ]);

        const failedStep = transcript.steps.find((s) => s.kind === 'error');
        if (failedStep?.kind === 'error') {
          throw new Error(
            `Saga setup halted at ${failedStep.call.tool}/${
              (failedStep.call.arguments as { action?: string }).action ?? '?'
            }: ${failedStep.error.message}`,
          );
        }

        const mcpRaw = await mcp.client.callTool({
          name: 'exarchos_event',
          arguments: { action: 'query', stream: featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        const mcpEvents = (mcpEnvelope as { data?: { events?: unknown } }).data
          ?.events;
        expect(Array.isArray(mcpEvents)).toBe(true);
        expect((mcpEvents as unknown[]).length).toBe(3);

        await mcp.terminate();

        const cliResult = await runCli({
          command: WORKTREE_BINARY,
          args: ['event', 'query', '--stream', featureId, '--json'],
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        const cliNorm = normalize(cliEnvelope);
        const mcpNorm = normalize(mcpEnvelope);
        const spec = PARITY_CONTRACT.find((s) => s.action === 'event.query');
        expect(spec).toBeDefined();
        assertParity(cliNorm, mcpNorm, spec!);
      } finally {
        await mcp.terminate();
      }
    });
  }, 30_000);
});
