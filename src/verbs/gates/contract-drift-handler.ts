/**
 * check_contract_drift: runs the contract-drift gate for the schema-boundary
 * changes of a task. The drift legs live in `contract-drift.ts`. This handler
 * resolves `repoRoot` and reads the `contract` term of the verification profile.
 * A segment reads the pinned term, and a direct call resolves the term live.
 * The handler runs each leg as an argv and persists the evidence through the durable gate producer.
 *
 * A drift finding is a verdict, not a tool error. Thus the result is
 * `success: true` with the verdict in `data.passed`.
 *
 * The gate never guesses a base. A run with no `baseBranch` gives the verdict
 * `base-missing`, which is indeterminate and blocks.
 *
 * The legs run in the local approved-check executor, in a disposable copy of the exact head, so codegen never writes the checkout.
 */

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import {
  defaultGitExec,
  profileOf,
  profilePathOf,
  resolvePolicySkip,
  SKIPPED_BY_POLICY,
  withProfileRoute,
  type ProfiledGateArgs,
} from './gate-utils.js';
import { runGatePreflight } from '../pure/gate-preflight.js';
import { runDurableGateProducer } from './durable-gate-producer.js';
import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import { verificationJson, type CheckLeg, type CheckPlan } from '../../contract/verification/harness-verification.js';
import {
  legArgv, pendingOfDirectCall, refusedCheckResult, runApprovedCheck, type CheckExecutor, type CheckSession,
} from '../verification/check-executor.js';
import type { VerificationProfile } from '../../workflow/verification/profile.js';
import type { RiskTier } from '../../workflow/verification-policy.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { GitExec } from '../pure/execute-merge.js';
import {
  runContractDrift,
  type CommandRunFn,
  type ContractDriftResult,
} from './contract-drift.js';

/**
 * The next action on a pass that is not a skip and that ran each codegen and diff leg. A contract pins the shape of a
 * boundary, not its meaning. Thus one semantic test of the boundary is enough,
 * and unit-test shape assertions are redundant.
 */
export const ONE_SEMANTIC_TEST_STEER =
  'contracts verify shape, not meaning — keep exactly ONE semantic test for ' +
  'this boundary; delete redundant shape assertions';

export interface ContractDriftHandlerArgs extends ProfiledGateArgs {
  readonly featureId: string;
  readonly taskId: string;
  /** The task branch (HEAD side of the diff). Defaults to the current branch. */
  readonly branch?: string;
  /**
   * The base ref that the branch forked from, which is the merge-base target. It has no default.
   * Without it, the gate blocks with `base-missing`.
   */
  readonly baseBranch?: string;
  /**
   * The repository to check. The gate uses a literal path as given. `'auto'`
   * resolves to the agent worktree of the calling delegation. When absent, the
   * gate uses `process.cwd()`.
   */
  readonly repoRoot?: string;
  /** Explicit agent worktree path — preferred resolver seam for 'auto'. */
  readonly worktreePath?: string;
  /** A legacy field. Evidence idempotency uses only the trusted DispatchContext. */
  readonly operationId?: string;

  /**
   * The task's stamped risk tier. When provided together with
   * {@link boundaryTouching}, the handler self-skips when the resolved
   * verification sequence does not include this gate (`skipped-by-policy`).
   * Absent (legacy callers) → the gate runs unconditionally.
   */
  readonly riskTier?: RiskTier;
  /** The task's stamped boundary-touching flag. See {@link riskTier}. */
  readonly boundaryTouching?: boolean;
  /**
   * The resolved project config. The dispatch adapter passes it, so the
   * self-skip uses the same policy as the delegation stamp. When absent, the
   * resolver uses the built-in table.
   */
  readonly projectConfig?: ResolvedProjectConfig;

  /** A test seam. The default is `defaultGitExec`, which reads the merge base in the live checkout. */
  readonly gitExec?: GitExec;
  /** A test seam. With it, the legs run through it at the root, and no executor runs. */
  readonly runCommand?: CommandRunFn;
}

/** The contract legs in the order of the gate. */
const CONTRACT_LEGS: readonly ('codegen' | 'typecheck' | 'diff')[] = ['codegen', 'typecheck', 'diff'];

