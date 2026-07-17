// Source: docs/plans/archive/2026-05-05-e2e-v29-revisited.md §T3.5
//
// Process-fidelity parity test for the `event.query` action. Mirrors
// T3.4 (workflow.describe) but exercises the event-log surface: drive a
// short saga (workflow init + 2 task.assigned events), then capture the
// query envelope from BOTH transports and assert parity per the
// `PARITY_CONTRACT.event.query` entry.
//
// The CLI subcommand path `exarchos event query --stream <id>` and the
// MCP `exarchos_event` action `query` compose to the same logical
// action key. On the wire both transports return the canonical result
// envelope `{ success, data: { events: [...], page }, next_actions,
// _meta, _perf }` (economy pagination migration, DR-8/DR-12), so the
// contract enforces equality on `success`, `data` (the paginated
// `{ events, page }` object), and `next_actions`. `_meta` and `_perf` are
// allowed to differ because `_perf.ms`/`_perf.bytes` are non-deterministic
// per run.
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
// test/process/saga-merge-detour.test.ts and reused in T3.4.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'bin',
  'exarchos-linux-x64',
);

describe('parity: exarchos event query — CLI ↔ MCP', () => {
  it('eventQuery_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-eventquery-${env.testId.slice(0, 8)}`;
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: env.stateDir,
      });
      try {
        // Drive a 3-step saga through MCP: init → 2 task.assigned events.
        // `task.assigned` requires `title` per the event schema (the MCP
        // tool returns `VALIDATION_ERROR: title: Required` otherwise);
        // include it so the events actually persist and the query
        // envelope on both sides carries the same 3-event payload (the
        // workflow.started bootstrap event + the two task.assigned).
        // Both transports observe the same persisted state afterwards
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

        // Halt-on-throw: surface saga setup failure for diagnostics.
        // This catches transport-level errors (e.g. MCP disconnect). It
        // does NOT catch tool-level `success: false` in the envelope —
        // the saga driver does not unwrap. We rely on the post-query
        // event count below to flag silently-failed appends.
        const failedStep = transcript.steps.find((s) => s.error !== undefined);
        if (failedStep) {
          throw new Error(
            `Saga setup halted at ${failedStep.call.tool}/${
              (failedStep.call.arguments as { action?: string }).action ?? '?'
            }: ${failedStep.error?.message}`,
          );
        }

        // Capture the MCP envelope first — while the server is still
        // running. tools/call → exarchos_event.query returns the events
        // array wrapped in the MCP `content[0].text` text block.
        const mcpRaw = await mcp.client.callTool({
          name: 'exarchos_event',
          arguments: { action: 'query', stream: featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        // Sanity check the saga actually persisted events. The query
        // envelope's `data` is the paginated shape `{ events, page }`
        // (economy pagination migration, DR-8/DR-12), so the events live
        // under `data.events`. If the appends silently failed (validation
        // error, etc.), the events array shrinks to just the
        // workflow.started bootstrap event and the parity assertion below
        // would still pass trivially — making this test useless as a
        // regression signal. Guard against that explicitly.
        const mcpEvents = (mcpEnvelope as { data?: { events?: unknown } }).data
          ?.events;
        expect(Array.isArray(mcpEvents)).toBe(true);
        expect((mcpEvents as unknown[]).length).toBe(3);

        // Terminate the MCP server BEFORE invoking the CLI. The
        // EventStore uses a per-PID lock (DR-5, see
        // servers/exarchos-mcp/src/event-store/cli-concurrency.test.ts);
        // a CLI process started while the MCP holds the lock is
        // diverted to sidecar mode or blocks. Sequentializing the
        // transports keeps the test deterministic — both transports
        // still observe the same persisted state under env.stateDir.
        await mcp.terminate();

        // Capture the CLI envelope. `event query --stream <id> --json`
        // returns the same canonical result envelope as the MCP
        // `exarchos_event.query` action.
        const cliResult = await runCli({
          command: WORKTREE_BINARY,
          args: ['event', 'query', '--stream', featureId, '--json'],
          // WORKFLOW_STATE_DIR is the load-bearing var
          // (servers/exarchos-mcp/src/utils/paths.ts:54).
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        // Normalize away non-deterministic fields (timestamps,
        // sequences, request IDs), then enforce parity per the
        // PARITY_CONTRACT entry for `event.query`.
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
