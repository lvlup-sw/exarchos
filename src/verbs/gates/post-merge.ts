// ─── Post-Merge Gate Handler ────────────────────────────────────────────────
//
// Orchestrates the post-merge regression check (DR-4) at the
// synthesize -> cleanup boundary. Calls the pure TypeScript
// checkPostMerge function and emits gate.executed events for
// flywheel integration.
// ────────────────────────────────────────────────────────────────────────────

import { spawnCommandSync } from '../../utils/process.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from './gate-runner.js';
import { requireGateEvent, sameOperationGateKey } from './gate-utils.js';
import { checkPostMerge } from '../pure/post-merge.js';
import type { CommandResult } from '../pure/post-merge.js';

// ─── Types ─────────────────────────────────────────────────────────────────

interface PostMergeArgs {
  readonly featureId: string;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly repoRoot?: string;
}

interface PostMergeResult {
  readonly passed: boolean;
  readonly prUrl: string;
  readonly mergeSha: string;
  readonly findings: string[];
  readonly report: string;
}

// ─── Command Runner Adapter ─────────────────────────────────────────────────

/**
 * Wraps spawnSync to match the command runner signature expected by
 * the pure TypeScript checkPostMerge function. Routes through
 * `spawnCommandSync` so a resolved package-manager command (`checkPostMerge`
 * spawns `npm`) launches its `.cmd` shim on Windows — raw `spawnSync('npm', …)`
 * throws EINVAL since CVE-2024-27980 (Node >= 20.12.2). (#1623)
 */
function execCommandRunner(
  cmd: string,
  args: readonly string[],
  cwd?: string,
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

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handlePostMerge(
  args: PostMergeArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // Guard clauses: validate all required inputs
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

  // Durable gate evidence is a declared postcondition here, and a bare
  // `gate.executed` append does not pay it — the observer reads
  // `admission.evidence-recorded`. The shared phase-gate runner records that
  // before any success carrier escapes; the declared signal is still minted by
  // the provider closure below.
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
  // Run the pure TypeScript post-merge check
  const cwd = args.repoRoot;
  const checkResult = await checkPostMerge({
    prUrl: args.prUrl,
    mergeSha: args.mergeSha,
    runCommand: (cmd, cmdArgs) => execCommandRunner(cmd, cmdArgs, cwd),
  });

  const passed = checkResult.status === 'pass';
  const { findings, report } = checkResult;

  // Build result
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
