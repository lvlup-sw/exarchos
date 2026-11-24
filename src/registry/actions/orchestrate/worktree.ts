import { withCappedShape } from '../../../output-schema-declaration.js';
import { AcquireWorktreeOutputSchema, ReconcileWorktreesOutputSchema, ReleaseWorktreeOutputSchema } from '../../../verbs/worktree/schemas.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION_IDEMPOTENT } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

export const worktreeActions: readonly BuiltinToolAction[] = [
  /**
   * The worktree lifecycle actions are actions of `exarchos_orchestrate`, not a separate tool.
   * Each one delegates to the in-process `WorktreeManager`. The `worktrees` read is on `exarchos_view`.
   */
  contracted(
    {
      name: 'acquire_worktree',
      surface: 'worktree',
      description:
        'Acquire a worktree for the live process: adopt-then-reserve composite. Adopts every on-disk worktree under repoRoot first (the adopt-gate), then reserves worktreeId for the caller. Idempotent. Auto-emits worktree.adopted (per newly tracked worktree) and worktree.reserved. Use for: claiming a worktree for the current process before it does isolated work. Do NOT use for: reading the governed set (use worktrees); freeing a claim (use release_worktree).',
      schema: z
        .object({
          repoRoot: z.string().min(1),
          worktreeId: z.string().min(1),
          path: z.string().min(1).optional(),
          featureId: featureIdSchema.optional(),
          /**
           * `ownerPid` and `ownerStartedAt` describe one real process, so both are given or neither.
           * With neither, they come from the current process. The refine and the handler both
           * reject a partial override. In Zod v4, `.refine()` keeps a ZodObject, so `.shape` still works.
           */
          ownerPid: z.number().int().positive().optional(),
          ownerStartedAt: z.string().min(1).optional(),
        })
        .refine(
          (v) => (v.ownerPid === undefined) === (v.ownerStartedAt === undefined),
          {
            message:
              'ownerPid and ownerStartedAt must be provided together (both or neither)',
          },
        ),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: withCappedShape(AcquireWorktreeOutputSchema),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('worktree acquire has no admission gate or approval discriminant'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'worktree.reserved' }),
      needs: declared('fs:read', 'fs:write'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'worktree', selector: 'worktreeId' },
          { kind: 'path', selector: 'repoRoot' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared(
        {
          event: 'worktree.adopted',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Per on-disk worktree not yet tracked',
        },
        { event: 'worktree.reserved', condition: 'always', owner: 'orchestrate', role: 'primary' },
      ),
    }
  ),
  contracted(
    {
      name: 'release_worktree',
      surface: 'worktree',
      description:
        "Release the caller's worktree reservation. Appends worktree.released for worktreeId; a no-op when nothing is held (idempotent). Auto-emits worktree.released. Use for: freeing a worktree the current process reserved once its isolated work is done. Do NOT use for: freeing another live owner's claim (refused — reaping a dead owner is reconcile_worktrees's job); deleting the worktree from disk (the harness removes worktrees with its own tools).",
      schema: z.object({
        worktreeId: z.string().min(1),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: withCappedShape(ReleaseWorktreeOutputSchema),
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('worktree release has no admission gate or approval discriminant'),
      ensures: declared({ source: 'event-append', when: 'success', event: 'worktree.released' }),
      needs: none('release appends a reservation-free event and does not require a filesystem capability'),
      touches: {
        frame: 'single-machine',
        resources: declared({ kind: 'worktree', selector: 'worktreeId' }),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared({ event: 'worktree.released', condition: 'always', owner: 'orchestrate', role: 'primary' }),
    }
  ),
  /**
   * The ground-truth reconcilers. They append events, so they are an action and not part of a
   * read verb. Thus the surface that emits `launch.executed` and `worktree.orphan_detected` also declares them.
   */
  contracted(
    {
      name: 'reconcile_worktrees',
      surface: 'worktree',
      description:
        'Reconcile governed worktrees and in-flight operations against the ground-truth process table, healing what a dead holder left behind. Three fail-closed passes: reservation reclaim (a worktree whose owner is provably dead is released, or flagged an orphan when a live foreign process still holds the path); phantom-launch heal (an in-flight launch whose supervisor died uncatchably is closed with its terminal); crash-mid-merge heal (a stranded merge lease whose holder is provably dead is freed). A live or unprovable holder is ALWAYS left in flight. Returns each pass\'s findings plus the POST-reconcile in-flight columns. Idempotent: a second pass heals nothing and emits nothing. Auto-emits worktree.released / worktree.orphan_detected / launch.executed / worktree.merge_executed per healed entry. Use for: clearing liveness phantoms ps reports after a crash. Do NOT use for: reading in-flight state (use ps — read-only, heals nothing); releasing your OWN reservation (use release_worktree); deleting worktrees from disk (the harness removes worktrees with its own tools).',
      /**
       * No parameters. The passes cover the singleton `worktrees` stream and the process table.
       * Each heal needs a holder that is provably dead, so a dry-run default protects nothing.
       */
      schema: z.object({}),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: withCappedShape(ReconcileWorktreesOutputSchema),
      /** Heals converge and delete nothing on disk. The reclaim frees a reservation, not a worktree. */
      annotations: LOCAL_MUTATION_IDEMPOTENT,
    },
    {
      requires: none('reconcile has no admission gate; heals only when a holder is provably dead'),
      ensures: none('reconcile heals only when a holder is provably dead; a clean pass writes no required postcondition'),
      needs: none('reconcile reads the process table and appends heal events without a filesystem capability'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'worktree', selector: 'governed' },
          { kind: 'stream', selector: 'worktrees' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared(
        {
          event: 'worktree.released',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Per reservation whose owner is provably dead and whose path is free',
        },
        {
          event: 'worktree.orphan_detected',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Per reservation whose owner is provably dead and whose path a live foreign process still occupies',
        },
        {
          event: 'launch.executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Closes an in-flight launch whose supervisor died without running teardown',
        },
        {
          event: 'worktree.merge_executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Frees a merge lease whose holder is provably dead',
        },
      ),
    }
  ),
];
