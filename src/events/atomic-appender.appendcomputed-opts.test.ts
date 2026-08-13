import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/**
 * Wave 3 Task 3.2 — `appendComputed` threads `AppendOptions` to the
 * substrate so callers (notably the new `decide`/`withSession`
 * primitives) can supply `expectedSequence` and get the same
 * `sequence-conflict` AppendResult shape that `append`/`appendUnkeyed`
 * already produce.
 *
 * Today's `appendComputed` accepts no options; this test pins the
 * extended signature.
 */
describe('AtomicAppender.appendComputed — AppendOptions (Task 3.2)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'appendcomputed-opts-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('AppendComputed_ThrowsSequenceConflict_WhenExpectedSequenceMismatched', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-seqconflict';

    // Seed with 3 events.
    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { i: 1 } }],
      'seed-1',
    );
    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { i: 2 } }],
      'seed-2',
    );
    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { i: 3 } }],
      'seed-3',
    );

    // Now request appendComputed with the WRONG expectedSequence.
    const result = await appender.appendComputed(
      streamId,
      'compute-key-conflict',
      async () => [{ type: 'task.completed', data: { i: 99 } }],
      { expectedSequence: 1 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('sequence-conflict');
    expect(result.expected).toBe(1);
    expect(result.actual).toBe(3);
  });

  it('AppendComputed_Succeeds_WhenExpectedSequenceMatches', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-seqok';

    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { i: 1 } }],
      'seed-1',
    );
    await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { i: 2 } }],
      'seed-2',
    );

    // Correct expectedSequence = 2 (tail after seeding).
    const result = await appender.appendComputed(
      streamId,
      'compute-key-ok',
      async () => [{ type: 'task.completed', data: { i: 99 } }],
      { expectedSequence: 2 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([3]);
  });
});
