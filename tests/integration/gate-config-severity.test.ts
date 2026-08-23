// ─── Config severity at the gate dispatch boundary ───────────────────────────
//
// `.exarchos.yml` lets a project turn a gate off — `review.gates[name].enabled:
// false`, or disabling the dimension the gate sits in. The severity resolver has
// always answered `disabled` for those; nothing in production asked it. The
// adapter that acts on the answer had zero production callers, so a disabled
// gate still ran and still blocked.
//
// Two things have to hold once it IS wired, and each has cost a wedge before:
//   - the key the wiring asks with must be the key the config is written in
//     (CLASS — `mock-boundary` — not the dispatch ACTION `check_mock_boundary`);
//   - turning a gate off must not delete a downstream obligation's only proof.
//     `check_static_analysis` is the sole provable discharge of `task_complete`,
//     so "skip it and record nothing" refuses every task completion afterwards.
//
// These tests drive the REAL composite router and the REAL admission reader, so
// they fail if the adapter is unwired again, if the key spaces drift apart, or
// if a withdrawn gate goes back to leaving no durable trace.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mocked so "the gate did not run" is observable as "the probe was never
// called" rather than inferred from the carrier the gate returns.
const mockRunProbe = vi.fn();
vi.mock('../../src/verbs/gates/test-adequacy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/verbs/gates/test-adequacy.js')>();
  return { ...actual, runProbe: (...args: unknown[]) => mockRunProbe(...args) };
});

import { EventStore } from '../../src/events/store.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { handleOrchestrate } from '../../src/verbs/composite.js';
import { gateRunnerObservationSource } from '../../src/verbs/gates/gate-runner.js';
import { resolveConfigGateKey } from '../../src/verbs/gates/gate-utils.js';
import { BUILTIN_GATE_PROVIDER_REGISTRY } from '../../src/verbs/gates/gate-provider-registry.js';
import { handleTaskComplete, resetModuleEventStore } from '../../src/verbs/tasks/tools.js';
import { resetMaterializerCache } from '../../src/projections/views/tools.js';
import { DEFAULTS, type ResolvedProjectConfig } from '../../src/config/resolve.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';
import {
  runAsTrustedCaller,
  seedActivePhaseAttempt,
  withTrustedCaller,
} from '../../tools/test-helpers/trusted-context.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GATE_ACTION = 'check_test_adequacy';
const GATE_CLASS = 'test-adequacy';

/** A config that turns a gate off the way a project would. */
function configDisabling(gateKey: string): ResolvedProjectConfig {
  return {
    ...DEFAULTS,
    review: {
      ...DEFAULTS.review,
      gates: {
        ...DEFAULTS.review.gates,
        [gateKey]: { enabled: false, blocking: true, params: {} },
      },
    },
  };
}

function probePass() {
  return {
    passed: true,
    probedTests: ['src/calc.test.ts'],
    redObserved: true,
    restoredClean: true,
  };
}

