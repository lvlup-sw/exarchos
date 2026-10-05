/**
 * Process tests for the `workflow.rehydrate` action.
 * Each test compares two envelopes on the fields of the `workflow.rehydrate` entry of `PARITY_CONTRACT`.
 * The first test compares the CLI envelope with the MCP envelope over one state directory.
 *
 * The second test proves that the events alone rebuild a projection.
 * It replays the event stream of one server into a second server that has an independent state directory.
 * The two rehydration documents must then be equal on those fields.
 * A difference shows projection state that does not come from the events, or a defect in `replayInto`.
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { spawnMcpClient, type SpawnedMcpClient } from '../helpers/mcp-client.js';
import { runCli } from '../helpers/cli-runner.js';
import { driveSaga, type SagaTranscript } from '../helpers/saga-driver.js';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { normalize } from '../helpers/normalizers.js';
import { PARITY_CONTRACT, assertParity } from '../helpers/parity-contract.js';
import { extractEnvelope } from '../helpers/mcp-envelope.js';
import { snapshotEventStream, replayInto } from '../helpers/event-replay.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The binary that this checkout built. The tests pin each MCP server and the CLI to it.
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

/**
 * Runs the standard saga through MCP: `init`, then two `task.assigned` events.
 * When a step throws a transport error, the function throws and names the step.
 * `task.assigned` needs a `title`, or the append fails validation.
 * `driveSaga` does not read a tool result with `success: false`, so each test also asserts the task count.
 */
async function driveStandardSaga(
  mcp: SpawnedMcpClient,
  featureId: string,
): Promise<SagaTranscript> {
  const transcript = await driveSaga(mcp, [
    {
      tool: 'exarchos_workflow',
      arguments: { action: 'init', featureId, workflowType: 'feature' },
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
  return transcript;
}

describe('parity: exarchos workflow rehydrate — CLI ↔ MCP', () => {
  /**
   * The MCP envelope must hold 2 tasks in `taskProgress`.
   * Without that count, parity also passes when the appends failed and both sides hold no tasks.
   * The MCP server stops before the CLI starts, so the two processes do not open the store at the same time.
   * `normalize` does not replace `data.projectionSequence`, so the contract compares the real count of folded events.
   */
  it('workflowRehydrate_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-rehydrate-${env.testId.slice(0, 8)}`;
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: env.stateDir,
      });
      try {
        await driveStandardSaga(mcp, featureId);

        const mcpRaw = await mcp.client.callTool({
          name: 'exarchos_workflow',
          arguments: { action: 'rehydrate', featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        const mcpData = (mcpEnvelope as { data?: unknown }).data;
        expect(mcpData).toBeTruthy();
        const mcpTasks = (mcpData as { taskProgress?: unknown[] }).taskProgress;
        expect(Array.isArray(mcpTasks)).toBe(true);
        expect((mcpTasks as unknown[]).length).toBe(2);

        await mcp.terminate();

        const cliResult = await runCli({
          command: WORKTREE_BINARY,
          args: [
            'workflow',
            'rehydrate',
            '--feature-id',
            featureId,
            '--json',
          ],
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        const cliNorm = normalize(cliEnvelope);
        const mcpNorm = normalize(mcpEnvelope);
        const spec = PARITY_CONTRACT.find(
          (s) => s.action === 'workflow.rehydrate',
        );
        expect(spec).toBeDefined();
        assertParity(cliNorm, mcpNorm, spec!);
      } finally {
        await mcp.terminate();
      }
    });
  }, 30_000);

  /**
   * The test replays the events of server A into server B, which has a separate state directory.
   * The test does not use `withHermeticEnv`, because that helper sets one state directory for the process.
   * `spawnMcpClient` gives each child its own `stateDir`, so two temporary directories are sufficient.
   * `snapshotEventStream` returns the events in ascending order, and `replayInto` appends them in that order.
   *
   * The snapshot must hold 3 events (`workflow.started` and two `task.assigned`), and server B must hold 2 tasks.
   * Without those counts, parity also passes when both servers lost the task events.
   * The contract compares the real `data.projectionSequence` values.
   * An unequal value after equal events shows a projection that is not deterministic.
   * A cleanup error for the temporary tree logs a warning and does not fail the test.
   */
  it('workflowRehydrate_replayedEvents_reconstructEqualProjection', async () => {
    const tmpRoot = path.join(
      os.tmpdir(),
      `exarchos-f61-${randomUUID()}`,
    );
    const stateDirA = path.join(tmpRoot, 'state-A');
    const stateDirB = path.join(tmpRoot, 'state-B');
    await fs.mkdir(stateDirA, { recursive: true });
    await fs.mkdir(stateDirB, { recursive: true });

    const featureId = `f61-rehydrate-${randomUUID().slice(0, 8)}`;
    let mcpA: SpawnedMcpClient | undefined;
    let mcpB: SpawnedMcpClient | undefined;

    try {
      mcpA = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: stateDirA,
      });
      await driveStandardSaga(mcpA, featureId);

      const snapshot = await snapshotEventStream(mcpA, featureId);
      expect(snapshot.events.length).toBe(3);

      const aRaw = await mcpA.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'rehydrate', featureId },
      });
      const aEnvelope = extractEnvelope(aRaw);

      await mcpA.terminate();
      mcpA = undefined;

      mcpB = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: stateDirB,
      });

      await replayInto(mcpB, snapshot);

      const bRaw = await mcpB.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'rehydrate', featureId },
      });
      const bEnvelope = extractEnvelope(bRaw);

      const bData = (bEnvelope as { data?: unknown }).data;
      expect(bData).toBeTruthy();
      const bTasks = (bData as { taskProgress?: unknown[] }).taskProgress;
      expect(Array.isArray(bTasks)).toBe(true);
      expect((bTasks as unknown[]).length).toBe(2);

      const aNorm = normalize(aEnvelope);
      const bNorm = normalize(bEnvelope);
      const spec = PARITY_CONTRACT.find(
        (s) => s.action === 'workflow.rehydrate',
      );
      expect(spec).toBeDefined();
      assertParity(aNorm, bNorm, spec!);
    } finally {
      if (mcpA) await mcpA.terminate();
      if (mcpB) await mcpB.terminate();
      try {
        await rmrfAsync(tmpRoot);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[F6.1 cleanup] failed for ${tmpRoot}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }, 30_000);
});
