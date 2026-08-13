// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §5.2 (T2.4)
// Regression test for #1208 — task.completed{worktreePath} must auto-detour the
// rehydration envelope's `next_actions` so a `merge_orchestrate` verb is
// surfaced. Per the documented behavior in
// `content/delivery/skills/delegate/SKILL.md` § "Worktree-Bearing Tasks: Auto-Detour to
// merge-pending", a runtime that consumes `next_actions` should be able to
// dispatch the worktree merge automatically — without manual operator
// intervention. Pre-fix the rehydrate envelope returns `next_actions: []` and
// `workflow.phase === 'delegate'`, contradicting the skill contract.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { withHermeticEnv } from '../helpers/hermetic.js';
import { spawnMcpClient } from '../helpers/mcp-client.js';
import { driveSaga } from '../helpers/saga-driver.js';

// Pin the spawned MCP server to the *worktree's* freshly built binary, not
// whatever `exarchos` happens to be on PATH (which usually points at the
// main repo's dist/). Otherwise the regression test would validate against
// stale code and silently mask any fix.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
            // T-03/DR-1 closed the caller-evidence bypass for BLOCKING gates:
            // `task_complete` now requires a durable `gate.executed` row for
            // `static-analysis` and caller-supplied evidence can no longer
            // stand in for it. Satisfy the gate via the documented
            // operator-emitted shape (top-level `taskId`) that the
            // task_complete tolerant reader accepts — this saga guards the
            // #1208 detour contract, not the gate machinery.
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

        // Halt-on-throw — if any step errored, surface it for diagnostics.
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

        // The MCP envelope returns content[0].text as the JSON-encoded payload.
        const [block] = view.content as Array<{ text: string }>;
        if (!block) throw new Error('the view envelope carried no content block');
        const content = JSON.parse(block.text) as { next_actions?: NextActionShape[] };

        // The expected behavior per #1208 + content/delivery/skills/delegate/SKILL.md:
        // a `merge_orchestrate` verb (with idempotency-key
        // `<streamId>:merge_orchestrate:<taskId>`) MUST be surfaced after a
        // worktree-bearing task.completed.
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
