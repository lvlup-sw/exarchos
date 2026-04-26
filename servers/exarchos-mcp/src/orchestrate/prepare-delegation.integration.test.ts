// Regression harness for #1145: verifies preflight.* events actually
// persist to a real EventStore, not just that a mock's .append was called.
//
// The v2.8.1 fix for #1129 added store.append() call sites for preflight
// events. The existing unit tests assert on mockStore.append.mock.calls,
// which only proves the handler *invoked* the append. Live MCP testing
// revealed events are being silently dropped — this harness exercises the
// real store through the production code path and queries it after the
// handler returns.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handleOrchestrate } from './composite.js';
import {
  getOrCreateEventStore,
  resetMaterializerCache,
} from '../views/tools.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

vi.mock('./dispatch-guard.js', () => ({
  validateBranchAncestry: vi.fn().mockResolvedValue({ passed: true, checks: ['ancestry'] }),
  assertMainWorktree: vi.fn().mockReturnValue({
    isMain: true,
    actual: '/fake/repo',
    expected: 'main worktree (no .claude/worktrees/ in path)',
  }),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  assertCurrentBranchNotProtected: vi.fn().mockReturnValue({
    blocked: true,
    reason: 'current-branch-protected',
    currentBranch: 'main',
  }),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-deleg-integ-'));
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function flushAsyncQueue(ms = 50): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(queueMicrotask);
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('handlePrepareDelegation — event persistence (integration)', () => {
  it('persists preflight.blocked to the injected EventStore when branch is protected', async () => {
    const args = { featureId: 'test-integration-stream' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue();

    expect(result.success).toBe(true);
    const data = result.data as {
      blocked: boolean;
      reason: string;
      currentBranch: string;
    };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');
    expect(data.currentBranch).toBe('main');

    const events = await ctxStore.query('test-integration-stream', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
    const eventData = events[0]?.data as {
      reason: string;
      details: { currentBranch: string };
    };
    expect(eventData.reason).toBe('current-branch-protected');
    expect(eventData.details.currentBranch).toBe('main');
  });

  // The constructor-injection refactor (#1182) requires every reader to
  // share the same EventStore instance the handler used. A "freshReader"
  // EventStore at the same stateDir must still see events on disk, but
  // sequence-counter coherence is only guaranteed when the same instance
  // is used for both writes and reads — that is enforced by single-
  // composition-root wiring at the MCP server level. This test verifies
  // the on-disk events are present (write-side persistence).
  it('event persists to disk and is readable by a second EventStore instance', async () => {
    const args = { featureId: 'test-cross-instance' };
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handlePrepareDelegation(args, tmpDir, ctx);
    await flushAsyncQueue(200);

    const freshReader = new EventStore(tmpDir);
    const events = await freshReader.query('test-cross-instance', {
      type: 'preflight.blocked',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('preflight.blocked');
  });

  // Reproduces the EXACT production MCP call path: handleOrchestrate
  // dispatched with a DispatchContext whose ctx.eventStore is a distinct
  // instance from the factory-cached store the handler uses internally.
  // This is the drift that caused #1129's partial regression to escape.
  it('preflight.blocked persists when dispatched via handleOrchestrate with DispatchContext', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    const result = await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-composite-stream' },
      ctx,
    );
    await flushAsyncQueue(200);

    expect(result.success).toBe(true);
    const data = result.data as { blocked: boolean; reason: string };
    expect(data.blocked).toBe(true);
    expect(data.reason).toBe('current-branch-protected');

    const events = await ctxStore.query('test-composite-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });

  // Race reproduction: a caller that queries IMMEDIATELY after the dispatch
  // response returns (no flush, no sleep) — exactly what a downstream MCP
  // client does. The event must be visible the moment the dispatch returns,
  // not "eventually." This is the failure mode that surfaced in the v2.8.1
  // dogfood re-verify: the handler returned blocked, the caller queried,
  // the stream was empty. Fire-and-forget appends are not synchronous with
  // the dispatch response, so any "read your writes" MCP caller races.
  it('preflight.blocked is visible the moment handleOrchestrate returns (no flush)', async () => {
    const ctxStore = new EventStore(tmpDir);
    const ctx: DispatchContext = {
      stateDir: tmpDir,
      eventStore: ctxStore,
      enableTelemetry: false,
    };

    await handleOrchestrate(
      { action: 'prepare_delegation', featureId: 'test-race-stream' },
      ctx,
    );

    // Intentionally no flush — mirrors a subsequent MCP call from the
    // same client reading its own writes.
    const events = await ctxStore.query('test-race-stream', {
      type: 'preflight.blocked',
    });
    expect(events).toHaveLength(1);
  });
});
