/**
 * Governance tier: the evidence provenance chain.
 * It covers who can produce governance evidence, what the record binds to, and how the frozen coordinate survives.
 *
 * Each test drives the real `dispatch()` against the production composition root.
 * Each test owns the lifecycle of its harness, because `initializeContext` binds process-level globals of the state store.
 * Two live harnesses conflict.
 *
 * Each criterion has a BLOCKING ARM and its NEGATIVE TWIN:
 * - The governed cannot supply governance. Evidence production needs a trusted caller, and the signal comes from the persisted record.
 * - The frozen `riskTier` reaches the gate.
 * - The frozen resolution is monotonic.
 *
 * No case here covers the degraded-projection marker. A read that can prove its own coverage does not refuse on a durable marker.
 * `tests/unit/projections/fold-at-tail.test.ts` asserts that behavior at the seam.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import {
  createPublicRootHarness,
  assertNoStubbedCompositeHandlers,
  type HarnessOptions,
  type PublicRootHarness,
  type DispatchObservation,
} from '../_harness.js';
import {
  deriveLocalOperatorIdentity,
  deriveMcpCallerIdentity,
} from '../../../../src/dispatch/caller-identity.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

type Rec = Record<string, unknown>;

const scratchDirs: string[] = [];
let gitFixture: string;

function data(obs: DispatchObservation): Rec {
  return (obs.result?.data ?? {}) as Rec;
}

/**
 * Creates a harness, runs `body`, and disposes the harness.
 * Only one harness can be live, because `initializeContext` rebinds the module-level backend of the state store.
 */
async function withHarness<T>(
  options: HarnessOptions,
  body: (harness: PublicRootHarness) => Promise<T>,
): Promise<T> {
  const harness = await createPublicRootHarness(options);
  try {
    return await body(harness);
  } finally {
    await harness.dispose();
  }
}

/** Makes a real git repository. Its feature branch adds production code and no tests. */
async function makeGitFixture(): Promise<string> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gov-t2-git-')));
  scratchDirs.push(repo);
  const git = async (args: readonly string[]): Promise<void> => {
    await execFileAsync('git', [...args], { cwd: repo });
  };
  await git(['init', '--quiet']);
  await git(['config', 'user.email', 'gov-t2@example.invalid']);
  await git(['config', 'user.name', 'Governance T2']);
  await git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'gov-t2-git-fixture', version: '1.0.0', private: true }, null, 2),
    'utf-8',
  );
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'chore: baseline']);
  await git(['branch', '-M', 'main']);
  await git(['checkout', '--quiet', '-b', 'feat/no-tests']);
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf-8');
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'feat: add widget with no tests']);
  return repo;
}

beforeAll(async () => {
  gitFixture = await makeGitFixture();
}, 120_000);

afterAll(async () => {
  for (const dir of scratchDirs) {
    await rmrfAsync(dir).catch(() => undefined);
  }
});

