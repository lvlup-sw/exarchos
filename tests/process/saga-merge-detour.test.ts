/**
 * Regression test for the `merge-pending` detour.
 * After a `task.completed` event with a `worktreePath`, the rehydration envelope must offer `merge_orchestrate` in `next_actions`.
 * A runtime that reads `next_actions` can then start the worktree merge with no operator step.
 * `content/delivery/skills/delegate/SKILL.md` documents this contract.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { driveSaga } from '../helpers/saga-driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The binary that this checkout built. The test pins the MCP server to it.
 * The `exarchos` on PATH can come from a different checkout, and then the test proves nothing about this branch.
 */
const WORKTREE_BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'bin',
  'exarchos-linux-x64',
);

interface NextActionShape {
  verb: string;
  reason?: string;
  validTargets?: string[];
  idempotencyKey?: string;
}

describe('#1208 — task.completed{worktreePath} auto-detours to merge-pending', () => {
  /**
   * `task_complete` needs a passing `gate.executed` event for the blocking `static-analysis` gate.
   * Caller evidence cannot replace that event, so the saga appends it with a top-level `taskId`.
   * A thrown transport error in the saga fails the test and names the step.
   */
  it('next_actions surfaces merge_orchestrate after worktree-bearing task.completed', async () => {
    await withHermeticEnv(async (env) => {
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
              featureId: 'p2-detour',
              workflowType: 'feature',
            },
          },
          {
            tool: 'exarchos_orchestrate',
            arguments: {
              action: 'prepare_delegation',
              featureId: 'p2-detour',
              tasks: [{ id: '001', title: 'detour-test' }],
            },
          },
          {
            tool: 'exarchos_event',
            arguments: {
              action: 'append',
              stream: 'p2-detour',
              event: {
                type: 'task.assigned',
                data: { taskId: '001', branch: 'feature/p2-detour-001' },
              },
            },
          },
          {
            tool: 'exarchos_event',
            arguments: {
              action: 'append',
              stream: 'p2-detour',
              event: {
                type: 'gate.executed',
                data: {
                  gateName: 'static-analysis',
                  layer: 'validation',
                  passed: true,
                  taskId: '001',
                },
              },
            },
          },
          {
            tool: 'exarchos_orchestrate',
            arguments: {
              action: 'task_complete',
              taskId: '001',
              streamId: 'p2-detour',
              evidence: {
                type: 'manual',
                output: 'auto-ack for #1208 regression',
                passed: true,
              },
              result: {
                worktreePath: env.gitDir,
                worktree: '.worktrees/001-detour',
              },
            },
          },
        ]);

        const failedStep = transcript.steps.find((s) => s.kind === 'error');
        if (failedStep && failedStep.kind === 'error') {
          throw new Error(
            `Saga halted at ${failedStep.call.tool}/${
              (failedStep.call.arguments as { action?: string }).action ?? '?'
            }: ${failedStep.error.message}`,
          );
        }

        const view = await mcp.client.callTool({
          name: 'exarchos_workflow',
          arguments: { action: 'rehydrate', featureId: 'p2-detour' },
        });

        const [block] = view.content as Array<{ text: string }>;
        if (!block) throw new Error('the view envelope carried no content block');
        const content = JSON.parse(block.text) as { next_actions?: NextActionShape[] };

        expect(content.next_actions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ verb: 'merge_orchestrate' }),
          ]),
        );
      } finally {
        await mcp.terminate();
      }
    });
  }, 30_000);
});
