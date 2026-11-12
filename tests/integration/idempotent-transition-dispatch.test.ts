/**
 * A transition to the current phase, through the real dispatcher with the shipped defaults.
 *
 * The context comes from `initializeContext` over a SQLite backend, with telemetry on and no project
 * config. So the emission check and the ensures check both run, and each blocks on a miss. The
 * handler replies `idempotent: true` and appends no row. That reply owes no `always` emission and no
 * `success` ensure. A real move still owes its row, and it passes both checks because the row lands.
 *
 * @oracle-sources: ../../src/dispatch/core/interceptors/emission-verifier.ts, the stream rows of the dispatched call
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../src/format.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
import { configureCutoverAutoExport } from '../../src/workflow/admission/cutover-auto-export.js';
import { configureCleanupSnapshotStore } from '../../src/workflow/cleanup.js';
import { configureStateStoreBackend } from '../../src/workflow/state-store.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const FEATURE_ID = 'idempotent-transition-dispatch';

/** The plan artifact that admits the move from `plan` to `plan-review`. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

let context: DispatchContext;

beforeEach(async () => {
  const stateDir = makeTempDir('idempotent-transition-dispatch-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const base = await initializeContext(stateDir, { backend });
  releases.push(() => base.eventStore.close());
  context = {
    ...base,
    enableTelemetry: true,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'idempotent-transition-dispatch' }),
  };
});

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
  configureCleanupSnapshotStore(null);
  configureCutoverAutoExport(undefined);
});

/** Dispatches one action of `exarchos_workflow` on the feature of the case. */
async function workflow(action: string, fields: Readonly<Record<string, unknown>> = {}): Promise<ToolResult> {
  return dispatch('exarchos_workflow', { action, featureId: FEATURE_ID, ...fields }, context);
}

/** The rows of one type on the stream of the feature. */
async function rowsOf(type: string): Promise<readonly { readonly type: string; readonly data?: unknown }[]> {
  return context.eventStore.query(FEATURE_ID, { type });
}

/** The value of one field of the reply data, or undefined when the data is not an object. */
function dataField(result: ToolResult, field: string): unknown {
  const data: unknown = result.data;
  if (typeof data !== 'object' || data === null) return undefined;
  return Reflect.get(data, field);
}

describe('A transition to the current phase through dispatch', () => {
  /**
   * The handler appends no row and replies `idempotent: true`. The emission check gives
   * `not-applicable`, and the ensures check owes no `success` ensure. So the reply stays a success.
   */
  it('Dispatch_TransitionToTheCurrentPhase_SucceedsIdempotently', async () => {
    const started = await workflow('init', { workflowType: 'feature' });
    expect(started.success, JSON.stringify(started.error)).toBe(true);
    expect(dataField(started, 'phase')).toBe('plan');

    const result = await workflow('transition', { target: 'plan' });

    expect(result.error?.code).toBeUndefined();
    expect(result.success).toBe(true);
    expect(dataField(result, 'idempotent')).toBe(true);
    expect(dataField(result, 'phase')).toBe('plan');
    expect(await rowsOf('workflow.transition')).toHaveLength(0);
    expect(await rowsOf('emission.violated')).toHaveLength(0);
  });

  /**
   * A real move appends its `workflow.transition` row on the operation and replies with no
   * `idempotent` field. Both checks find the row, so the move succeeds and records no finding.
   */
  it('Dispatch_AMoveThatAppendsItsRow_StillPassesBothChecks', async () => {
    const started = await workflow('init', { workflowType: 'feature' });
    expect(started.success, JSON.stringify(started.error)).toBe(true);
    const planned = await workflow('update', { updates: { 'artifacts.plan': PLAN_ARTIFACT } });
    expect(planned.success, JSON.stringify(planned.error)).toBe(true);

    const result = await workflow('transition', { target: 'plan-review' });

    expect(result.error?.code).toBeUndefined();
    expect(result.success).toBe(true);
    expect(dataField(result, 'idempotent')).toBeUndefined();
    expect(dataField(result, 'phase')).toBe('plan-review');
    const transitions = await rowsOf('workflow.transition');
    expect(transitions).toHaveLength(1);
    expect(Reflect.get(Object(transitions[0]?.data), 'to')).toBe('plan-review');
    expect(await rowsOf('emission.violated')).toHaveLength(0);
  });
});
