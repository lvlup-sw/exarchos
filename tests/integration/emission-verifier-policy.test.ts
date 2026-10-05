/**
 * The emission verifier as a policy, over a real event store.
 *
 * The unit tests pin the comparison. This file pins two properties of a whole run.
 * A run that checked nothing cannot report itself clean.
 * A skipped declared emission fails the run. It is not only a warning.
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

/**
 * The store holds a live SQLite connection in this temp directory. `close()` must run before the
 * removal, or the handle stays open and Windows refuses the removal.
 */
afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('emission verifier policy', () => {
  /**
   * The verifier can assess none of the three dispatches. They have no unconditional contract, no
   * stream, and an unreadable store. The first two are `not-applicable` and the third is
   * `indeterminate`. With zero determinate verdicts, the run is not clean although it has zero
   * violations. The summary counts the two statuses apart, so a store outage does not look like an
   * ordinary skip.
   */
  it('EmissionVerifier_AllIndeterminateRun_FailsRatherThanReportingClean', async () => {
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

    expect(summary.total).toBe(3);
    expect(summary.violated).toBe(0);
    expect(summary.determinate).toBe(0);
    expect(summary.clean).toBe(false);

    expect(summary.notApplicable).toBe(2);
    expect(summary.indeterminate).toBe(1);
  });

  /**
   * The action declares `workflow.started` unconditionally and nothing appends it. No dispatch
   * fails, so the verifier must find the miss. The default mode, which a run with no project config
   * gets, blocks on the verdict. The finding is a record on the stream, not only a log line.
   * The contrast case keeps the same declaration, and is determinate and clean. `operationId` is on
   * the event, not on the append options, because the verifier queries by it.
   */
  it('EmissionPolicy_SeededSkippedEmission_FailsTheSuite', async () => {
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

    expect(emissionViolationBlocks(skipped, undefined)).toBe(true);

    const recorded = await store.query('feature-b', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    expect((violation?.data as { missingEvents: string[] }).missingEvents).toEqual([
      'workflow.started',
    ]);

    const summary = summarizeEmissionRun([skipped]);
    expect(summary.determinate).toBe(1);
    expect(summary.violated).toBe(1);
    expect(summary.clean).toBe(false);

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

  /**
   * The unconditional event lands, so the missing-events axis is empty. The action also declares a
   * conditional edge to a retired event, and that event lands. The lifecycle axis alone makes the
   * verdict `violated`, and the verifier must persist that finding as a record on the stream.
   */
  it('EmissionVerifier_LifecycleOnlyViolation_PersistsEvidence', async () => {
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

    const recorded = await store.query('feature-lifecycle', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    const parsed = EmissionViolatedData.parse(violation?.data);
    expect(parsed.missingEvents).toEqual([]);
    expect(parsed.lifecycleViolations).toEqual([{ event: 'merge.rollback', lifecycle: 'retired' }]);
  });

  /**
   * `workflow.started` never lands and the retired event lands. Both axes fire on one operation,
   * and the one persisted record must hold both.
   */
  it('EmissionVerifier_CombinedViolation_PersistsBothAxes', async () => {
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

  /**
   * A report that names no missing event and no lifecycle violation is not evidence. A schema that
   * accepts it lets a clean run and a violation share one durable shape. Either axis alone is
   * sufficient.
   */
  it('EmissionViolatedData refuses a report with both axes empty', () => {
    expect(() =>
      EmissionViolatedData.parse({
        action: 'exarchos_workflow.init',
        missingEvents: [],
        lifecycleViolations: [],
        operationId: 'op-empty',
      }),
    ).toThrow(/at least one axis/);

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
      notApplicable: 1,
      indeterminate: 0,
      clean: false,
    });
  });
});

/**
 * These cases run the real `dispatch()` and assert on its return value, which is what a caller
 * sees. The enforcement mode must change the outcome, not only the log level.
 * `dispatchCleanup` writes the handler directly into `COMPOSITE_HANDLERS`, because the verifier
 * skips a handler that `stubCompositeHandler` installs. `cleanup` declares `workflow.cleanup` with
 * `condition: 'always'`. `silentHandler` succeeds and does not append it. `keepingHandler` appends
 * it, and `append` takes the operationId from the ambient dispatch scope.
 *
 * `breakVerifierRead` fails only a stream query that filters by operationId and not by type, which
 * is the verifier read. The ensures observer also filters by type, so it still reaches the store.
 */
describe('emission enforcement reaches the dispatch result', () => {
  const TOOL = 'exarchos_workflow';
  const silentHandler = async (): Promise<ToolResult> => ({
    success: true,
    data: { performed: 'the-side-effect' },
  });

  const keepingHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const featureId = typeof args.featureId === 'string' ? args.featureId : '';
    await store.append(featureId, {
      type: 'workflow.cleanup',
      data: { from: 'synthesizing', to: 'completed', trigger: 'test', featureId },
    });
    return { success: true, data: { performed: 'the-side-effect' } };
  };

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

  /**
   * The dispatch reaches this branch only after the handler reported success, so the effects are
   * already performed. A bare failure envelope invites a retry that repeats a mutation. The message
   * must tell the caller not to retry, and `data` must hold what the handler returned.
   */
  it('EmissionEnforcement_BlockMode_UndeliveredEmissionFailsTheDispatch', async () => {
    const result = await dispatchCleanup('enforce-block');

    expect(result.success).toBe(false);
    expect((result.error as Record<string, unknown>).code).toBe('EMISSION_CONTRACT_VIOLATED');
    expect((result.error as Record<string, unknown>).message).toContain('workflow.cleanup');

    expect((result.error as Record<string, unknown>).message).toMatch(/do NOT retry/i);
    expect(result.data).toEqual({ performed: 'the-side-effect' });
  });

  /**
   * This case is the counterpart of the block case. Without it, a dispatch that rejects every
   * violation in every mode satisfies the block case.
   */
  it('EmissionEnforcement_AdvisoryMode_SameViolationReturnsTheHandlerResult', async () => {
    const result = await dispatchCleanup(
      'enforce-advisory',
      resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
    );

    expect(result.success).toBe(true);
  });

  /**
   * Advisory mode adds no warning for a `violated` verdict, because `warnings` is for
   * `indeterminate` verdicts. The caller still gets the handler payload, and the finding is durable
   * on the stream.
   */
  it('EmissionVerifier_AdvisoryViolation_ReturnsPayloadAndPersistsEvidence', async () => {
    const result = await dispatchCleanup(
      'advisory-violation-payload',
      resolveConfig({ events: { 'emission-enforcement': 'advisory' } }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ performed: 'the-side-effect' });

    const recorded = await store.query('advisory-violation-payload', {});
    const violation = recorded.find((event) => event.type === 'emission.violated');
    expect(violation).toBeDefined();
    const parsed = EmissionViolatedData.parse(violation?.data);
    expect(parsed.missingEvents).toEqual(['workflow.cleanup']);
  });

  /**
   * The control dispatch keeps its promise and succeeds. Without the control, a dispatch that
   * refuses this action in every condition satisfies the case. Then the same handler runs and only
   * the verifier read fails. The contract is unassessed, which is not the same as no contract, and
   * block mode refuses it. The code is not the violation code, because the verifier read nothing.
   * The message tells the caller not to retry, because the effects are performed.
   */
  it('EmissionVerifier_StoreUnavailable_IsIndeterminateAndCannotPromote', async () => {
    const kept = await dispatchCleanup('indeterminate-control', undefined, keepingHandler);
    expect(kept.success).toBe(true);

    breakVerifierRead();
    const result = await dispatchCleanup('indeterminate-block', undefined, keepingHandler);

    expect(result.success).toBe(false);
    const error = result.error as Record<string, unknown>;
    expect(error.code).toBe('EMISSION_VERIFICATION_INDETERMINATE');
    expect(error.code).not.toBe('EMISSION_CONTRACT_VIOLATED');
    expect(error.message).toContain('could not be verified');
    expect(error.message).toMatch(/do NOT retry/i);
    expect(result.data).toEqual({ performed: 'the-side-effect' });
  });

  /**
   * The mode comes from config, not from the environment. Advisory mode reports the unassessed
   * contract in `warnings` and does not block.
   */
  it('EmissionVerifier_StoreUnavailable_AdvisoryModeSurfacesWithoutBlocking', async () => {
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

  /**
   * An action with no unconditional edge never reads the store. The verifier checks the contract
   * before the read, so a failing store cannot turn the benign exemption into an unassessed one.
   */
  it('EmissionVerifier_NoContract_RemainsBenignNotApplicable', async () => {
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

  /**
   * A handler that refused the work owes no record of the work. The verifier decides this before
   * any read, so a business failure never gets an infrastructure cause. Through the real dispatch,
   * the caller reads the failure of the handler, not an emission verdict.
   */
  it('EmissionVerifier_HandlerRefusal_RemainsBenignNotApplicable', async () => {
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

/**
 * This case dispatches the whole safe-emission corpus that the oracle maintains
 * (`emissionProbeCorpus()`). Each probe runs a real registered action through its real
 * implementation binding, in a private state directory. A new safe emitter in the corpus widens
 * this coverage with no change to this file.
 */
describe('emission verifier over the safe corpus', () => {
  /**
   * `verifyDeclaredEmissions` is the comparison that `runEmissionVerifierInterceptor` makes. Its
   * input is the set of appends that the store confirmed durable for the probe, without the setup
   * appends. The assertion message carries the denominator, because "0 violated" has meaning only
   * next to the determinate count.
   */
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
    expect(
      summary.determinate,
      `${summary.total} probed, ${summary.determinate} determinate, ${summary.indeterminate} indeterminate`,
    ).toBeGreaterThan(0);
    expect(summary.total).toBe(corpus.probes.length);
  }, 300_000);
});