describe('T2 governance — evidence provenance (DR-2, DR-3, DR-4, DR-10)', () => {
  /**
   * Evidence production needs a trusted caller. An anonymous caller cannot mint evidence for itself.
   * BLOCKING ARM: without a caller identity, the call gets `TRUSTED_CALLER_REQUIRED`, and the stream gains no evidence row and no `gate.executed`.
   * NEGATIVE TWIN: the identical call with an identified caller appends the evidence row.
   */
  it('Governance_Dr2_EvidenceProduction_RequiresTrustedCaller', async () => {
    const featureId = 'gov-t2-untrusted';
    const request = {
      featureId,
      taskId: 'T-untrusted',
      repoRoot: gitFixture,
      branch: 'feat/no-tests',
      baseBranch: 'main',
      riskTier: 'high' as const,
      boundaryTouching: true,
    };

    await withHarness({}, async (h) => {
      expect(h.ctx.callerIdentity).toBeUndefined();
      await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });

      const refused = await h.runAction('exarchos_orchestrate', 'check_test_adequacy', request, {
        timeoutMs: 180_000,
      });
      expect(refused.result?.success).toBe(false);
      expect(refused.errorCode).toBe('TRUSTED_CALLER_REQUIRED');
      expect(String(refused.result?.error?.message)).toContain(
        'requires trusted dispatch caller identity',
      );

      const types = (await h.events(featureId)).map((e) => e.type);
      expect(types).not.toContain('admission.evidence-recorded');
      expect(types).not.toContain('gate.executed');
    });

    await withHarness(
      { overrides: { callerIdentity: deriveMcpCallerIdentity({ sessionId: 'gov-t2-session' }) } },
      async (h) => {
        await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });

        const produced = await h.runAction(
          'exarchos_orchestrate',
          'check_test_adequacy',
          request,
          { timeoutMs: 180_000 },
        );
        expect(produced.errorCode).toBeUndefined();
        expect(produced.result?.success).toBe(true);

        const types = (await h.events(featureId)).map((e) => e.type);
        expect(types).toContain('admission.evidence-recorded');
      },
    );
  }, 300_000);

  /**
   * The signal that `task_complete` reads comes from the persisted evidence record, so proof and signal cannot disagree.
   * The test asserts a three-way identity of the evidence id: the handler payload, the `admission.evidence-recorded` row, and `gate.executed.details`.
   * The record names the producer, and the gate runner is the source of the signal.
   *
   * BLOCKING ARM: a `fail` verdict mints a signal with `passed: false`.
   * NEGATIVE TWIN: a policy-skipped run on the same chain returns `passed: true` in the payload, but mints an `indeterminate` signal with `passed: false`.
   * The payload does not block, because policy excludes the gate at this tier. The signal is not proof.
   * Thus a gate that did not run is distinguishable from a gate that passed.
   * In both arms, `signal.passed` equals `persisted.verdict === 'pass'`.
   */
  it('Governance_Dr2_GateSignal_MintedFromPersistedEvidenceRecord', async () => {
    const featureId = 'gov-t2-provenance';
    await withHarness(
      { overrides: { callerIdentity: deriveLocalOperatorIdentity('gov-t2-provenance') } },
      async (h) => {
        await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });

        const run = await h.runAction(
          'exarchos_orchestrate',
          'check_test_adequacy',
          {
            featureId,
            taskId: 'T-prov',
            repoRoot: gitFixture,
            branch: 'feat/no-tests',
            baseBranch: 'main',
            riskTier: 'high',
            boundaryTouching: true,
          },
          { timeoutMs: 180_000 },
        );
        expect(run.result?.success).toBe(true);

        const refs = data(run).evidenceReferences as readonly Rec[] | undefined;
        expect(refs?.length).toBeGreaterThan(0);
        const claimedId = String(refs?.[0]?.evidenceId);
        expect(claimedId).toMatch(/^evidence:/);

        const events = await h.events(featureId);
        const recorded = events.filter((e) => e.type === 'admission.evidence-recorded');
        expect(recorded).toHaveLength(1);
        const persisted = (recorded[0]?.data as Rec).evidence as Rec;
        expect(persisted.evidenceId).toBe(claimedId);
        expect((persisted.subject as Rec).taskId).toBe('T-prov');
        expect(String((persisted.producer as Rec).providerRef)).toBe('check_test_adequacy');

        const signals = events.filter((e) => e.type === 'gate.executed');
        expect(signals).toHaveLength(1);
        const signal = signals[0]?.data as Rec;
        const details = signal.details as Rec;
        expect(details.evidenceId).toBe(claimedId);
        expect(String(signals[0]?.source)).toMatch(/^gate-runner\/v1\//);
        expect(details.taskId).toBe('T-prov');

        expect(details.verdict).toBe('fail');
        expect(signal.passed).toBe(false);
        expect(data(run).passed).toBe(false);
        expect(signal.passed).toBe(persisted.verdict === 'pass');

        const skipped = await h.runAction(
          'exarchos_orchestrate',
          'check_test_adequacy',
          {
            featureId,
            taskId: 'T-prov-low',
            repoRoot: gitFixture,
            branch: 'feat/no-tests',
            baseBranch: 'main',
            riskTier: 'low',
            boundaryTouching: false,
          },
          { timeoutMs: 180_000 },
        );
        expect(data(skipped).passed).toBe(true);
        expect(data(skipped).skipped).toBe(true);

        const twinSignals = (await h.events(featureId))
          .filter((e) => e.type === 'gate.executed')
          .map((e) => e.data as Rec)
          .filter((d) => (d.details as Rec).taskId === 'T-prov-low');
        expect(twinSignals).toHaveLength(1);
        const twinDetails = twinSignals[0]?.details as Rec;
        expect(twinSignals[0]?.passed).toBe(false);
        expect(twinDetails.verdict).toBe('indeterminate');
        expect(twinDetails.skipped).toBe(true);
        expect(typeof twinDetails.discriminant).toBe('string');

        const twinRecord = (await h.events(featureId))
          .filter((e) => e.type === 'admission.evidence-recorded')
          .map((e) => (e.data as Rec).evidence as Rec)
          .find((ev) => (ev.subject as Rec).taskId === 'T-prov-low');
        expect(twinRecord?.verdict).toBe('indeterminate');
        expect(twinSignals[0]?.passed).toBe(twinRecord?.verdict === 'pass');
      },
    );
  }, 300_000);

  /**
   * The frozen `riskTier` reaches the gate and changes its decision.
   * BLOCKING ARM: at `riskTier: 'high'`, a diff with no new tests gets `disposition: 'blocked'` and a report that names the tier.
   * NEGATIVE TWIN: at `riskTier: 'low'`, the identical diff is a policy skip, and the reason echoes the tier and `boundaryTouching`.
   * If the tier does not reach the gate, both arms return the same verdict.
   *
   * Both task runbooks declare the coordinate as template variables and bind it into the params of a step.
   * The test also applies the predicate to a step list with no coordinate, so a predicate that always reports no gap fails.
   */
  it('Governance_Dr3_FrozenRiskTier_ReachesTheGate', async () => {
    const featureId = 'gov-t2-risk-tier';
    await withHarness(
      { overrides: { callerIdentity: deriveLocalOperatorIdentity('gov-t2-tier') } },
      async (h) => {
        await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });
        const base = {
          featureId,
          repoRoot: gitFixture,
          branch: 'feat/no-tests',
          baseBranch: 'main',
        };

        const high = await h.runAction(
          'exarchos_orchestrate',
          'check_test_adequacy',
          { ...base, taskId: 'T-high', riskTier: 'high', boundaryTouching: true },
          { timeoutMs: 180_000 },
        );
        expect(high.result?.success).toBe(true);
        expect(data(high).passed).toBe(false);
        expect(data(high).disposition).toBe('blocked');
        expect(data(high).discriminant).toBe('no-new-tests');
        expect(String(data(high).report)).toContain('the high tier requires a kill probe');
        expect(data(high).skipped).toBeFalsy();

        const low = await h.runAction(
          'exarchos_orchestrate',
          'check_test_adequacy',
          { ...base, taskId: 'T-low', riskTier: 'low', boundaryTouching: true },
          { timeoutMs: 180_000 },
        );
        expect(low.result?.success).toBe(true);
        expect(data(low).passed).toBe(true);
        expect(data(low).skipped).toBe(true);
        expect(data(low).discriminant).toBe('skipped-by-policy');
        expect(String(data(low).reason)).toContain("riskTier='low'");
        expect(String(data(low).reason)).toContain('boundaryTouching=true');

        expect(data(high).passed).not.toBe(data(low).passed);

        interface Step {
          readonly action?: string;
          readonly params?: Record<string, unknown>;
        }
        const COORD = ['riskTier', 'boundaryTouching'] as const;
        const missingCoordinate = (
          templateVars: readonly string[],
          steps: readonly Step[],
        ): readonly string[] => {
          const gaps: string[] = [];
          for (const key of COORD) {
            if (!templateVars.includes(key)) gaps.push(`templateVar:${key}`);
            const bound = steps.some((s) => s.params?.[key] === `<${key}>`);
            if (!bound) gaps.push(`param:${key}`);
          }
          return gaps;
        };

        for (const id of ['task-completion', 'task-fix']) {
          const runbook = await h.runAction('exarchos_orchestrate', 'runbook', { id });
          expect(runbook.result?.success).toBe(true);
          const templateVars = (data(runbook).templateVars ?? []) as readonly string[];
          const steps = (data(runbook).steps ?? []) as readonly Step[];
          expect(steps.length).toBeGreaterThan(0);
          expect(missingCoordinate(templateVars, steps)).toEqual([]);
        }

        expect(missingCoordinate([], [{ action: 'check_test_adequacy', params: {} }])).toEqual([
          'templateVar:riskTier',
          'param:riskTier',
          'templateVar:boundaryTouching',
          'param:boundaryTouching',
        ]);
      },
    );
  }, 300_000);

  /**
   * The frozen resolution is monotonic: a re-entry of a phase can raise the coordinate but never weaken it.
   * `runCycle` enters `plan-review` with the state at `first`, goes back to `plan`, sets the state to `second`, and enters `plan-review` again.
   * The state does change to `second`, so only the freeze refuses a weaker coordinate.
   *
   * BLOCKING ARM: when the state goes from `high` to `low`, each `phase.entered` still records `high`, and the last keeps the gate set of the first.
   * NEGATIVE TWIN: when the state goes from `low` to `high`, the last `phase.entered` records `high`.
   * Thus the `high` of the first arm is a decision, not a constant.
   *
   * An absent coordinate fails safe: the frozen `riskTier` is `unknown`, not `low`, and `boundaryTouching` is true.
   */
  it('Governance_Dr10_FrozenResolution_IsMonotonic', async () => {
    await withHarness({}, async (h) => {
      interface Frozen {
        readonly phase: unknown;
        readonly riskTier: unknown;
        readonly gates: readonly unknown[];
      }
      const frozenEntries = async (featureId: string): Promise<readonly Frozen[]> =>
        (await h.events(featureId))
          .filter((e) => e.type === 'phase.entered')
          .map((e) => {
            const d = e.data as Rec;
            return {
              phase: d.phase,
              riskTier: d.riskTier,
              gates: ((d.resolvedGates ?? []) as readonly Rec[]).map((g) => g.gate),
            };
          });

      const runCycle = async (
        featureId: string,
        first: { riskTier: string; boundaryTouching: boolean },
        second: { riskTier: string; boundaryTouching: boolean },
      ): Promise<readonly Frozen[]> => {
        await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });
        await h.runAction('exarchos_workflow', 'update', {
          featureId,
          updates: { ...first, artifacts: { plan: 'docs/specs/monotonic.md' } },
        });
        const enter = await h.runAction('exarchos_workflow', 'transition', {
          featureId,
          target: 'plan-review',
        });
        expect(enter.result?.success).toBe(true);

        await h.runAction('exarchos_workflow', 'update', {
          featureId,
          updates: { planReview: { gapsFound: true } },
        });
        const revise = await h.runAction('exarchos_workflow', 'transition', {
          featureId,
          target: 'plan',
        });
        expect(revise.result?.success).toBe(true);

        const changed = await h.runAction('exarchos_workflow', 'update', {
          featureId,
          updates: { ...second },
        });
        expect(changed.result?.success).toBe(true);
        const readBack = await h.runAction('exarchos_workflow', 'get', { featureId });
        expect(data(readBack).riskTier).toBe(second.riskTier);

        const reEnter = await h.runAction('exarchos_workflow', 'transition', {
          featureId,
          target: 'plan-review',
        });
        expect(reEnter.result?.success).toBe(true);
        return frozenEntries(featureId);
      };

      const weakened = await runCycle(
        'gov-t2-monotonic-weaken',
        { riskTier: 'high', boundaryTouching: true },
        { riskTier: 'low', boundaryTouching: false },
      );
      expect(weakened).toHaveLength(3);
      expect(weakened.map((f) => f.riskTier)).toEqual(['high', 'high', 'high']);
      expect(weakened[2]?.gates).toEqual(weakened[0]?.gates);
      expect((weakened[0]?.gates ?? []).length).toBeGreaterThan(0);

      const raised = await runCycle(
        'gov-t2-monotonic-raise',
        { riskTier: 'low', boundaryTouching: false },
        { riskTier: 'high', boundaryTouching: true },
      );
      expect(raised).toHaveLength(3);
      expect(raised.map((f) => f.riskTier)).toEqual(['low', 'low', 'high']);

      const unknownId = 'gov-t2-unknown-tier';
      await h.runAction('exarchos_workflow', 'init', {
        featureId: unknownId,
        workflowType: 'feature',
      });
      const stateRead = await h.runAction('exarchos_workflow', 'get', { featureId: unknownId });
      expect(data(stateRead).riskTier ?? null).toBeNull();
      await h.runAction('exarchos_workflow', 'update', {
        featureId: unknownId,
        updates: { artifacts: { plan: 'docs/specs/unknown.md' } },
      });
      await h.runAction('exarchos_workflow', 'transition', {
        featureId: unknownId,
        target: 'plan-review',
      });
      const frozen = await frozenEntries(unknownId);
      expect(frozen).toHaveLength(1);
      expect(frozen[0]?.riskTier).toBe('unknown');
      expect(frozen[0]?.riskTier).not.toBe('low');
      const boundary = (await h.events(unknownId))
        .filter((e) => e.type === 'phase.entered')
        .map((e) => (e.data as Rec).boundaryTouching);
      expect(boundary).toEqual([true]);
    });
  }, 180_000);

  /** The anti-stub invariant of this tier. The test asserts the returned list. */
  it('Governance_EvidenceTier_DrivesRealCompositeHandlers', async () => {
    await withHarness({}, async (h) => {
      await h.runAction('exarchos_workflow', 'get', { featureId: 'gov-t2-degraded' });
      await h.runAction('exarchos_orchestrate', 'runbook', { id: 'task-completion' });
      await h.probe('exarchos_event', { action: 'append', stream: 'gov-t2-noop', event: {} });

      const verified = await assertNoStubbedCompositeHandlers();
      expect(verified).toContain('exarchos_workflow');
      expect(verified).toContain('exarchos_orchestrate');
      expect(verified).toContain('exarchos_event');
      expect(h.reachedActionIds()).toContain('exarchos_orchestrate.runbook');
    });
  }, 120_000);
});
