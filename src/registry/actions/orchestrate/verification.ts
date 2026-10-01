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
      /**
       * Without direct values, `urgency` and `rootCauseKnown` resolve from the event-store projection.
       * `featureId` names the stream for that resolution, so no state file is necessary.
       */
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
      /**
       * Without a direct value, `investigation.startedAt` resolves from the event-store projection.
       * `featureId` names the stream for that resolution, so no state file is necessary.
       */
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
      /**
       * The stream that records the durable gate evidence. It is required, because the postcondition
       * observer reads the record on the stream that the call names.
       */
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
      /**
       * Without a `files` list, `explore.scopeAssessment.filesAffected` resolves from the event-store
       * projection. `featureId` names the stream for that resolution.
       */
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
      /** When present, it turns on the advisory intent-grounding check, which reads `artifacts.intent`. */
      featureId: featureIdSchema.optional(),
      /**
       * By default, a deficient body is reported on the success carrier. A composition sees only the
       * envelope, so a caller that depends on the verdict sets `enforce` to get a refusal instead.
       */
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
      /**
       * The stream that records the durable gate evidence. It is required, because the observer reads
       * the record on the stream that the call names.
       */
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
      /**
       * The stream that records the durable gate evidence. It is also the subject of the
       * stream-subject claim scope for replay.
       */
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
      /**
       * The handler requires `featureId` or `stateFile`, because a single-field `.min(1)` cannot
       * express the cross-field rule.
       */
      featureId: z.string().min(1).optional(),
      /**
       * An optional override for file-based workflows. Otherwise the findings and worktrees resolve
       * from the event-store projection.
       */
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
    /**
     * The shepherd runs in `synthesize` and calls this action after `assess_stack`. With only
     * `REVIEW_PHASES`, the phase guard refuses that call.
     */
    phases: SYNTHESIS_REVIEW_PHASES,
    roles: ROLE_LEAD,
    outputSchema: vacuityWaiver('exarchos_orchestrate.classify_review_items'),
    annotations: LOCAL_MUTATION,
  }, {
    /**
     * The classification record is best-effort. The handler logs an append failure and still returns
     * the grouping. A postcondition makes that a dispatch failure, so only the emission declares it.
     */
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
      /**
       * The stream that records the durable gate evidence. It is required, because the
       * `when: 'always'` postcondition needs a subject on each call.
       */
      featureId: z.string().min(1),
      planFile: z.string().min(1),
      repoRoot: z.string().min(1),
      skipRun: z.boolean().optional(),
      /**
       * The coverage phase. Dispatch forwards only schema-parsed args, so this field must be declared
       * to reach the handler. The handler default is `post-implementation`. A plan-time caller passes
       * `'plan'`, so a declared test file that does not exist yet is not a failure.
       *
       * The name is not `phase`. `buildRegistrationSchema` flattens field names across all actions,
       * and `check_test_adequacy` declares `phase` as a free-form string. The two base types collide
       * and throw at server construction.
       */
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
      /**
       * The branch resolves from `branch`, then `workflow.tasks[id=taskId].branch`, then the default.
       * With `featureId` and no `branch`, the composite adapter reads the planned branch from state.
       */
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
      /**
       * The stream that records the durable gate evidence. It is required, because the observer reads
       * the record on the stream that the call names. `stateFile` is an optional state override.
       */
      featureId: z.string().min(1),
      repoRoot: z.string().min(1),
      skipTests: z.boolean().optional(),
    }),
    phases: DELEGATE_PHASES,
    roles: ROLE_LEAD,
    gate: { blocking: true, gateClass: 'post-delegation' },
    /** It runs the resolved test command in each task worktree with a 120s timeout, so it grows with the task count. */
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