/** The reviewed typed scope of the resolved contract legs, in the order of the gate. */
export function contractDriftPlan(contract: VerificationProfile['contract']): CheckPlan {
  const legs: CheckLeg[] = [];
  for (const kind of CONTRACT_LEGS) {
    const term = contract[kind];
    if (term.state === 'resolved') legs.push({ name: kind, kind, argv: [...term.argv] });
  }
  return { operation: 'contract-drift', legs };
}

/** True when the gate runs a leg: codegen or diff resolves, and a bound diff names both standalone coordinates. */
function contractDriftRunsLegs(contract: VerificationProfile['contract'], bound: boolean): boolean {
  const { codegen, diff } = contract;
  if (codegen.state === 'unresolved' && diff.state === 'unresolved') return false;
  return !(bound && diff.state === 'resolved'
    && (!diff.argv.slice(1).includes('@baseCommit@') || !diff.argv.slice(1).includes('@headCommit@')));
}

/**
 * A leg runner over one executor session. Each argv that the drift legs ask for must be an approved leg after the coordinate substitution.
 * A leg that ended other than by an exit reads as exit 1, and its output names the end. A failed exit keeps stdout and stderr.
 */
function sessionLegs(session: CheckSession, plan: CheckPlan, substitute: Readonly<Record<string, string>>): CommandRunFn {
  return async ({ argv }) => {
    const wanted = verificationJson(argv);
    const leg = plan.legs.findIndex((_, index) => verificationJson(legArgv(plan, { leg: index, substitute })) === wanted);
    const run = await session.run({ leg, substitute });
    if (run.end === 'exited' && run.exitCode === 0) return { exitCode: 0, stdout: run.stdout };
    const stopped = run.end === 'exited' ? '' : `[the executor stopped the leg: ${run.end}${run.detail === undefined ? '' : `, ${run.detail}`}] `;
    return { exitCode: run.end === 'exited' ? run.exitCode ?? 1 : 1, stdout: `${stopped}${run.stdout}${run.stderr}` };
  };
}

/** The discriminant of a run that names no base. */
const BASE_MISSING = 'base-missing';

/** The report of a run that names no base. */
const BASE_MISSING_REPORT =
  'check_contract_drift did not run: no base was supplied (`baseBranch`), so the diff has nothing to be measured from. ' +
  'Pass the branch that the task forked from. The task-completion runbook binds it from the capsule `baseRef`.';

/**
 * The fields that an unresolved term adds to the carrier. A skip descriptor rides on the carrier, so it reaches the `gate.executed` row and the trace qualifier.
 * A pass that did not run a codegen or diff leg gets the discriminant and the reason, with no `skipped` field.
 * The reason starts with the profile path and ends with the route of a remedy. A run with no unresolved leg adds no field.
 */
function unresolvedFields(args: ContractDriftHandlerArgs, repoRoot: string, drift: ContractDriftResult): Record<string, unknown> {
  if (!drift.skipped && drift.discriminant === undefined) return {};
  return {
    ...(drift.skipped ? { skipped: true } : {}),
    ...(drift.discriminant === undefined ? {} : { discriminant: drift.discriminant }),
    ...(drift.reason === undefined
      ? {}
      : { reason: `${profilePathOf(args, repoRoot)}. ${withProfileRoute(args, drift.reason)}` }),
  };
}

/** True for a pass that ran each codegen and diff leg. Only such a pass gets {@link ONE_SEMANTIC_TEST_STEER}. */
function isCleanPass(drift: ContractDriftResult): boolean {
  return drift.passed && !drift.skipped && drift.discriminant === undefined;
}

/**
 * Runs the drift legs. With a test runner in the args, the legs run through it at the root.
 * Else the legs run in the local executor, in a disposable copy of the exact head, and the merge base reads the live checkout.
 * A run that runs no leg starts no executor.
 */
