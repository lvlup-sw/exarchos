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

const PRUNE_ANNOTATIONS = {
  safety: 'compensable',
  readOnly: false,
  destructive: true,
  idempotent: true,
  openWorld: false,
} as const;

export const worktreeActions: readonly BuiltinToolAction[] = [
  // ─── Worktree-lifecycle Actions (WLM foundation, task 008) ────────────────
  // INV-5d: ACTIONS on exarchos_orchestrate, NOT a fifth visible tool. Each
  // delegates to the in-process `WorktreeManager` facade (INV-2 — adapters
  // carry zero behavior). `worktrees` (the read) rides exarchos_view.
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
          // All-or-nothing: a (pid, startedAt) tuple must describe ONE real
          // process. Both explicit, or neither (then both are derived from the
          // current process). A partial override is rejected by the refine below
          // AND by the handler — keeping the schema and resolveOwner in sync. In
          // Zod v4 `.refine()` keeps the value a ZodObject, so `.shape` still
          // drives buildRegistrationSchema / addFlagsFromSchema.
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
        // INV-5c: dry-run is the safe default. The default is enforced in the
        // handler (dryRun === false ⇒ apply) — NOT a Zod `.default()` — because
        // the MCP-registration flattener forbids divergent defaults across the
        // shared `dryRun` field (merge_orchestrate / prune_stale_workflows
        // already declare it `.optional()` with no default).
        dryRun: z.boolean().optional(),
        pruneOrphans: z.boolean().optional(),
        yes: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      // prune_worktrees → compensable + destructive (the two-event delete split
      // is the compensating recovery seam) AND idempotent (a re-run re-classifies
      // and deletes only what is still eligible). No preset carries this exact
      // tuple, so it is declared inline; the `superRefine` constraint
      // (destructive ⇒ compensable) is satisfied.
      // DR-4 / INV-11: garbage-collects governed worktrees + their branches —
      // shared, un-isolated state destroyed from the main worktree, the strictest
      // mutating trust tier. Mirrors merge_orchestrate / serialize_merge so the
      // resolver gate rejects a task-isolated or read-only caller BEFORE the
      // destructive prune runs.
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
  // ─── Ground-truth reconcilers (moved off the read side) ───────────────────
  // These three passes ran under `exarchos_view.ps probe:true`. They append,
  // and their appends live in `verbs/` — reached from a manager method and two
  // reconcilers — so no annotation on a read verb could make the effect true.
  // Giving them their own action is what lets the events they raise be DECLARED
  // by the surface that performs them: `launch.executed` and
  // `worktree.orphan_detected` were registered to `exarchos_orchestrate` and
  // emitted from `exarchos_view`, which is the disagreement this closes.
  contracted(
    {
      name: 'reconcile_worktrees',
      surface: 'worktree',
      description:
        'Reconcile governed worktrees and in-flight operations against the ground-truth process table, healing what a dead holder left behind. Three fail-closed passes: reservation reclaim (a worktree whose owner is provably dead is released, or flagged an orphan when a live foreign process still holds the path); phantom-launch heal (an in-flight launch whose supervisor died uncatchably is closed with its terminal); crash-mid-merge heal (a stranded merge lease whose holder is provably dead is freed). A live or unprovable holder is ALWAYS left in flight. Returns each pass\'s findings plus the POST-reconcile in-flight columns. Idempotent: a second pass heals nothing and emits nothing. Auto-emits worktree.released / worktree.orphan_detected / launch.executed / worktree.merge_executed per healed entry. Use for: clearing liveness phantoms ps reports after a crash. Do NOT use for: reading in-flight state (use ps — read-only, heals nothing); releasing your OWN reservation (use release_worktree); deleting worktrees from disk (use prune_worktrees).',
      // No parameters: the passes are repo-global over the singleton `worktrees`
      // stream and the process table. Nothing to scope, and nothing to dry-run —
      // every heal is conditioned on a holder being PROVABLY dead, so there is no
      // unsafe apply for a dry-run default to protect against.
      schema: z.object({}),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      outputSchema: withCappedShape(ReconcileWorktreesOutputSchema),
      // Heals converge and destroy nothing on disk — the reclaim frees a
      // RESERVATION, not a worktree. Same tuple `ps` used to carry for the same
      // write path, which is the point: the effect did not change, only the
      // surface that owns it.
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
  // ─── Integration-branch merge serializer (WLM operational core, DR-7) ──────
  // INV-5d: an ACTION on exarchos_orchestrate, NOT a fifth visible tool. An
  // OPTIMISTIC LEASE over `integrationRef` — the right to merge `sourceBranch`
  // into `integrationRef` lives in the event log (the
  // worktree.merge_requested / worktree.merge_executed pair on the singleton
  // `worktrees` stream), enforcing at most one in-flight merge per integration
  // ref. It then composes `merge_orchestrate` UNCHANGED for the git work. No
  // flock / PID file / advisory-lock library — the lease IS the serialization.
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
        // Bounded-wait budget before merge-slot-timeout. Same base type
        // (ZodNumber) as `doctor.timeoutMs` so the MCP-registration flattener
        // does not see a divergent shape for the shared `timeoutMs` field name.
        timeoutMs: z.number().int().positive().optional(),
        // INV-5c safe default: dry-run unless the caller EXPLICITLY opts out with
        // dryRun:false. Declared `.optional()` with NO Zod `.default()` because the
        // MCP-registration flattener forbids divergent defaults across the shared
        // `dryRun` field (prune_worktrees / merge_orchestrate / prune_stale_workflows
        // all declare it `.optional()` with no default); the default is applied in
        // handleSerializeMerge instead.
        dryRun: z.boolean().optional(),
      }),
      phases: ALL_PHASES,
      roles: ROLE_LEAD,
      // Descriptive only (NOT the control point — the handler applies the dry-run
      // default). On the default dry-run NOTHING is emitted; both lease events fire
      // only on an apply run (dryRun:false).
      // Multi-step serialized merge (wait → claim → compose merge_orchestrate →
      // release) is the canonical long-running verb — advisory Tasks-augmented
      // dispatch, mirroring merge_orchestrate.
      dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
      // Mutates shared state (the integration branch + working tree, via the
      // composed merge_orchestrate) from the main worktree — the strictest
      // mutating trust tier. Mirrors merge_orchestrate so the resolver mints the
      // same fs:write + shell:exec capabilities.
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
