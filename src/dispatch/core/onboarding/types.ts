/**
 * Harness-neutral domain types for the onboarding reconciler. Detection produces a
 * {@link DesiredState}, `diff` produces a {@link ReconcilePlan}, and `apply` returns a
 * {@link ReconcileResult}.
 *
 * The Zod schemas are the source of truth, and each exported type comes from `z.infer`. The
 * behavior is in `reconcile.ts`.
 */
import { z } from 'zod';

/**
 * The capability surface that a reconcile step needs. An `any` step runs on every harness path. A
 * `cli-only` step, such as a skills-bundle install, runs only on the CLI path. On another surface,
 * the reconciler returns an {@link Advisory} for it.
 */
export const SurfaceSchema = z.enum(['any', 'cli-only']);
export type Surface = z.infer<typeof SurfaceSchema>;

/**
 * The kind of work that a reconcile step does.
 *
 * - `config` reconciles `.exarchos.yml`, `.exarchos/`, or the invariants catalog.
 * - `generate` writes per-runtime artifacts through the `init` writers.
 * - `install` installs the skills bundle or the project dependencies.
 * - `hook` binds or removes lifecycle hooks.
 */
export const PlanStepKindSchema = z.enum(['config', 'generate', 'install', 'hook']);
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>;

/**
 * One idempotent reconcile step. The `surface` tag lets the executor gate CLI-only steps.
 */
export const PlanStepSchema = z.object({
  /** What category of work this step performs. */
  kind: PlanStepKindSchema,
  /** Capability surface required to execute this step. */
  surface: SurfaceSchema,
  /** Stable identifier for this step (used for diffing and idempotence). */
  key: z.string().min(1),
  /** Human-readable description of what the step reconciles. */
  description: z.string().min(1),
  /** Optional path or identifier that the step acts on, such as a file or a runtime id. */
  target: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * Resolver-derived commands for the target repo, one field for each verification-ladder command.
 * The layered resolver can leave any field unresolved, and detection then omits that field.
 */
export const ResolvedCommandsSchema = z.object({
  test: z.string().optional(),
  typecheck: z.string().optional(),
  install: z.string().optional(),
  mutation: z.string().optional(),
  lint: z.string().optional(),
});
export type ResolvedCommands = z.infer<typeof ResolvedCommandsSchema>;

/**
 * The reconcile target that `detectDesiredState` derives: the runtimes, the VCS, and the
 * resolver-derived commands.
 */
export const DesiredStateSchema = z.object({
  /** Detected agent-host runtime ids, such as `claude-code` or `codex`. */
  runtimes: z.array(z.string()),
  /** Detected VCS identifier, such as `git` or `none`. */
  vcs: z.string(),
  /** Commands derived by the layered resolver. */
  commands: ResolvedCommandsSchema,
});
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/**
 * A notice that the reconciler returns when it cannot run a step on the current surface, or when a
 * step needs attention from the operator.
 */
export const AdvisorySchema = z.object({
  /** Surface the advised action requires. */
  surface: SurfaceSchema,
  /** Human-readable explanation of the advised action. */
  message: z.string().min(1),
  /** Optional commands that the operator can run to resolve the advisory. */
  commands: z.array(z.string()).optional(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

/**
 * The structured reconcile plan (= the structured `doctor` diff). An empty
 * plan (`{ steps: [] }`) is valid and `apply` over it is a no-op (idempotence).
 */
export const ReconcilePlanSchema = z.object({
  steps: z.array(PlanStepSchema),
});
export type ReconcilePlan = z.infer<typeof ReconcilePlanSchema>;

/**
 * The outcome of applying a {@link ReconcilePlan}: which steps were applied,
 * skipped, or left residual, plus the advisories.
 */
export const ReconcileResultSchema = z.object({
  /** Steps that were executed successfully. */
  applied: z.array(PlanStepSchema),
  /** Steps that did not run on purpose, such as a config step that keeps a hand edit. */
  skipped: z.array(PlanStepSchema),
  /** Steps that remain unreconciled after apply, such as a failed step or a step that a gate blocked. */
  residual: z.array(PlanStepSchema),
  /** Notices for the operator, such as a surface-gated step, a step failure, or a forced overwrite. */
  advisories: z.array(AdvisorySchema),
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
