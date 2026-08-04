// ─── DR-4 (T-07): every consumer returns a typed degraded result ────────────
//
// ## Characterization — what these consumers did BEFORE this task
//
// T-06 made ONE durable degraded state publishable (`projection.degraded` on
// `meta/projection-health`, read back through `readProjectionDegradedState`).
// Nothing consumed it. Every read surface below folded through the SAME
// in-memory materializer LRU that CB-8 caught lying, and answered
// `success: true` with the stale payload:
//
//   - `exarchos_view`      → `success: true`, degradation only whispered on the
//                            ephemeral `_meta.projectionDegraded` courtesy key.
//   - `exarchos_workflow`  → `success: true` off `moduleViewMaterializer`;
//                            no freshness signal at all, not even `_meta`.
//   - `exarchos_orchestrate` readiness/reliability actions
//                          → `success: true` off `getOrCreateMaterializer`;
//                            no freshness signal at all.
//
// A caller could therefore dispatch agents, gate a phase, or report a workflow
// complete from a fold that provably did not cover the durable tail.
//
// ## The change
//
// One shared typed degraded result (`projections/degraded-result.ts`) is now
// returned by every one of those consumers when `readProjectionDegradedState`
// reports the stream degraded: `success: false` with the reserved
// `PROJECTION_DEGRADED` error code and the durable state attached as
// `error.projectionDegraded`. The stale payload is DROPPED, not annotated.
//
// ## Fault injection (no mocked readers anywhere in this file)
//
// Every test drives a REAL stale cursor: seed real events on a real
// `EventStore`, warm a REAL fold through the REAL view chokepoint, then rewind
// that fold's high-water mark via `materializer.loadState(...)`. The durable
// `projection.degraded` row is then produced by the production publish path
// (the view chokepoint) or by `publishProjectionFreshness` fed from the REAL
// live cursor/tail comparison — never by stubbing `readProjectionDegradedState`.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { EventStore } from '../event-store/store.js';
import { handleView } from '../views/composite.js';
import { handleWorkflow } from '../workflow/composite.js';
import { handleOrchestrate } from '../orchestrate/composite.js';
import { getOrCreateMaterializer } from '../views/tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import {
  assessStreamFreshness,
  publishProjectionFreshness,
  readProjectionDegradedState,
} from './freshness.js';

const STREAM = 'dr4-consumers-feature';

let stateDir: string;
let store: EventStore;
let ctx: DispatchContext;

beforeEach(async () => {
  stateDir = await mkdtemp(nodePath.join(tmpdir(), 'dr4-consumers-'));
  store = new EventStore(stateDir);
  await store.initialize();
  ctx = { stateDir, eventStore: store, enableTelemetry: false };
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

/** Seed a REAL workflow stream through the REAL init path, then real activity. */
async function seedWorkflow(): Promise<void> {
  const init = await handleWorkflow(
    { action: 'init', featureId: STREAM, workflowType: 'feature' },
    ctx,
  );
  expect(init.success, `seed init failed: ${JSON.stringify(init.error)}`).toBe(true);
  for (let i = 0; i < 3; i++) {
    await store.append(STREAM, { type: 'task.progressed', data: { i } });
  }
}

/**
 * The CB-8 fault, injected for real: warm a genuine fold through the genuine
 * view chokepoint, then rewind its high-water mark so the materialized cursor
 * provably stops short of the durable tail.
 */
async function injectStaleFold(cursor: number): Promise<void> {
  await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
  const materializer = getOrCreateMaterializer(stateDir);
  const cursors = materializer.getStreamCursors(STREAM);
  expect(cursors.length, 'fault injection needs a real materialized fold').toBeGreaterThan(0);
  for (const { viewName } of cursors) {
    const state = materializer.getState(STREAM, viewName);
    if (state) materializer.loadState(STREAM, viewName, state.view, cursor);
  }
}

/** Publish the durable row from the REAL live cursor/tail disagreement. */
async function publishLiveDegradation(): Promise<void> {
  const materializer = getOrCreateMaterializer(stateDir);
  const freshness = assessStreamFreshness(
    await store.tailSequence(STREAM),
    materializer.getStreamCursors(STREAM),
  );
  expect(freshness.degraded, 'fault injection must produce a real disagreement').toBe(true);
  await publishProjectionFreshness(store, STREAM, freshness);
  expect(await readProjectionDegradedState(store, STREAM)).toBeDefined();
}

function errorCode(result: ToolResult): string | undefined {
  return result.error?.code;
}

describe('CHARACTERIZATION — consumers served stale folds as success:true', () => {
  it('Characterize_ViewComposite_StaleFold_AnsweredSuccessTrue', async () => {
    await seedWorkflow();
    // `projection-ahead`: a re-fold cannot heal a cursor past the tail, so the
    // disagreement survives the read that observes it.
    await injectStaleFold(25);
    const result = await handleView({ action: 'workflow_status', workflowId: STREAM }, ctx);
    // OLD CONTRACT: the stale answer is served as a success; degradation is
    // whispered only on the ephemeral `_meta` courtesy key.
    expect(result.success).toBe(true);
    expect(errorCode(result)).toBeUndefined();
  });

  it('Characterize_WorkflowComposite_StaleFold_AnsweredSuccessTrue', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    const result = await handleWorkflow({ action: 'get', featureId: STREAM }, ctx);
    // OLD CONTRACT: a durable `projection.degraded` row stands for this stream
    // and the workflow read ignores it entirely — success, no signal at all.
    expect(result.success).toBe(true);
    expect(errorCode(result)).toBeUndefined();
  });

  it('Characterize_OrchestrateComposite_StaleFold_AnsweredSuccessTrue', async () => {
    await seedWorkflow();
    await injectStaleFold(1);
    await publishLiveDegradation();
    const result = await handleOrchestrate(
      { action: 'check_convergence', featureId: STREAM },
      ctx,
    );
    // OLD CONTRACT: same — a readiness/reliability verdict computed off a fold
    // that provably does not cover the tail, returned as an ordinary success.
    expect(result.success).toBe(true);
    expect(errorCode(result)).toBeUndefined();
  });
});
