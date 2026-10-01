import { coercedNonnegativeInt, coercedPositiveInt } from '../../../coerce.js';
import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { LOCAL_MUTATION } from '../../annotations.js';
import { DELEGATE_PHASES, PLAN_PHASES, REVIEW_PHASES, ROLE_LEAD, STACK_PHASES } from '../../phases.js';
import type { BuiltinActionDraft, BuiltinToolAction } from '../../types.js';

function withContract(
  action: BuiltinActionDraft,
  partial: {
    readonly requires?: ActionContract['requires'];
    readonly ensures: ActionContract['ensures'];
    readonly needs: ActionContract['needs'];
    readonly resources?: ActionContract['touches']['resources'];
    readonly replay: ActionContract['replay'];
    readonly emissions?: ActionContract['emissions'];
  },
): BuiltinToolAction {
  return withActionContract(
    action,
    {
      requires: partial.requires ?? none('this action does not consume a prior resolved gate or approval floor'),
      ensures: partial.ensures,
      needs: partial.needs,
      touches: {
        frame: 'single-machine',
        resources: partial.resources ?? none('this action does not address a stream, path, worktree, or git-ref'),
      },
      executionAuthority: { kind: 'local' },
      replay: partial.replay,
      emissions: partial.emissions ?? none('this action appends no catalog events'),
    },
    { annotations: action.annotations },
  );
}

