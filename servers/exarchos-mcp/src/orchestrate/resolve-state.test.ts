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
import { classifyStateFile, resolveWorkflowState } from './resolve-state.js';
import { EventStore } from '../event-store/store.js';

/**
 * Minimal equivalence checker for the #1504 1504-1 proof. Returns the dot-paths
 * (supporting `arr[idx]` segments) where the folded `state` diverges from the
 * `expected` field values. An empty array means the projection reconstructs
 * every asserted field-group losslessly — i.e. the on-disk `.state.json` carried
 * nothing the event fold cannot recover.
 */
function diffStates(
  state: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  const get = (obj: unknown, dotPath: string): unknown =>
    dotPath.split('.').reduce<unknown>((acc, seg) => {
      if (acc == null) return undefined;
      const m = seg.match(/^(.+)\[(\d+)\]$/);
      if (m) {
        const arr = (acc as Record<string, unknown>)[m[1]];
        return Array.isArray(arr) ? arr[Number(m[2])] : undefined;
      }
      return (acc as Record<string, unknown>)[seg];
    }, obj);

  const mismatches: string[] = [];
  for (const [pathKey, want] of Object.entries(expected)) {
    const got = get(state, pathKey);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      mismatches.push(`${pathKey}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  return mismatches;
}

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

  // ─── Task 1504-1: Equivalence proof (projection ≡ file, event-store-first) ──
  //
  // The resolver became event-store-first in 1504-2; these pin the guarantees
  // that close out PR2 (#1504): a stale file never shadows newer events, the
  // CLI and MCP arms resolve identically, and the event fold reconstructs every
  // field-group the `.state.json` used to carry (so the file is fully
  // redundant and safe to stop writing).

  it('ResolveWorkflowState_StaleFileShadowsNewerEvents_PrefersProjection', async () => {
    const eventStoreDir = path.join(tempDir, 'events-stale');
    await fsPromises.mkdir(eventStoreDir, { recursive: true });
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();
    const streamId = 'stale-feature';

    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    await eventStore.append(streamId, { type: 'workflow.transition', data: { to: 'plan' } });

    // Stale file claims the OLD phase — must NOT shadow the newer event.
    const stateFile = path.join(tempDir, `${streamId}.state.json`);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ featureId: streamId, workflowType: 'feature', phase: 'ideate' }),
      'utf-8',
    );

    const result = await resolveWorkflowState({ stateFile, featureId: streamId, eventStore });

    expect('state' in result).toBe(true);
    if ('state' in result) {
      // Event-folded 'plan', NOT the stale file's 'ideate' — the #1504 fix.
      expect((result.state as Record<string, unknown>).phase).toBe('plan');
    }
  });

  it('ResolveWorkflowState_SameFeatureIdViaCliAndMcp_IdenticalState', async () => {
    // INV-2 facade parity: identical state for the same `featureId + eventStore`
    // whether or not a (divergent) stateFile is also supplied — no file-presence
    // divergence between the CLI arm (passes a path) and the MCP arm (omits it).
    const eventStoreDir = path.join(tempDir, 'events-parity');
    await fsPromises.mkdir(eventStoreDir, { recursive: true });
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();
    const streamId = 'parity-feature';

    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    await eventStore.append(streamId, { type: 'workflow.transition', data: { to: 'plan' } });

    // A divergent file on the "CLI" arm must not change the result.
    const stateFile = path.join(tempDir, `${streamId}.state.json`);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ featureId: streamId, workflowType: 'feature', phase: 'review' }),
      'utf-8',
    );

    const cliArm = await resolveWorkflowState({ stateFile, featureId: streamId, eventStore });
    const mcpArm = await resolveWorkflowState({ featureId: streamId, eventStore });

    expect('state' in cliArm && 'state' in mcpArm).toBe(true);
    if ('state' in cliArm && 'state' in mcpArm) {
      expect(cliArm.state).toEqual(mcpArm.state);
    }
  });

  it('ResolveWorkflowState_ProjectionFoldOverRealHistory_ReconstructsAllFileFields', async () => {
    // Equivalence proof (diffStates): over a realistic history the projection
    // fold reconstructs EVERY field-group the file carried — phase, artifacts,
    // tasks, and synthesis — losslessly, so the file is fully redundant.
    const eventStoreDir = path.join(tempDir, 'events-coverage');
    await fsPromises.mkdir(eventStoreDir, { recursive: true });
    const eventStore = new EventStore(eventStoreDir);
    await eventStore.initialize();
    const streamId = 'coverage-feature';

    await eventStore.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });
    await eventStore.append(streamId, { type: 'workflow.transition', data: { to: 'plan' } });
    await eventStore.append(streamId, {
      type: 'state.patched',
      data: {
        featureId: streamId,
        fields: ['artifacts', 'tasks', 'synthesis'],
        patch: {
          'artifacts.design': 'docs/designs/d.md',
          'artifacts.plan': 'docs/plans/p.md',
          tasks: [
            { id: 't1', title: 'Build', status: 'complete', branch: 'feat/t1' },
            { id: 't2', title: 'Test', status: 'pending' },
          ],
          'synthesis.prUrl': 'https://github.com/x/y/pull/1',
        },
      },
    });

    const result = await resolveWorkflowState({ featureId: streamId, eventStore });
    expect('state' in result).toBe(true);
    if (!('state' in result)) return;

    const mismatches = diffStates(result.state, {
      featureId: streamId,
      workflowType: 'feature',
      phase: 'plan',
      'artifacts.design': 'docs/designs/d.md',
      'artifacts.plan': 'docs/plans/p.md',
      'tasks[0].id': 't1',
      'tasks[0].status': 'complete',
      'tasks[1].id': 't2',
      'tasks[1].status': 'pending',
      'synthesis.prUrl': 'https://github.com/x/y/pull/1',
    });
    expect(mismatches, `field-coverage divergence: ${JSON.stringify(mismatches)}`).toEqual([]);
  });
});

describe('classifyStateFile', () => {
  it('ClassifyStateFile_NoPath_ReturnsAbsent', () => {
    expect(classifyStateFile(undefined)).toBe('absent');
  });

  it('ClassifyStateFile_NonExistentPath_ReturnsMissing', () => {
    expect(classifyStateFile(path.join(tempDir, 'nope.json'))).toBe('missing');
  });

  it('ClassifyStateFile_CorruptJson_ReturnsMalformed', () => {
    const f = path.join(tempDir, 'bad.json');
    fs.writeFileSync(f, '{ not valid json', 'utf-8');
    expect(classifyStateFile(f)).toBe('malformed');
  });

  it('ClassifyStateFile_ValidJson_ReturnsOk', () => {
    const f = path.join(tempDir, 'good.json');
    fs.writeFileSync(f, JSON.stringify({ phase: 'plan' }), 'utf-8');
    expect(classifyStateFile(f)).toBe('ok');
  });
});
