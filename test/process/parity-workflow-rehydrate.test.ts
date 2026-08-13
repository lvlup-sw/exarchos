// Source: docs/plans/archive/2026-05-05-e2e-v29-revisited.md §T3.6
//
// Process-fidelity parity test for the `workflow.rehydrate` action AND
// the F6.1 reconstructability invariant — the operational closure of
// #1109 invariant #2 (event-store is the single source of truth;
// projections reconstruct deterministically from events).
//
// Two assertions ship in this file:
//
//   1. workflowRehydrate_cliVsMcp_envelopesMatchAfterNormalize —
//      classic parity check: same persisted state, both transports
//      observed via shared `EXARCHOS_STATE_DIR`, capture MCP envelope
//      first (server still up), then terminate MCP and run CLI (DR-5
//      per-PID lock — see cli-concurrency.test.ts), normalize, assert
//      parity per `PARITY_CONTRACT.workflow.rehydrate`.
//
//   2. workflowRehydrate_replayedEvents_reconstructEqualProjection —
//      F6.1 INVARIANT (the load-bearing test). Snapshot the event
//      stream from server A, replay every event into a fresh server B
//      backed by an INDEPENDENT state directory, and assert the
//      rehydration document at B equals the rehydration document at
//      A under the same parity contract. If this fails, either the
//      projection has non-determinism (state derived from something
//      not in the event log — wall time, PID, env) or `replayInto`
//      doesn't actually achieve causal equivalence.
//
// The rehydrate envelope (per src/workflow/rehydrate.ts):
//   { success, data: { v, projectionSequence, behavioralGuidance,
//                       workflowState, taskProgress, decisions,
//                       artifacts, blockers },
//     next_actions, _meta, _perf, _cacheHints }
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { spawnMcpClient, type SpawnedMcpClient } from '../fixtures/mcp-client.js';
import { runCli } from '../fixtures/cli-runner.js';
import { driveSaga, type SagaTranscript } from '../fixtures/saga-driver.js';
import { withHermeticEnv } from '../fixtures/hermetic.js';
import { normalize } from '../fixtures/normalizers.js';
import { PARITY_CONTRACT, assertParity } from '../fixtures/parity-contract.js';
import { extractEnvelope } from '../fixtures/mcp-envelope.js';
import { snapshotEventStream, replayInto } from '../fixtures/event-replay.js';

// Pin the spawned MCP server and CLI to THIS worktree's freshly built
// binary. The npm-linked `exarchos` on PATH points at whatever checkout
// last ran `npm link` (typically the main worktree's dist/), which would
// silently mask bugs introduced on this branch. Pattern lifted from
// test/process/saga-merge-detour.test.ts and reused in T3.4 / T3.5.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_BINARY = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'bin',
  'exarchos-linux-x64',
);

