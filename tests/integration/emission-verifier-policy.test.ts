/**
 * The emission verifier as a policy, over a real event store.
 *
 * The unit tests pin the comparison. This file pins the two properties that
 * only exist at the level of a whole run: that a run which checked nothing
 * cannot report itself clean, and that a handler which skips a declared
 * emission actually reddens a suite rather than being absorbed as a warning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

import { EventStore } from '../../src/events/store.js';
import {
  runEmissionVerifierInterceptor,
  summarizeEmissionRun,
  emissionViolationBlocks,
  type EmissionVerdict,
} from '../../src/dispatch/core/interceptors/emission-verifier.js';
import type { EventRegistration } from '../../src/events/event-registration.js';
import { COMPOSITE_HANDLERS, dispatch } from '../../src/dispatch/core/dispatch.js';
import { resolveConfig } from '../../src/config/resolve.js';
import type { DispatchContext } from '../../src/dispatch/core/types.js';
import type { ToolResult } from '../../src/types.js';

const ANNOTATIONS: Readonly<Record<string, EventRegistration>> = Object.freeze({
  'workflow.started': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
} as Readonly<Record<string, EventRegistration>>);

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emission-policy-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  // The store holds a live SQLite connection rooted in this temp directory,
  // and `close()` is the documented precondition for removing it. Without the
  // close the handle survives the test and Windows refuses the removal.
  store.close();
  await rmrfAsync(stateDir);
});

describe('emission verifier policy', () => {
  it('EmissionVerifier_AllIndeterminateRun_FailsRatherThanReportingClean', async () => {
    // Three dispatches, none of which could be assessed: no unconditional
    // contract, no stream, and an unreadable store. Every one is a legitimate
    // `not-applicable` — and together they are a run that checked nothing.
    const noContract = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'get',
      operationId: 'op-1',
      streamId: 'feature-a',
      declared: [{ event: 'workflow.started', condition: 'conditional' }],
      annotations: ANNOTATIONS,
    });

    const noStream = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-2',
      streamId: undefined,
      declared: [{ event: 'workflow.started', condition: 'always' }],
      annotations: ANNOTATIONS,
    });

    const brokenStore = {
      query: () => Promise.reject(new Error('store unavailable')),
      append: () => Promise.reject(new Error('store unavailable')),
    } as unknown as EventStore;
    const unreadable = await runEmissionVerifierInterceptor(brokenStore, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-3',
      streamId: 'feature-a',
      declared: [{ event: 'workflow.started', condition: 'always' }],
      annotations: ANNOTATIONS,
    });

    for (const verdict of [noContract, noStream, unreadable]) {
      expect(verdict.status).toBe('not-applicable');
    }

    const summary = summarizeEmissionRun([noContract, noStream, unreadable]);

    // Three verdicts, zero violations — and NOT clean. This is the whole
    // tooth: without the determinate count, this run is indistinguishable
    // from a run that checked three contracts and found them all kept.
    expect(summary.total).toBe(3);
    expect(summary.violated).toBe(0);
    expect(summary.determinate).toBe(0);
    expect(summary.indeterminate).toBe(3);
    expect(summary.clean).toBe(false);
  });

  it('EmissionPolicy_SeededSkippedEmission_FailsTheSuite', async () => {
    // A handler that declares `workflow.started` unconditionally and then does
    // not append it. Nothing about the dispatch fails — it is the verifier's
    // job to notice, and the suite's job to go red when it does.
    const skipped = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-skip',
      streamId: 'feature-b',
      declared: [{ event: 'workflow.started', condition: 'always' }],
      annotations: ANNOTATIONS,
    });

    expect(skipped.status).toBe('violated');
    expect(skipped.missingEvents).toEqual(['workflow.started']);

    // Under the default mode — which is what a run with no project config
    // gets — this blocks. An advisory project still records it.
    expect(emissionViolationBlocks(skipped, undefined)).toBe(true);

    // The finding outlived the run: it is on the stream, not only in a log.
    const recorded = await store.query('feature-b', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    expect((violation?.data as { missingEvents: string[] }).missingEvents).toEqual([
      'workflow.started',
    ]);

    // And the run summary refuses to call this clean.
    const summary = summarizeEmissionRun([skipped]);
    expect(summary.determinate).toBe(1);
    expect(summary.violated).toBe(1);
    expect(summary.clean).toBe(false);

    // The contrast case: the same declaration, kept. Determinate AND clean.
    // `operationId` rides on the EVENT, not the append options — it is the
    // join key the verifier queries by.
    await store.append('feature-c', {
      type: 'workflow.started',
      operationId: 'op-kept',
      data: { featureId: 'feature-c', workflowType: 'feature' },
    });

    const kept = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-kept',
      streamId: 'feature-c',
      declared: [{ event: 'workflow.started', condition: 'always' }],
      annotations: ANNOTATIONS,
    });

    expect(kept.status).toBe('ok');
    const keptSummary = summarizeEmissionRun([kept]);
    expect(keptSummary.determinate).toBe(1);
    expect(keptSummary.clean).toBe(true);
  });

  it('a mixed run reports the determinate count it actually earned', () => {
    const verdicts: EmissionVerdict[] = [
      { status: 'ok', missingEvents: [], lifecycleViolations: [], required: ['a'] },
      { status: 'ok', missingEvents: [], lifecycleViolations: [], required: ['b'] },
      { status: 'violated', missingEvents: ['c'], lifecycleViolations: [], required: ['c'] },
      { status: 'not-applicable', reason: 'no-stream', missingEvents: [], lifecycleViolations: [], required: ['d'] },
    ];

    const summary = summarizeEmissionRun(verdicts);
    expect(summary).toEqual({
      total: 4,
      determinate: 3,
      ok: 2,
      violated: 1,
      indeterminate: 1,
      clean: false,
    });
  });
});

// ─── The mode reaches the OUTCOME, not only the log level ───────────────────
//
// `events.emission-enforcement` was resolved, documented and defaulted to
// `block`, and `emissionViolationBlocks` computed the decision — but nothing in
// `dispatch()` consulted it, so its only observable effect was whether the
// finding was logged at `error` or `warn`. Every caller of these two functions
// was a test, which is the shape that makes a control look enforced while it
// enforces nothing.
//
// These cases run the real `dispatch()` and assert on its RETURN VALUE, which
// is the surface a caller sees. The handler is installed straight into
// `COMPOSITE_HANDLERS` rather than through `stubCompositeHandler`, because a
// declared stub is now exempt by design: what is under test is a REGISTERED
// handler that completed without keeping its own unconditional promise.
describe('emission enforcement reaches the dispatch result', () => {
  const TOOL = 'exarchos_workflow';
  // `cleanup` declares `workflow.cleanup` with `condition: 'always'`.
  const silentHandler = async (): Promise<ToolResult> => ({
    success: true,
    data: { performed: 'the-side-effect' },
  });

  const dispatchCleanup = async (
    featureId: string,
    projectConfig?: DispatchContext['projectConfig'],
  ): Promise<ToolResult> => {
    const had = TOOL in COMPOSITE_HANDLERS;
    const prev = COMPOSITE_HANDLERS[TOOL];
    COMPOSITE_HANDLERS[TOOL] = silentHandler;
    try {
      return await dispatch(
        TOOL,
        { action: 'cleanup', featureId, mergeVerified: true },
        {
          stateDir,
          eventStore: store,
          enableTelemetry: false,
          ...(projectConfig !== undefined ? { projectConfig } : {}),
        } as DispatchContext,
      );
    } finally {
      if (had) COMPOSITE_HANDLERS[TOOL] = prev as typeof silentHandler;
      else delete COMPOSITE_HANDLERS[TOOL];
    }
  };

  it('EmissionEnforcement_BlockMode_UndeliveredEmissionFailsTheDispatch', async () => {
    const result = await dispatchCleanup('enforce-block');

    expect(result.success).toBe(false);
    expect((result.error as Record<string, unknown>).code).toBe('EMISSION_CONTRACT_VIOLATED');
    expect((result.error as Record<string, unknown>).message).toContain('workflow.cleanup');

    // This branch is reachable ONLY when the handler completed and reported
    // success, so the effects are already performed. Half the actions behind
    // this dispatch are non-idempotent, and a bare failure envelope reads as
    // "your call did nothing" — which would invite a retry that repeats a
    // mutation. The envelope therefore has to say so, and has to hand back what
    // the operation produced rather than discarding it with the result.
    expect((result.error as Record<string, unknown>).message).toMatch(/do NOT retry/i);
    expect(result.data).toEqual({ performed: 'the-side-effect' });
  });

  it('EmissionEnforcement_AdvisoryMode_SameViolationReturnsTheHandlerResult', async () => {
    // The other half. If this also failed, the first case would be satisfied by
    // a dispatch that rejects every violation regardless of configuration —
    // which is not the contract the key documents, and would leave an operator
    // no way back to the recorded-but-not-fatal behavior.
    const result = await dispatchCleanup(
      'enforce-advisory',
      resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
    );

    expect(result.success).toBe(true);
  });
});
