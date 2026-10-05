/**
 * `runFollowLoop` for the `pipeline`, `convergence` and `delegation_timeline` subcommands.
 * A source scan also keeps the three view projection modules free of write calls.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { V2Task as Task } from '../../../src/contract/sdk/seam.js';

import { runFollowLoop, type FollowTaskStore } from '../../../src/cli/follow-loop.js';

const ISO_FIXED = '2026-05-17T00:00:00.000Z';

/** A task store that returns the scripted snapshots in order, then repeats the last one. */
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
    },
  };
}

function drain(stream: PassThrough): string {
  return stream.read()?.toString('utf8') ?? '';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The subcommand changes only the bracket prefix of each output line. */
describe('runFollowLoop — #1440 Op 1 expansion to additional view actions', () => {
  it('CliFollow_PipelineAction_EmitsNdjsonFrames', async () => {
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

/**
 * A `--follow` poll must be a pure read, so a view module must hold no write call.
 * The scan reads the projection modules (`<name>-view.ts`) and matches literal substrings.
 * The pattern `.emit(` matches a method call only, so the bare word `emit` passes.
 */
describe('view handlers — #1440 Op 1 idempotency cross-check (T1 audit)', () => {
  const VIEWS_DIR = path.resolve(__dirname, '../../../src/projections/views');
  const FOLLOW_TARGETS = [
    'pipeline-view.ts',
    'convergence-view.ts',
    'delegation-timeline-view.ts',
  ];
  const FORBIDDEN_PATTERNS: ReadonlyArray<string> = [
    'eventStore.append',
    '.polled',
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
