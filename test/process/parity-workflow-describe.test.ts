// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.3 (T3.4)
//
// Process-fidelity parity test for the `workflow.describe` action.
// Drives a 3-step saga (init + 2 task.assigned events) over the MCP
// transport, then captures the workflow envelope from BOTH the CLI and
// the MCP transport and asserts parity per the
// `PARITY_CONTRACT.workflow.describe` entry.
//
// Mid-flight correction note (2026-05-05): the parity contract action
// label is `workflow.describe`, but its required fields (`phase`,
// `featureId`, `tasks`) describe workflow STATE, not introspection.
// On the wire we therefore exercise the action that returns workflow
// state for a featureId — `exarchos_workflow.get` over MCP, and
// `exarchos workflow status` over CLI (alias of `wf get`). The action
// label in the contract is the logical key, not the on-the-wire action
// name. See parity-contract.ts §"Mid-flight correction" for the
// migration table.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { spawnMcpClient } from '../fixtures/mcp-client.js';
import { runCli } from '../fixtures/cli-runner.js';
import { driveSaga } from '../fixtures/saga-driver.js';
import { withHermeticEnv } from '../fixtures/hermetic.js';
import { normalize } from '../fixtures/normalizers.js';
import { PARITY_CONTRACT, assertParity } from '../fixtures/parity-contract.js';
import { extractEnvelope } from '../fixtures/mcp-envelope.js';

// Pin the spawned MCP server and CLI to THIS worktree's freshly built
// binary. The npm-linked `exarchos` on PATH points at whatever checkout
// last ran `npm link` (typically the main worktree's dist/), which would
// silently mask bugs introduced on this branch. Pattern lifted from
// test/process/saga-merge-detour.test.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'bin',
  'exarchos-linux-x64',
);

describe('parity: exarchos workflow describe — CLI ↔ MCP', () => {
  it('workflowDescribe_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-describe-${env.testId.slice(0, 8)}`;
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: env.stateDir,
      });
      try {
        // Drive a 3-step saga through MCP: init → 2 task.assigned events.
        // Both transports observe the same persisted state afterwards,
        // since they share `EXARCHOS_STATE_DIR` (env.stateDir).
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

        // Halt-on-throw — surface saga setup failure for diagnostics.
        const failedStep = transcript.steps.find((s) => s.error !== undefined);
        if (failedStep) {
          throw new Error(
            `Saga setup halted at ${failedStep.call.tool}/${
              (failedStep.call.arguments as { action?: string }).action ?? '?'
            }: ${failedStep.error?.message}`,
          );
        }

        // Capture the MCP envelope first — while the server is still
        // running. tools/call → exarchos_workflow.get returns the
        // workflow document wrapped in the MCP `content[0].text` text
        // block.
        const mcpRaw = await mcp.client.callTool({
          name: 'exarchos_workflow',
          arguments: { action: 'get', featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        // Terminate the MCP server BEFORE invoking the CLI. The
        // EventStore uses a per-PID lock (DR-5, see
        // src/event-store/cli-concurrency.test.ts);
        // a CLI process started while the MCP holds the lock is
        // diverted to sidecar mode or blocks. Sequentializing the
        // transports keeps the test deterministic — both transports
        // still observe the same persisted state under env.stateDir.
        await mcp.terminate();

        // Capture the CLI envelope. `workflow status` is the CLI alias
        // for the MCP `workflow.get` action — it returns the same
        // workflow document (phase, featureId, tasks, ...). The
        // `--json` flag emits the raw envelope on stdout.
        const cliResult = await runCli({
          command: WORKTREE_BINARY,
          args: ['workflow', 'status', '--feature-id', featureId, '--json'],
          // WORKFLOW_STATE_DIR is the load-bearing var the binary reads
          // (utils/paths.ts:54). EXARCHOS_STATE_DIR is preserved alongside
          // for forward-compat. Setting both here makes the test
          // self-documenting and resilient to runCli env-merge changes.
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        // Normalize away non-deterministic fields, then enforce parity.
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
