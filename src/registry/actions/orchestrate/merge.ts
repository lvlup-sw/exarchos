import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { COMPENSABLE_REMOTE } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const mergeActions: readonly BuiltinToolAction[] = [
  contracted(
    {
      name: 'merge_orchestrate',
      description: 'Top-level merge orchestrator (DR-MO-1): runs preflight, emits merge.preflight, then delegates to the executor on pass; handles abort/dryRun/resume. Use for: merging a task/feature source branch into the integration target with full preflight + compensating recovery from the main worktree. Do NOT use for: a raw provider PR/MR merge (use merge_pr); verifying a directory is a git worktree (use verify_worktree); or requesting synthesis/PR creation on a oneshot workflow (use request_synthesize).',
      schema: z.object({
        featureId: z.string().min(1),
        sourceBranch: z.string().min(1),
        targetBranch: z.string().min(1),
        taskId: z.string().optional(),
        /**
         * Required, with no default, like `merge_pr.strategy`. The CLI and MCP then show the same
         * parameter, and the event log records the choice of the operator.
         */
        strategy: z.enum(['squash', 'rebase', 'merge']),
        dryRun: z.boolean().optional(),
        resume: z.boolean().optional(),
        repoRoot: z.string().optional(),
        /**
         * The merge-lease correlator of the caller. The handler fails closed when the target ref has
         * an in-flight `worktrees@v1` lease with another holder `operationId` that is not provably
         * dead. `serialize_merge` passes its own lease `operationId`, and a crash-resumed caller
         * passes the original one. No other action declares this field, so
         * `buildRegistrationSchema` sees no type collision. When it is absent, no lease check runs.
         */
        leaseOperationId: z.string().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      /**
       * The merge runs preflight, execute, and an optional rollback, so it suits task-augmented
       * dispatch. This hint is advisory. The opt-in gate is in `dispatch/core/dispatch.ts`.
       */
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      /**
       * This declaration is the only owner of the top-level `merge-orchestrate` verb. The hoist loop
       * reads it and routes the command through `registerActionCommand`, with the same schema,
       * handler, and exit codes as `orch merge-orchestrate`.
       */
      cli: { topLevel: 'merge-orchestrate' },
      /**
       * The merge changes the integration branch, the working tree, and the event store from the
       * main worktree, with no isolation. This is the strictest mutating tier, and the resolver
       * mints `fs:write` and `shell:exec` from it.
       */
      posture: 'shared-mutating',
      outputSchema: vacuityWaiver('exarchos_orchestrate.merge_orchestrate'),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('merge admission is the in-handler preflight and lease guard, not an authored obligation discriminant'),
      ensures: declared(
        { source: 'event-append', when: 'always', event: 'merge.preflight' },
        { source: 'event-append', when: 'success', event: 'merge.executed' },
        { source: 'event-append', when: 'success', event: 'merge.completed' },
        { source: 'event-append', when: 'failure', event: 'merge.recovered' },
      ),
      needs: declared('fs:write', 'shell:exec'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'stream', selector: 'featureId' },
          { kind: 'git-ref', selector: 'sourceBranch' },
          { kind: 'git-ref', selector: 'targetBranch' },
          { kind: 'path', selector: 'repoRoot' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(
        { event: 'merge.preflight', condition: 'always', owner: 'orchestrate', role: 'primary' },
        {
          event: 'merge.executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'When preflight passes and execute succeeds',
        },
        {
          event: 'merge.recovered',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'When execute fails and the recovery ladder runs',
        },
        {
          event: 'merge.completed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'After the merge lands and the terminal marker is written',
        },
        {
          event: 'merge.executing_started',
          /**
           * Conditional, because a `dryRun` call returns success after preflight and never enters
           * the executing phase.
           */
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'When the executor enters the executing phase, before the first merge attempt',
        },
        {
          event: 'merge.retry_attempt',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Once per timeout-triggered retry of the merge attempt',
        },
      ),
    },
  ),
];
