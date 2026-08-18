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

import { EventStore } from '../../src/events/store.js';
import {
  runEmissionVerifierInterceptor,
  summarizeEmissionRun,
  emissionViolationBlocks,
  type EmissionVerdict,
} from '../../src/dispatch/core/interceptors/emission-verifier.js';
import type { EventRegistration } from '../../src/events/event-registration.js';

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
  await fs.rm(stateDir, { recursive: true, force: true });
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
