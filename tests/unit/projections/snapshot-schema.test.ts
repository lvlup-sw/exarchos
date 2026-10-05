import { describe, it, expect } from 'vitest';
import { SnapshotRecord } from '../../../src/projections/snapshot-schema.js';
import type { SnapshotRecord as SnapshotRecordType } from '../../../src/projections/snapshot-schema.js';

describe('snapshot-schema', () => {
  it('SnapshotRecord_RoundTripJsonl_Preserves', () => {
    const record: SnapshotRecordType = {
      projectionId: 'rehydration',
      projectionVersion: 'v1',
      sequence: 42,
      state: {
        workflowType: 'rehydrate-foundation',
        phase: 'red',
        taskProgress: [
          { id: '004', status: 'in-progress', title: 'snapshot schema' },
        ],
      },
      timestamp: '2026-04-24T12:34:56.000Z',
    };

    const validated = SnapshotRecord.parse(record);

    const line = JSON.stringify(validated);
    expect(line.includes('\n')).toBe(false);

    const parsed = SnapshotRecord.parse(JSON.parse(line));

    expect(parsed).toEqual(record);
  });
});
