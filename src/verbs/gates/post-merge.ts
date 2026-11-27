/**
 * The post-merge regression gate at the boundary between synthesize and cleanup. It runs the pure
 * `checkPostMerge` check and records the gate result for the feature.
 * The local approved-check executor runs the test suite of the selected checkout as a lifecycle check of the phase attempt.
 */

import { isAbsolute } from 'node:path';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { HostedAdequacyPending, hostedPendingResult, runPhaseGateWithEvidence } from './gate-runner.js';
import { admitLifecycleLegs } from '../verification/lifecycle-check.js';
import type { CheckExecutor } from '../verification/check-executor.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { checkPostMerge } from '../pure/post-merge.js';
import type { CommandResult } from '../pure/post-merge.js';

interface PostMergeArgs {
  readonly featureId: string;
  readonly prUrl: string;
  readonly mergeSha: string;
  /** The absolute path of the checkout whose resolved test command runs. */
  readonly repoRoot: string;
}

interface PostMergeResult {
  readonly passed: boolean;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly findings: string[];
  readonly report: string;
}

/** A refusal of the local executor. It stops the gate run, and the handler returns its result. */
class LocalRefusal extends Error {
  constructor(readonly result: ToolResult) { super(result.error?.message); }
}

/** The event store, the executor and the phase attempt that scope the test run of one call. */
interface PostMergeRun {
  readonly eventStore: EventStore;
  readonly executor?: CheckExecutor;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * The local test runner of the post-merge check. The exit code of its one leg reads as the suite result.
 * A refusal stops the gate run. A pending result, a run with no verdict and a missing leg throw the pending signal.
 */
function localTestRunner(args: PostMergeArgs, run: PostMergeRun) {
  return async (bin: string, cmdArgs: readonly string[]): Promise<CommandResult> => {
    const phaseAttemptId = run.phaseAttemptId();
    const legs = await admitLifecycleLegs({
      eventStore: run.eventStore, checkout: args.repoRoot, legs: [{ kind: 'command', argv: [bin, ...cmdArgs] }],
      streamId: args.featureId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }),
      ...(run.executor === undefined ? {} : { executor: run.executor }),
    });
    if ('success' in legs) throw new LocalRefusal(legs);
    const leg = legs[0]?.run;
    if (leg?.exitCode === undefined || leg.exitCode === null) throw new HostedAdequacyPending('The executor returned no exited test leg, so the suite has no verdict.');
    return { exitCode: leg.exitCode, stdout: leg.stdout, stderr: leg.stderr };
  };
}

/**
 * Runs the post-merge gate through the shared phase-gate runner. The observer reads
 * `admission.evidence-recorded`, not a bare `gate.executed` append. The runner records that
 * evidence before a success result returns. `repoRoot` must be an absolute path, because the gate runs
 * the resolved test command there.
 *
 * The suite runs in the local executor with no verifier provisioning. A pending result maps to its existing code with no evidence.
 *
 * @param executor - The local check executor. The default is the real executor. A test passes its own executor.
 */
export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
  eventStore: EventStore,
  executor?: CheckExecutor,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.prUrl) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prUrl is required' },
    };
  }

  if (!args.mergeSha) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'mergeSha is required' },
    };
  }

  if (typeof args.repoRoot !== 'string' || !isAbsolute(args.repoRoot)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message:
          'repoRoot is required and must be an absolute path: check_post_merge runs the ' +
          "repository's resolved test command there and does not fall back to the server's " +
          'own working directory.',
      },
    };
  }

  let attempt: string | undefined;
  const run: PostMergeRun = { eventStore, ...(executor === undefined ? {} : { executor }), phaseAttemptId: () => attempt };
  try {
    return await runPhaseGateWithEvidence({
      streamId: args.featureId,
      gateClass: 'post-merge',
      requirementId: 'requirement:post-merge',
      stateDir,
      eventStore,
      subject: (phaseAttemptId) => {
        attempt = phaseAttemptId;
        return createEvidenceSubject(
          { kind: 'phase-attempt', phaseAttemptId },
          {
            gate: 'post-merge',
            phase: 'synthesize',
            prUrl: args.prUrl,
            mergeSha: args.mergeSha,
          },
        );
      },
      providerInput: args,
      executeProvider: async () => executePostMerge(args, eventStore, run),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

/** Run the pure check with the local test runner. The handler always passes it, so the pure check never reaches its own runner. */
async function executePostMerge(
  args: PostMergeArgs,
  eventStore: EventStore,
  run: PostMergeRun,
): Promise<ToolResult> {
  const { repoRoot } = args;
  let checkResult: Awaited<ReturnType<typeof checkPostMerge>>;
  try {
    checkResult = await checkPostMerge({
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      repoRoot,
      localTestRun: localTestRunner(args, run),
    });
  } catch (error) {
    if (error instanceof LocalRefusal) return error.result;
    throw error;
  }

  const passed = checkResult.status === 'pass';
  const { findings, report } = checkResult;

  const data: PostMergeResult = {
    passed,
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    findings,
    report,
  };
  const carrier: ToolResult = { success: true, data };

  const store = eventStore;
  const unrecorded = await requireGateEvent(
    store,
    args.featureId,
    'post-merge',
    'post-merge',
    passed,
    carrier,
    {
      dimension: 'D4',
      phase: 'synthesize',
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      findings,
    },
    sameOperationGateKey('post-merge'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return carrier;
}
