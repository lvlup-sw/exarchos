/**
 * Persisted identifiers and registered action names stay stable when a module
 * is split.
 *
 * A dropped tool action still passes the type check, the lint, and each test
 * that does not use that action. A changed hash input makes each stored event
 * row stop matching the ids that the new code computes. The compiler sees
 * neither, so `tools/audit/registered-actions-snapshot.json` records them.
 *
 * The snapshot is a record and not a rule. A change to the snapshot must be in
 * the same commit as the change that it records.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { TOOL_REGISTRY } from '../../src/registry.js';
import { EVENT_ANNOTATIONS } from '../../src/events/event-annotations.js';
import { allocatePhaseAttemptId } from '../../src/workflow/phase-attempt-id.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

interface SnapshotTool {
  readonly name: string;
  readonly hidden: boolean;
  readonly actions: readonly string[];
}
interface SnapshotEvent {
  readonly type: string;
  readonly lifecycle: string;
  readonly tier: string;
}
interface Snapshot {
  readonly counts: Record<string, number>;
  readonly tools: readonly SnapshotTool[];
  readonly eventTypes: readonly SnapshotEvent[];
}

const snapshot = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'tools/audit/registered-actions-snapshot.json'), 'utf8'),
) as Snapshot;

/** The live registry in the shape that the snapshot records. */
function liveTools(): SnapshotTool[] {
  return TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    hidden: tool.hidden === true,
    actions: tool.actions.map((a) => a.name).sort(),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function liveEvents(): SnapshotEvent[] {
  return Object.entries(EVENT_ANNOTATIONS)
    .map(([type, reg]) => ({ type, lifecycle: reg.lifecycle, tier: reg.tier }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

describe('identifier stability across decomposition', () => {
  /**
   * Rows in the event store hold these type strings, so a rename is a migration.
   * The comparison uses the full record, so it also detects a change of
   * lifecycle or tier.
   */
  it('PersistedIdentifiers_AcrossDecomposition_AreStable', () => {
    const live = liveEvents();
    const recorded = snapshot.eventTypes.map((e) => ({
      type: e.type,
      lifecycle: e.lifecycle,
      tier: e.tier,
    }));

    expect(live).toEqual(recorded);
    expect(live.length, 'the event registry resolved to nothing').toBeGreaterThan(100);
  });

  it('RegisteredActions_AcrossDecomposition_AreStable', () => {
    expect(liveTools()).toEqual(
      snapshot.tools.map((t) => ({ name: t.name, hidden: t.hidden, actions: [...t.actions] })),
    );
  });

  /**
   * The snapshot comparison sorts names, so it does not see a change of order.
   * `describe` and the CLI help follow the declaration array. Thus this test
   * pins the published sequence for each tool.
   */
  it('RegisteredActions_DeclarationOrder_IsThePublishedSequence', () => {
    const order = Object.fromEntries(
      TOOL_REGISTRY.map((tool) => [tool.name, tool.actions.map((a) => a.name)]),
    );
    expect(order).toEqual({
      exarchos_workflow: [
        'init',
        'get',
        'transition',
        'update',
        'cancel',
        'cleanup',
        'reconcile',
        'rehydrate',
        'checkpoint',
        'feedback',
        'describe',
      ],
      exarchos_event: ['append', 'query', 'batch_append', 'describe'],
      exarchos_orchestrate: [
        'task_claim',
        'task_complete',
        'task_fail',
        'review_triage',
        'prepare_delegation',
        'prepare_synthesis',
        'stack_place',
        'assess_stack',
        'check_static_analysis',
        'check_integration_suite',
        'check_security_scan',
        'check_context_economy',
        'check_operational_resilience',
        'check_workflow_determinism',
        'check_review_verdict',
        'check_convergence',
        'check_provenance_chain',
        'check_design_completeness',
        'check_plan_coverage',
        'check_exploration_depth',
        'check_test_adequacy',
        'check_contract_drift',
        'check_mock_boundary',
        'mutation-adequacy',
        'check_post_merge',
        'merge_orchestrate',
        'check_task_decomposition',
        'check_event_emissions',
        'extract_task',
        'review_diff',
        'verify_worktree',
        'select_debug_track',
        'investigation_timer',
        'check_coverage_thresholds',
        'assess_refactor_scope',
        'check_pr_comments',
        'validate_pr_body',
        'validate_pr_stack',
        'debug_review_gate',
        'extract_fix_tasks',
        'classify_review_items',
        'generate_traceability',
        'spec_coverage_check',
        'verify_worktree_baseline',
        'setup_worktree',
        'verify_delegation_saga',
        'post_delegation_check',
        'reconcile_state',
        'pre_synthesis_check',
        'check_coderabbit',
        'check_polish_scope',
        'needs_schema_sync',
        'verify_doc_links',
        'verify_review_triage',
        'check_invariant_conformance',
        'prepare_review',
        'discover_bridge',
        'prune_stale_workflows',
        'request_synthesize',
        'finalize_oneshot',
        'runbook',
        'agent_spec',
        'doctor',
        'create_pr',
        'merge_pr',
        'check_ci',
        'list_prs',
        'get_pr_comments',
        'add_pr_comment',
        'create_issue',
        'onboard',
        'invariants_scaffold',
        'invariants_add',
        'invariants_amend',
        'acquire_worktree',
        'release_worktree',
        'prune_worktrees',
        'reconcile_worktrees',
        'serialize_merge',
        'cutover_readiness',
        'cutover_decide',
        'execute_intent',
        'prepare',
        'settle',
        'describe',
      ],
      exarchos_view: [
        'pipeline',
        'tasks',
        'workflow_status',
        'stack_status',
        'telemetry',
        'team_performance',
        'delegation_timeline',
        'code_quality',
        'eval_results',
        'quality_correlation',
        'quality_attribution',
        'delegation_readiness',
        'session_provenance',
        'provenance',
        'synthesis_readiness',
        'shepherd_status',
        'convergence',
        'gate_reliability',
        'quality_hints',
        'invariants_effective',
        'worktrees',
        'ps',
        'wait',
        'inspect',
        'export',
        'describe',
      ],
      exarchos_sync: ['now'],
    });
  });

  /**
   * The kill probe for the snapshot comparison. A comparison that passes for
   * each input also satisfies the tests above. Thus this test drops one action,
   * and then one tool, from the live shape and requires a mismatch.
   */
  it('RegisteredActions_DroppedRegistration_FailsTheSnapshot', () => {
    const live = liveTools();
    const [first] = live;
    expect(first, 'the registry is empty — nothing to drop').toBeDefined();
    expect(first!.actions.length, 'the first tool declares no actions').toBeGreaterThan(0);

    const mutilated = live.map((t, i) => (i === 0 ? { ...t, actions: t.actions.slice(1) } : t));
    expect(mutilated).not.toEqual(
      snapshot.tools.map((t) => ({ name: t.name, hidden: t.hidden, actions: [...t.actions] })),
    );

    expect(live.slice(1)).not.toEqual(
      snapshot.tools.map((t) => ({ name: t.name, hidden: t.hidden, actions: [...t.actions] })),
    );
  });

  /**
   * The composite-tool invariant: four visible composite tools, and each tool
   * has an action discriminator. The expected names are literals here, so a
   * snapshot that drifts with a wrong tree does not make this test pass.
   */
  it('CompositeToolSurface_MatchesINV5d', () => {
    const live = liveTools();
    const visible = live.filter((t) => !t.hidden);

    expect(visible.map((t) => t.name).sort()).toEqual([
      'exarchos_event',
      'exarchos_orchestrate',
      'exarchos_view',
      'exarchos_workflow',
    ]);
    for (const tool of live) {
      expect(tool.actions.length, `${tool.name} declares no action discriminator`).toBeGreaterThan(0);
    }
  });

  /**
   * The hash input of a persisted phase-attempt id joins its fields with a NUL
   * separator. Without the separator, `from='ab', to='c'` and `from='a', to='bc'`
   * give one id. The test calls the production constructor, because a local
   * copy of the concatenation cannot detect that loss.
   */
  it('DeterministicHashInputs_ForIdenticalInput_ProduceIdenticalOutput', () => {
    const first = allocatePhaseAttemptId('feature', 'ideate', 'plan', 'pred-1', 7);
    const again = allocatePhaseAttemptId('feature', 'ideate', 'plan', 'pred-1', 7);
    expect(first).toBe(again);
    expect(first.startsWith('phase-attempt:')).toBe(true);

    expect(allocatePhaseAttemptId('feature', 'ab', 'c', 'pred', 0)).not.toBe(
      allocatePhaseAttemptId('feature', 'a', 'bc', 'pred', 0),
    );

    const predecessor = 'attempt:pred-1';
    const expected = `phase-attempt:${createHash('sha256')
      .update(`feature\0${predecessor}\0ideate\0plan`)
      .digest('hex')}`;
    expect(first).toBe(expected);
  });

  /**
   * The snapshot pins type, lifecycle and tier, and not emit sites.
   * `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` and the
   * `check_event_emissions` action cover emission. This test requires that those
   * artifacts exist, so nobody takes the snapshot for a census of append sites.
   */
  it('EventAnnotationSnapshot_IsBoundToTheEmissionOracle', () => {
    const registryTest = readFileSync(path.join(REPO_ROOT, 'tests/unit/registry.test.ts'), 'utf8');
    expect(registryTest).toContain('RegistryDrift_AutoEmitsMatchEventEmissionRegistry');
    expect(registryTest).toContain('EVENT_EMISSION_REGISTRY');
    expect(registryTest).toContain('autoEmits');

    const emissionsGate = path.join(REPO_ROOT, 'tests/unit/verbs/gates/check-event-emissions.test.ts');
    expect(existsSync(emissionsGate), 'check-event-emissions tests are absent').toBe(true);

    const verification = readFileSync(
      path.join(REPO_ROOT, 'src/registry/actions/orchestrate/verification.ts'),
      'utf8',
    );
    expect(verification).toMatch(/name:\s*'check_event_emissions'/);

    for (const ev of snapshot.eventTypes) {
      expect(ev.type.length, 'snapshot event is missing type').toBeGreaterThan(0);
      expect(ev.lifecycle.length, `${ev.type} is missing lifecycle`).toBeGreaterThan(0);
      expect(ev.tier.length, `${ev.type} is missing tier`).toBeGreaterThan(0);
      expect(
        'emitSites' in ev,
        `${ev.type} records emit sites — that is a different oracle`,
      ).toBe(false);
    }
  });

  /** Counts that disagree with the contents show that a person edited the snapshot by hand. */
  it('Snapshot_CountsAgreeWithItsOwnContents', () => {
    expect(snapshot.counts.tools).toBe(snapshot.tools.length);
    expect(snapshot.counts.visibleTools).toBe(snapshot.tools.filter((t) => !t.hidden).length);
    expect(snapshot.counts.actions).toBe(
      snapshot.tools.reduce((n, t) => n + t.actions.length, 0),
    );
    expect(snapshot.counts.eventTypes).toBe(snapshot.eventTypes.length);
  });
});
