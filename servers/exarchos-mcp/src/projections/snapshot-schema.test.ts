import { describe, it, expect } from 'vitest';
import { SnapshotRecord } from './snapshot-schema.js';
import type { SnapshotRecord as SnapshotRecordType } from './snapshot-schema.js';

describe('snapshot-schema', () => {
  it('SnapshotRecord_RoundTripJsonl_Preserves', () => {
    // A representative, valid snapshot record.
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

    // Validate first (input is a well-formed record per the schema).
    const validated = SnapshotRecord.parse(record);

    // Encode to a single JSONL line and decode back.
    const line = JSON.stringify(validated);
    expect(line.includes('\n')).toBe(false);

    const parsed = SnapshotRecord.parse(JSON.parse(line));

    // Round-trip preserves every field deeply.
    expect(parsed).toEqual(record);
  });
});
