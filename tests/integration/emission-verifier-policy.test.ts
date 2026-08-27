/**
 * The emission verifier as a policy, over a real event store.
 *
 * The unit tests pin the comparison. This file pins the two properties that
 * only exist at the level of a whole run: that a run which checked nothing
 * cannot report itself clean, and that a handler which skips a declared
 * emission actually reddens a suite rather than being absorbed as a warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

import { EventStore } from '../../src/events/store.js';
import {
  runEmissionVerifierInterceptor,
  summarizeEmissionRun,
  verifyDeclaredEmissions,
  emissionIndeterminacyBlocks,
  emissionViolationBlocks,
  type EmissionVerdict,
} from '../../src/dispatch/core/interceptors/emission-verifier.js';
import type { EventRegistration } from '../../src/events/event-registration.js';
import { COMPOSITE_HANDLERS, dispatch } from '../../src/dispatch/core/dispatch.js';
import { resolveConfig } from '../../src/config/resolve.js';
import type { DispatchContext } from '../../src/dispatch/core/types.js';
import type { ToolResult } from '../../src/types.js';
import { EmissionViolatedData } from '../../src/events/schemas.js';
import { contractEmissionsOf } from '../../src/registry.js';
import {
  EMISSION_PROBE_FEATURE_ID,
  declaredEmittingActions,
  emissionProbeCorpus,
  runEmissionProbe,
  type DispatchContextFactory,
} from '../../src/contract/oracle/fixtures.js';

const ANNOTATIONS: Readonly<Record<string, EventRegistration>> = Object.freeze({
  'workflow.started': {
    lifecycle: 'active',
    tier: 'substrate',
    rationale: 'transition-record',
  },
  'merge.rollback': {
    lifecycle: 'retired',
    tier: 'substrate',
    rationale: 'compensation-record',
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
    // contract, no stream, and an unreadable store. The first two are benign
    // exemptions and the third is an unread answer — different statuses, and
    // together still a run that checked nothing.
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

    for (const verdict of [noContract, noStream]) {
      expect(verdict.status).toBe('not-applicable');
    }
    expect(unreadable.status).toBe('indeterminate');
    expect(unreadable.cause).toBe('store-unavailable');

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

  it('EmissionVerifier_LifecycleOnlyViolation_PersistsEvidence', async () => {
    // The unconditional promise is kept, so the missing-events axis is empty.
    // The same action also carries a conditional edge onto a RETIRED event, and
    // that edge lands anyway — the lifecycle axis's own fault, independent of
    // whether anything is missing.
    await store.append('feature-lifecycle', {
      type: 'workflow.started',
      operationId: 'op-lifecycle',
      data: { featureId: 'feature-lifecycle', workflowType: 'feature' },
    });
    await store.append('feature-lifecycle', {
      type: 'merge.rollback',
      operationId: 'op-lifecycle',
      data: { reason: 'landed against a retired registration' },
    });

    const verdict = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-lifecycle',
      streamId: 'feature-lifecycle',
      declared: [
        { event: 'workflow.started', condition: 'always' },
        { event: 'merge.rollback', condition: 'conditional' },
      ],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('violated');
    expect(verdict.missingEvents).toEqual([]);
    expect(verdict.lifecycleViolations).toEqual([{ event: 'merge.rollback', lifecycle: 'retired' }]);

    // The finding outlived the run on the LIFECYCLE axis alone — this is the
    // subject of this test: before this change, a lifecycle-only violation
    // still failed the verdict but was carried by a log line, not a record.
    const recorded = await store.query('feature-lifecycle', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    const parsed = EmissionViolatedData.parse(violation?.data);
    expect(parsed.missingEvents).toEqual([]);
    expect(parsed.lifecycleViolations).toEqual([{ event: 'merge.rollback', lifecycle: 'retired' }]);
  });

  it('EmissionVerifier_CombinedViolation_PersistsBothAxes', async () => {
    // The unconditional promise is BROKEN this time (`workflow.started` never
    // lands) and the retired edge lands anyway — both axes fire on the same
    // operation, and both have to survive onto the one persisted record.
    await store.append('feature-combined', {
      type: 'merge.rollback',
      operationId: 'op-combined',
      data: { reason: 'landed against a retired registration' },
    });

    const verdict = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'init',
      operationId: 'op-combined',
      streamId: 'feature-combined',
      declared: [
        { event: 'workflow.started', condition: 'always' },
        { event: 'merge.rollback', condition: 'conditional' },
      ],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('violated');
    expect(verdict.missingEvents).toEqual(['workflow.started']);
    expect(verdict.lifecycleViolations).toEqual([{ event: 'merge.rollback', lifecycle: 'retired' }]);

    const recorded = await store.query('feature-combined', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    const parsed = EmissionViolatedData.parse(violation?.data);
    expect(parsed.missingEvents).toEqual(['workflow.started']);
    expect(parsed.lifecycleViolations).toEqual([{ event: 'merge.rollback', lifecycle: 'retired' }]);
  });

  it('EmissionViolatedData refuses a report with both axes empty', () => {
    // The refinement's kill probe. A report naming neither a missing event nor
    // a lifecycle violation is not evidence of anything — accepting `[]`/`[]`
    // would let a clean run and a violation share one durable shape.
    expect(() =>
      EmissionViolatedData.parse({
        action: 'exarchos_workflow.init',
        missingEvents: [],
        lifecycleViolations: [],
        operationId: 'op-empty',
      }),
    ).toThrow(/at least one axis/);

    // Either axis alone is sufficient — the refinement is an OR, not an AND.
    expect(() =>
      EmissionViolatedData.parse({
        action: 'exarchos_workflow.init',
        missingEvents: ['workflow.started'],
        operationId: 'op-missing-only',
      }),
    ).not.toThrow();
    expect(() =>
      EmissionViolatedData.parse({
        action: 'exarchos_workflow.init',
        missingEvents: [],
        lifecycleViolations: [{ event: 'merge.rollback', lifecycle: 'retired' }],
        operationId: 'op-lifecycle-only',
      }),
    ).not.toThrow();
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

  /**
   * A handler that DOES keep its promise. `append` picks the operationId up
   * from the ambient dispatch scope, so both post-dispatch axes can find the
   * row — which is what makes an unread store distinguishable from a real miss.
   */
  const keepingHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const featureId = typeof args.featureId === 'string' ? args.featureId : '';
    await store.append(featureId, {
      type: 'workflow.cleanup',
      data: { from: 'synthesizing', to: 'completed', trigger: 'test', featureId },
    });
    return { success: true, data: { performed: 'the-side-effect' } };
  };

  /**
   * Break exactly the emission verifier's read — a stream query filtered by
   * operationId and nothing else. The ensures observer filters by type as well,
   * so it still reaches the real store: what is under test is one axis going
   * unanswered, not the store disappearing.
   */
  const breakVerifierRead = (): void => {
    const real = store.query.bind(store);
    vi.spyOn(store, 'query').mockImplementation(async (streamId, filters) => {
      if (filters?.operationId !== undefined && filters.type === undefined) {
        throw new Error('synthetic store failure');
      }
      return real(streamId, filters);
    });
  };

  const dispatchCleanup = async (
    featureId: string,
    projectConfig?: DispatchContext['projectConfig'],
    handler: (args: Record<string, unknown>) => Promise<ToolResult> = silentHandler,
  ): Promise<ToolResult> => {
    const had = TOOL in COMPOSITE_HANDLERS;
    const prev = COMPOSITE_HANDLERS[TOOL];
    COMPOSITE_HANDLERS[TOOL] = handler;
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

  it('EmissionVerifier_AdvisoryViolation_ReturnsPayloadAndPersistsEvidence', async () => {
    // Advisory does not add a warning for a VIOLATED verdict — that surface is
    // reserved for `indeterminate` (see the branch above `result` is reused
    // unchanged). What advisory still owes is the handler's own payload back
    // to the caller, and the finding durable on the stream either way.
    const result = await dispatchCleanup(
      'advisory-violation-payload',
      resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ performed: 'the-side-effect' });

    // The finding outlived the run: the missing event is on the stream, not
    // only in a log line the advisory run chose not to fail on.
    const recorded = await store.query('advisory-violation-payload', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    const parsed = EmissionViolatedData.parse(violation?.data);
    expect(parsed.missingEvents).toEqual(['workflow.cleanup']);
  });

  it('EmissionVerifier_StoreUnavailable_IsIndeterminateAndCannotPromote', async () => {
    // Control: the handler keeps its promise and the dispatch promotes. Without
    // this the case below would be satisfied by a dispatch that refuses this
    // action under every condition.
    const kept = await dispatchCleanup('indeterminate-control', undefined, keepingHandler);
    expect(kept.success).toBe(true);

    // Same handler, same promise kept — only the verifier's read fails. The
    // contract is now UNASSESSED, which is a different thing from having no
    // contract, and block mode will not promote on it. Before the split this
    // resolved `not-applicable` and promoted: a store that failed on every call
    // disabled enforcement outright while every verdict read benign.
    breakVerifierRead();
    const result = await dispatchCleanup('indeterminate-block', undefined, keepingHandler);

    expect(result.success).toBe(false);
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('EMISSION_VERIFICATION_INDETERMINATE');
    // Not the violation code: nothing was found missing, because nothing was read.
    expect(error.code).not.toBe('EMISSION_CONTRACT_VIOLATED');
    expect(error.message).toContain('could not be verified');
    // Same disposition as the violation envelope — the effects are performed.
    expect(error.message).toMatch(/do NOT retry/i);
    expect(result.data).toEqual({ performed: 'the-side-effect' });
  });

  it('EmissionVerifier_StoreUnavailable_AdvisoryModeSurfacesWithoutBlocking', async () => {
    // `block` and `advisory` remain the only two answers, and they are config,
    // not environment. Advisory reports the unassessed contract on the envelope
    // the caller already reads rather than swallowing it.
    breakVerifierRead();
    const result = await dispatchCleanup(
      'indeterminate-advisory',
      resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
      keepingHandler,
    );

    expect(result.success).toBe(true);
    expect((result.warnings ?? []).join(' ')).toContain('could not be verified');
    expect((result.warnings ?? []).join(' ')).toContain('workflow.cleanup');
  });

  it('EmissionVerifier_NoContract_RemainsBenignNotApplicable', async () => {
    // An action with no unconditional edge never reads the store, so a store
    // that would refuse cannot turn its benign exemption into an unassessed
    // one. The ordering is the whole claim: contract first, read second.
    const querySpy = vi.spyOn(store, 'query');
    const verdict = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'reconcile',
      operationId: 'op-no-contract',
      streamId: 'feature-no-contract',
      declared: [],
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('no-unconditional-contract');
    expect(verdict.cause).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
    expect(emissionIndeterminacyBlocks(verdict, undefined)).toBe(false);
    expect(emissionViolationBlocks(verdict, undefined)).toBe(false);
  });

  it('EmissionVerifier_HandlerRefusal_RemainsBenignNotApplicable', async () => {
    // A handler that refused the work owes no record of having done it, and it
    // is decided BEFORE any read — so a business failure can never arrive
    // wearing the infrastructure name.
    const querySpy = vi
      .spyOn(store, 'query')
      .mockRejectedValue(new Error('synthetic store failure'));
    const verdict = await runEmissionVerifierInterceptor(store, {
      tool: 'exarchos_workflow',
      action: 'cleanup',
      operationId: 'op-refused',
      streamId: 'feature-refused',
      declared: [{ event: 'workflow.started', condition: 'always' }],
      handlerSucceeded: false,
      annotations: ANNOTATIONS,
    });

    expect(verdict.status).toBe('not-applicable');
    expect(verdict.reason).toBe('handler-refused');
    expect(verdict.cause).toBeUndefined();
    expect(querySpy).not.toHaveBeenCalled();
    expect(emissionIndeterminacyBlocks(verdict, undefined)).toBe(false);
    querySpy.mockRestore();

    // And through the real dispatch: the caller reads the handler's own
    // failure, not an emission verdict laid over it.
    breakVerifierRead();
    const refusing = async (): Promise<ToolResult> => ({
      success: false,
      error: { code: 'MERGE_NOT_VERIFIED', message: 'the handler refused the work' },
    });
    const result = await dispatchCleanup('refusal-block', undefined, refusing);
    expect(result.success).toBe(false);
    expect((result.error as Record<string, unknown>).code).toBe('MERGE_NOT_VERIFIED');
  });
});

