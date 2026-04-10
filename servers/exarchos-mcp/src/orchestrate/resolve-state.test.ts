// ─── Tests for resolveWorkflowState ─────────────────────────────────────────
//
// Verifies state resolution fallback: file → event store → error.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolveWorkflowState } from './resolve-state.js';
import { EventStore } from '../event-store/store.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'resolve-state-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('resolveWorkflowState', () => {
  // ─── Test 1: With State File ─────────────────────────────────────────────

  it('ResolveWorkflowState_WithStateFile_ReadsFromFile', async () => {
    const stateData = {
      workflowType: 'feature',
      phase: 'plan',
      featureId: 'test-feature',
      tasks: [
        { id: 'task-1', status: 'complete', branch: 'feat/task-1' },
      ],
    };
    const stateFile = path.join(tempDir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify(stateData), 'utf-8');

    const result = await resolveWorkflowState({ stateFile });

    expect('state' in result).toBe(true);
    if ('state' in result) {
      expect(result.state).toEqual(stateData);
    }
  });

  // ─── Test 2: No State File, With FeatureId + EventStore ──────────────────

  it('ResolveWorkflowState_NoStateFile_WithFeatureId_ResolvesFromEventStore', async () => {
    const eventStoreDir = path.join(tempDir, 'events');
    await fsPromises.mkdir(eventStoreDir, { recursive: true });
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const streamId = 'test-feature';

    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'test-feature', workflowType: 'feature' },
    });

    await eventStore.append(streamId, {
      type: 'workflow.transition',
      data: { to: 'plan' },
    });

    const result = await resolveWorkflowState({
      featureId: streamId,
      eventStore,
    });

    // Must NOT return an error
    expect('error' in result).toBe(false);

    // Must return materialized state
    expect('state' in result).toBe(true);
    if ('state' in result) {
      const state = result.state as Record<string, unknown>;
      expect(state.featureId).toBe('test-feature');
      expect(state.phase).toBe('plan');
      expect(state.workflowType).toBe('feature');
    }
  });

  // ─── Test 3: No State File, No FeatureId ─────────────────────────────────

  it('ResolveWorkflowState_NoStateFile_NoFeatureId_ReturnsError', async () => {
    const result = await resolveWorkflowState({});

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.success).toBe(false);
      expect(result.error.error?.code).toBe('NO_STATE_SOURCE');
    }
  });

  // ─── Test 4: State File Not Found, Falls Back to Event Store ─────────────

  it('ResolveWorkflowState_StateFileNotFound_FallsBackToEventStore', async () => {
    const nonExistentFile = path.join(tempDir, 'does-not-exist.json');

    const eventStoreDir = path.join(tempDir, 'events-fallback');
    await fsPromises.mkdir(eventStoreDir, { recursive: true });
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();

    const streamId = 'fallback-feature';

    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'fallback-feature', workflowType: 'debug' },
    });

    await eventStore.append(streamId, {
      type: 'workflow.transition',
      data: { to: 'investigate' },
    });

    const result = await resolveWorkflowState({
      stateFile: nonExistentFile,
      featureId: streamId,
      eventStore,
    });

    // Must NOT return STATE_FILE_NOT_FOUND — should fall back to event store
    expect('error' in result).toBe(false);

    expect('state' in result).toBe(true);
    if ('state' in result) {
      const state = result.state as Record<string, unknown>;
      expect(state.featureId).toBe('fallback-feature');
      expect(state.phase).toBe('investigate');
      expect(state.workflowType).toBe('debug');
    }
  });
});
