import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/**
 * The message of the seeded failure. The mock makes the pre-startup binding gate fail.
 * This proves that the gate is wired into the real MCP bootstrap.
 * `createMcpServer` must throw before it builds the server or registers a tool, not on the first tool call.
 * Without the `assertBindingsAtStartup()` call in `src/adapters/mcp/mcp.ts`, the server builds and this test fails.
 */
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

  /** The ctx is valid, so the only reason to throw is the seeded binding gate. */
  it('CreateMcpServer_RefusesToStart_WhenBindingGateFails', async () => {
    const { createMcpServer } = await import('../../../../src/adapters/mcp/mcp.js');
    expect(() => createMcpServer(ctx)).toThrow(SEEDED);
  });
});
