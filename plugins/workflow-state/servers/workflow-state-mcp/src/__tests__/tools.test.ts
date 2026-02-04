import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleInit, handleList, handleGet, handleSet } from '../tools.js';
import { initStateFile, readStateFile } from '../state-store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-tools-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Core Tools', () => {
  // ─── ToolInit ───────────────────────────────────────────────────────────────

  describe('ToolInit_NewFeature_CreatesStateFile', () => {
    it('should create a new state file with correct defaults', async () => {
      const result = await handleInit(
        { featureId: 'my-feature', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result._meta).toBeDefined();
      expect(result._meta?.checkpointAdvised).toBe(false);

      // Verify state was created on disk
      const state = await readStateFile(path.join(tmpDir, 'my-feature.state.json'));
      expect(state.featureId).toBe('my-feature');
      expect(state.workflowType).toBe('feature');
      expect(state.phase).toBe('ideate');

      // Verify data in result contains the state
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('my-feature');
      expect(data.workflowType).toBe('feature');
      expect(data.phase).toBe('ideate');
    });
  });

  describe('ToolInit_ExistingFeature_ReturnsStateAlreadyExists', () => {
    it('should return error if state already exists', async () => {
      // Create it first
      await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      // Try to create again
      const result = await handleInit(
        { featureId: 'existing', workflowType: 'feature' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STATE_ALREADY_EXISTS');
    });
  });

  // ─── ToolList ───────────────────────────────────────────────────────────────

  describe('ToolList_ActiveWorkflows_ReturnsWithStaleness', () => {
    it('should return all workflows with staleness info', async () => {
      // Create multiple workflows
      await handleInit({ featureId: 'feat-a', workflowType: 'feature' }, tmpDir);
      await handleInit({ featureId: 'feat-b', workflowType: 'debug' }, tmpDir);

      const result = await handleList({}, tmpDir);

      expect(result.success).toBe(true);
      const data = result.data as Array<Record<string, unknown>>;
      expect(data).toHaveLength(2);

      // Each entry should have checkpoint meta (staleness info)
      for (const entry of data) {
        expect(entry.featureId).toBeDefined();
        expect(entry._meta).toBeDefined();
        const meta = entry._meta as Record<string, unknown>;
        expect(meta.stale).toBeDefined();
        expect(meta.minutesSinceActivity).toBeDefined();
        expect(meta.checkpointAdvised).toBeDefined();
      }
    });
  });

  // ─── ToolGet ────────────────────────────────────────────────────────────────

  describe('ToolGet_DotPathQuery_ReturnsValue', () => {
    it('should return the nested value for a dot-path query', async () => {
      await handleInit({ featureId: 'get-test', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-test', query: 'artifacts.design' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.data).toBeNull(); // design is null by default
      expect(result._meta).toBeDefined();
    });

    it('should return the full state when no query is provided', async () => {
      await handleInit({ featureId: 'get-full', workflowType: 'feature' }, tmpDir);

      const result = await handleGet(
        { featureId: 'get-full' },
        tmpDir,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.featureId).toBe('get-full');
      expect(data.phase).toBe('ideate');
    });
  });

  describe('ToolGet_InternalField_ReturnsValue', () => {
    it('should be able to read internal fields like _history and _events', async () => {
      await handleInit({ featureId: 'internal-test', workflowType: 'feature' }, tmpDir);

      const historyResult = await handleGet(
        { featureId: 'internal-test', query: '_history' },
        tmpDir,
      );
      expect(historyResult.success).toBe(true);
      expect(historyResult.data).toEqual({});

      const eventsResult = await handleGet(
        { featureId: 'internal-test', query: '_events' },
        tmpDir,
      );
      expect(eventsResult.success).toBe(true);
      expect(eventsResult.data).toEqual([]);
    });
  });

  // ─── ToolSet ────────────────────────────────────────────────────────────────

  describe('ToolSet_FieldUpdates_AppliesAndReturns', () => {
    it('should apply field updates via dot-path', async () => {
      await handleInit({ featureId: 'set-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'set-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result._meta).toBeDefined();

      // Verify the update was persisted
      const state = await readStateFile(path.join(tmpDir, 'set-test.state.json'));
      expect(state.artifacts.design).toBe('docs/design.md');
    });
  });

  describe('ToolSet_PhaseTransition_ValidatesViaHSM', () => {
    it('should validate phase transition via HSM and apply if valid', async () => {
      await handleInit({ featureId: 'phase-test', workflowType: 'feature' }, tmpDir);

      // First set the design artifact so the guard passes
      await handleSet(
        { featureId: 'phase-test', updates: { 'artifacts.design': 'docs/design.md' } },
        tmpDir,
      );

      // Now transition from ideate -> plan
      const result = await handleSet(
        { featureId: 'phase-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(true);

      // Verify phase was updated on disk
      const state = await readStateFile(path.join(tmpDir, 'phase-test.state.json'));
      expect(state.phase).toBe('plan');
    });

    it('should return GUARD_FAILED for transition with unsatisfied guard', async () => {
      await handleInit({ featureId: 'guard-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> plan without setting design artifact
      const result = await handleSet(
        { featureId: 'guard-test', phase: 'plan' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('GUARD_FAILED');
    });

    it('should return INVALID_TRANSITION for invalid target phase', async () => {
      await handleInit({ featureId: 'invalid-test', workflowType: 'feature' }, tmpDir);

      // Try to transition ideate -> synthesize (not a valid transition)
      const result = await handleSet(
        { featureId: 'invalid-test', phase: 'synthesize' },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_TRANSITION');
    });
  });

  describe('ToolSet_ReservedField_ReturnsReservedFieldError', () => {
    it('should reject updates to reserved fields (_prefix)', async () => {
      await handleInit({ featureId: 'reserved-test', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'reserved-test', updates: { '_events': [] } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });

    it('should reject updates to nested reserved fields', async () => {
      await handleInit({ featureId: 'nested-reserved', workflowType: 'feature' }, tmpDir);

      const result = await handleSet(
        { featureId: 'nested-reserved', updates: { 'some._internal': 'value' } },
        tmpDir,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('RESERVED_FIELD');
    });
  });
});
