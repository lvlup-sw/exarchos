/**
 * Regression test for the `merge-pending` detour.
 * After a `task.completed` event with a `worktreePath`, the workflow parks in `merge-pending`.
 * The rehydration envelope offers no retired `merge_orchestrate`, because the harness lands the task branch.
 * The coordinator records the landing with one `merge.executed` row, and the rehydrated workflow then leaves `merge-pending`.
 * `content/delivery/skills/merge-orchestrator/SKILL.md` documents this contract.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { driveSaga } from '../helpers/saga-driver.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

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

/** The text of the first content block of an MCP tool result. It throws when the result has none. */
function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('the tool result carried no content array');
  }
  const [block]: unknown[] = result.content;
  if (typeof block !== 'object' || block === null || !('text' in block) || typeof block.text !== 'string') {
    throw new Error('the tool result carried no text block');
  }
  return block.text;
}

interface NextActionShape {
  verb: string;
  reason?: string;
  validTargets?: string[];
  idempotencyKey?: string;
}

describe('#1208 — task.completed{worktreePath} auto-detours to merge-pending', () => {
  /**
   * `task_complete` needs a passing `gate.executed` row for the blocking `static-analysis` gate.
   * Caller evidence cannot replace that row, and the generic append refuses it. Thus the saga runs
   * `check_static_analysis` for the task on a Node project whose npm scripts exit with 0.
   * The local check executor runs a direct call only on a branch checkout with a clean tree, so the saga commits the project first.
   * The workflow has no prepared scope, so the assignment names the project as the worktree of the task.
   * A thrown transport error in the saga fails the test and names the step.
   */
  it('next_actions offers no merge_orchestrate, and a recorded merge.executed row exits merge-pending', async () => {
    await withHermeticEnv(async (env) => {
      await fs.writeFile(
        path.join(env.gitDir, 'package.json'),
        JSON.stringify({
          name: 'p2-detour-fixture',
          version: '1.0.0',
          private: true,
          scripts: { lint: 'node -e ""', typecheck: 'node -e ""', 'quality-check': 'node -e ""' },
        }),
        'utf-8',
      );
      const git = (...args: string[]) => execFileAsync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd: env.gitDir });
      await git('switch', '-q', '-c', 'feature/p2-detour-001');
      await git('add', 'package.json');
      await git('commit', '-q', '-m', 'the detour fixture');
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp', '--operator'],
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
                data: { taskId: '001', title: 'detour-test', branch: 'feature/p2-detour-001', worktree: env.gitDir },
              },
            },
          },
          {
            tool: 'exarchos_orchestrate',
            arguments: {
              action: 'check_static_analysis',
              featureId: 'p2-detour',
              taskId: '001',
              repoRoot: env.gitDir,
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
        const content: {
          next_actions?: NextActionShape[];
          data?: { workflowState?: { phase?: string } };
        } = JSON.parse(block.text);

        expect(content.data?.workflowState?.phase).toBe('merge-pending');
        expect((content.next_actions ?? []).map((a) => a.verb)).not.toContain('merge_orchestrate');

        const landed = await driveSaga(mcp, [
          {
            tool: 'exarchos_event',
            arguments: {
              action: 'append',
              stream: 'p2-detour',
              idempotencyKey: `001:${'a'.repeat(40)}`,
              event: {
                type: 'merge.executed',
                data: {
                  taskId: '001',
                  sourceBranch: 'feature/p2-detour-001',
                  targetBranch: 'main',
                  mergeSha: 'a'.repeat(40),
                  rollbackSha: 'b'.repeat(40),
                },
              },
            },
          },
        ]);
        expect(landed.steps.map((step) => step.kind)).toEqual(['success']);
        for (const step of landed.steps) {
          if (step.kind !== 'success') continue;
          const text = firstText(step.result);
          expect(JSON.parse(text), `${step.call.tool} ${text}`).toMatchObject({ success: true });
        }

        const after = await mcp.client.callTool({
          name: 'exarchos_workflow',
          arguments: { action: 'rehydrate', featureId: 'p2-detour' },
        });
        const afterContent: { data?: { workflowState?: { phase?: string } } } = JSON.parse(firstText(after));
        expect(afterContent.data?.workflowState?.phase).toBe('delegate');
      } finally {
        await mcp.terminate();
      }
    });
  }, 30_000);
});
