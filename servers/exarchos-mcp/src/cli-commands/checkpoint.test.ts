// ─── T035 — `/exarchos:checkpoint` CLI adapter tests (RED) ─────────────────
//
// The CLI adapter is a thin shim around the shared `dispatch()` layer that
// prints the envelope returned by `exarchos_workflow.checkpoint` to stdout
// and mirrors its success flag to the process exit code.
//
// Per DR-6, the envelope's `data` must include `projectionSequence` from
// the rehydration projection snapshot the T034 handler writes — this lets
// an operator see at a glance "how many events are behind this checkpoint"
// without having to query the event store afterwards.
//
// Tests drive the CLI entry point directly (no child process) with stdout/
// stderr spied so we can assert on the rendered envelope.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleCheckpointCli } from './checkpoint.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

function makeCtx(stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
}

describe('checkpoint CLI adapter (T035, DR-6)', () => {
  let tmpDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-cli-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function capturedStdout(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function capturedStderr(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('CheckpointCli_Invocation_OutputIncludesProjectionSequence', async () => {
    // GIVEN: an initialized workflow with several task events appended to its
    //   stream. The rehydration reducer folds `workflow.started` + 3 task
    //   events → `projectionSequence = 4`.
    const featureId = 't035-projseq';
    const ctx = makeCtx(tmpDir);

    // Seed via the workflow tool's own dispatch surface — we need the full
    // side-effect chain (state file, outbound event) rather than forging a
    // state file by hand, and this matches what a real caller would do.
    const { dispatch } = await import('../core/dispatch.js');
    const initResult = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx,
    );
    expect(initResult.success).toBe(true);

    await ctx.eventStore.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T001' },
    });
    await ctx.eventStore.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T001' },
    });
    await ctx.eventStore.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T002' },
    });

    // WHEN: the CLI adapter is invoked for this feature.
    const exitCode = await handleCheckpointCli(
      { featureId, summary: 'T035 CLI checkpoint' },
      ctx,
    );

    // THEN: exit 0 (success), stdout contains a JSON envelope whose
    //   `data.projectionSequence` is the absorbed stream position. The
    //   handler appends `workflow.checkpoint` (seq 5) before materializing
    //   the snapshot, so the snapshot reflects sequences 1..5 even though
    //   only 4 of those events are folded by the rehydration reducer. The
    //   envelope reports the stream position (5) — that is the
    //   operator-meaningful "events behind" anchor. (CodeRabbit PR #1178
    //   follow-up review.)
    expect(exitCode).toBe(0);

    const stdout = capturedStdout();
    const parsed = JSON.parse(stdout) as {
      success: boolean;
      data: { phase: string; projectionSequence: number };
      next_actions: unknown[];
      _meta: Record<string, unknown>;
      _perf: { ms: number };
    };
    expect(parsed.success).toBe(true);
    expect(parsed.data.projectionSequence).toBe(5);
    expect(typeof parsed.data.phase).toBe('string');
  });

  it('CheckpointCli_Envelope_HasNextActions', async () => {
    // GIVEN: an initialized workflow so the checkpoint has real state.
    const featureId = 't035-nextactions';
    const ctx = makeCtx(tmpDir);

    const { dispatch } = await import('../core/dispatch.js');
    const initResult = await dispatch(
      'exarchos_workflow',
      { action: 'init', featureId, workflowType: 'feature' },
      ctx,
    );
    expect(initResult.success).toBe(true);

    // WHEN
    const exitCode = await handleCheckpointCli({ featureId }, ctx);

    // THEN: envelope carries `next_actions` as an array (may be empty per
    //   workflow state, but the FIELD must be present — that is the whole
    //   HATEOAS contract for DR-7/DR-8).
    expect(exitCode).toBe(0);

    const stdout = capturedStdout();
    const parsed = JSON.parse(stdout) as {
      next_actions: unknown;
    };
    expect(Array.isArray(parsed.next_actions)).toBe(true);
  });

  it('CheckpointCli_MissingFeatureId_ExitsNonZero', async () => {
    // GIVEN: no featureId supplied.
    const ctx = makeCtx(tmpDir);

    // WHEN
    const exitCode = await handleCheckpointCli(
      {} as { featureId?: string },
      ctx,
    );

    // THEN: non-zero exit + stderr explains the missing argument.
    expect(exitCode).not.toBe(0);
    const stderr = capturedStderr();
    expect(stderr.toLowerCase()).toContain('featureid');
  });
});
