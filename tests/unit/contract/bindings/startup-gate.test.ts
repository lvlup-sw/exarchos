import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

// Seed the pre-startup binding gate to FAIL. This proves the gate is wired into
// the real MCP bootstrap: `createMcpServer` must throw BEFORE it constructs the
// server / registers any tool — never deferring to a first tool call. Remove
// the `assertBindingsAtStartup()` call in `adapters/mcp.ts` and this goes red
// (the server would build successfully against a valid ctx).
const SEEDED = 'SEEDED_BINDING_GATE_FAILURE';
vi.mock('../../../../src/contract/bindings/verify-bindings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/contract/bindings/verify-bindings.js')>();
  return {
    ...actual,
    assertBindingsAtStartup: () => {
      throw new Error(SEEDED);
    },
  };
});

// State-store side effects are irrelevant to this test; keep them inert.
vi.mock('../../../../src/workflow/state-store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../src/workflow/state-store.js')>();
  return { ...original, configureStateStoreBackend: vi.fn() };
});

describe('MCP bootstrap — binding gate blocks startup, not first call (P03-04)', () => {
  let tmpDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'binding-gate-test-'));
    const eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
    ctx = { stateDir: tmpDir, eventStore, enableTelemetry: false };
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
    vi.restoreAllMocks();
  });

  it('CreateMcpServer_RefusesToStart_WhenBindingGateFails', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    // A fully valid ctx: the ONLY reason to throw is the seeded binding gate.
    expect(() => createMcpServer(ctx)).toThrow(SEEDED);
  });
});
