/**
 * cli-follow-expansion — `--follow` expansion to view {pipeline,convergence,delegation_timeline} (#1440 Op 1, T7).
 *
 * Pin two contracts independently from the broader `follow-loop.test.ts` to
 * keep the diff focused:
 *
 *   1. `runFollowLoop` accepts the three new `FollowSubcommand` values and
 *      emits NDJSON-shaped transition frames identical to the existing
 *      workflow_status/shepherd_status entry points (only the prefix
 *      bracket differs).
 *   2. The underlying view handlers are pure projections — no
 *      `eventStore.append`, no `emit`, no `*.polled` events. Cross-checks
 *      the T1 idempotency audit at the source-file level so any future
 *      handler edit that introduces a write surface fails this test
 *      before it ships.
 *
 * INV-2: CLI `--follow` and MCP `tasks/get` polling produce byte-equivalent
 * transitions. The TaskStore-polling substrate is shared with the
 * workflow_status/shepherd_status path, so the rendering test below is
 * the only new behavior to pin at this layer.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { V1Task as Task } from '../sdk/seam.js';

import { runFollowLoop, type FollowTaskStore } from './follow-loop.js';

const ISO_FIXED = '2026-05-17T00:00:00.000Z';

// ─── Fixture builder (mirrors the scriptedStore in follow-loop.test.ts) ───

function scriptedStore(taskId: string, script: ReadonlyArray<Task>): FollowTaskStore {
  let cursor = 0;
  return {
    async getTask(id: string): Promise<Task | null> {
      if (id !== taskId) return null;
      const next = script[Math.min(cursor, script.length - 1)];
      cursor += 1;
      return { ...next };
    },
    async updateTaskStatus(): Promise<void> {
      /* unused in expansion tests */
    },
  };
}

function drain(stream: PassThrough): string {
  return stream.read()?.toString('utf8') ?? '';
}

// Resolve `__dirname` under ESM/NodeNext so the source-file idempotency
// check below works regardless of vitest worker cwd.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('runFollowLoop — #1440 Op 1 expansion to additional view actions', () => {
  it('CliFollow_PipelineAction_EmitsNdjsonFrames', async () => {
    // Pipeline view is the paginated list of active workflows. Operators
    // tail it during a synthesis push to watch workflows arrive/complete.
    // Same TaskStore-polling substrate as workflow_status — the only
    // observable diff is the `[pipeline]` bracket in the output line.
    const taskId = 'task-pipeline-001';
    const script: Task[] = [
      { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
      {
        taskId,
        status: 'completed',
        ttl: 60_000,
        createdAt: ISO_FIXED,
        lastUpdatedAt: '2026-05-17T00:00:01.000Z',
      },
    ];
    const stdout = new PassThrough();
    const store = scriptedStore(taskId, script);

    const result = await runFollowLoop({
      taskStore: store,
      taskId,
      pollIntervalMs: 1,
      stdout,
      subcommand: 'pipeline',
    });

    const text = drain(stdout);
    expect(text).toContain('[pipeline]');
    expect(text).toContain(taskId);
    expect(text).toContain('completed');
    expect(result.terminalStatus).toBe('completed');
    expect(result.transitions).toBeGreaterThanOrEqual(2);
  });

  it('CliFollow_ConvergenceAction_EmitsNdjsonFrames', async () => {
    // Convergence view surfaces D1-D5 gate convergence. Useful during a
    // synthesis push to watch dimensions land sequentially.
    const taskId = 'task-convergence-002';
    const script: Task[] = [
      {
        taskId,
        status: 'working',
        ttl: 60_000,
        createdAt: ISO_FIXED,
        lastUpdatedAt: ISO_FIXED,
        statusMessage: 'D1 pending',
      },
      {
        taskId,
        status: 'completed',
        ttl: 60_000,
        createdAt: ISO_FIXED,
        lastUpdatedAt: '2026-05-17T00:00:02.000Z',
        statusMessage: 'D1-D5 converged',
      },
    ];
    const stdout = new PassThrough();
    const store = scriptedStore(taskId, script);

    const result = await runFollowLoop({
      taskStore: store,
      taskId,
      pollIntervalMs: 1,
      stdout,
      subcommand: 'convergence',
    });

    const text = drain(stdout);
    expect(text).toContain('[convergence]');
    expect(text).toContain(taskId);
    expect(text).toContain('D1-D5 converged');
    expect(result.terminalStatus).toBe('completed');
  });

  it('CliFollow_DelegationTimelineAction_EmitsNdjsonFrames', async () => {
    // Delegation timeline drives bottleneck detection in flight. Operators
    // typically tail this during multi-agent dispatch waves.
    const taskId = 'task-delegation-003';
    const script: Task[] = [
      { taskId, status: 'working', ttl: 60_000, createdAt: ISO_FIXED, lastUpdatedAt: ISO_FIXED },
      {
        taskId,
        status: 'completed',
        ttl: 60_000,
        createdAt: ISO_FIXED,
        lastUpdatedAt: '2026-05-17T00:00:03.000Z',
      },
    ];
    const stdout = new PassThrough();
    const store = scriptedStore(taskId, script);

    const result = await runFollowLoop({
      taskStore: store,
      taskId,
      pollIntervalMs: 1,
      stdout,
      subcommand: 'delegation_timeline',
    });

    const text = drain(stdout);
    expect(text).toContain('[delegation_timeline]');
    expect(text).toContain(taskId);
    expect(text).toContain('completed');
    expect(result.terminalStatus).toBe('completed');
  });
});

describe('view handlers — #1440 Op 1 idempotency cross-check (T1 audit)', () => {
  // Cross-check the orchestrator-inline T1 idempotency audit at the
  // source-file level. The three new --follow targets MUST be pure
  // `ViewProjection` folds — no `eventStore.append`, no `emit`, no
  // `*.polled` events. If a future edit introduces a write surface this
  // test fails BEFORE the per-handler test, surfacing the regression at
  // the design-invariant level.
  const VIEWS_DIR = path.resolve(__dirname, '..', 'views');
  const FOLLOW_TARGETS = [
    'pipeline-view.ts',
    'convergence-view.ts',
    'delegation-timeline-view.ts',
  ];
  // Strings that would indicate a write side-effect on a poll path. The
  // patterns are conservative: any literal substring match here is
  // enough to fail the test and trigger a manual review of the handler.
  const FORBIDDEN_PATTERNS: ReadonlyArray<string> = [
    'eventStore.append',
    '.polled',
    // `.emit(` (method-call form, NOT the bare word) catches EventEmitter-
    // style write surfaces while avoiding false-positives on the word
    // 'emit' that legitimately appears in JSDoc/comments referencing the
    // T1 audit. Per CodeRabbit C5: the per-handler docstring at the top of
    // this file explicitly forbids `emit`, but the runtime guard above
    // missed it — closing the gap so a future regression that introduces
    // an event-emitter write on a poll path fails CI before review.
    '.emit(',
  ];

  for (const filename of FOLLOW_TARGETS) {
    it(`ViewHandler_${filename}_NoWriteSurfacesOrPolledEvents`, () => {
      const filePath = path.join(VIEWS_DIR, filename);
      const source = fs.readFileSync(filePath, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(
          source.includes(pattern),
          `${filename} must not contain '${pattern}' — the --follow polling path requires idempotent reads (T1 audit, INV-2)`,
        ).toBe(false);
      }
    });
  }
});
