import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import {
  handleCheckpoint,
  handleInit,
  handleSet,
} from './tools.js';

// ─── Sidecar-Pending Ack (Issue #1082, Tier 3) ─────────────────────────────
//
// When the event store is in sidecar mode (the PID lock is held by a sibling
// process), auto-emitted events from workflow handlers land in the sidecar
// file and receive a provisional sequence of 0. Callers must be able to
// detect this degraded mode to decide whether to retry on the primary, alert,
// or tolerate eventual consistency. The `sidecarPending: true` ack on the
// ToolResult mirrors the `sequencePending` signal already returned by
// `exarchos_event append` (event-store/tools.ts:15).

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-sidecar-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeSidecarStore(dir: string): Promise<EventStore> {
  // Simulate another process holding the PID lock by writing our own PID —
  // `acquirePidLock` checks `isPidAlive(existingPid)` and only enters sidecar
  // mode when the lock holder is alive. `process.pid` is the one PID
  // guaranteed to be alive for the duration of the test; a fabricated
  // "sibling" offset could easily map to a non-existent PID, causing the
  // lock to be reclaimed as stale and the store to skip sidecar fallback.
  const lockPath = path.join(dir, '.event-store.lock');
  await fs.writeFile(lockPath, String(process.pid), 'utf-8');
  const store = new EventStore(dir);
  await store.initialize();
  return store;
}

describe('handleInit sidecar-pending ack', () => {
  it('handleInit_SidecarMode_ReturnsSidecarPending', async () => {
    const store = await makeSidecarStore(tmpDir);
    expect(store.inSidecarMode).toBe(true);

    const result = await handleInit(
      { featureId: 'wf-init-sidecar', workflowType: 'feature' },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBe(true);
  });

  it('handleInit_NormalMode_OmitsSidecarPending', async () => {
    const store = new EventStore(tmpDir);
    await store.initialize();
    expect(store.inSidecarMode).toBe(false);

    const result = await handleInit(
      { featureId: 'wf-init-normal', workflowType: 'feature' },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBeUndefined();
  });
});

describe('handleSet sidecar-pending ack', () => {
  it('handleSet_SidecarMode_PhaseTransitionReturnsSidecarPending', async () => {
    // Seed state in normal mode before the sibling "acquires" the lock.
    const seeder = new EventStore(tmpDir);
    const initResult = await handleInit(
      { featureId: 'wf-set-phase', workflowType: 'feature' },
      tmpDir,
      seeder,
    );
    expect(initResult.success).toBe(true);

    const sidecar = await makeSidecarStore(tmpDir);
    expect(sidecar.inSidecarMode).toBe(true);

    const result = await handleSet(
      {
        featureId: 'wf-set-phase',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
      sidecar,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
    expect(data.sidecarPending).toBe(true);
  });

  it('handleSet_SidecarMode_FieldUpdateReturnsSidecarPending', async () => {
    const seeder = new EventStore(tmpDir);
    await handleInit(
      { featureId: 'wf-set-field', workflowType: 'feature' },
      tmpDir,
      seeder,
    );

    const sidecar = await makeSidecarStore(tmpDir);

    // Field-only update (no phase transition) still emits a state.patched
    // event in sidecar mode, so the ack must surface sidecarPending.
    const result = await handleSet(
      {
        featureId: 'wf-set-field',
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      tmpDir,
      sidecar,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBe(true);
  });

  it('handleSet_NormalMode_OmitsSidecarPending', async () => {
    const store = new EventStore(tmpDir);
    const initResult = await handleInit(
      { featureId: 'wf-set-normal', workflowType: 'feature' },
      tmpDir,
      store,
    );
    expect(initResult.success).toBe(true);
    expect(store.inSidecarMode).toBe(false);

    const result = await handleSet(
      {
        featureId: 'wf-set-normal',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.phase).toBe('plan');
    expect(data.sidecarPending).toBeUndefined();
  });

  it('handleSet_SidecarMode_NoOpUpdateOmitsSidecarPending', async () => {
    // Ack-precision: in sidecar mode, a call that emits no event (empty
    // updates, no phase transition) must not return sidecarPending. The flag
    // signals "a write landed in the sidecar" — absent a write, it would be
    // a false alarm.
    const seeder = new EventStore(tmpDir);
    await handleInit(
      { featureId: 'wf-set-noop', workflowType: 'feature' },
      tmpDir,
      seeder,
    );

    const sidecar = await makeSidecarStore(tmpDir);
    expect(sidecar.inSidecarMode).toBe(true);

    const result = await handleSet(
      { featureId: 'wf-set-noop', updates: {} },
      tmpDir,
      sidecar,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBeUndefined();
  });

  it('handleSet_SidecarMode_V1WorkflowFieldUpdateOmitsSidecarPending', async () => {
    // v1 workflows (no _esVersion) skip the state.patched event path, so a
    // field-only update must not claim sidecarPending even when the store is
    // in sidecar mode — no event was actually written.
    const seeder = new EventStore(tmpDir);
    await handleInit(
      { featureId: 'wf-set-v1', workflowType: 'feature' },
      tmpDir,
      seeder,
    );
    // Downgrade to v1 by stripping _esVersion from the state file.
    const stateFile = path.join(tmpDir, 'wf-set-v1.state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    delete state._esVersion;
    await fs.writeFile(stateFile, JSON.stringify(state));

    const sidecar = await makeSidecarStore(tmpDir);
    expect(sidecar.inSidecarMode).toBe(true);

    const result = await handleSet(
      {
        featureId: 'wf-set-v1',
        updates: { 'artifacts.design': 'docs/design.md' },
      },
      tmpDir,
      sidecar,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBeUndefined();
  });

  it('handleSet_WithoutEventStore_OmitsSidecarPending', async () => {
    // When eventStore is null (test-mode or disabled), no events are emitted
    // and the sidecarPending signal is meaningless — must not be set.
    await handleInit(
      { featureId: 'wf-set-noeventstore', workflowType: 'feature' },
      tmpDir,
      null,
    );

    const result = await handleSet(
      {
        featureId: 'wf-set-noeventstore',
        updates: { 'artifacts.design': 'docs/design.md' },
        phase: 'plan',
      },
      tmpDir,
      null,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBeUndefined();
  });
});

describe('handleCheckpoint sidecar-pending ack', () => {
  it('handleCheckpoint_SidecarMode_ReturnsSidecarPending', async () => {
    const seeder = new EventStore(tmpDir);
    await handleInit(
      { featureId: 'wf-chk-sidecar', workflowType: 'feature' },
      tmpDir,
      seeder,
    );

    const sidecar = await makeSidecarStore(tmpDir);

    const result = await handleCheckpoint(
      { featureId: 'wf-chk-sidecar' },
      tmpDir,
      sidecar,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBe(true);
  });

  it('handleCheckpoint_NormalMode_OmitsSidecarPending', async () => {
    const store = new EventStore(tmpDir);
    await handleInit(
      { featureId: 'wf-chk-normal', workflowType: 'feature' },
      tmpDir,
      store,
    );

    const result = await handleCheckpoint(
      { featureId: 'wf-chk-normal' },
      tmpDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.sidecarPending).toBeUndefined();
  });
});
