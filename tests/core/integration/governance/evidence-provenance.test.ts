/**
 * T2 governance tier — the *evidence provenance* chain: who may PRODUCE
 * governance evidence, what the produced record is bound to, and how the
 * frozen coordinate that selected the gate is preserved.
 *
 * DR-28: every assertion is driven through the REAL public root (`dispatch()`)
 * against the production composition root. Each test owns its harness
 * lifecycle because `initializeContext` binds process-level state-store
 * globals — two live harnesses would fight over them.
 *
 * Criteria covered here (each with a BLOCKING arm and its NEGATIVE TWIN):
 *   DR-2   the governed cannot supply governance (evidence production is
 *          capability-gated, and the signal is minted from the persisted record)
 *   DR-3   the frozen `riskTier` reaches the gate
 *   DR-4   degraded is never served as success
 *   DR-10  monotonic frozen resolution
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
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

type Rec = Record<string, unknown>;

const scratchDirs: string[] = [];
let gitFixture: string;

function data(obs: DispatchObservation): Rec {
  return (obs.result?.data ?? {}) as Rec;
}

/**
 * One live harness at a time: `initializeContext` rebinds the module-level
 * state-store backend, so a second concurrent harness would invalidate the
 * first. Create → use → dispose, strictly sequentially.
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

/** A real git repository whose feature branch adds production code and NO tests. */
async function makeGitFixture(): Promise<string> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gov-t2-git-')));
  scratchDirs.push(repo);
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  git(['init', '--quiet']);
  git(['config', 'user.email', 'gov-t2@example.invalid']);
  git(['config', 'user.name', 'Governance T2']);
  git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'gov-t2-git-fixture', version: '1.0.0', private: true }, null, 2),
    'utf-8',
  );
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'chore: baseline']);
  git(['branch', '-M', 'main']);
  git(['checkout', '--quiet', '-b', 'feat/no-tests']);
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'widget.ts'), 'export const widget = 1;\n', 'utf-8');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'feat: add widget with no tests']);
  return repo;
}

beforeAll(async () => {
  gitFixture = await makeGitFixture();
}, 120_000);

