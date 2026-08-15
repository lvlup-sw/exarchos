/**
 * Persisted identifiers and registered action names survive decomposition
 * (task 047, DR-9).
 *
 * Tasks 048-051 split four large modules apart. The dangerous failure in that
 * work is not a broken build — it is a SILENT one. Drop a tool action while
 * moving a block of declarations and the result type-checks, lints, and passes
 * every behavioural test that does not happen to exercise that action. Change a
 * hash input and every existing row in the event store stops matching the ids
 * the new code computes, with nothing red anywhere.
 *
 * Both are invisible to the compiler by construction, so they need a recorded
 * baseline. That is what `tools/audit/registered-actions-snapshot.json` is.
 *
 * The snapshot is a BEFORE picture, not a rule: adding an action is ordinary
 * work. Regenerating it is allowed and expected — what is not allowed is
 * regenerating it *silently*, which is why the diff has to appear in the same
 * commit as the change it records.
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

/** The live registry, reduced to the same shape the snapshot records. */
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
  it('PersistedIdentifiers_AcrossDecomposition_AreStable', () => {
    // Event types are PERSISTED: rows in the event store carry these strings,
    // so a rename is a migration, not a refactor. Compared by full record so a
    // lifecycle or tier change is caught too — a type silently demoted from
    // `active` to `retired` still reads as present.
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

  it('RegisteredActions_DeclarationOrder_IsThePublishedSequence', () => {
    // The snapshot above sorts names so a set change is visible. Order is a
    // different contract: `describe` and CLI help walk the declaration array,
    // and a family reorder during a split would be silent if we only compared
    // sorted sets. Pin the published sequence per tool.
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
        'serialize_merge',
        'cutover_readiness',
        'cutover_decide',
        'describe',
      ],
      exarchos_view: [
        'pipeline',
        'tasks',
        'workflow_status',
        'stack_status',
        'stack_place',
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

  it('RegisteredActions_DroppedRegistration_FailsTheSnapshot', () => {
    // The kill probe, and the reason the test above is worth having. A
    // comparison that passes for every input would satisfy the assertions above
    // just as well — so drop one action from the LIVE shape and require the
    // comparison to notice.
    const live = liveTools();
    const [first] = live;
    expect(first, 'the registry is empty — nothing to drop').toBeDefined();
    expect(first!.actions.length, 'the first tool declares no actions').toBeGreaterThan(0);

    const mutilated = live.map((t, i) => (i === 0 ? { ...t, actions: t.actions.slice(1) } : t));
    expect(mutilated).not.toEqual(
      snapshot.tools.map((t) => ({ name: t.name, hidden: t.hidden, actions: [...t.actions] })),
    );

    // And a dropped TOOL, which is the coarser version of the same loss.
    expect(live.slice(1)).not.toEqual(
      snapshot.tools.map((t) => ({ name: t.name, hidden: t.hidden, actions: [...t.actions] })),
    );
  });

  it('CompositeToolSurface_MatchesINV5d', () => {
    // INV-5d stated as an instrument rather than as prose: four VISIBLE
    // composite tools, each discriminated by an action. The snapshot could
    // drift into agreement with a wrong tree; this is checked against the
    // invariant's own numbers, so both have to be wrong to pass.
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

  it('DeterministicHashInputs_ForIdenticalInput_ProduceIdenticalOutput', () => {
    // Persisted phase-attempt ids are hashed from a template literal with a
    // NUL separator. Losing the separator during a decomposition silently
    // collides two different field splits onto one id. This calls the
    // production constructor — a local helper that restates a different
    // concatenation cannot catch that loss.
    const first = allocatePhaseAttemptId('feature', 'ideate', 'plan', 'pred-1', 7);
    const again = allocatePhaseAttemptId('feature', 'ideate', 'plan', 'pred-1', 7);
    expect(first).toBe(again);
    expect(first.startsWith('phase-attempt:')).toBe(true);

    // Without the separator, from='ab', to='c' and from='a', to='bc'
    // concatenate to the same string. With it they must not.
    expect(allocatePhaseAttemptId('feature', 'ab', 'c', 'pred', 0)).not.toBe(
      allocatePhaseAttemptId('feature', 'a', 'bc', 'pred', 0),
    );

    const predecessor = 'attempt:pred-1';
    const expected = `phase-attempt:${createHash('sha256')
      .update(`feature\0${predecessor}\0ideate\0plan`)
      .digest('hex')}`;
    expect(first).toBe(expected);
  });

  it('EventAnnotationSnapshot_IsBoundToTheEmissionOracle', () => {
    // The snapshot pins type / lifecycle / tier, not emit sites. Emission is
    // `RegistryDrift_AutoEmitsMatchEventEmissionRegistry` plus the
    // `check_event_emissions` action. This binds those artifacts so the
    // snapshot cannot be mistaken for an append-site census.
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
      expect(Object.keys(ev).sort()).toEqual(['lifecycle', 'tier', 'type']);
    }
  });

  it('Snapshot_CountsAgreeWithItsOwnContents', () => {
    // A snapshot whose header disagrees with its body is a snapshot someone
    // hand-edited. Cheap to check, and it makes the counts quotable.
    expect(snapshot.counts.tools).toBe(snapshot.tools.length);
    expect(snapshot.counts.visibleTools).toBe(snapshot.tools.filter((t) => !t.hidden).length);
    expect(snapshot.counts.actions).toBe(
      snapshot.tools.reduce((n, t) => n + t.actions.length, 0),
    );
    expect(snapshot.counts.eventTypes).toBe(snapshot.eventTypes.length);
  });
});
