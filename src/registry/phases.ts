import { z } from 'zod';

// ─── Shared Constants ───────────────────────────────────────────────────────

export const ALL_PHASES: ReadonlySet<string> = new Set([
  // Feature workflow
  'plan',
  'plan-review',
  'delegate',
  // Substate of `delegate` — entered when a worktree-task's autonomous merge
  // is pending. Must be in this set so phase-gated actions (notably
  // `merge_orchestrate` itself) remain dispatchable while the workflow sits
  // in this phase.
  'merge-pending',
  'review',
  'synthesize',
  // Debug workflow
  'triage',
  'investigate',
  'rca',
  'design',
  'debug-implement',
  'debug-validate',
  'debug-review',
  'hotfix-implement',
  'hotfix-validate',
  // Refactor workflow
  'explore',
  'brief',
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
  'overhaul-plan',
  'overhaul-delegate',
  'overhaul-review',
  'overhaul-update-docs',
  // Oneshot workflow (compressed lifecycle: plan → implementing →
  // synthesize|completed). `plan` is already present above from the
  // feature workflow; `implementing` is oneshot-exclusive and MUST be in
  // this set so generic actions gated by ALL_PHASES (get / set / cancel /
  // event append / etc.) remain callable while a oneshot is mid-flight.
  'implementing',
  // Shared
  'blocked',
]);

export const ROLE_ANY: ReadonlySet<string> = new Set(['any']);
export const ROLE_LEAD: ReadonlySet<string> = new Set(['lead']);
export const ROLE_TEAMMATE: ReadonlySet<string> = new Set(['teammate']);

export const DELEGATE_PHASES: ReadonlySet<string> = new Set([
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
export const STACK_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'delegate',
  'overhaul-delegate',
  'debug-implement',
]);
export const REVIEW_PHASES: ReadonlySet<string> = new Set([
  'review',
  'overhaul-review',
  'debug-review',
]);
export const SYNTHESIS_REVIEW_PHASES: ReadonlySet<string> = new Set([
  'synthesize',
  'review',
  'overhaul-review',
  'debug-review',
]);
export const PLAN_PHASES: ReadonlySet<string> = new Set([
  'plan',
  'plan-review',
  'overhaul-plan',
]);
// `prepare_review` serves BOTH the back-of-pipeline code-review catalog (REVIEW
// phases) and the front-of-pipeline plan-review provisioning (the `plan-review`
// PLAN-kind phase). Deliberately NOT equal to the PLAN_PHASES set: an action
// whose phase set exactly equals the plan-structure binding is treated as a
// canonical plan gate, and `prepare_review` is not one — it is a non-blocking
// provisioning surface, discriminated by scope. Matching that set exactly would
// silently promote it into the gate population.
export const PREPARE_REVIEW_PHASES: ReadonlySet<string> = new Set([
  ...REVIEW_PHASES,
  'plan-review',
]);

// ─── Shared Schema Fragments ────────────────────────────────────────────────

export const featureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);
