import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  infraSignatureFor,
  FrictionMonitor,
  evaluateFrictionRun,
  FRICTION_THRESHOLD,
  INFRA_SIGNATURES,
  type FailureObservation,
} from '../../../src/install/friction-signal.js';

// Real error text observed on this program run.
const NPM_SSL =
  'npm error code ERR_SSL_… request to https://registry.npmjs.org/vitest failed, ' +
  'reason: 40E7…: error:0A000410:SSL routines::sslv3 alert handshake failure';
const VITEST_WORKER_RPC =
  'Error: [vitest-worker]: Timeout calling "onTaskUpdate"\n' + '  Test Files  no failures';
const WORKTREE_ORPHAN =
  'setup_worktree: fatal: worktree .worktrees/P07-07 already exists on disk with no ' +
  'corresponding event (orphaned)';

describe('classifyFailure', () => {
  it('Classify_NpmRegistrySslHandshake_IsInfrastructure', () => {
    const v = classifyFailure({ operation: 'npm install', message: NPM_SSL });
    expect(v.class).toBe('infrastructure');
    expect(v.cause).toBe('npm-registry-unreachable');
  });

  it('Classify_VitestWorkerRpcTimeout_ZeroFailing_IsInfrastructure', () => {
    const v = classifyFailure({
      operation: 'vitest run',
      message: VITEST_WORKER_RPC,
      failingTests: 0,
    });
    expect(v.class).toBe('infrastructure');
    expect(v.cause).toBe('vitest-worker-rpc-timeout');
  });

  it('Classify_WorktreeOrphan_IsInfrastructure', () => {
    const v = classifyFailure({ operation: 'setup_worktree', message: WORKTREE_ORPHAN });
    expect(v.class).toBe('infrastructure');
    expect(v.cause).toBe('worktree-nonatomic');
  });

  // The load-bearing distinction: a GENUINE red test is never "infrastructure".
  it('Classify_GenuineTestFailure_IsTestFailure_NotInfrastructure', () => {
    const v = classifyFailure({
      operation: 'vitest run',
      message: 'AssertionError: expected 2 to be 3\n  ❯ src/x.test.ts:10:5',
      failingTests: 1,
    });
    expect(v.class).toBe('test-failure');
    expect(v.cause).toBe('');
  });

  it('Classify_PositiveFailingCount_DominatesInfraSignature', () => {
    // Even if the log happens to contain a worker-RPC line, a positive failing
    // count means a real red test dominates — do NOT call it infrastructure.
    const v = classifyFailure({
      operation: 'vitest run',
      message: VITEST_WORKER_RPC,
      failingTests: 3,
    });
    expect(v.class).toBe('test-failure');
  });

  it('Classify_UnrecognizedFailure_IsUnknown', () => {
    const v = classifyFailure({ operation: 'build', message: 'some novel error' });
    expect(v.class).toBe('unknown');
    expect(v.cause).toBe('');
  });

  it('EveryInfraSignature_IsResolvableByCause', () => {
    for (const s of INFRA_SIGNATURES) {
      expect(infraSignatureFor(s.cause)).toBe(s);
      expect(s.remedy.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('FrictionMonitor', () => {
  it('Friction_RepeatedInfraFailure_EmitsStopAndSimplify', () => {
    const m = new FrictionMonitor();
    const obs: FailureObservation = { operation: 'npm install', message: NPM_SSL };
    // Below threshold — no signal yet.
    for (let i = 1; i < FRICTION_THRESHOLD; i++) {
      expect(m.observe(obs)).toBeNull();
    }
    // The FRICTION_THRESHOLD-th consecutive same-cause infra failure fires.
    const sig = m.observe(obs);
    expect(sig).not.toBeNull();
    expect(sig?.kind).toBe('stop-and-simplify');
    expect(sig?.cause).toBe('npm-registry-unreachable');
    expect(sig?.occurrences).toBe(FRICTION_THRESHOLD);
    expect(sig?.recommendation).toMatch(/stop/i);
  });

  it('Friction_SingleGenuineTestFailure_DoesNotSignal', () => {
    const m = new FrictionMonitor();
    const sig = m.observe({
      operation: 'vitest run',
      message: 'AssertionError: expected true to be false',
      failingTests: 1,
    });
    expect(sig).toBeNull();
  });

  it('Friction_RepeatedGenuineTestFailures_NeverSignal', () => {
    // A red test that stays red is NOT a broken tool — no stop-and-simplify.
    const m = new FrictionMonitor();
    for (let i = 0; i < FRICTION_THRESHOLD + 2; i++) {
      expect(
        m.observe({ operation: 'vitest run', message: 'expect(x).toBe(y) failed', failingTests: 2 }),
      ).toBeNull();
    }
  });

  it('Friction_DifferentCauses_DoNotAccumulateIntoOneSignal', () => {
    // Same operation, alternating infra causes — each streak is tracked
    // separately, so neither reaches the threshold.
    const m = new FrictionMonitor();
    const npm: FailureObservation = { operation: 'ci step', message: NPM_SSL };
    const wt: FailureObservation = { operation: 'ci step', message: WORKTREE_ORPHAN };
    let emitted = false;
    for (let i = 0; i < FRICTION_THRESHOLD - 1; i++) {
      if (m.observe(npm)) emitted = true;
      if (m.observe(wt)) emitted = true;
    }
    expect(emitted).toBe(false);
    expect(m.streakFor('ci step', 'npm-registry-unreachable')).toBe(FRICTION_THRESHOLD - 1);
    expect(m.streakFor('ci step', 'worktree-nonatomic')).toBe(FRICTION_THRESHOLD - 1);
  });

  it('Friction_NonInfraOutcome_ResetsTheStreak', () => {
    const m = new FrictionMonitor();
    const npm: FailureObservation = { operation: 'npm install', message: NPM_SSL };
    m.observe(npm);
    m.observe(npm);
    // A genuine test failure (or success) for the operation clears the infra streak.
    m.observe({ operation: 'npm install', message: 'expect failed', failingTests: 1 });
    expect(m.streakFor('npm install', 'npm-registry-unreachable')).toBe(0);
    // Now it must take a fresh full run of infra failures to signal.
    for (let i = 1; i < FRICTION_THRESHOLD; i++) expect(m.observe(npm)).toBeNull();
    expect(m.observe(npm)).not.toBeNull();
  });

  it('Friction_RecordSuccess_ResetsTheStreak', () => {
    const m = new FrictionMonitor();
    const npm: FailureObservation = { operation: 'npm install', message: NPM_SSL };
    m.observe(npm);
    m.observe(npm);
    m.recordSuccess('npm install');
    expect(m.streakFor('npm install', 'npm-registry-unreachable')).toBe(0);
  });

  it('Friction_ContinuesEmitting_WithGrowingOccurrences', () => {
    const m = new FrictionMonitor();
    const npm: FailureObservation = { operation: 'npm install', message: NPM_SSL };
    let last = 0;
    for (let i = 0; i < FRICTION_THRESHOLD + 2; i++) {
      const sig = m.observe(npm);
      if (sig) last = sig.occurrences;
    }
    expect(last).toBe(FRICTION_THRESHOLD + 2);
  });
});

describe('evaluateFrictionRun', () => {
  it('Friction_BatchLog_EmitsExactlyTheInfraStopSignals', () => {
    const npm = { operation: 'npm install', message: NPM_SSL };
    const redTest = { operation: 'vitest run', message: 'expect failed', failingTests: 1 };
    const log: FailureObservation[] = [
      npm,
      npm,
      redTest, // a single genuine red test — no signal, unrelated operation
      npm, // 3rd npm → stop-and-simplify
    ];
    const signals = evaluateFrictionRun(log);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.operation).toBe('npm install');
    expect(signals[0]?.cause).toBe('npm-registry-unreachable');
    expect(signals[0]?.occurrences).toBe(FRICTION_THRESHOLD);
  });

  it('Friction_BatchLogOfOnlyRedTests_EmitsNothing', () => {
    const redTest = { operation: 'vitest run', message: 'boom', failingTests: 4 };
    expect(evaluateFrictionRun([redTest, redTest, redTest, redTest])).toEqual([]);
  });
});
