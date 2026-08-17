import { withCappedShape } from '../../../output-schema-declaration.js';
import { AcquireWorktreeOutputSchema, PruneWorktreesOutputSchema, ReleaseWorktreeOutputSchema, SerializeMergeOutputSchema } from '../../../verbs/worktree/schemas.js';
import { z } from 'zod';
import { COMPENSABLE_REMOTE, LOCAL_MUTATION_IDEMPOTENT } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD, featureIdSchema } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const worktreeActions: readonly BuiltinToolAction[] = [
  // ─── Worktree-lifecycle Actions (WLM foundation, task 008) ────────────────
  // INV-5d: ACTIONS on exarchos_orchestrate, NOT a fifth visible tool. Each
  // delegates to the in-process `WorktreeManager` facade (INV-2 — adapters
  // carry zero behavior). `worktrees` (the read) rides exarchos_view.
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
    autoEmits: [
      { event: 'worktree.adopted', condition: 'conditional', description: 'Per on-disk worktree not yet tracked' },
      { event: 'worktree.reserved', condition: 'always' },
    ],
    outputSchema: withCappedShape(AcquireWorktreeOutputSchema),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
  {
    name: 'release_worktree',
    surface: 'worktree',
    description:
      "Release the caller's worktree reservation. Appends worktree.released for worktreeId; a no-op when nothing is held (idempotent). Auto-emits worktree.released. Use for: freeing a worktree the current process reserved once its isolated work is done. Do NOT use for: freeing another live owner's claim (refused — reaping a dead owner is ps probe:true / reconcile's job); deleting the worktree from disk (use prune_worktrees).",
    schema: z.object({
      worktreeId: z.string().min(1),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'worktree.released', condition: 'always' },
    ],
    outputSchema: withCappedShape(ReleaseWorktreeOutputSchema),
    annotations: LOCAL_MUTATION_IDEMPOTENT,
  },
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
    autoEmits: [
      { event: 'worktree.remove.requested', condition: 'conditional', description: 'Per delete-eligible candidate on an apply run' },
      { event: 'worktree.remove.executed', condition: 'conditional', description: 'After each git worktree remove succeeds' },
    ],
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
    annotations: {
      safety: 'compensable',
      readOnly: false,
      destructive: true,
      idempotent: true,
      openWorld: false,
    },
  },
  // ─── Integration-branch merge serializer (WLM operational core, DR-7) ──────
  // INV-5d: an ACTION on exarchos_orchestrate, NOT a fifth visible tool. An
  // OPTIMISTIC LEASE over `integrationRef` — the right to merge `sourceBranch`
  // into `integrationRef` lives in the event log (the
  // worktree.merge_requested / worktree.merge_executed pair on the singleton
  // `worktrees` stream), enforcing at most one in-flight merge per integration
  // ref. It then composes `merge_orchestrate` UNCHANGED for the git work. No
  // flock / PID file / advisory-lock library — the lease IS the serialization.
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
    autoEmits: [
      { event: 'worktree.merge_requested', condition: 'conditional', description: 'The lease CLAIM (single-writer per integrationRef) — apply run only (dryRun:false)' },
      { event: 'worktree.merge_executed', condition: 'conditional', description: 'The lease RELEASE (plain keyed append) — apply run only (dryRun:false)' },
    ],
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
];
