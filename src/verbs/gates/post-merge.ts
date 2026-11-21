/**
 * The post-merge regression gate at the boundary between synthesize and cleanup. It runs the pure
 * `checkPostMerge` check and records the gate result for the feature.
 * A provisioned verifier runs the test suite of the selected checkout under a checkout subject. No route runs it locally.
 * A machine with no verifier refuses with VERIFIER_NOT_PROVISIONED after argument validation.
 */

import { isAbsolute } from 'node:path';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import type { VerificationHostConnector } from '../../contract/verification/harness-verification.js';
import { HostedAdequacyPending, admitLifecycleLegs, hostedPendingResult, runPhaseGateWithEvidence, verifierNotProvisioned } from './gate-runner.js';
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

/** A refusal of the verifier. It stops the gate run, and the handler returns its result. */
class HostedRefusal extends Error {
  constructor(readonly result: ToolResult) { super(result.error?.message); }
}

/** The verifier of one call and the phase attempt that scopes its request. */
interface PostMergeHost {
  readonly connector: VerificationHostConnector;
  readonly phaseAttemptId: () => string | undefined;
}

/**
 * The hosted test runner of the post-merge check. Its signed exit code reads as the suite result.
 * A refusal stops the gate run. A pending result, a run with no verdict and a missing leg throw the pending signal.
 */
function hostedTestRunner(args: PostMergeArgs, host: PostMergeHost) {
  return async (bin: string, cmdArgs: readonly string[]): Promise<CommandResult> => {
    const phaseAttemptId = host.phaseAttemptId();
    const legs = await admitLifecycleLegs({
      connector: host.connector, checkout: args.repoRoot, legs: [{ kind: 'command', argv: [bin, ...cmdArgs] }],
      streamId: args.featureId, ...(phaseAttemptId === undefined ? {} : { phaseAttemptId }),
    });
    if ('success' in legs) throw new HostedRefusal(legs);
    const run = legs[0]?.run;
    if (run?.exitCode === undefined || run.exitCode === null) throw new HostedAdequacyPending('The verifier returned no exited test leg, so the suite has no verdict.');
    return { exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr };
  };
}

/**
 * Runs the post-merge gate through the shared phase-gate runner. The observer reads
 * `admission.evidence-recorded`, not a bare `gate.executed` append. The runner records that
 * evidence before a success result returns. `repoRoot` must be an absolute path, because the gate runs
 * the resolved test command there.
 *
 * A connector comes only from the dispatch context. With no connector, the gate refuses after argument validation. A pending hosted result maps to its existing code with no evidence.
 */
export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
  eventStore: EventStore,
  connector?: VerificationHostConnector,
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

  if (connector === undefined) return verifierNotProvisioned('check_post_merge');

  let attempt: string | undefined;
  const host: PostMergeHost = { connector, phaseAttemptId: () => attempt };
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
      executeProvider: async () => executePostMerge(args, eventStore, host),
    });
  } catch (error) {
    return hostedPendingResult(error);
  }
}

/** Run the pure check with the hosted test runner. The handler always passes it, so the pure check never reaches a local runner. */
async function executePostMerge(
  args: PostMergeArgs,
  eventStore: EventStore,
  host: PostMergeHost,
): Promise<ToolResult> {
  const { repoRoot } = args;
  let checkResult: Awaited<ReturnType<typeof checkPostMerge>>;
  try {
    checkResult = await checkPostMerge({
      prUrl: args.prUrl,
      mergeSha: args.mergeSha,
      repoRoot,
      hostedTestRun: hostedTestRunner(args, host),
    });
  } catch (error) {
    if (error instanceof HostedRefusal) return error.result;
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