async function runDrift(
  args: ContractDriftHandlerArgs, repoRoot: string, baseRef: string, eventStore: EventStore, executor: CheckExecutor,
): Promise<ContractDriftResult | ToolResult> {
  const profile = profileOf(args, repoRoot);
  const { contract } = profile;
  const gitExec = args.gitExec ?? defaultGitExec;
  const drift = (root: string, runCommand: CommandRunFn) => runContractDrift({
    repoRoot: root, baseRef, contract, coordinate: args.coordinate, gitExec: (_root, gitArgs) => gitExec(repoRoot, gitArgs), runCommand,
  });
  if (args.runCommand !== undefined) return drift(repoRoot, args.runCommand);
  const plan = contractDriftPlan(contract);
  if (!contractDriftRunsLegs(contract, args.coordinate !== undefined)) {
    return drift(repoRoot, async () => { throw new Error('a contract run with no runnable leg runs no command'); });
  }
  const coordinate = args.coordinate;
  const substitute = coordinate === undefined ? {} : { '@baseCommit@': coordinate.diffBaseCommit, '@headCommit@': coordinate.observedHeadCommit };
  const ran = await executor({
    eventStore, operation: 'contract-drift', streamId: args.featureId, taskId: args.taskId, plan, profileDigest: contentDigest(profile),
    checkout: repoRoot, coordinate, workspace: 'disposable-copy',
  }, (session) => drift(session.root, sessionLegs(session, plan, substitute)));
  return ran.kind === 'refused' ? refusedCheckResult(ran.reason) : ran.value;
}

/**
 * Runs the shared gate preflight, which requires `taskId`. Then it runs the
 * gate inside the durable gate producer. A policy skip gives a passing result
 * with `skipped: true`.
 *
 * After the policy skip and before any contract leg, a run with no base gives `base-missing`.
 * Its verdict is `indeterminate` with `passed: false`, and it is not a skip. Thus it blocks, and a policy skip with no base stays a skip.
 * With no base, the producer scope gets no `baseRef`, so the evidence subject names no diff base.
 *
 * @param executor - The local check executor, {@link runApprovedCheck} by default. A test passes its own executor.
 */
export async function handleContractDrift(
  args: ContractDriftHandlerArgs,
  stateDir: string,
  eventStore: EventStore,
  executor: CheckExecutor = runApprovedCheck,
): Promise<ToolResult> {
  const pre = await runGatePreflight(
    {
      featureId: args.featureId,
      taskId: args.taskId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      handlerName: 'handleContractDrift',
      requireTaskId: true,
    },
    eventStore,
  );
  if (!pre.ok) return pre.result;
  const repoRoot = pre.repoRoot;
  const baseRef = args.baseBranch && args.baseBranch.trim().length > 0 ? args.baseBranch.trim() : undefined;

  try {
    return await runDurableGateProducer(
      {
        coordinate: args.coordinate,
        gateClass: 'contract-drift',
        featureId: args.featureId,
        taskId: args.taskId,
        ...(args.branch ? { branch: args.branch } : {}),
        ...(baseRef ? { baseRef } : {}),
        repoRoot,
        stateDir,
        eventStore,
      },
      async () => {
        const policySkip = resolvePolicySkip({
          gateName: 'check_contract_drift',
          riskTier: args.riskTier,
          boundaryTouching: args.boundaryTouching,
          config: args.projectConfig,
        });
        if (policySkip) {
          return {
            success: true,
            data: {
              passed: true,
              skipped: true,
              drift: false,
              breaking: [],
              report: policySkip.reason,
              discriminant: SKIPPED_BY_POLICY,
            },
          };
        }

        if (baseRef === undefined) {
          return {
            success: true,
            data: {
              passed: false,
              verdict: 'indeterminate',
              drift: false,
              breaking: [],
              report: BASE_MISSING_REPORT,
              discriminant: BASE_MISSING,
            },
          };
        }

        const drift = await runDrift(args, repoRoot, baseRef, eventStore, executor);
        if ('success' in drift) return drift;
        if (drift.discriminant === 'PROFILE_DIFF_COORDINATE_UNBOUND') {
          return { success: false, error: { code: drift.discriminant, message: drift.report } };
        }
        return {
          success: true,
          data: {
            passed: drift.passed,
            drift: drift.drift,
            breaking: drift.breaking,
            report: `profile = ${profilePathOf(args, repoRoot)}\n${drift.report}`,
            ...unresolvedFields(args, repoRoot, drift),
            ...(isCleanPass(drift) ? { next_actions: [ONE_SEMANTIC_TEST_STEER] } : {}),
          },
        };
      },
    );
  } catch (error) {
    return pendingOfDirectCall(error, args.coordinate !== undefined);
  }
}
