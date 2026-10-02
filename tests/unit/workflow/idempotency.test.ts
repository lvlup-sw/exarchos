import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  handleInit,
  handleSet,
  handleGet,
  handleCancel,
  handleCheckpoint,
} from '../../../src/workflow/tools.js';
import { readStateFile } from '../../../src/workflow/state-store.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('Idempotency', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-idempotency-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  describe('Idempotency_PhaseTransitionTwice_NoDuplicateEvent', () => {
    it('should treat a repeated phase transition as a no-op with no duplicate event', async () => {
      const initResult = await handleInit(
        { featureId: 'idem-phase', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      const guardResult = await handleSet(
        {
          featureId: 'idem-phase',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(guardResult.success).toBe(true);

      const firstTransition = await handleSet(
        { featureId: 'idem-phase', phase: 'plan' },
        stateDir,
      );
      expect(firstTransition.success).toBe(true);

      const firstData = firstTransition.data as Record<string, unknown>;
      expect(firstData.phase).toBe('plan');

      const stateAfterFirst = await readStateFile(path.join(stateDir, 'idem-phase.state.json'));
      expect(stateAfterFirst.phase).toBe('plan');

      const secondTransition = await handleSet(
        { featureId: 'idem-phase', phase: 'plan' },
        stateDir,
      );
      expect(secondTransition.success).toBe(true);

      const secondData = secondTransition.data as Record<string, unknown>;
      expect(secondData.phase).toBe('plan');

      const stateAfterSecond = await readStateFile(path.join(stateDir, 'idem-phase.state.json'));
      expect(stateAfterSecond.phase).toBe('plan');
    });
  });

  describe('Idempotency_SameFieldUpdateTwice_IdenticalState', () => {
    it('should produce identical state when setting the same field to the same value twice', async () => {
      const initResult = await handleInit(
        { featureId: 'idem-field', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      const firstSet = await handleSet(
        {
          featureId: 'idem-field',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(firstSet.success).toBe(true);

      const secondSet = await handleSet(
        {
          featureId: 'idem-field',
          updates: { 'artifacts.design': 'docs/design.md' },
        },
        stateDir,
      );
      expect(secondSet.success).toBe(true);

      const firstData = firstSet.data as Record<string, unknown>;
      const secondData = secondSet.data as Record<string, unknown>;

      expect(secondData.phase).toBe(firstData.phase);

      const state = await readStateFile(path.join(stateDir, 'idem-field.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  describe('Idempotency_CancelTwice_AlreadyCancelledTrue', () => {
    it('should return ALREADY_CANCELLED when cancelling a workflow that is already cancelled', async () => {
      const initResult = await handleInit(
        { featureId: 'idem-cancel', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

      const firstCancel = await handleCancel(
        { featureId: 'idem-cancel', reason: 'testing idempotency' },
        stateDir,
      );
      expect(firstCancel.success).toBe(true);

      const secondCancel = await handleCancel(
        { featureId: 'idem-cancel', reason: 'testing idempotency again' },
        stateDir,
      );

      expect(secondCancel.success).toBe(false);
      expect(secondCancel.error).toBeDefined();
      expect(secondCancel.error?.code).toBe('ALREADY_CANCELLED');
    });
  });

  describe('Idempotency_MultipleCheckpoints_CounterResetsEachTime', () => {
    it('should reset operationsSince to 0 after each checkpoint', async () => {
      const initResult = await handleInit(
        { featureId: 'idem-checkpoint', workflowType: 'feature' },
        stateDir,
      );
      expect(initResult.success).toBe(true);

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

      const getBeforeFirstCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getBeforeFirstCheckpoint.success).toBe(true);
      expect(getBeforeFirstCheckpoint.data).toBe(2);

      const firstCheckpoint = await handleCheckpoint(
        { featureId: 'idem-checkpoint', summary: 'First checkpoint' },
        stateDir,
      );
      expect(firstCheckpoint.success).toBe(true);

      const getAfterFirstCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getAfterFirstCheckpoint.success).toBe(true);
      expect(getAfterFirstCheckpoint.data).toBe(0);

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

      const getBeforeSecondCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getBeforeSecondCheckpoint.success).toBe(true);
      expect(getBeforeSecondCheckpoint.data).toBe(3);

      const secondCheckpoint = await handleCheckpoint(
        { featureId: 'idem-checkpoint', summary: 'Second checkpoint' },
        stateDir,
      );
      expect(secondCheckpoint.success).toBe(true);

      const getAfterSecondCheckpoint = await handleGet(
        { featureId: 'idem-checkpoint', query: '_checkpoint.operationsSince' },
        stateDir,
      );
      expect(getAfterSecondCheckpoint.success).toBe(true);
      expect(getAfterSecondCheckpoint.data).toBe(0);
    });
  });
});
