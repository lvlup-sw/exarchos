import { z } from 'zod';

/**
 * Pure, harness-neutral domain types for the onboarding reconciler (DR-1).
 *
 * These are the foundation every later onboarding task builds on:
 *   - detect (task 005) produces a {@link DesiredState}
 *   - diff   (task 006) turns desired + actual into a {@link ReconcilePlan}
 *   - apply  (task 007) executes a plan and returns a {@link ReconcileResult}
 *
 * Zod schemas are the source of truth; the exported `type`s are derived via
 * `z.infer`. No behavior lives here — schemas + types only (INV-2 facade:
 * behavior belongs in `reconcile.ts`, never the adapters).
 */

// ─── Surface ────────────────────────────────────────────────────────────────

/**
 * The capability surface a reconcile step requires.
 *
 * - `'any'`      — runnable on any harness path (config writes, generate, hooks).
 * - `'cli-only'` — gated to the CLI path (e.g. skills-bundle install). When the
 *   reconciler runs from a non-CLI surface, such steps are downgraded to an
 *   {@link Advisory} instead of being executed (DR-6).
 */
export const SurfaceSchema = z.enum(['any', 'cli-only']);
export type Surface = z.infer<typeof SurfaceSchema>;

// ─── PlanStep ─────────────────────────────────────────────────────────────

/**
 * The kind of work a reconcile step performs.
 *
 * - `'config'`   — reconcile `.exarchos.yml` / `.exarchos/` / invariants catalog.
 * - `'generate'` — emit per-runtime artifacts via the existing `init` writers.
 * - `'install'`  — install the skills bundle / project deps (typically cli-only).
 * - `'hook'`     — bind lifecycle hooks (DR-8).
 */
export const PlanStepKindSchema = z.enum(['config', 'generate', 'install', 'hook']);
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>;

/**
 * A single, idempotent reconcile step. The `surface` tag lets the executor gate
 * CLI-only steps (DR-6); `key` is a stable identifier for diff/idempotence.
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
  /** Optional path or identifier the step acts on (e.g. a file or runtime id). */
  target: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

// ─── DesiredState ───────────────────────────────────────────────────────────

/**
 * Resolver-derived commands for the target repo. Each field is optional because
 * the layered resolver (override > `.exarchos.yml` > user `toolchains:` >
 * task-runner > registry) may leave a field unresolved. The shape only — the
 * derivation lives in detect (task 005).
 *
 * The field set tracks the verification ladder, not just the legacy test
 * triple: `mutation` and `lint` join `test`/`typecheck`/`install` so onboard /
 * doctor resolve and surface the wider verification surface (task 007, design
 * §4.5-detect). Both new fields carry the SAME optionality semantics as the
 * legacy three — the resolver may leave either unresolved, in which case detect
 * OMITS it (INV-6 omit-never-fabricate).
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
 * The derived reconcile target: detected runtimes + VCS plus resolver-derived
 * commands. Produced by `detectDesiredState` (task 005).
 */
export const DesiredStateSchema = z.object({
  /** Detected agent-host runtime ids (e.g. `claude-code`, `codex`). */
  runtimes: z.array(z.string()),
  /** Detected VCS identifier (e.g. `git`, `none`). */
  vcs: z.string(),
  /** Commands derived by the layered resolver. */
  commands: ResolvedCommandsSchema,
});
export type DesiredState = z.infer<typeof DesiredStateSchema>;

// ─── Advisory ─────────────────────────────────────────────────────────────

/**
 * A surface-gated advisory the reconciler returns instead of executing a step
 * it cannot run on the current surface (e.g. the cli-only MCP/skills install
 * advisory: `{ surface: 'cli-only', commands: ['exarchos onboard'] }`).
 */
export const AdvisorySchema = z.object({
  /** Surface the advised action requires. */
  surface: SurfaceSchema,
  /** Human-readable explanation of the advised action. */
  message: z.string().min(1),
  /** Optional commands the operator should run to satisfy the advisory. */
  commands: z.array(z.string()).optional(),
});
export type Advisory = z.infer<typeof AdvisorySchema>;

// ─── ReconcilePlan ──────────────────────────────────────────────────────────

/**
 * The structured reconcile plan (= the structured `doctor` diff). An empty
 * plan (`{ steps: [] }`) is valid and `apply` over it is a no-op (idempotence).
 */
export const ReconcilePlanSchema = z.object({
  steps: z.array(PlanStepSchema),
});
export type ReconcilePlan = z.infer<typeof ReconcilePlanSchema>;

// ─── ReconcileResult ────────────────────────────────────────────────────────

/**
 * The outcome of applying a {@link ReconcilePlan}: which steps were applied,
 * skipped, or left residual, plus any surface-gated advisories.
 */
export const ReconcileResultSchema = z.object({
  /** Steps that were executed successfully. */
  applied: z.array(PlanStepSchema),
  /** Steps intentionally not executed (already reconciled / surface-gated). */
  skipped: z.array(PlanStepSchema),
  /** Steps that remain unreconciled after apply (e.g. blocked / failed). */
  residual: z.array(PlanStepSchema),
  /** Surface-gated advisories returned in lieu of execution. */
  advisories: z.array(AdvisorySchema),
});
export type ReconcileResult = z.infer<typeof ReconcileResultSchema>;