// ─── The safe corpus, beyond workflow.init/cleanup ─────────────────────────
//
// The cases above dispatch two actions by hand. This one widens the exercised
// surface to the whole safe-emission corpus the oracle already maintains
// (`emissionProbeCorpus()` in `src/contract/oracle/fixtures.ts`) — real
// registered actions, dispatched through their real implementation binding
// into a private, per-probe state directory, never leaving it. Reusing that
// membership means a newly-admitted safe emitter widens this coverage without
// this file having to re-derive which actions are safe to dispatch locally.
describe('emission verifier over the safe corpus', () => {
  it('EmissionVerifier_SafeCorpus_HasNonZeroDeterminateCoverage', async () => {
    const makeContext: DispatchContextFactory = (dir) => ({
      stateDir: dir,
      eventStore: new EventStore(dir),
      enableTelemetry: false,
    });
    const corpus = emissionProbeCorpus();
    expect(corpus.probes.length).toBeGreaterThan(0);
    const byId = new Map(declaredEmittingActions().map((entry) => [entry.actionId, entry.action]));

    const verdicts: EmissionVerdict[] = [];
    for (const probe of corpus.probes) {
      const action = byId.get(probe.actionId);
      if (action === undefined) continue;
      const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emission-safe-corpus-'));
      try {
        const run = await runEmissionProbe(probe, probeDir, makeContext);
        // The same comparison `runEmissionVerifierInterceptor` makes, fed the
        // exact appended set the store confirmed durable for THIS probe (the
        // observer already excludes the setup dispatches' own appends).
        verdicts.push(
          verifyDeclaredEmissions({
            declared: contractEmissionsOf(action),
            streamId: EMISSION_PROBE_FEATURE_ID,
            landed: run.appended,
          }),
        );
      } finally {
        await rmrfAsync(probeDir);
      }
    }

    const summary = summarizeEmissionRun(verdicts);
    // The denominator rides along with the assertion: "0 violated" only means
    // something next to how many were actually determinate.
    expect(
      summary.determinate,
      `${summary.total} probed, ${summary.determinate} determinate, ${summary.indeterminate} indeterminate`,
    ).toBeGreaterThan(0);
    expect(summary.total).toBe(corpus.probes.length);
  }, 300_000);
});
