/**
 * Parity test for the workflow state between the CLI and the MCP transport.
 * It writes a workflow and two `task.assigned` events through MCP, then reads the state on both transports.
 * The contract key is `workflow.describe`, but its required fields (`phase`, `featureId`, `tasks`) are workflow state.
 * Thus the test calls `exarchos_workflow.get` through MCP and `exarchos workflow status` through the CLI.
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

describe('parity: exarchos workflow describe — CLI ↔ MCP', () => {
  /**
   * Both transports read the same state directory, so they see the same persisted state.
   * A thrown transport error in the saga fails the test and names the step.
   * The MCP server stops before the CLI starts, so the two processes do not open the store at the same time.
   * `workflow status` is the CLI alias of the `get` action, and `--json` prints the envelope on stdout.
   * The binary reads `WORKFLOW_STATE_DIR`. The test also sets `EXARCHOS_STATE_DIR` to the same directory.
   */
  it('workflowDescribe_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-describe-${env.testId.slice(0, 8)}`;
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
          name: 'exarchos_workflow',
          arguments: { action: 'get', featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        await mcp.terminate();

        const cliResult = await runCli({
          command: WORKTREE_BINARY,
          args: ['workflow', 'status', '--feature-id', featureId, '--json'],
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        const cliNorm = normalize(cliEnvelope);
        const mcpNorm = normalize(mcpEnvelope);
        const spec = PARITY_CONTRACT.find((s) => s.action === 'workflow.describe');
        expect(spec).toBeDefined();
        assertParity(cliNorm, mcpNorm, spec!);
      } finally {
        await mcp.terminate();
      }
    });
  }, 30_000);
});