afterAll(async () => {
  for (const dir of scratchDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('T2 governance — evidence provenance (DR-2, DR-3, DR-4, DR-10)', () => {
  /**
   * DR-2: producing governance evidence is capability-gated. An anonymous
   * dispatch caller — the shape a governed agent gets when it has not been
   * granted an identity — cannot mint evidence for itself.
   *
   * BLOCKING arm: no caller identity ⇒ the SPECIFIC `TRUSTED_CALLER_REQUIRED`
   * refusal, and the durable stream gains NO evidence row (the refusal is not
   * "ran it and hid the answer").
   * NEGATIVE TWIN: the identical call with an identified caller produces the
   * evidence row.
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

    // ── BLOCKING ARM: anonymous caller ────────────────────────────────────
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

    // ── NEGATIVE TWIN: an identified caller ───────────────────────────────
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
   * DR-2, provenance half: the signal `task_complete` reads is MINTED FROM the
   * persisted evidence record, so proof and signal cannot disagree.
   *
   * This is also the tier's ANTI-SHALLOWNESS assertion: it does not check that
   * "an envelope came back". It checks a three-way identity between values
   * that a generic well-formed envelope simply does not contain — the handler
   * payload's `evidenceReferences[0].evidenceId`, the `admission.evidence-recorded`
   * row's `evidence.evidenceId`, and `gate.executed.details.evidenceId` — plus
   * the producer's source string.
   *
   * BLOCKING arm: a blocked (`fail`) verdict mints `passed: false`.
   * NEGATIVE TWIN: a POLICY-SKIPPED run on the same chain mints an
   * `indeterminate` signal — non-blocking in the carrier, but never proof.
   *
   * The twin used to assert that this arm minted `passed: true` / `verdict:
   * 'pass'`. That was the DR-7 defect written down as the contract: the low-tier
   * arm is a policy SKIP, the gate never ran, and it was manufacturing durable
   * proof for it. Both arms now show the same underlying property from opposite
   * sides — `signal.passed === (persisted.verdict === 'pass')` — across three
   * distinct verdicts, and the twin additionally pins that a skip is
   * DISTINGUISHABLE from a run rather than silently equal to a pass.
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
        // (1) the payload's claim IS the persisted record.
        expect(persisted.evidenceId).toBe(claimedId);
        expect((persisted.subject as Rec).taskId).toBe('T-prov');
        // The producer is named, and it is not the caller.
        expect(String((persisted.producer as Rec).providerRef)).toBe('check_test_adequacy');

        const signals = events.filter((e) => e.type === 'gate.executed');
        expect(signals).toHaveLength(1);
        const signal = signals[0]?.data as Rec;
        const details = signal.details as Rec;
        // (2) the signal is bound to the SAME persisted record …
        expect(details.evidenceId).toBe(claimedId);
        // … and (3) minted by the gate runner, not by the caller.
        expect(String(signals[0]?.source)).toMatch(/^gate-runner\/v1\//);
        expect(details.taskId).toBe('T-prov');

        // ── BLOCKING ARM: a non-pass verdict mints a non-pass signal ─────
        expect(details.verdict).toBe('fail');
        expect(signal.passed).toBe(false);
        expect(data(run).passed).toBe(false);
        // proof and signal agree, by construction
        expect(signal.passed).toBe(persisted.verdict === 'pass');

        // ── NEGATIVE TWIN: a policy-SKIPPED run on the same chain ─────────
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
        // The CARRIER stays non-blocking — the ladder does not stop for a gate
        // its own policy excluded.
        expect(data(skipped).passed).toBe(true);
        expect(data(skipped).skipped).toBe(true);

        const twinSignals = (await h.events(featureId))
          .filter((e) => e.type === 'gate.executed')
          .map((e) => e.data as Rec)
          .filter((d) => (d.details as Rec).taskId === 'T-prov-low');
        expect(twinSignals).toHaveLength(1);
        const twinDetails = twinSignals[0]?.details as Rec;
        // …but the durable SIGNAL records that nothing was verified, and says
        // why. This is what makes a gate that did not run distinguishable from
        // one that passed — the property the fail arm above cannot show.
        expect(twinSignals[0]?.passed).toBe(false);
        expect(twinDetails.verdict).toBe('indeterminate');
        expect(twinDetails.skipped).toBe(true);
        expect(typeof twinDetails.discriminant).toBe('string');

        // The same construction-level identity as the blocking arm, on a third
        // verdict: the signal's `passed` is the persisted verdict, nothing else.
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
   * DR-3: the frozen `riskTier` REACHES the gate and changes its decision.
   *
   * BLOCKING arm: `riskTier: 'high'` on a diff that adds no tests ⇒ the gate
   * refuses with `disposition: 'blocked'`, `passed: false`, and a report that
   * names the tier as the reason.
   * NEGATIVE TWIN: the identical diff at `riskTier: 'low'` is a policy skip —
   * `passed: true`, with a reason that echoes the tier it was resolved for.
   * (If the tier did not reach the gate, both arms would return the same
   * verdict — which is exactly what the kill probe removes.)
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

        // ── BLOCKING ARM ──────────────────────────────────────────────────
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

        // ── NEGATIVE TWIN ─────────────────────────────────────────────────
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
        // The gate echoes the coordinate it was resolved AT — proof the frozen
        // tier travelled all the way in, rather than being defaulted locally.
        expect(String(data(low).reason)).toContain("riskTier='low'");
        expect(String(data(low).reason)).toContain('boundaryTouching=true');

        // The two arms differ ONLY in the coordinate.
        expect(data(high).passed).not.toBe(data(low).passed);

        // DR-3 (runbook half): the coordinate is a first-class runbook input on
        // BOTH task runbooks — declared as templateVars AND bound into the gate
        // steps' params, so no step is expected to re-derive it. The predicate
        // is applied to a deliberately-stripped copy too, so a predicate that
        // always says "fine" cannot pass this.
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

        // The detector really detects.
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
   * DR-4: a degraded projection is never served as success.
   *
   * BLOCKING arm: with a durable `projection.degraded` marker, a projection-
   * derived read REFUSES with `PROJECTION_DEGRADED` and a message that carries
   * the INJECTED lag numbers — an answer synthesised from a stale fold, or a
   * generic well-formed envelope, could not contain them.
   * NEGATIVE TWIN: append `projection.recovered` and the identical read
   * succeeds and returns the real state.
   */
  it('Governance_Dr4_DegradedProjection_IsNeverServedAsSuccess', async () => {
    const featureId = 'gov-t2-degraded';
    await withHarness({}, async (h) => {
      await h.runAction('exarchos_workflow', 'init', { featureId, workflowType: 'feature' });

      const healthy = await h.runAction('exarchos_workflow', 'get', { featureId });
      expect(healthy.result?.success).toBe(true);
      expect(data(healthy).phase).toBe('plan');

      // ── BLOCKING ARM ──────────────────────────────────────────────────
      const inject = await h.runAction('exarchos_event', 'append', {
        stream: 'meta/projection-health',
        event: {
          type: 'projection.degraded',
          data: {
            streamId: featureId,
            reason: 'projection-behind',
            eventTail: 42,
            projectionCursor: 13,
            lag: 29,
            staleViews: ['workflow-state'],
          },
        },
      });
      expect(inject.result?.success).toBe(true);

      const refused = await h.runAction('exarchos_workflow', 'get', { featureId });
      expect(refused.result?.success).toBe(false);
      expect(refused.errorCode).toBe('PROJECTION_DEGRADED');
      const message = String(refused.result?.error?.message);
      expect(message).toContain('29 event(s) short');
      expect(message).toContain('tail 42');
      expect(message).toContain('worst cursor 13');
      expect(message).toContain(featureId);
      // Emphatically not a "no data" answer served as success.
      expect(refused.result?.data).toBeUndefined();

      // ── NEGATIVE TWIN ─────────────────────────────────────────────────
      const recover = await h.runAction('exarchos_event', 'append', {
        stream: 'meta/projection-health',
        event: {
          type: 'projection.recovered',
          data: { streamId: featureId, eventTail: 42, projectionCursor: 42 },
        },
      });
      expect(recover.result?.success).toBe(true);

      const restored = await h.runAction('exarchos_workflow', 'get', { featureId });
      expect(restored.errorCode).toBeUndefined();
      expect(restored.result?.success).toBe(true);
      expect(data(restored).phase).toBe('plan');
    });
  }, 180_000);

  /**
   * DR-10: frozen resolution is MONOTONE. Once a phase attempt has been
   * resolved at a coordinate, re-entering that phase may raise the coordinate
   * but never weaken it.
   *
   * BLOCKING arm: freeze at `high`, then lower the state's `riskTier` to `low`
   * and re-enter the same phase — the newly frozen `phase.entered` still
   * records `high` and still carries the full gate set.
   * NEGATIVE TWIN: an identical workflow frozen at `low` that is later RAISED
   * to `high` does record `high` — so the blocking arm's `high` is a decision,
   * not a hard-coded constant.
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

      /** Freeze `plan-review` at `first`, revise back to `plan`, re-freeze at `second`. */
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
        // The *state* really did change — the freeze is what refuses to follow.
        const readBack = await h.runAction('exarchos_workflow', 'get', { featureId });
        expect(data(readBack).riskTier).toBe(second.riskTier);

        const reEnter = await h.runAction('exarchos_workflow', 'transition', {
          featureId,
          target: 'plan-review',
        });
        expect(reEnter.result?.success).toBe(true);
        return frozenEntries(featureId);
      };

      // ── BLOCKING ARM: a weakening is ignored ──────────────────────────
      const weakened = await runCycle(
        'gov-t2-monotonic-weaken',
        { riskTier: 'high', boundaryTouching: true },
        { riskTier: 'low', boundaryTouching: false },
      );
      expect(weakened).toHaveLength(3);
      expect(weakened.map((f) => f.riskTier)).toEqual(['high', 'high', 'high']);
      // …and the gate set frozen at the raised coordinate is preserved too.
      expect(weakened[2]?.gates).toEqual(weakened[0]?.gates);
      expect((weakened[0]?.gates ?? []).length).toBeGreaterThan(0);

      // ── NEGATIVE TWIN: a raise IS honoured ────────────────────────────
      const raised = await runCycle(
        'gov-t2-monotonic-raise',
        { riskTier: 'low', boundaryTouching: false },
        { riskTier: 'high', boundaryTouching: true },
      );
      expect(raised).toHaveLength(3);
      expect(raised.map((f) => f.riskTier)).toEqual(['low', 'low', 'high']);

      // DR-10 criterion 1: an ABSENT coordinate fails safe — it never
      // collapses to `low`, and `boundaryTouching` defaults to true.
      const unknownId = 'gov-t2-unknown-tier';
      await h.runAction('exarchos_workflow', 'init', {
        featureId: unknownId,
        workflowType: 'feature',
      });
      const stateRead = await h.runAction('exarchos_workflow', 'get', { featureId: unknownId });
      expect(data(stateRead).riskTier ?? null).toBeNull(); // nothing was stated
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

  /** The tier's own anti-stub invariant; the returned list is asserted. */
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
