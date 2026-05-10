// ─── DR-4 hard-cut guard test (T5a.1) ──────────────────────────────────────
//
// Verifies that `workflow.set` is no longer routed through the deprecation
// rerouting handler. The v2.10 substrate flip (#1259) introduced
// `set({phase})` as a one-release rerouting surface that emitted a real
// `workflow.transition` event, surfaced `_meta.deprecation`, and emitted
// `hsm.deprecated_action_invoked` telemetry. v2.11 hard-cuts that surface:
// the action falls through to the default branch and returns a structured
// `UNKNOWN_ACTION` error pointing the agent at `transition`.
//
// Disposable test — deleted in REFACTOR once the GREEN deletion has shipped.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from './composite.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

let stateDir: string;
let ctx: DispatchContext;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr4-removal-'));
  ctx = {
    stateDir,
    eventStore: new EventStore(stateDir),
    enableTelemetry: false,
  };
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe('Workflow_SetActionReturnsUnknownActionError (T5a.1, DR-4)', () => {
  it('Workflow_SetAction_ReturnsUnknownActionWithValidActions', async () => {
    const result = await handleWorkflow(
      { action: 'set', featureId: 'test', phase: 'plan' },
      ctx,
    );

    // Hard-error contract.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');

    // Agent self-correction breadcrumb (INV-5a): the error envelope must
    // direct the caller at `transition` as the canonical replacement.
    const validActions = (result.error as { validActions?: unknown })
      ?.validActions;
    expect(Array.isArray(validActions)).toBe(true);
    expect(validActions as string[]).toContain('transition');

    // No deprecation envelope — the rerouting surface is gone.
    const meta = (result as { _meta?: Record<string, unknown> })._meta;
    expect(meta?.deprecation).toBeUndefined();
  });
});
