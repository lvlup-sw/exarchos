/**
 * The lifecycle checks, the team commands and the standalone test verb in the local approved-check executor.
 * Each check runs the live resolved test command and typecheck command as the legs of one approved plan, read-only in the checkout.
 * The working directory must be a registered worktree of the workflow repository, or the checkout of the capsule scope, with a clean tree.
 *
 * A refusal of the executor is a failed result with the local refusal code. A leg with no verdict throws the pending signal, so no evidence lands.
 * The standalone verb has no store, so its run claims, records and replays nothing, and it does not need a clean tree.
 */
import { checkPlanDigest, type CheckPlan } from '../../contract/verification/harness-verification.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { LocalTestRun, RunTestsHost } from '../../lifecycle/run-tests.js';
import { HostedAdequacyPending } from '../gates/gate-runner.js';
import {
  refusedCheckResult, runApprovedCheck, runStandaloneCheck, type CheckExecutor, type CheckSession, type LegObservation, type StandaloneCheckOutcome,
} from './check-executor.js';

/** One leg of a lifecycle check: the test command or the typecheck command, as an argument vector. */
export interface LifecycleLeg {
  readonly kind: 'command' | 'typecheck';
  readonly argv: readonly string[];
}

/** The approved plan of a lifecycle check. A check that stops after a failed test leg declares the stop. */
export function lifecyclePlan(legs: readonly LifecycleLeg[], stopAfterTestFailure = false): CheckPlan {
  const plan: CheckPlan = {
    operation: 'lifecycle',
    legs: legs.map(leg => ({ name: leg.kind === 'command' ? 'test' : 'typecheck', kind: leg.kind, argv: [...leg.argv] })),
  };
  return stopAfterTestFailure ? { ...plan, onTestFailure: 'stop' } : plan;
}

/** The inputs of one lifecycle check. The stream, the phase attempt and the task scope the request and its replay. */
export interface LifecycleCheckInput {
  readonly eventStore: EventStore;
  readonly checkout: string;
  readonly legs: readonly LifecycleLeg[];
  readonly stopAfterTestFailure?: boolean;
  readonly streamId?: string;
  readonly phaseAttemptId?: string;
  readonly taskId?: string;
  /** The local check executor, {@link runApprovedCheck} by default. A test passes its own executor. */
  readonly executor?: CheckExecutor;
}

/** One leg of a lifecycle check that ran: its plan name, its kind and its observed end. */
export interface LifecycleLegRun {
  readonly name: string;
  readonly kind: LifecycleLeg['kind'];
  readonly run: LegObservation;
}

/** The no-verdict cause of one leg, or undefined for a leg that exited with a status. A no-verdict leg never reads as a red suite. */
export function lifecycleNoVerdict(run: LegObservation): string | undefined {
  switch (run.end) {
    case 'exited': return run.exitCode === null ? 'the run exited with no status' : undefined;
    case 'timeout': return 'the executor stopped the run at its time cap';
    case 'output-limit': return 'the executor stopped the run at its output cap';
    case 'unavailable': return `the run did not start: ${run.detail ?? 'the program is unavailable'}`;
    case 'signal': return 'a signal stopped the run';
    case 'refused': return `the executor refused the leg: ${run.detail ?? 'the leg is not approved'}`;
  }
}

/** Run each leg of the plan in order. A plan that stops after a failed test leg runs no later leg. */
async function runLegs(plan: CheckPlan, session: CheckSession): Promise<readonly LifecycleLegRun[]> {
  const runs: LifecycleLegRun[] = [];
  for (const [index, leg] of plan.legs.entries()) {
    const kind: LifecycleLeg['kind'] = leg.kind === 'typecheck' ? 'typecheck' : 'command';
    const run = await session.run({ leg: index });
    runs.push({ name: leg.name, kind, run });
    if (kind === 'command' && plan.onTestFailure === 'stop' && (run.end !== 'exited' || run.exitCode !== 0)) break;
  }
  return runs;
}

/**
 * The legs of a phase or team check, or the failed result of a refusal.
 * A refused leg refuses the check. A pending outcome and a leg with no verdict throw the pending signal, so the phase handler records no evidence.
 */
export async function admitLifecycleLegs(input: LifecycleCheckInput): Promise<readonly LifecycleLegRun[] | ToolResult> {
  const plan = lifecyclePlan(input.legs, input.stopAfterTestFailure);
  const executor = input.executor ?? runApprovedCheck;
  const outcome = await executor({
    eventStore: input.eventStore, operation: 'lifecycle', plan, profileDigest: checkPlanDigest(plan), checkout: input.checkout, workspace: 'checkout',
    ...(input.streamId === undefined ? {} : { streamId: input.streamId }),
    ...(input.phaseAttemptId === undefined ? {} : { phaseAttemptId: input.phaseAttemptId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  }, session => runLegs(plan, session));
  if (outcome.kind === 'refused') return refusedCheckResult(outcome.reason);
  for (const leg of outcome.value) {
    if (leg.run.end === 'refused') return refusedCheckResult(`The ${leg.name} leg did not run: ${leg.run.detail ?? 'the leg is not approved'}`);
    const cause = lifecycleNoVerdict(leg.run);
    if (cause !== undefined) throw new HostedAdequacyPending(`The ${leg.name} leg gave no verdict: ${cause}.`);
  }
  return outcome.value;
}

/** The test run of one standalone outcome. A refusal refuses, a leg with no verdict is unavailable, and an exited leg gives its status. */
function testRunOf(outcome: StandaloneCheckOutcome<LegObservation>): LocalTestRun {
  if (outcome.kind === 'refused') return { kind: 'refused', message: outcome.reason };
  const run = outcome.value;
  if (run.end === 'refused') return { kind: 'refused', message: run.detail ?? 'The executor refused the test leg.' };
  const cause = lifecycleNoVerdict(run);
  if (cause !== undefined || run.exitCode === null) return { kind: 'unavailable', message: `The test run gave no verdict: ${cause ?? 'no status'}.` };
  return { kind: 'exited', exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
}

/**
 * The local host of the standalone test verb. It runs the resolved test command as the one leg of a lifecycle plan in the working directory.
 * The working directory must be the root of a registered branch checkout. Uncommitted changes do not refuse. A wrong directory and a refused program refuse.
 * A time cap, an output cap, a signal and a program that does not start give no verdict.
 */
export function standaloneTestHost(): RunTestsHost {
  return {
    async run(cwd: string, argv: readonly string[]): Promise<LocalTestRun> {
      const plan = lifecyclePlan([{ kind: 'command', argv }]);
      return testRunOf(await runStandaloneCheck({ plan, checkout: cwd }, session => session.run({ leg: 0 })));
    },
  };
}
