// Tests for `resolveWorkflowState` and `classifyStateFile`.
// With `featureId` and an event store, the resolver folds the event stream.
// Otherwise it reads the state file. With neither source, it returns an error.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { classifyStateFile, resolveWorkflowState } from '../../../src/verbs/resolve-state.js';
import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Returns the dot paths where `state` differs from the `expected` values. A path can hold `arr[idx]` segments.
 * An empty array means that the projection rebuilds each asserted field.
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
  await rmrfAsync(tempDir);
});

describe('resolveWorkflowState', () => {
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

    expect('error' in result).toBe(false);

    expect('state' in result).toBe(true);
    if ('state' in result) {
      const state = result.state as Record<string, unknown>;
      expect(state.featureId).toBe('test-feature');
      expect(state.phase).toBe('plan');
      expect(state.workflowType).toBe('feature');
    }
  });

  it('ResolveWorkflowState_NoStateFile_NoFeatureId_ReturnsError', async () => {
    const result = await resolveWorkflowState({});

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.success).toBe(false);
      expect(result.error.error?.code).toBe('NO_STATE_SOURCE');
    }
  });

  /** With `featureId` and a store, a missing state file is not an error. */
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

    expect('error' in result).toBe(false);

    expect('state' in result).toBe(true);
    if ('state' in result) {
      const state = result.state as Record<string, unknown>;
      expect(state.featureId).toBe('fallback-feature');
      expect(state.phase).toBe('investigate');
      expect(state.workflowType).toBe('debug');
    }
  });

  /** A stale state file never shadows newer events. The phase comes from the event fold. */
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

    const stateFile = path.join(tempDir, `${streamId}.state.json`);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ featureId: streamId, workflowType: 'feature', phase: 'ideate' }),
      'utf-8',
    );

    const result = await resolveWorkflowState({ stateFile, featureId: streamId, eventStore });

    expect('state' in result).toBe(true);
    if ('state' in result) {
      expect((result.state as Record<string, unknown>).phase).toBe('plan');
    }
  });

  /** The CLI arm passes a divergent state file, and the MCP arm omits it. For the same `featureId` and store, both arms give the same state. */
  it('ResolveWorkflowState_SameFeatureIdViaCliAndMcp_IdenticalState', async () => {
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

  /** Over a realistic history, the event fold rebuilds the phase, artifacts, tasks, and synthesis fields of the state file. */
  it('ResolveWorkflowState_ProjectionFoldOverRealHistory_ReconstructsAllFileFields', async () => {
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