/**
 * Drive the canonical 3-step saga (workflow.init + 2 task.assigned events
 * with required `title` field) against a connected MCP client. Halts on
 * transport throw and surfaces an actionable error.
 *
 * `task.assigned` schema requires `title` — leaving it off makes the
 * tool return `VALIDATION_ERROR: title: Required` and the saga driver
 * does NOT unwrap tool-level success, so silent failure would slip
 * through. T3.5 added the same guard. The post-saga length assertion
 * below catches any remaining silent-append regressions.
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

  const failedStep = transcript.steps.find((s) => s.error !== undefined);
  if (failedStep) {
    throw new Error(
      `Saga setup halted at ${failedStep.call.tool}/${
        (failedStep.call.arguments as { action?: string }).action ?? '?'
      }: ${failedStep.error?.message}`,
    );
  }
  return transcript;
}

describe('parity: exarchos workflow rehydrate — CLI ↔ MCP', () => {
  it('workflowRehydrate_cliVsMcp_envelopesMatchAfterNormalize', async () => {
    await withHermeticEnv(async (env) => {
      const featureId = `parity-rehydrate-${env.testId.slice(0, 8)}`;
      const mcp = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: env.stateDir,
      });
      try {
        // Drive the saga so the rehydration document has tasks to
        // project. Both transports observe the same persisted state
        // afterwards (shared EXARCHOS_STATE_DIR = env.stateDir).
        await driveStandardSaga(mcp, featureId);

        // Capture the MCP envelope first — while the server is still
        // running. tools/call → exarchos_workflow.rehydrate returns
        // the rehydration document wrapped in the MCP `content[0].text`
        // text block.
        const mcpRaw = await mcp.client.callTool({
          name: 'exarchos_workflow',
          arguments: { action: 'rehydrate', featureId },
        });
        const mcpEnvelope = extractEnvelope(mcpRaw);

        // Defensive sanity: the rehydration document must include
        // taskProgress with both tasks. If the saga's appends silently
        // failed, the projection would lack tasks and the parity
        // assertion below could pass trivially with both sides showing
        // an empty taskProgress array.
        const mcpData = (mcpEnvelope as { data?: unknown }).data;
        expect(mcpData).toBeTruthy();
        const mcpTasks = (mcpData as { taskProgress?: unknown[] }).taskProgress;
        expect(Array.isArray(mcpTasks)).toBe(true);
        expect((mcpTasks as unknown[]).length).toBe(2);

        // Terminate the MCP server BEFORE invoking the CLI. The
        // EventStore uses a per-PID lock (DR-5 — see
        // src/event-store/cli-concurrency.test.ts);
        // a CLI process started while MCP holds the lock is diverted
        // to sidecar mode or blocks. Sequentializing keeps this test
        // deterministic — both transports still see the same persisted
        // state under env.stateDir.
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
          // WORKFLOW_STATE_DIR is the load-bearing var
          // (src/utils/paths.ts:54).
          env: {
            WORKFLOW_STATE_DIR: env.stateDir,
            EXARCHOS_STATE_DIR: env.stateDir,
          },
        });
        expect(cliResult.exitCode).toBe(0);
        const cliEnvelope = JSON.parse(cliResult.stdout);

        // Normalize away non-deterministic fields, then enforce parity.
        // `data.projectionSequence` is NOT normalized (key is not in
        // `SEQUENCE_KEYS`) — the contract demands real numeric equality
        // on it, so any divergence in events folded by the two
        // transports surfaces here.
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

  it('workflowRehydrate_replayedEvents_reconstructEqualProjection', async () => {
    // F6.1 — the centerpiece reconstructability test. Two MCP servers
    // (A, B) backed by SEPARATE state directories. A's events are
    // replayed into B; B's projection must equal A's projection under
    // the parity contract.
    //
    // We don't use `withHermeticEnv` here because that fixture sets a
    // single process-wide EXARCHOS_STATE_DIR via a serialized mutex —
    // it's designed for one state dir per callback. F6.1 needs two
    // independent state dirs simultaneously. Each `spawnMcpClient`
    // call passes `stateDir` directly to the child env, so the host
    // process's EXARCHOS_STATE_DIR is irrelevant; we just create two
    // unique tmp dirs and pass them through.
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
      // ── 1. Spawn server A and drive saga ─────────────────────────
      mcpA = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: stateDirA,
      });
      await driveStandardSaga(mcpA, featureId);

      // ── 2. Snapshot A's event stream ─────────────────────────────
      // `snapshotEventStream` queries `exarchos_event.query`, which
      // returns events in commit order (sequence-ascending) — see
      // `handleEventQuery`. `replayInto` consumes the snapshot in the
      // same array order, so causal ordering is preserved.
      const snapshot = await snapshotEventStream(mcpA, featureId);
      // Three events expected: workflow.started bootstrap + 2
      // task.assigned. If this is wrong the snapshot is faulty and
      // the F6.1 test would assert on a malformed input.
      expect(snapshot.events.length).toBe(3);

      // ── 3. Capture A's rehydrate envelope ────────────────────────
      const aRaw = await mcpA.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'rehydrate', featureId },
      });
      const aEnvelope = extractEnvelope(aRaw);

      // ── 4. Terminate A ───────────────────────────────────────────
      // No CLI involvement here — both projections come from MCP — so
      // we don't strictly need to terminate before B. But terminating
      // releases the per-PID lock on stateDirA early and matches the
      // shape of the parity test above.
      await mcpA.terminate();
      mcpA = undefined;

      // ── 5. Spawn server B in a SEPARATE state directory ──────────
      mcpB = await spawnMcpClient({
        command: WORKTREE_BINARY,
        args: ['mcp'],
        stateDir: stateDirB,
      });

      // ── 6. Replay events into B ──────────────────────────────────
      // `replayInto` re-emits each event via `exarchos_event.append`
      // in commit order. Server B applies them through its EventStore
      // synchronously, so once the replay resolves the projection at
      // B is up-to-date with A's snapshot.
      await replayInto(mcpB, snapshot);

      // ── 7. Capture B's rehydrate envelope ────────────────────────
      const bRaw = await mcpB.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'rehydrate', featureId },
      });
      const bEnvelope = extractEnvelope(bRaw);

      // Defensive sanity: B's projection must include the replayed
      // tasks. If `replayInto` silently dropped the task.assigned
      // events (e.g. schema rejection on a missing field after a
      // future change), B's taskProgress would be empty and the
      // parity assertion could pass trivially against an A-projection
      // that ALSO lost those tasks.
      const bData = (bEnvelope as { data?: unknown }).data;
      expect(bData).toBeTruthy();
      const bTasks = (bData as { taskProgress?: unknown[] }).taskProgress;
      expect(Array.isArray(bTasks)).toBe(true);
      expect((bTasks as unknown[]).length).toBe(2);

      // ── 8. Normalize both, assert F6.1 invariant ─────────────────
      // The parity contract for `workflow.rehydrate` enforces equality
      // on `success`, `data.workflowState`, `data.taskProgress`,
      // `data.projectionSequence`. The last is NOT normalized — both
      // servers must reach identical projection sequence after the
      // same set of events, or there's a determinism bug.
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
      // Best-effort tmp tree cleanup; cleanup failures must not flake
      // the test outcome (axiom DIM-7 — same policy as withHermeticEnv).
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
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