export const gateActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'check_static_analysis',
    description: 'Run static analysis gate (lint + typecheck) and persist canonical subject-bound evidence.',
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      /**
       * The handler passes it to `resolveRepoRoot`, so `repoRoot: 'auto'` resolves the agent's worktree.
       * Without this declaration, schema parsing drops the field before the handler sees it.
       */
      worktreePath: z.string().optional(),
      skipLint: z.boolean().optional(),
      skipTypecheck: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'static-analysis' },
    /** It runs `npm run lint` and `npm run typecheck`, which exceed the 2s heartbeat threshold on a large repo. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_static_analysis'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'admission.evidence-recorded' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'worktreePath' },
      { kind: 'git-ref', selector: 'branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'admission.evidence-recorded', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'check_integration_suite',
    description:
      'Run the FULL test suite against the integration tip and fold file-LOAD ' +
      'failures into the failure count (#1329). vitest counts a file that throws ' +
      'at import as "1 failed suite / 0 failed tests" — invisible to per-task ' +
      'gates; this gate makes a load cascade a hard FAIL. Set repoRoot to the ' +
      'integration worktree (or "auto" to resolve the calling delegation\'s ' +
      'worktree). Persists canonical subject-bound evidence. Do NOT use for a single task\'s scoped tests — use ' +
      'check_static_analysis / check_test_adequacy for per-task verification; ' +
      'this gate is the cumulative-regression backstop between merges.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      taskId: z.string().optional(),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      testScript: z.string().optional(),
    }),
    phases: STACK_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D2', gateClass: 'integration-suite' },
    /** It runs the full test suite, which exceeds the 2s heartbeat threshold on a real repo. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_integration_suite'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'admission.evidence-recorded' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'worktreePath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'admission.evidence-recorded', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'check_security_scan',
    description: 'Run security pattern scan on diff. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      diffContent: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1', gateClass: 'security-scan' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_security_scan'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_context_economy',
    description: 'Check code complexity impacting LLM context consumption. Emits gate.executed event with dimension D3.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3', gateClass: 'context-economy' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_context_economy'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_operational_resilience',
    description: 'Check for operational anti-patterns (empty catches, swallowed errors, console.log). Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4', gateClass: 'operational-resilience' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_operational_resilience'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_workflow_determinism',
    description: 'Check test reliability and determinism (.only/.skip, non-deterministic time/random, debug artifacts). Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      repoRoot: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5', gateClass: 'workflow-determinism' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_workflow_determinism'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_review_verdict',
    description: 'Compute review verdict from finding counts. Emits per-dimension and summary gate.executed events. On NEEDS_FIXES, bounds the fix-loop via the shared escalation policy (DR-3): returns escalate:true when the auto-fix bound is hit or a finding is intent-touching.',
    schema: z.object({
      featureId: z.string().min(1),
      high: coercedNonnegativeInt(),
      medium: coercedNonnegativeInt(),
      low: coercedNonnegativeInt(),
      blockedReason: z.string().optional(),
      dimensionResults: z.record(z.string(), z.object({
        passed: z.boolean(),
        findingCount: z.number().int().nonnegative(),
      })).optional(),
      pluginFindings: z.array(z.object({
        source: z.string(),
        severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        dimension: z.string().optional(),
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        message: z.string(),
        /** The classification for the escalation policy. A `spec` finding or a flagged finding escalates at once. */
        category: z.string().optional(),
        intentTouching: z.boolean().optional(),
      })).optional(),
      /** Overrides the auto-fix bound for this loop. It takes precedence over `escalation.maxIterations` and the default. */
      maxFixCycles: coercedPositiveInt().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'review-verdict' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_review_verdict'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_convergence',
    description: 'Query D1-D5 convergence status from gate.executed events. Emits gate.executed event on each invocation. Returns overall pass/fail and per-dimension summary.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, gateClass: 'convergence' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_convergence'),
    /**
     * The handler appends a gate event on each call, so the action is not read-only.
     * A read-only annotation lets a readonly-tier client write to the event store.
     */
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_provenance_chain',
    description: 'Verify design requirement traceability (DR-N) from design doc to plan tasks. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'provenance-chain' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_provenance_chain'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'designPath' },
      { kind: 'path', selector: 'planPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_design_completeness',
    description: 'DEPRECATED (#1581): delegates to check_plan_coverage on the unified docs/specs/ artifact; its acceptance-criteria check folded into plan-coverage. Use check_plan_coverage. Removed in a future minor version.',
    deprecated: true,
    schema: z.object({
      featureId: z.string().min(1),
      stateFile: z.string().optional(),
      designPath: z.string().optional(),
      /** Equals `designPath` when one spec file holds the design and the plan. The handler can also resolve it from state. */
      planPath: z.string().optional(),
    }),
    /**
     * Only the `plan` phase, not `PLAN_PHASES`. An action with exactly `PLAN_PHASES` counts as a
     * plan-structure gate, and this deprecated alias must not count as one.
     */
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_design_completeness'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'designPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_plan_coverage',
    description: 'Verify plan tasks cover all design sections. Emits gate.executed event with dimension D1.',
    schema: z.object({
      featureId: z.string().min(1),
      designPath: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'plan-coverage' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_plan_coverage'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'designPath' },
      { kind: 'path', selector: 'planPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_exploration_depth',
    description:
      'Deep-depth planning gate (DR-4): verifies a `deep`-designDepth spec carries ' +
      'the template-required `### Exploration` section citing the /exarchos:discover ' +
      'research pass by report path + correlationId, failing when the section is ' +
      'absent (or present but not citing the pass). SELF-SKIPS at thin/standard ' +
      'depth — the Exploration citation is a deep-only obligation. Resolves ' +
      'designDepth + the unified docs/specs/ artifact path from explicit args, then ' +
      'from workflow state. Emits a gate.executed event (gate "exploration-depth", ' +
      'layer planning, dimension D1) on every path, including the skip.',
    schema: z.object({
      featureId: z.string().min(1),
      /** The unified spec artifact. When absent, the handler resolves it from state: the plan first, then the design. */
      designPath: z.string().optional(),
      /** The frozen design depth of the feature. When absent, it comes from `state.designDepth`. A depth other than `deep` skips. */
      designDepth: z.enum(['thin', 'standard', 'deep']).optional(),
      stateFile: z.string().optional(),
    }),
    /**
     * Only the `plan` phase, not `PLAN_PHASES`, which is the plan-structure binding of the `standard`
     * rung. This gate is a `deep`-only obligation, so it must stay out of that binding.
     */
    phases: new Set<string>(['plan']),
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'exploration-depth' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_exploration_depth'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'designPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_test_adequacy',
    description:
      'Per-task test-adequacy kill probe (mutation-testing-at-N=1): reverts the ' +
      "task's source hunks (keeping tests), re-runs the new/changed tests, and " +
      'asserts at least one goes red — proving the tests are not vacuous. ' +
      'Restores the working tree unconditionally (INV-14) and persists canonical ' +
      'subject-bound evidence. Pass repoRoot ("auto" to resolve the calling ' +
      "delegation's worktree) and baseBranch, the branch the task forked from; " +
      'without a base the gate blocks (base-missing). Stamp riskTier + boundaryTouching (from ' +
      'prepare_delegation) to let the gate self-skip when the verification ' +
      'policy excludes it for that tier (skipped-by-policy). This is the sole ' +
      'per-task verification gate: it subsumes the regression-coverage intent of ' +
      'the retired check_tdd_compliance (#1587) — outcome-based test adequacy, ' +
      'test-after, NOT commit-order test-first.',
    /**
     * The schema is `.strict()`, so dispatch rejects an unknown key such as `base` and applies no silent
     * default. Dispatch removes injected sibling-action defaults before this validation.
     */
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      /** A compatibility field. Durable evidence uses the stored `phaseAttemptId`, not this caller value. */
      phase: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }).strict(),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'test-adequacy' },
    /** It reverts source and runs the test command, which exceeds the 2s heartbeat threshold on a real repo. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_test_adequacy'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'admission.evidence-recorded' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'worktreePath' },
      { kind: 'git-ref', selector: 'branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'admission.evidence-recorded', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'check_contract_drift',
    description:
      'Per-task contract-drift gate (verification-ladder slice 1): regenerates ' +
      'schema bindings (codegen), typechecks the regen, then runs a ' +
      'breaking-change diff against the MERGE-BASE (git merge-base baseBranch ' +
      'HEAD). A drift gate, NOT a write-lock — reports findings, never mutates ' +
      'the tree. Persists canonical subject-bound evidence. Degrades to a ' +
      'skipped/advisory pass when no contract tool resolves ' +
      '(INV-4). Pass repoRoot ("auto" to resolve the calling delegation\'s ' +
      'worktree). On a ' +
      'clean pass, surfaces a one-semantic-test steer in next_actions.',
    /**
     * The field names and base types match `check_test_adequacy`, so `buildRegistrationSchema` sees no
     * field name with two base types.
     */
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, dimension: 'D1', gateClass: 'contract-drift' },
    /** It runs codegen, typecheck and a breaking-change diff, which exceed the 2s heartbeat threshold. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_contract_drift'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'admission.evidence-recorded' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'worktreePath' },
      { kind: 'git-ref', selector: 'branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'admission.evidence-recorded', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'check_mock_boundary',
    description:
      'Per-task mock-boundary gate (verification-ladder slice 1, SIV-4): scans ' +
      "the task's NEW test hunks for mock sites (mock/stub/spy/fake/patch/" +
      'monkeypatch at an identifier boundary) and cross-references each mocked ' +
      'target against the resolved `ownership.firstParty` scope. Mocking a ' +
      'FIRST-PARTY module is low-risk (its contract is visible); mocking an ' +
      'UNOWNED dependency asserts against a fiction — the high-risk pattern. ' +
      'ADVISORY by default (severity resolved via DEFAULTS.review.gates, like ' +
      'tdd-compliance; a project review-gate override still wins). On an unowned ' +
      'finding, surfaces a per-finding steer in next_actions (replace with a ' +
      'hermetic fixture / contract-verified stub / a fake). An explicit `reason` ' +
      'is an escape hatch that passes the gate advisory AND records the ' +
      'acknowledgement in durable evidence. Pass repoRoot ("auto" to resolve ' +
      "the calling delegation's worktree).",
    /**
     * The field names and base types match `check_test_adequacy` and `check_contract_drift`, so
     * `buildRegistrationSchema` sees no field name with two base types. `reason` is an optional string.
     */
    schema: z.object({
      featureId: z.string().min(1),
      taskId: z.string().min(1),
      branch: z.string().optional(),
      baseBranch: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      reason: z.string().optional(),
      riskTier: z.enum(['low', 'medium', 'high']).optional(),
      boundaryTouching: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    /**
     * Advisory by default. `resolveGateSeverity` reads the severity from
     * `DEFAULTS.review.gates['mock-boundary']`, and this flag mirrors it for the runbook drift check.
     */
    gate: { blocking: false, dimension: 'D1', gateClass: 'mock-boundary' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_mock_boundary'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'admission.evidence-recorded' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'worktreePath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'admission.evidence-recorded', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'mutation-adequacy',
    description:
      'Verification-ladder slice 3 (R5): the mutation-adequacy backstop for the ' +
      'relaxed verification mix. Runs the resolved mutation command DIFF-SCOPED ' +
      'against `base` (Stryker --since / cargo-mutants --in-diff / mutmut path ' +
      'restriction, resolved from the toolchains SoT), parses the Stryker ' +
      'mutation-testing-report-schema, and returns the fixed carrier ' +
      '{passed, mutationScore, killed, survived, noCoverage, total, report}. ' +
      'Surviving + NoCoverage mutants become next_actions ("write a test that ' +
      'kills <file>:<line>"). ADVISORY by default (severity resolved via ' +
      "DEFAULTS.review.gates['mutation-adequacy']; an explicit override can raise " +
      'it to blocking). An unresolved mutation command → Skipped (reason names ' +
      'remediation); a malformed/empty report → Warning (degrade, never throws). ' +
      "scope:'full' runs full-tree only with offline:true (nightly lane); else a " +
      'deferred advisory (no inline run). Emits mutation.executing_started/executed (INV-10) and a foldable ' +
      'gate.executed carrying mutationScore (INV-1); operationId makes the gate ' +
      'emission idempotent (INV-8). Reuse `base` as a string verbatim.',
    /**
     * Each field keeps the base type of other declarations with the same name, so
     * `buildRegistrationSchema` sees no collision. `scope` is a plain string, as in `prepare_review`,
     * and the handler accepts only `'diff'` or `'full'`.
     */
    schema: z.object({
      featureId: z.string().min(1),
      base: z.string().min(1),
      /**
       * Lets `repoRoot: 'auto'` resolve through the task's `worktree.created` event. It is optional,
       * because the review-gate path often passes an explicit worktree.
       */
      taskId: z.string().optional(),
      worktreePath: z.string().optional(),
      operationId: z.string().optional(),
      threshold: z.number().min(0).max(1).optional(),
      scope: z.string().optional(),
      /** The opt-in for a full-tree run. Inline `/review` does not set it, so `scope: 'full'` stays deferred there. */
      offline: z.boolean().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    /** Advisory by default. This flag mirrors the severity in `DEFAULTS.review.gates['mutation-adequacy']`. */
    gate: { blocking: false, dimension: 'mutation-adequacy' },
    /** It runs a mutation runner, which exceeds the 2s heartbeat threshold on a real repo. */
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.mutation-adequacy'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
      { source: 'event-append', when: 'always', event: 'mutation.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'worktree', selector: 'worktreePath' },
      { kind: 'git-ref', selector: 'base' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared(
      { event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'mutation.executed', condition: 'always', owner: 'orchestrate', role: 'primary' },
      { event: 'mutation.executing_started', condition: 'always', owner: 'orchestrate', role: 'primary' },
    ),
  }),
  withContract({
    name: 'check_post_merge',
    description: 'Post-merge regression check. Emits gate.executed event with dimension D4.',
    schema: z.object({
      featureId: z.string().min(1),
      prUrl: z.string().min(1),
      mergeSha: z.string().min(1),
      repoRoot: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D4', gateClass: 'post-merge' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_post_merge'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
];
