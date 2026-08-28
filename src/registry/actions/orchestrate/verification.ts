import { vacuityWaiver } from '../../../output-schema-declaration.js';
import { z } from 'zod';
import { declared, none, withActionContract, type ActionContract } from '../../action-contract.js';
import { COMPENSABLE_LOCAL, LOCAL_MUTATION, READ_ONLY_LOCAL, READ_ONLY_REMOTE } from '../../annotations.js';
import { ALL_PHASES, DELEGATE_PHASES, PLAN_PHASES, REVIEW_PHASES, ROLE_ANY, ROLE_LEAD, SYNTHESIS_REVIEW_PHASES, featureIdSchema } from '../../phases.js';
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

export const verificationActions: readonly BuiltinToolAction[] = [
  withContract({
    name: 'check_task_decomposition',
    description: 'Task decomposition quality check at plan boundary. Emits gate.executed event with dimension D5.',
    schema: z.object({
      featureId: z.string().min(1),
      planPath: z.string().min(1),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D5', gateClass: 'task-decomposition' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_task_decomposition'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared(
      { source: 'durable-evidence', when: 'always', evidenceType: 'gate' },
      { source: 'event-append', when: 'always', event: 'gate.executed' },
    ),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'planPath' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'check_event_emissions',
    description: 'Check for expected-but-missing model-emitted events in the current workflow phase. Returns structured hints for missing events.',
    schema: z.object({
      featureId: z.string().min(1),
      workflowId: z.string().optional(),
    }),
    phases: ALL_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_event_emissions'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'event-append', when: 'always', event: 'gate.executed' }),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({ event: 'gate.executed', condition: 'always', owner: 'orchestrate', role: 'primary' }),
  }),
  withContract({
    name: 'extract_task',
    description: 'Extract a task definition from a plan file by task ID',
    schema: z.object({
      planPath: z.string().min(1),
      taskId: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.extract_task'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('extract_task returns an in-memory task definition and writes nothing durable'),
    needs: declared('fs:read'),
    resources: declared({ kind: 'path', selector: 'planPath' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'review_diff',
    description: 'Collect diff statistics for a worktree branch against its base',
    schema: z.object({
      worktreePath: z.string().optional(),
      baseBranch: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.review_diff'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('review_diff reports ephemeral diff statistics and writes nothing durable'),
    needs: declared('fs:read'),
    resources: declared(
      { kind: 'worktree', selector: 'worktreePath' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'verify_worktree',
    description: 'Verify a directory is a valid git worktree',
    schema: z.object({
      cwd: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_worktree'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('verify_worktree inspects git metadata and writes nothing durable'),
    needs: declared('fs:read'),
    resources: declared({ kind: 'worktree', selector: 'cwd' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'select_debug_track',
    description: 'Select hotfix or thorough debug track based on urgency and root cause knowledge',
    schema: z.object({
      // INV-1: urgency/rootCauseKnown resolve from the event-store projection
      // when not passed directly; `featureId` enables fileless resolution.
      featureId: z.string().min(1).optional(),
      urgency: z.string().optional(),
      rootCauseKnown: z.union([z.boolean(), z.string()]).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.select_debug_track'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('select_debug_track chooses a track from caller or projected facts and appends no catalog events'),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'investigation_timer',
    description: 'Check investigation time budget and recommend continue or escalate',
    schema: z.object({
      // INV-1: investigation.startedAt resolves from the event-store
      // projection when not passed directly; `featureId` enables fileless
      // resolution for MCP-only workflows.
      featureId: z.string().min(1).optional(),
      startedAt: z.string().optional(),
      stateFile: z.string().optional(),
      budgetMinutes: z.number().optional(),
    }),
    phases: new Set<string>(['investigate']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.investigation_timer'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('investigation_timer reports budget remaining and writes nothing durable'),
    needs: declared('mcp:exarchos:readonly'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'check_coverage_thresholds',
    description: 'Check code coverage metrics against threshold values',
    schema: z.object({
      // The stream the gate's durable evidence is recorded against. Required:
      // the postcondition observer reads the record on the stream the CALL
      // names, so a gate with no stream identity can never pay the evidence it
      // declares.
      featureId: z.string().min(1),
      coverageFile: z.string().min(1),
      lineThreshold: z.number().optional(),
      branchThreshold: z.number().optional(),
      functionThreshold: z.number().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D3', gateClass: 'coverage-thresholds' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_coverage_thresholds'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: declared({ source: 'durable-evidence', when: 'always', evidenceType: 'gate' }),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'coverageFile' },
    ),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'assess_refactor_scope',
    description: 'Assess refactoring scope and recommend polish or overhaul track',
    schema: z.object({
      // INV-1: explore.scopeAssessment.filesAffected resolves from the
      // event-store projection when no explicit `files` list is supplied;
      // `featureId` enables fileless resolution.
      featureId: z.string().min(1).optional(),
      files: z.array(z.string()).optional(),
      stateFile: z.string().optional(),
    }),
    phases: new Set<string>(['explore', 'brief']),
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.assess_refactor_scope'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('assess_refactor_scope classifies scope from caller or projected facts and writes nothing durable'),
    needs: declared('mcp:exarchos:readonly'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'check_pr_comments',
    description: 'Check PR for unresolved review comment threads',
    schema: z.object({
      pr: z.number().int().positive(),
      repo: z.string().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.check_pr_comments'),
    annotations: READ_ONLY_REMOTE,
  }, {
    ensures: none('check_pr_comments reads remote review threads and writes nothing durable'),
    needs: none('remote PR comment reads use the host gh client; no capability token names that network'),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'validate_pr_body',
    description: 'Validate PR body contains required sections (Summary, Changes, Test Plan)',
    schema: z.object({
      pr: z.number().int().positive().optional(),
      bodyFile: z.string().optional(),
      body: z.string().optional(),
      template: z.string().optional(),
      // DR-1 (#1593) task 006: optional — enables the advisory intent-grounding
      // check (reads `artifacts.intent`). Absent → unchanged legacy validation.
      featureId: featureIdSchema.optional(),
      // Optional, and the default keeps the shipped semantics: a deficient body
      // is reported on the success carrier. A caller whose next step depends on
      // the verdict cannot read a payload field — a composition sees the
      // envelope — so it asks for the verdict as a refusal instead.
      enforce: z.boolean().optional(),
    }),
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.validate_pr_body'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('validate_pr_body checks section presence and writes nothing durable'),
    needs: declared('fs:read'),
    resources: declared({ kind: 'path', selector: 'bodyFile' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'validate_pr_stack',
    description: 'Validate PR stack ordering and base branch consistency',
    schema: z.object({
      // The stream the gate's durable evidence is recorded against. Required
      // for the same reason the sibling gates need one: the observer looks for
      // the record on the stream the call names.
      featureId: z.string().min(1),
      baseBranch: z.string().min(1),
    }),
    phases: new Set<string>(['synthesize']),
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'pr-stack' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.validate_pr_stack'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: declared({ source: 'durable-evidence', when: 'always', evidenceType: 'gate' }),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'debug_review_gate',
    description: 'Run debug-track review gate: verify test files exist and pass for changed files',
    schema: z.object({
      // The stream the gate's durable evidence is recorded against. The action
      // already replayed under a stream-subject claim scope while naming no
      // stream at all; this is the identity that scope always presumed.
      featureId: z.string().min(1),
      repoRoot: z.string().min(1),
      baseBranch: z.string().min(1),
      skipRun: z.boolean().optional(),
    }),
    phases: new Set<string>(['debug-review']),
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'debug-review' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.debug_review_gate'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'durable-evidence', when: 'always', evidenceType: 'gate' }),
    needs: declared('fs:read', 'mcp:exarchos', 'shell:exec'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'git-ref', selector: 'baseBranch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'extract_fix_tasks',
    description: 'Extract fix tasks from review findings and map to worktrees',
    schema: z.object({
      // featureId OR stateFile — the handler enforces "at least one source"
      // (Zod single-field `.min(1)` can't express the cross-field rule).
      featureId: z.string().min(1).optional(),
      // INV-1: findings + worktrees resolve from the event-store projection;
      // `stateFile` is an optional override for legacy file-based workflows.
      stateFile: z.string().min(1).optional(),
      reviewReport: z.string().optional(),
      repoRoot: z.string().optional(),
    }),
    phases: REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.extract_fix_tasks'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('extract_fix_tasks maps findings to worktrees and appends no catalog events'),
    needs: declared('fs:read', 'mcp:exarchos'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'repoRoot' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'classify_review_items',
    description: 'Group ActionItems by file and recommend dispatch strategy (direct/delegate-fixer/delegate-scaffolder) per group (#1159)',
    schema: z.object({
      featureId: z.string().min(1),
      actionItems: z.array(z.record(z.string(), z.unknown())),
    }),
    // Shepherd operates within `synthesize` and invokes classify_review_items
    // after assess_stack; restricting to REVIEW_PHASES would trip phase-guard
    // at runtime (#1161 / Sentry bug prediction).
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.classify_review_items'),
    annotations: LOCAL_MUTATION,
  }, {
    // The classification telemetry is best-effort by design: the handler logs an
    // append failure and still returns the grouping, which is the shepherd-visible
    // result. A postcondition would turn that deliberate tolerance into a dispatch
    // failure, so the append is carried on the emission axis alone.
    ensures: none('the classification record is best-effort — the handler swallows an append failure and still returns the grouping'),
    needs: declared('mcp:exarchos'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
    emissions: declared({
      event: 'dispatch.classified',
      condition: 'conditional',
      owner: 'orchestrate',
      role: 'primary',
      description: 'When an event store is wired and the append succeeds',
    }),
  }),
  withContract({
    name: 'generate_traceability',
    description: 'Generate a traceability matrix mapping design sections to plan tasks',
    schema: z.object({
      designFile: z.string().min(1),
      planFile: z.string().min(1),
      outputFile: z.string().optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.generate_traceability'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('generate_traceability writes an optional matrix file and appends no catalog events'),
    needs: declared('fs:read', 'fs:write'),
    resources: declared(
      { kind: 'path', selector: 'designFile' },
      { kind: 'path', selector: 'planFile' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'spec_coverage_check',
    description: 'Verify that test files referenced in the plan exist in the repo',
    schema: z.object({
      // The gate declares durable gate evidence keyed to a phase attempt, and
      // evidence is recorded against a stream — the action cannot pay a
      // postcondition it has no subject for. Required rather than optional:
      // `when: 'always'` admits no "when the caller supplied one".
      featureId: z.string().min(1),
      planFile: z.string().min(1),
      repoRoot: z.string().min(1),
      skipRun: z.boolean().optional(),
      // WFQ-010. Declared here or the parameter cannot reach the handler at all:
      // dispatch forwards only schema-parsed args and Zod strips unknown keys, so
      // an undeclared field left `runPlanSyntaxCheck` unreachable and applied
      // post-implementation semantics in the plan phases this action is bound to.
      // The handler's default stays `post-implementation` for back-compat; plan-time
      // callers pass `coveragePhase: 'plan'` so a declared-but-uncreated test file
      // reads as a forward declaration rather than a failure.
      //
      // NOT named `phase`: `buildRegistrationSchema` flattens field names across
      // every action, and `check_test_adequacy` already declares a free-form
      // `phase: z.string()` legacy workflow-phase carrier. Two different meanings
      // under one name is a hard collision (base types differ, string vs enum) that
      // throws at server construction — and widening this one to `string` to match
      // would trade a schema-level constraint for a prose one, which INV-5a forbids.
      coveragePhase: z.enum(['plan', 'post-implementation']).optional(),
    }),
    phases: PLAN_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: false, dimension: 'D1', gateClass: 'spec-coverage' },
    outputSchema: vacuityWaiver('exarchos_orchestrate.spec_coverage_check'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: declared({ source: 'durable-evidence', when: 'always', evidenceType: 'gate' }),
    needs: declared('fs:read'),
    resources: declared(
      { kind: 'stream', selector: 'featureId' },
      { kind: 'path', selector: 'planFile' },
      { kind: 'path', selector: 'repoRoot' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'verify_worktree_baseline',
    description: 'Verify a worktree passes baseline tests before task work begins',
    schema: z.object({
      worktreePath: z.string().min(1),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_ANY,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_worktree_baseline'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('verify_worktree_baseline runs baseline tests and appends no catalog events'),
    needs: declared('fs:read', 'shell:exec'),
    resources: declared({ kind: 'worktree', selector: 'worktreePath' }),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'setup_worktree',
    description: 'Create a git worktree for a task with branch and baseline verification',
    schema: z.object({
      repoRoot: z.string().min(1),
      taskId: z.string().min(1),
      taskName: z.string().min(1),
      baseBranch: z.string().optional(),
      skipTests: z.boolean().optional(),
      // DR-3 (T-09, #1204): resolution priority is
      //   `branch` > `workflow.tasks[id=taskId].branch` > legacy default.
      // Provide `featureId` to let the composite adapter look up the planned
      // branch from workflow state when `branch` is not supplied.
      branch: z.string().min(1).optional(),
      featureId: z.string().min(1).optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.setup_worktree'),
    annotations: LOCAL_MUTATION,
  }, {
    ensures: none('setup_worktree creates a git worktree and appends no catalog events'),
    needs: declared('fs:write', 'shell:exec'),
    resources: declared(
      { kind: 'path', selector: 'repoRoot' },
      { kind: 'worktree', selector: 'taskId' },
      { kind: 'git-ref', selector: 'branch' },
    ),
    replay: { kind: 'claim-required', scope: 'stream-subject-request' },
  }),
  withContract({
    name: 'verify_delegation_saga',
    description: 'Verify delegation event saga completeness (spawned, dispatched, disbanded)',
    schema: z.object({
      featureId: z.string().min(1),
      stateDir: z.string().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.verify_delegation_saga'),
    annotations: READ_ONLY_LOCAL,
  }, {
    ensures: none('verify_delegation_saga reads saga completeness and writes nothing durable'),
    needs: declared('mcp:exarchos:readonly'),
    resources: declared({ kind: 'stream', selector: 'featureId' }),
    replay: { kind: 'safe-repeat' },
  }),
  withContract({
    name: 'post_delegation_check',
    description: 'Run post-delegation checks: task completion, test pass, branch existence',
    schema: z.object({
      stateFile: z.string().min(1).optional(),
      // Required, not optional: the gate declares durable evidence, and the
      // observer reads that record on the stream the call names. A stateFile-only
      // call had no stream to record against, so the declaration could not be
      // paid. `stateFile` remains the optional state-resolution override.
      featureId: z.string().min(1),
      repoRoot: z.string().min(1),
      skipTests: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'post-delegation' },
    // DR-5: chains `npm run test:run` across every task worktree with a
    // 120s per-worktree timeout; scales with the number of tasks.
    longRunning: true,
    outputSchema: vacuityWaiver('exarchos_orchestrate.post_delegation_check'),
    annotations: COMPENSABLE_LOCAL,
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
