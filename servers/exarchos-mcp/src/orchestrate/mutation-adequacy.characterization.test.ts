// ─── mutation-adequacy PIN — review-dimension + action rosters ──────────────
//
// Per Michael Feathers, "Working Effectively with Legacy Code": these tests
// pin the CURRENT (pre-slice-3) shape of two cross-surface rosters so the R5
// reshape can be proven to land deliberately and nowhere else:
//
//   1. the required-review dimension roster (`getRequiredReviews` per workflow
//      type) — R5 adds the `mutation-adequacy` review dimension (task 007);
//   2. the `exarchos_orchestrate` action roster (names + count) — R5 adds the
//      `mutation-adequacy` action (task 003).
//
// Both assertions MUST PASS on unmodified HEAD. When tasks 003 / 007 land they
// will FAIL by exactly one entry; the agent landing them updates the pinned
// expectations in the same change (the deliberate-update protocol — a roster
// drift that is NOT the slice-3 addition is then a real regression, caught
// here). Do not "fix" anything observed below — this is a regression backstop.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import { getRequiredReviews } from '../workflow/review-contract.js';
import { TOOL_REGISTRY } from '../registry.js';

describe('mutation-adequacy roster characterization (PIN)', () => {
  // ── Review-dimension roster ──────────────────────────────────────────────
  //
  // `getRequiredReviews` is keyed by WORKFLOW TYPE (not risk tier). R5's
  // `mutation-adequacy` dimension is wired for the HIGH tier at the /review
  // boundary (task 007) — that wiring will change this pinned output. Today
  // only the `feature` workflow declares required reviews; every other
  // workflow type (and any unknown type) yields the empty contract.
  describe('ReviewDimensionRoster_CurrentBuild_StablePerWorkflowType', () => {
    it('feature workflow requires exactly review', () => {
      expect(getRequiredReviews('feature')).toEqual(['review']);
    });

    it('non-feature and unknown workflow types declare no required reviews', () => {
      for (const workflowType of ['debug', 'refactor', 'oneshot', 'discovery', 'unknown-type']) {
        expect(getRequiredReviews(workflowType)).toEqual([]);
      }
    });

    // R5 (task 007) made the contract tier-aware: the HIGH risk tier adds the
    // `mutation-adequacy` adequacy backstop at the /review boundary. This pin
    // was updated DELIBERATELY when task 007 landed (the deliberate-update
    // protocol). The no-tier per-workflow-type assertions above are unchanged
    // (backward-compat); a drift in EITHER set that is not this single tier
    // addition is a real regression, caught here.
    it('feature workflow at the HIGH tier adds exactly mutation-adequacy', () => {
      expect(getRequiredReviews('feature', 'high')).toEqual([
        'review',
        'mutation-adequacy',
      ]);
    });

    it('medium / low tiers reproduce the no-tier roster (high-tier-only)', () => {
      expect(getRequiredReviews('feature', 'medium')).toEqual(['review']);
      expect(getRequiredReviews('feature', 'low')).toEqual(['review']);
    });
  });

  // ── exarchos_orchestrate action roster ───────────────────────────────────
  //
  // Derived from the registry SoT (`TOOL_REGISTRY`), not re-declared, so the
  // pin tracks the live surface. R5's `mutation-adequacy` ACTION (INV-5d — an
  // action, never a 5th tool) landed on this tool (task 003), taking the count
  // from 71 → 72 and adding the name. This pin was updated DELIBERATELY when
  // task 003 landed (the deliberate-update protocol) — a roster drift that is
  // NOT this single addition is a real regression, caught here.
  describe('OrchestrateActionRoster_CurrentBuild_PinnedActionSet', () => {
    const orchestrate = TOOL_REGISTRY.find((t) => t.name === 'exarchos_orchestrate');
    const actionNames = (orchestrate?.actions ?? []).map((a) => a.name);

    it('exposes exactly 77 actions (WLM operational-core #1578 added serialize_merge; DR-4 (#1630) added check_exploration_depth; WLM foundation task 008 added acquire_worktree, release_worktree, prune_worktrees; #1587 retired check_tdd_compliance; #1581 task 018 added discover_bridge)', () => {
      expect(orchestrate).toBeDefined();
      expect(actionNames).toHaveLength(77);
    });

    it('carries the mutation-adequacy action (R5 / task 003)', () => {
      expect(actionNames).toContain('mutation-adequacy');
    });

    it('pins the current (sorted) action name set', () => {
      expect([...actionNames].sort()).toEqual([
        'acquire_worktree',
        'add_pr_comment',
        'agent_spec',
        'assess_refactor_scope',
        'assess_stack',
        'check_ci',
        'check_coderabbit',
        'check_context_economy',
        'check_contract_drift',
        'check_convergence',
        'check_coverage_thresholds',
        'check_design_completeness',
        'check_event_emissions',
        'check_exploration_depth',
        'check_integration_suite',
        'check_invariant_conformance',
        'check_mock_boundary',
        'check_operational_resilience',
        'check_plan_coverage',
        'check_polish_scope',
        'check_post_merge',
        'check_pr_comments',
        'check_provenance_chain',
        'check_review_verdict',
        'check_security_scan',
        'check_static_analysis',
        'check_task_decomposition',
        'check_test_adequacy',
        'check_workflow_determinism',
        'classify_review_items',
        'create_issue',
        'create_pr',
        'debug_review_gate',
        'describe',
        'discover_bridge',
        'doctor',
        'extract_fix_tasks',
        'extract_task',
        'finalize_oneshot',
        'generate_traceability',
        'get_pr_comments',
        'invariants_add',
        'invariants_scaffold',
        'investigation_timer',
        'list_prs',
        'merge_orchestrate',
        'merge_pr',
        'mutation-adequacy',
        'needs_schema_sync',
        'onboard',
        'post_delegation_check',
        'pre_synthesis_check',
        'prepare_delegation',
        'prepare_review',
        'prepare_synthesis',
        'prune_stale_workflows',
        'prune_worktrees',
        'reconcile_state',
        'release_worktree',
        'request_synthesize',
        'review_diff',
        'review_triage',
        'runbook',
        'select_debug_track',
        'serialize_merge',
        'setup_worktree',
        'spec_coverage_check',
        'task_claim',
        'task_complete',
        'task_fail',
        'validate_pr_body',
        'validate_pr_stack',
        'verify_delegation_saga',
        'verify_doc_links',
        'verify_review_triage',
        'verify_worktree',
        'verify_worktree_baseline',
      ]);
    });
  });
});
