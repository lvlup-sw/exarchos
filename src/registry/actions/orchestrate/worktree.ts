import { withCappedShape } from '../../../output-schema-declaration.js';
import { AcquireWorktreeOutputSchema, PruneWorktreesOutputSchema, ReconcileWorktreesOutputSchema, ReleaseWorktreeOutputSchema, SerializeMergeOutputSchema } from '../../../verbs/worktree/schemas.js';
import { z } from 'zod';
import { declared, none, withActionContract } from '../../action-contract.js';
import { COMPENSABLE_REMOTE, LOCAL_MUTATION_IDEMPOTENT } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function contracted(action: BuiltinActionDraft, contract: unknown): BuiltinToolAction {
  return withActionContract(action, contract, { annotations: action.annotations });
}

/**
 * The annotations of `prune_worktrees`. The prune is compensable and destructive, because the
 * two-event delete is the recovery seam. It is idempotent, because a re-run deletes only what is
 * still eligible. No preset has this tuple.
 */
const PRUNE_ANNOTATIONS = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
} as const;

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
        "Release the caller's worktree reservation. Appends worktree.released for worktreeId; a no-op when nothing is held (idempotent). Auto-emits worktree.released. Use for: freeing a worktree the current process reserved once its isolated work is done. Do NOT use for: freeing another live owner's claim (refused — reaping a dead owner is reconcile_worktrees's job); deleting the worktree from disk (use prune_worktrees).",
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
  contracted(
    {
      name: 'prune_worktrees',
      surface: 'worktree',
      description:
        'Garbage-collect governed worktrees through the fail-closed safety ladder. Defaults to dry-run (report candidates + reclaimable bytes + grouped skip reasons, delete nothing); pass dryRun:false to apply. Orphan deletion needs pruneOrphans:true + yes:true on an apply run. Auto-emits worktree.remove.requested then worktree.remove.executed per deleted worktree. Use for: reclaiming released/orphan governed worktrees + their branches from the main worktree. Do NOT use for: freeing a live reservation (use release_worktree); listing the governed set (use worktrees).',
      schema: z.object({
        repoRoot: z.string().min(1),
        /**
         * Dry-run is the safe default, and only `dryRun: false` applies. The handler applies the
         * default, not a Zod `.default()`, because the MCP flattener rejects different defaults
         * for the shared `dryRun` field.
         */
        dryRun: z.boolean().optional(),
        pruneOrphans: z.boolean().optional(),
        yes: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      /**
       * The prune deletes shared worktrees and branches from the main worktree, so it has the
       * strictest mutating posture. The resolver gate rejects a task-isolated or read-only caller
       * before the prune runs.
       */
      posture: 'shared-mutating',
      outputSchema: withCappedShape(PruneWorktreesOutputSchema),
      annotations: PRUNE_ANNOTATIONS,
    },
    {
      requires: none('prune has no admission gate; dry-run is the handler default'),
      ensures: declared({ source: 'event-append', when: 'always', event: 'prune.executed' }),
      needs: declared('fs:write', 'shell:exec'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'worktree', selector: 'governed' },
          { kind: 'path', selector: 'repoRoot' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'safe-repeat' },
      emissions: declared(
        {
          event: 'worktree.remove.requested',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Per delete-eligible candidate on an apply run',
        },
        {
          event: 'worktree.remove.executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'After each git worktree remove succeeds',
        },
        {
          event: 'prune.executing_started',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Once per prune pass, before the safety ladder',
        },
        {
          event: 'prune.executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'Closes the pass exactly once, including on a throw',
        },
      ),
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
        'Reconcile governed worktrees and in-flight operations against the ground-truth process table, healing what a dead holder left behind. Three fail-closed passes: reservation reclaim (a worktree whose owner is provably dead is released, or flagged an orphan when a live foreign process still holds the path); phantom-launch heal (an in-flight launch whose supervisor died uncatchably is closed with its terminal); crash-mid-merge heal (a stranded merge lease whose holder is provably dead is freed). A live or unprovable holder is ALWAYS left in flight. Returns each pass\'s findings plus the POST-reconcile in-flight columns. Idempotent: a second pass heals nothing and emits nothing. Auto-emits worktree.released / worktree.orphan_detected / launch.executed / worktree.merge_executed per healed entry. Use for: clearing liveness phantoms ps reports after a crash. Do NOT use for: reading in-flight state (use ps — read-only, heals nothing); releasing your OWN reservation (use release_worktree); deleting worktrees from disk (use prune_worktrees).',
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
  /**
   * The integration-branch merge serializer. An optimistic lease in the event log allows at most
   * one in-flight merge per `integrationRef`. The `worktree.merge_requested` and
   * `worktree.merge_executed` pair on the `worktrees` stream holds the lease. Then `merge_orchestrate`
   * does the git work. No file lock is used.
   */
  contracted(
    {
      name: 'serialize_merge',
      surface: 'worktree',
      description:
        'Serialize an integration-branch merge behind an optimistic per-integrationRef lease, then compose merge_orchestrate UNCHANGED. DEFAULTS TO DRY-RUN (INV-5c): omitting dryRun (or dryRun:true) claims NO lease, runs NO merge, and returns the planned effect (integration head + merge params); pass dryRun:false to actually claim the lease and execute. Grants at most one in-flight merge per integrationRef: a held slot bounded-waits (re-folding worktrees@v1) and reclaims a provably-dead holder inline, or returns a structured merge-slot-timeout. Auto-emits worktree.merge_requested (claim) then worktree.merge_executed (release) ONLY on an apply run. Use for: landing a source branch onto a shared integration ref under cross-process serialization. Do NOT use for: a single unsynchronized merge (use merge_orchestrate); a raw provider PR merge (use merge_pr).',
      schema: z.object({
        featureId: z.string().min(1),
        integrationRef: z.string().min(1),
        sourceBranch: z.string().min(1),
        strategy: z.enum(['squash', 'rebase', 'merge']),
        taskId: z.string().optional(),
        repoRoot: z.string().optional(),
        /**
         * The wait budget before `merge-slot-timeout`. It has the same base type as
         * `doctor.timeoutMs`, so the MCP flattener sees one shape for the shared field name.
         */
        timeoutMs: z.number().int().positive().optional(),
        /**
         * Dry-run is the safe default, and only `dryRun: false` applies. `handleSerializeMerge`
         * applies the default, because the MCP flattener rejects different defaults for the shared
         * `dryRun` field. A dry run emits no lease event.
         */
        dryRun: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      /**
       * An advisory hint. The serialized merge has many steps (wait, claim, merge, release), so it
       * suits Tasks-augmented dispatch, like `merge_orchestrate`.
       */
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      /**
       * The merge changes the integration branch and the working tree from the main worktree, so
       * it has the strictest mutating posture, like `merge_orchestrate`.
       */
      posture: 'shared-mutating',
      outputSchema: withCappedShape(SerializeMergeOutputSchema),
      annotations: COMPENSABLE_REMOTE,
    },
    {
      requires: none('serialize-merge admission is the in-handler lease wait, not an authored obligation discriminant'),
      ensures: none('lease events append only on an apply run; dry-run success has no durable postcondition'),
      needs: declared('fs:write', 'shell:exec'),
      touches: {
        frame: 'single-machine',
        resources: declared(
          { kind: 'stream', selector: 'featureId' },
          { kind: 'git-ref', selector: 'integrationRef' },
          { kind: 'git-ref', selector: 'sourceBranch' },
        ),
      },
      executionAuthority: { kind: 'local' },
      replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      emissions: declared(
        {
          event: 'worktree.merge_requested',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'The lease CLAIM (single-writer per integrationRef) — apply run only (dryRun:false)',
        },
        {
          event: 'worktree.merge_executed',
          condition: 'conditional',
          owner: 'orchestrate',
          role: 'primary',
          description: 'The lease RELEASE (plain keyed append) — apply run only (dryRun:false)',
        },
      ),
    }
  ),
];
