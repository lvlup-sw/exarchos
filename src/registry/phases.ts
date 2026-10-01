import { z } from 'zod';

export const ALL_PHASES: ReadonlySet<string> = new Set([
  /** Feature workflow. */
  'plan',
  'plan-review',
  'delegate',
  /**
   * The substate of `delegate` while a worktree task's autonomous merge is pending. It must be in
   * this set, so phase-gated actions such as `merge_orchestrate` stay available in it.
   */
  'merge-pending',
  'review',
  'synthesize',
  /** Debug workflow. */
  'triage',
  'investigate',
  'rca',
  'design',
  'debug-implement',
  'debug-validate',
  'debug-review',
  'hotfix-implement',
  'hotfix-validate',
  /** Refactor workflow. */
  'explore',
  'brief',
  'polish-implement',
  'polish-validate',
  'polish-update-docs',
  'overhaul-plan',
  'overhaul-delegate',
  'overhaul-review',
  'overhaul-update-docs',
  /**
   * The oneshot workflow phase after `plan`. It must be in this set, so generic actions gated by
   * `ALL_PHASES` stay available during a oneshot.
   */
  'implementing',
  /** Shared by all workflows. */
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
/**
 * The phases of `prepare_review`: the review phases and `plan-review`. This set must not equal
 * `PLAN_PHASES`, because an action with exactly that phase set counts as a plan gate.
 * `prepare_review` is a non-blocking provisioning surface, not a gate.
 */
export const PREPARE_REVIEW_PHASES: ReadonlySet<string> = new Set([
  ...REVIEW_PHASES,
  'plan-review',
]);

export const featureIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/);
