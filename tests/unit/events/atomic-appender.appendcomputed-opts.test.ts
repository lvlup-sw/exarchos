import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * `appendComputed` passes `AppendOptions` to the SQLite body. A caller such as `decide` or
 * `withSession` can supply `expectedSequence` and get the same `sequence-conflict` result that
 * `append` and `appendUnkeyed` return.
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
