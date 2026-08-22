import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { COMPENSABLE_REMOTE } from '../../annotations.js';
import { ALL_PHASES, ROLE_LEAD } from '../../phases.js';
import type { BuiltinToolAction } from '../../types.js';

export const mergeActions: readonly BuiltinToolAction[] = [
  // ─── Merge Orchestrator (DR-MO-1) ─────────────────────────────────────────
  {
    name: 'merge_orchestrate',
    description: 'Top-level merge orchestrator (DR-MO-1): runs preflight, emits merge.preflight, then delegates to the executor on pass; handles abort/dryRun/resume. Use for: merging a task/feature source branch into the integration target with full preflight + compensating recovery from the main worktree. Do NOT use for: a raw provider PR/MR merge (use merge_pr); verifying a directory is a git worktree (use verify_worktree); or requesting synthesis/PR creation on a oneshot workflow (use request_synthesize).',
    schema: z.object({
      featureId: z.string().min(1),
      sourceBranch: z.string().min(1),
      targetBranch: z.string().min(1),
      taskId: z.string().optional(),
      // Required-no-default — matches `merge_pr.strategy` per #1127, gives
      // CLI/MCP user-visible parity (#1109 §2), and keeps operator intent
      // explicit in the event log (DIM-2 / DIM-3).
      strategy: z.enum(['squash', 'rebase', 'merge']),
      dryRun: z.boolean().optional(),
      resume: z.boolean().optional(),
      repoRoot: z.string().optional(),
      // DR-2 single-writer lease guard: the caller-presented merge-lease
      // correlator. When the target integration ref carries an in-flight
      // `worktrees@v1` lease whose holder `operationId` differs from this
      // value AND the holder is not provably dead, the handler fails closed
      // (route through `serialize_merge`). `serialize_merge` threads its own
      // lease `operationId` here so its composed call passes the guard; a
      // crash-resumed caller presents the ORIGINAL claim's `operationId`.
      // Optional string — the SOLE declaration of this field across the
      // registry, so `buildRegistrationSchema` sees no same-name base-type
      // collision. Omitting it preserves today's no-lease behavior.
      leaseOperationId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_LEAD,
    autoEmits: [
      { event: 'merge.preflight', condition: 'always', role: 'primary', owner: 'orchestrate' },
      { event: 'merge.executed', condition: 'conditional', description: 'When preflight passes and execute succeeds', role: 'primary', owner: 'orchestrate' },
      // DR-2 (task 006): recovery emits ONLY the canonical `merge.recovered`.
      // The legacy `merge.rollback` write path is retired (read-tolerant, not
      // emittable) so it is NO LONGER declared here — a `retired` event must not
      // appear in any `autoEmits` (RegistryDrift enforces `autoEmits ⊆ auto`).
      // Compensation terminal for the merge saga — the only emitter of this
      // event, not a backstop for another primary edge.
      { event: 'merge.recovered', condition: 'conditional', description: 'When execute fails and the INV-14 recovery ladder runs', role: 'primary', owner: 'orchestrate' },
      // The terminal marker, appended by `execute-merge.ts` in the same dispatch that already
      // declares `merge.executed`. A losing concurrent invocation returns STATE_CONFLICT and
      // defers completion to the winner, so this is conditional rather than always.
      { event: 'merge.completed', condition: 'conditional', description: 'After the merge lands and the terminal marker is written', role: 'primary', owner: 'orchestrate' },
    ],
    // T9 (#1440 Op 2, preview-4 design §4.3): multi-step git merge
    // orchestration (preflight → execute → optional rollback) is the
    // canonical long-running verb and benefits from Tasks-augmented
    // dispatch. Advisory — the binding opt-in gate stays at
    // `dispatch/core/dispatch.ts:927-954`.
    dispatch: { taskSuitable: true, taskTtlSuggestionMs: 60_000 },
    // DR-5 (task 076): `merge-orchestrate` is promoted to a top-level verb from
    // HERE, the registry declaration — not by a hand-written
    // `.command('merge-orchestrate')` in the composition root. Task 023 found
    // that duplicate declaration while seeding G1's allowlist: the verb was
    // declared twice (registry action + composition root), which is the
    // multiply-owned-representation defect DR-5 exists to eliminate, and the
    // guard's kill fixture refuses to exempt it. The DR-7 hoist loop reads this
    // hint and routes the top-level command through `registerActionCommand` —
    // the same schema, handler and exit-code ladder as the `orch
    // merge-orchestrate` subcommand form. The operator-visible surface is
    // UNCHANGED (`exarchos merge-orchestrate …` still works), so no rename stub
    // or deprecation window is spent: this is a change of WHERE the name is
    // declared, not WHETHER the verb exists.
    cli: { topLevel: 'merge-orchestrate' },
    // #1305 T13: merge_orchestrate mutates shared state (the integration
    // branch, the working tree, the event store) from the main worktree with
    // no worktree isolation — the strictest mutating trust tier. The resolver
    // mints fs:write + shell:exec from this posture.
    posture: 'shared-mutating',
    outputSchema: vacuityWaiver('exarchos_orchestrate.merge_orchestrate'),
    annotations: COMPENSABLE_REMOTE,
  },
];