describe('gate config severity', () => {
  const stateDirs: string[] = [];

  beforeEach(() => {
    resetModuleEventStore();
    resetMaterializerCache();
    mockRunProbe.mockReset();
    mockRunProbe.mockResolvedValue(probePass());
  });

  afterEach(() => {
    resetModuleEventStore();
    resetMaterializerCache();
    for (const dir of stateDirs.splice(0)) {
      try {
        rmrf(dir);
      } catch {
        /* best-effort */
      }
    }
  });

  async function makeCtx(
    projectConfig?: ResolvedProjectConfig,
  ): Promise<DispatchContext> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gate-severity-'));
    stateDirs.push(stateDir);
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    return withTrustedCaller({
      stateDir,
      eventStore,
      enableTelemetry: false,
      ...(projectConfig === undefined ? {} : { projectConfig }),
    } as DispatchContext);
  }

  /**
   * Dispatch a gate the way a real run does: inside the trusted scope, against
   * a workflow that has an active phase attempt for evidence to bind to.
   */
  async function dispatchGate(
    ctx: DispatchContext,
    featureId: string,
    action: string = GATE_ACTION,
    taskId = 'T-severity',
  ) {
    await seedActivePhaseAttempt(ctx.eventStore, featureId);
    return runAsTrustedCaller(ctx.stateDir, () =>
      // `baseBranch` is explicit because this suite's subject is the config
      // knob, not base-branch detection. Since the diff base stopped defaulting
      // to a literal, a repoRoot with no discoverable default branch makes the
      // gate report `diff-failed` before it ever reaches the probe — which
      // would make the assertions below pass for the wrong reason.
      handleOrchestrate(
        { action, featureId, taskId, repoRoot: '/fake/repo', baseBranch: 'main' },
        ctx,
      ),
    );
  }

  /** Durable rows the canonical runner owns for a gate class. */
  async function evidenceRows(
    ctx: DispatchContext,
    featureId: string,
    gateClass: string = GATE_CLASS,
  ) {
    const events = await ctx.eventStore.query(featureId);
    const source = gateRunnerObservationSource(gateClass);
    return events.filter(
      (e) => e.type === 'admission.evidence-recorded' && e.source === source,
    );
  }

  async function signalRows(ctx: DispatchContext, featureId: string) {
    const events = await ctx.eventStore.query(featureId, { type: 'gate.executed' });
    return events.map((e) => e.data as Record<string, unknown>);
  }

  it('DisabledGate_DoesNotRun', async () => {
    // The denominator first: with the shipped defaults the gate DOES run, so the
    // assertion below is about the config and not about a dispatch that never
    // reaches the handler for some unrelated reason.
    const enabled = await makeCtx();
    await dispatchGate(enabled, 'feat-enabled');
    expect(mockRunProbe).toHaveBeenCalledOnce();
    expect(await evidenceRows(enabled, 'feat-enabled')).toHaveLength(1);

    mockRunProbe.mockClear();

    const disabled = await makeCtx(configDisabling(GATE_CLASS));
    await dispatchGate(disabled, 'feat-disabled');

    expect(mockRunProbe).not.toHaveBeenCalled();
  });

  it('DisabledGate_RecordsTheWithdrawalDurably', async () => {
    // A withdrawn gate is not a silence. Recording nothing made "the project
    // turned this off" indistinguishable from "nobody ever called it" — and it
    // is the difference between the two that the admission below reads.
    const ctx = await makeCtx(configDisabling(GATE_CLASS));
    await dispatchGate(ctx, 'feat-trace');

    const evidence = await evidenceRows(ctx, 'feat-trace');
    expect(evidence).toHaveLength(1);
    const record = (evidence[0]?.data as { evidence: Record<string, unknown> }).evidence;
    expect(record.verdict).toBe('pass');
    expect((record.subject as { taskId?: string }).taskId).toBe('T-severity');

    // The signal row has to say WHY on its own. Read without the marker it is an
    // ordinary green for a gate that never ran.
    const signals = await signalRows(ctx, 'feat-trace');
    expect(signals).toHaveLength(1);
    const details = signals[0]?.details as Record<string, unknown>;
    expect(signals[0]?.gateName).toBe(GATE_CLASS);
    expect(signals[0]?.passed).toBe(true);
    expect(details.notApplicable).toBe(true);
    expect(details.reason).toContain('disabled by project config');
    expect(details.evidenceId).toBe(record.evidenceId);
  });

  it('DisabledGate_DoesNotBlock', async () => {
    const ctx = await makeCtx(configDisabling(GATE_CLASS));
    const result = await dispatchGate(ctx, 'feat-noblock');

    expect(result.success).toBe(true);
    const data = result.data as { notApplicable?: boolean; passed?: boolean; reason?: string };
    // `passed:false` is the field the orchestrator blocks on, so a withdrawn
    // gate must not carry it — and `notApplicable` is what keeps the `passed:
    // true` beside it from reading as a verdict the gate earned.
    expect(data.passed).toBe(true);
    expect(data.notApplicable).toBe(true);
    expect(data.reason).toContain('disabled by project config');
  });

  it('DisablingStaticAnalysis_DoesNotWedgeTaskCompletion', async () => {
    // The regression this whole seam exists to avoid. `task_complete` has ONE
    // blocking obligation and `check_static_analysis` is its only provable
    // discharge, so a disable knob that removes the gate without leaving proof
    // refuses every task completion from then on — forever, with no way back.
    const featureId = 'feat-wedge';
    const taskId = 'T-wedge';

    // Denominator: the same task, same store, with the gate simply never run.
    // Without this the assertion below could pass on a reader that admits
    // anything.
    const bare = await makeCtx();
    await seedActivePhaseAttempt(bare.eventStore, featureId);
    await bare.eventStore.append(featureId, {
      type: 'task.assigned',
      data: { taskId, title: 'Wedge subject', assignee: 'agent-1' },
    });
    const refused = await runAsTrustedCaller(bare.stateDir, () =>
      handleTaskComplete({ taskId, streamId: featureId }, bare.stateDir, bare.eventStore),
    );
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('GATE_NOT_PASSED');

    const ctx = await makeCtx(configDisabling('static-analysis'));
    await ctx.eventStore.append(featureId, {
      type: 'task.assigned',
      data: { taskId, title: 'Wedge subject', assignee: 'agent-1' },
    });
    await dispatchGate(ctx, featureId, 'check_static_analysis', taskId);

    const completed = await runAsTrustedCaller(ctx.stateDir, () =>
      handleTaskComplete({ taskId, streamId: featureId }, ctx.stateDir, ctx.eventStore),
    );
    expect(completed.error?.code).not.toBe('GATE_NOT_PASSED');
    expect(completed.success).toBe(true);
  });

  it('DisabledDimension_DoesNotRunTheGate', async () => {
    // The other documented knob. The gate names no explicit override here; the
    // dimension it is dispatched under is switched off.
    const ctx = await makeCtx({
      ...DEFAULTS,
      review: {
        ...DEFAULTS.review,
        dimensions: {
          ...DEFAULTS.review.dimensions,
          D1: { ...DEFAULTS.review.dimensions.D1, enabled: false },
        },
      },
    });
    const result = await dispatchGate(ctx, 'feat-dim');

    expect(mockRunProbe).not.toHaveBeenCalled();
    expect((result.data as { notApplicable?: boolean }).notApplicable).toBe(true);
  });

  it('DisableKnob_ReadsTheClassKeySpace_NotTheActionKeySpace', async () => {
    // The divergence that made the knob inert: `.exarchos.yml` and the shipped
    // defaults address a gate by CLASS, the dispatch table by ACTION, and asking
    // the resolver with the dispatch key reads a table nobody writes to.
    const byClass = await makeCtx(configDisabling(GATE_CLASS));
    await dispatchGate(byClass, 'feat-class');
    expect(mockRunProbe).not.toHaveBeenCalled();

    const byAction = await makeCtx(configDisabling(GATE_ACTION));
    await dispatchGate(byAction, 'feat-action');
    // One key space, and it is the documented one. A wiring that honoured BOTH
    // would paper over the divergence instead of closing it.
    expect(mockRunProbe).toHaveBeenCalledOnce();
  });

  it('ConfigKeySpace_MatchesTheDeclaredGateClasses', async () => {
    // The structural half. The behavioural test above covers one gate; this one
    // fails if ANY action's translation drifts, or if a shipped default is
    // rewritten into the action key space it would then be unreachable from.
    const providers = BUILTIN_GATE_PROVIDER_REGISTRY.list();
    expect(providers.length).toBeGreaterThanOrEqual(5);

    for (const provider of providers) {
      expect(resolveConfigGateKey(provider.actionName)).toBe(provider.gateClass);
      // Idempotent: a key already in the config space translates to itself, so a
      // caller cannot be punished for handing over the right key.
      expect(resolveConfigGateKey(provider.gateClass)).toBe(provider.gateClass);
    }

    const actionNames = new Set(providers.map((provider) => provider.actionName));
    const shippedDefaults = Object.keys(DEFAULTS.review.gates);
    expect(shippedDefaults.length).toBeGreaterThan(0);
    expect(shippedDefaults.filter((key) => actionNames.has(key))).toEqual([]);
  });

  it('SeverityAdapter_HasAtLeastOneProductionCaller', () => {
    // The anti-vacuity assertion. The behavioural tests above would also catch
    // an unwiring, but they would report it as "the probe ran" — this one names
    // the actual cause, and it catches a caller deleted from a gate the
    // behavioural tests do not dispatch.
    const sources = collectSources(path.join(REPO_ROOT, 'src'));

    // Denominator: a scan that walked nothing would satisfy every claim below.
    expect(sources.length).toBeGreaterThan(200);

    const declaringModule = path.join(REPO_ROOT, 'src/verbs/gates/gate-utils.ts');
    expect(sources).toContain(declaringModule);

    const callers = sources.filter(
      (file) =>
        file !== declaringModule && readFileSync(file, 'utf8').includes('withConfigSeverity('),
    );

    expect(
      callers.map((file) => path.relative(REPO_ROOT, file)),
      'withConfigSeverity has no production caller — the disabled severity is unreachable again',
    ).not.toEqual([]);
  });
});

/** Every `.ts` file under `root`, so the census cannot go stale with a glob. */
function collectSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.ts')) found.push(full);
    }
  };
  walk(root);
  return found;
}
