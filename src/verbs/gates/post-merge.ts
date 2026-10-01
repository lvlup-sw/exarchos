/**
 * The post-merge regression gate at the boundary between synthesize and cleanup. It runs the pure
 * `checkPostMerge` check and records the gate result for the feature.
 */

import { isAbsolute } from 'node:path';
import { spawnCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
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

/**
 * The command runner for `checkPostMerge`. It uses `spawnCommandSync`, so a resolved package-manager command
 * launches its `.cmd` shim on Windows. A raw `spawnSync` of such a shim throws EINVAL there since CVE-2024-27980.
 */
function execCommandRunner(
  cmd: string,
  args: readonly string[],
  cwd: string,
): CommandResult {
  const result = spawnCommandSync(cmd, [...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

/**
 * Runs the post-merge gate through the shared phase-gate runner. The observer reads
 * `admission.evidence-recorded`, not a bare `gate.executed` append. The runner records that
 * evidence before a success result returns. `repoRoot` must be an absolute path, because the gate runs
 * the resolved test command there.
 */
export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
  eventStore: EventStore,
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

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'post-merge',
    requirementId: 'requirement:post-merge',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        {
          gate: 'post-merge',
          phase: 'synthesize',
          prUrl: args.prUrl,
          mergeSha: args.mergeSha,
        },
      ),
    providerInput: args,
    executeProvider: async () => executePostMerge(args, eventStore),
  });
}

async function executePostMerge(
  args: PostMergeArgs,
  eventStore: EventStore,
): Promise<ToolResult> {
  const { repoRoot } = args;
  const checkResult = await checkPostMerge({
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    repoRoot,
    runCommand: (cmd, cmdArgs) => execCommandRunner(cmd, cmdArgs, repoRoot),
  });

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
