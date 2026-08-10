import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { handleEventAppend, handleBatchAppend, handleEventQuery } from './tools.js';
import {
  BATCH_VALIDATION_ATOMICITY,
  EmptySchemaRegistryError,
  resolveBatchEvents,
  validateEventData,
} from './event-validation.js';
import type { ToolResult } from '../format.js';

let tempDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'batch-append-validation-'));
  eventStore = new EventStore(tempDir);
});

afterEach(async () => {
  const { rmrfAsync } = await import('../test-helpers/temp-dir.js');
  await rmrfAsync(tempDir);
});

function storedEvents(result: ToolResult): Array<Record<string, unknown>> {
  const data = result.data as { events?: unknown } | undefined;
  return (data?.events ?? []) as Array<Record<string, unknown>>;
}

/**
 * The measured kill fixture (2026-08-07, `internal-mechanics-overhaul`
 * sequences 152-157): `task.completed` registers `evidence` as an object, and
 * six events carrying a STRING `evidence` reached the authoritative store
 * through `batch_append` while `append` rejected the identical payload.
 */
const STRING_EVIDENCE_EVENT = {
  type: 'task.completed',
  data: {
    taskId: 'task-071',
    evidence: 'all tests pass',
  },
} as const;

const WELL_FORMED_EVENT = {
  type: 'task.completed',
  data: {
    taskId: 'task-071',
    evidence: { type: 'test', output: 'ok', passed: true },
  },
} as const;

describe('batch_append event-data validation (DR-1)', () => {
  it('BatchAppend_EventWithSchemaViolatingData_IsRejected', async () => {
    const result = await handleBatchAppend(
      { stream: 'kill-fixture', events: [{ ...STRING_EVIDENCE_EVENT }] },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    expect(result.error?.message).toContain('evidence');

    // The store is authoritative and events are immutable: nothing may land.
    const query = await handleEventQuery({ stream: 'kill-fixture' }, tempDir, eventStore);
    expect(storedEvents(query)).toHaveLength(0);
  });

  it('BatchAppend_OneInvalidEventInBatch_RejectsPerDeclaredAtomicity', async () => {
    // The declared atomicity is all-or-nothing: one invalid event rejects the
    // whole batch. Neither the valid prefix nor the valid suffix may survive.
    expect(BATCH_VALIDATION_ATOMICITY).toBe('all-or-nothing');

    const result = await handleBatchAppend(
      {
        stream: 'atomicity',
        events: [
          { ...WELL_FORMED_EVENT, data: { ...WELL_FORMED_EVENT.data, taskId: 'before' } },
          { ...STRING_EVIDENCE_EVENT },
          { ...WELL_FORMED_EVENT, data: { ...WELL_FORMED_EVENT.data, taskId: 'after' } },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_ERROR');
    // The rejection names the offending position, not just "somewhere".
    expect(result.error?.message).toContain('events[1]');

    const query = await handleEventQuery({ stream: 'atomicity' }, tempDir, eventStore);
    expect(storedEvents(query)).toHaveLength(0);
  });

  it('AppendAndBatchAppend_IdenticalPayload_AgreeOnValidity', async () => {
    const payloads: ReadonlyArray<{ label: string; event: Record<string, unknown> }> = [
      { label: 'string-evidence', event: { ...STRING_EVIDENCE_EVENT } },
      { label: 'well-formed', event: { ...WELL_FORMED_EVENT } },
      {
        label: 'evidence-missing-passed',
        event: {
          type: 'task.completed',
          data: { taskId: 't', evidence: { type: 'test', output: 'ok' } },
        },
      },
      {
        label: 'evidence-bad-enum',
        event: {
          type: 'task.completed',
          data: { taskId: 't', evidence: { type: 'vibes', output: 'ok', passed: true } },
        },
      },
      {
        label: 'missing-required-taskId',
        event: { type: 'task.completed', data: { verified: true } },
      },
      {
        label: 'unknown-event-type',
        event: { type: 'not.a.real.event.type', data: {} },
      },
    ];

    // A vacuous parity test (zero payloads compared) must not read as agreement.
    expect(payloads.length).toBeGreaterThan(0);

    const disagreements: string[] = [];
    for (const { label, event } of payloads) {
      const viaAppend = await handleEventAppend(
        { stream: `parity-append-${label}`, event: { ...event } },
        tempDir,
        eventStore,
      );
      const viaBatch = await handleBatchAppend(
        { stream: `parity-batch-${label}`, events: [{ ...event }] },
        tempDir,
        eventStore,
      );
      if (viaAppend.success !== viaBatch.success) {
        disagreements.push(
          `${label}: append=${viaAppend.success} batch=${viaBatch.success} ` +
            `(append error: ${viaAppend.error?.message ?? 'none'}; ` +
            `batch error: ${viaBatch.error?.message ?? 'none'})`,
        );
      }
    }

    expect(disagreements).toEqual([]);
  });
});

describe('non-empty denominator (DR-1)', () => {
  it('ResolveBatchEvents_ZeroResolvedEvents_Fails', async () => {
    // A batch that resolves to no appendable events is a caller error, not a
    // clean pass. Both the empty input and the post-dedup-empty case fail.
    expect(resolveBatchEvents([]).ok).toBe(false);
    expect(resolveBatchEvents([{ type: 'workflow.started' }]).ok).toBe(true);

    const result = await handleBatchAppend(
      { stream: 'empty-batch', events: [] },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('ValidateEventData_EmptySchemaRegistry_Fails', () => {
    // A validator whose registry resolves zero schemas would wave every
    // payload through. It must fail loudly instead of passing clean.
    expect(() =>
      validateEventData('task.completed', { taskId: 't' }, {}),
    ).toThrow(EmptySchemaRegistryError);
  });

  it('ValidateEventData_SchemaViolation_ThrowsForBothCallPaths', () => {
    // The one authority both write paths route through.
    expect(() =>
      validateEventData('task.completed', { taskId: 't', evidence: 'a string' }),
    ).toThrow();
    expect(() =>
      validateEventData('task.completed', {
        taskId: 't',
        evidence: { type: 'test', output: 'ok', passed: true },
      }),
    ).not.toThrow();
  });
});
