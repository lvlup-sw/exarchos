import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleInit,
  handleSet,
  handleGet,
  handleCancel,
  handleCheckpoint,
} from '../tools.js';
import { readStateFile } from '../state-store.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Idempotency', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-idempotency-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  // ─── Test 1: Phase Transition Twice ──────────────────────────────────────

  describe('Idempotency_PhaseTransitionTwice_NoDuplicateEvent', () => {
    it('should treat a repeated phase transition as a no-op with no duplicate event', async () => {
      // Arrange: init a feature workflow
      const initResult = await handleInit(
        { featureId: 'idem-phase', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Satisfy the ideate→plan guard: artifacts.design must exist
      const guardResult = await handleSet(
        {
          featureId: 'idem-phase',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(guardResult.success).toBe(true);

      // Act: transition ideate→plan (first time)
      const firstTransition = await handleSet(
        { featureId: 'idem-phase', phase: 'plan' },
        stateDir,
      );
      expect(firstTransition.success).toBe(true);

      // Verify phase is now 'plan'
      const firstData = firstTransition.data as Record<string, unknown>;
      expect(firstData.phase).toBe('plan');

      // Count transition events after first transition (read from disk)
      const stateAfterFirst = await readStateFile(path.join(stateDir, 'idem-phase.state.json'));
      const transitionEventsAfterFirst = stateAfterFirst._events.filter(
        (e) => e.type === 'transition' && e.from === 'ideate' && e.to === 'plan',
      );
      expect(transitionEventsAfterFirst.length).toBe(1);

      // Act: transition plan→plan (already at plan, should be idempotent)
      const secondTransition = await handleSet(
        { featureId: 'idem-phase', phase: 'plan' },
        stateDir,
      );
      expect(secondTransition.success).toBe(true);

      // Assert: event log should NOT contain a duplicate transition event (read from disk)
      const secondData = secondTransition.data as Record<string, unknown>;
      expect(secondData.phase).toBe('plan');

      const stateAfterSecond = await readStateFile(path.join(stateDir, 'idem-phase.state.json'));
      const transitionEventsAfterSecond = stateAfterSecond._events.filter(
        (e) => e.type === 'transition' && e.from === 'ideate' && e.to === 'plan',
      );
      expect(transitionEventsAfterSecond.length).toBe(1);
    });
  });

  // ─── Test 2: Same Field Update Twice ─────────────────────────────────────

  describe('Idempotency_SameFieldUpdateTwice_IdenticalState', () => {
    it('should produce identical state when setting the same field to the same value twice', async () => {
      // Arrange: init a feature workflow
      const initResult = await handleInit(
        { featureId: 'idem-field', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Act: set artifacts.design to a value
      const firstSet = await handleSet(
        {
          featureId: 'idem-field',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(firstSet.success).toBe(true);

      // Act: set the same field to the same value again
      const secondSet = await handleSet(
        {
          featureId: 'idem-field',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(secondSet.success).toBe(true);

      // Assert: both calls succeeded and slim response is consistent
      const firstData = firstSet.data as Record<string, unknown>;
      const secondData = secondSet.data as Record<string, unknown>;

      // The phase should remain unchanged
      expect(secondData.phase).toBe(firstData.phase);

      // Verify the field value is persisted correctly (read from disk)
      const state = await readStateFile(path.join(stateDir, 'idem-field.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  // ─── Test 3: Cancel Twice ────────────────────────────────────────────────

  describe('Idempotency_CancelTwice_AlreadyCancelledTrue', () => {
    it('should return ALREADY_CANCELLED when cancelling a workflow that is already cancelled', async () => {
      // Arrange: init a feature workflow
      const initResult = await handleInit(
        { featureId: 'idem-cancel', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Act: cancel the workflow (first time)
      const firstCancel = await handleCancel(
        { featureId: 'idem-cancel', reason: 'testing idempotency' },
        stateDir,
      );
      expect(firstCancel.success).toBe(true);

      // Act: cancel the workflow again
      const secondCancel = await handleCancel(
        { featureId: 'idem-cancel', reason: 'testing idempotency again' },
        stateDir,
      );

      // Assert: second cancel returns error with ALREADY_CANCELLED code
      expect(secondCancel.success).toBe(false);
      expect(secondCancel.error).toBeDefined();
      expect(secondCancel.error?.code).toBe('ALREADY_CANCELLED');
    });
  });

  // ─── Test 4: Multiple Checkpoints ────────────────────────────────────────

  describe('Idempotency_MultipleCheckpoints_CounterResetsEachTime', () => {
    it('should reset operationsSince to 0 after each checkpoint', async () => {
      // Arrange: init a feature workflow
      const initResult = await handleInit(
        { featureId: 'idem-checkpoint', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      // Act: do several set operations
      await handleSet(
        {
          featureId: 'idem-checkpoint',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      await handleSet(
        {
          featureId: 'idem-checkpoint',
          updates: { 'artifacts.plan': 'docs/plan.md' },
        },
        stateDir,
      );

      // Verify operationsSince is now 2
      const getBeforeFirstCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getBeforeFirstCheckpoint.success).toBe(true);
      expect(getBeforeFirstCheckpoint.data).toBe(2);

      // Act: first checkpoint
      const firstCheckpoint = await handleCheckpoint(
        { featureId: 'idem-checkpoint', summary: 'First checkpoint' },
        stateDir,
      );
      expect(firstCheckpoint.success).toBe(true);

      // Assert: operationsSince should be 0 after checkpoint
      const getAfterFirstCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getAfterFirstCheckpoint.success).toBe(true);
      expect(getAfterFirstCheckpoint.data).toBe(0);

      // Act: do more operations
      await handleSet(
        {
          featureId: 'idem-checkpoint',
          updates: { 'artifacts.review': 'docs/review.md' },
        },
        stateDir,
      );
      await handleSet(
        {
          featureId: 'idem-checkpoint',
          updates: { 'artifacts.notes': 'some notes' },
        },
        stateDir,
      );
      await handleSet(
        {
          featureId: 'idem-checkpoint',
          updates: { 'artifacts.extra': 'extra data' },
        },
        stateDir,
      );

      // Verify operationsSince is now 3
      const getBeforeSecondCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getBeforeSecondCheckpoint.success).toBe(true);
      expect(getBeforeSecondCheckpoint.data).toBe(3);

      // Act: second checkpoint
      const secondCheckpoint = await handleCheckpoint(
        { featureId: 'idem-checkpoint', summary: 'Second checkpoint' },
        stateDir,
      );
      expect(secondCheckpoint.success).toBe(true);

      // Assert: operationsSince should be 0 after second checkpoint
      const getAfterSecondCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getAfterSecondCheckpoint.success).toBe(true);
      expect(getAfterSecondCheckpoint.data).toBe(0);
    });
  });
});
