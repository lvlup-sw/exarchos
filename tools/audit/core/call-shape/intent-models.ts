// The recorded judgements: which located call belongs to which path for each
// named intent, and why.
//
// Nothing here is a count. Each entry names a call and a piece of text in the
// source that pins it, and the census resolves both against the live file. An
// anchor that stops resolving, or a located call that no entry accounts for,
// makes the census refuse, so this table cannot drift away from the skills it
// reads without failing.

import type { CensusModel, IntentModel, SiteRef } from './census.js';

const O = 'exarchos_orchestrate';
const W = 'exarchos_workflow';
const E = 'exarchos_event';

function at(source: string, call: string, needle: string): SiteRef {
  return { source, call, at: needle };
}

const SCHEMA_REFERENCE = 'schema-discovery reference: consulted when a schema is needed, not prescribed on every run';

const PLAN: IntentModel = {
  id: 'plan',
  source: 'plan',
  boundary: {
    label: 'transition plan -> plan-review',
    cite: { source: 'plan', needle: 'The `plan` → `plan-review` transition requires guard' },
  },
  normal: [
    { kind: 'site', ref: at('plan', `${O}.generate_traceability`, '-traceability.md"') },
    { kind: 'site', ref: at('plan', `${O}.check_plan_coverage`, 'action: "check_plan_coverage",') },
    { kind: 'site', ref: at('plan', `${O}.check_provenance_chain`, 'action: "check_provenance_chain",') },
    {
      kind: 'site',
      ref: at('plan', `${O}.check_task_decomposition`, 'action: "check_task_decomposition",'),
      why: 'advisory gate, but its step prescribes running it',
    },
    { kind: 'site', ref: at('plan', `${O}.spec_coverage_check`, 'repoRoot: ".",') },
    {
      kind: 'site',
      ref: at('plan', `${O}.check_coverage_thresholds`, 'lineThreshold: 80'),
      why: 'prescribed only as a completion criterion, which the skill lists as required before planning is complete',
      flag: 'A plan-phase completion criterion prescribes a coverage-threshold gate, but no coverage summary exists at plan time for it to read.',
    },
    {
      kind: 'site',
      ref: at('plan', `${W}.update`, 'action: "update", featureId: "<id>", updates: {'),
      why: 'a bare action key, resolved to the only tool that serves update',
    },
    { kind: 'site', ref: at('plan', `${W}.transition`, 'action: "transition", featureId: "<id>", target: "<plan-review-phase>"') },
  ],
  exceptions: [
    {
      id: 'coverage-gaps-revise',
      label: 'the coverage gate fails, so the plan is revised and re-run',
      trigger: { source: 'plan', needle: 'If passed: false → auto-invoke `plan --revise`' },
      through: `${O}.check_plan_coverage`,
      extra: [
        {
          kind: 'site',
          ref: at('plan', `${W}.update`, 'clear gaps via `exarchos:exarchos_workflow`'),
          why: 'revision mode names one call, clearing the recorded gaps',
        },
      ],
      reentersNormalPath: true,
      bound: { max: 3, cite: { source: 'plan', needle: 'Max revisions: 3 per plan.' } },
      why: 'Revision re-invokes this skill, so one revision counts the calls up to the failing gate, the gap-clearing update, and the whole normal path again. Reading the gaps from state names no call and is not counted.',
    },
  ],
  conditional: [
    { kind: 'site', ref: at('plan', `${W}.describe`, 'actions: ["update", "init"] })` for'), why: SCHEMA_REFERENCE },
    { kind: 'site', ref: at('plan', `${W}.describe`, 'playbook: "feature" })`'), why: SCHEMA_REFERENCE },
    {
      kind: 'site',
      ref: at('plan', `${O}.describe`, 'actions: ["check_plan_coverage", "check_provenance_chain"]'),
      why: SCHEMA_REFERENCE,
    },
  ],
  excluded: [
    {
      ref: at('plan', `${O}.check_test_adequacy`, 'riskTier: "high"'),
      kind: 'other-phase',
      why: 'the verification-ladder section shows the kill probe a task runs after implementation, not a planning call',
    },
    { ref: at('plan', `${O}.generate_traceability`, 'Spec traceability table created'), kind: 'restatement', why: 'completion checklist restates the traceability step' },
    { ref: at('plan', `${O}.check_plan_coverage`, 'Plan verification passed'), kind: 'restatement', why: 'completion checklist restates the coverage step' },
    { ref: at('plan', `${O}.check_provenance_chain`, 'Provenance chain checked'), kind: 'restatement', why: 'completion checklist restates the provenance step' },
    { ref: at('plan', `${O}.check_task_decomposition`, 'Task decomposition checked'), kind: 'restatement', why: 'completion checklist restates the decomposition step' },
    { ref: at('plan', `${O}.spec_coverage_check`, 'Spec coverage check passed'), kind: 'restatement', why: 'completion checklist restates the spec coverage step' },
    {
      ref: at('plan', `${O}.check_coverage_thresholds`, 'Coverage thresholds met'),
      kind: 'restatement',
      why: 'the checklist line names the call whose full recipe follows it',
    },
    {
      ref: at('plan', `${O}.prepare_review`, 'scope: "plan", artifact:'),
      kind: 'beyond-boundary',
      why: 'provisions the plan-review pass, which runs after the transition this intent ends at',
    },
    { ref: at('plan', `${O}.check_plan_coverage`, '**REQUIRED:** Run'), kind: 'restatement', why: 'the transition section restates the coverage gate as the revise trigger' },
    {
      ref: at('plan', `${W}.set`, 'Phase transitions auto-emit `workflow.transition` events via'),
      kind: 'stale-unregistered',
      why: 'the integration note names a workflow action the registry no longer serves',
      flag: 'The plan skill says phase transitions emit through `exarchos_workflow` `set`, an action the registry does not serve; the same skill prescribes `transition` for the phase change.',
    },
  ],
};

const TASK_COMPLETION: IntentModel = {
  id: 'task-completion',
  source: 'delegate',
  boundary: {
    label: 'task_complete records the task complete',
    cite: { source: 'delegate', needle: '`task_complete` is the **terminal** step of the task-completion runbook' },
  },
  normal: [
    {
      kind: 'runbook',
      id: 'task-completion',
      via: at('delegate', `${O}.runbook`, 'and execute the returned steps in order. Stop on gate failure.'),
      why: 'the primitive path, kept for the workflow types prepare does not compile: the appendix says to execute the fetched steps in order. Every gate step is counted, although the frozen risk-tier stamp can route a low-tier task past some of them. On the capsule path settlement composes this same runbook per accepted task, and the orchestrator makes none of these calls',
    },
  ],
  exceptions: [
    {
      id: 'gate-failure-fix',
      label: 'a blocking gate fails, so a fixer is dispatched and the task-fix chain runs',
      trigger: { source: 'delegate', needle: '**On a gate failure**, dispatch a fixer' },
      through: `${O}.check_static_analysis`,
      extra: [
        {
          kind: 'site',
          ref: at('delegate', 'native:SUBAGENT_RESULT_API', '(`{{SUBAGENT_RESULT_API}}`)'),
          why: 'read the failure output',
        },
        { kind: 'site', ref: at('delegate', 'native:SPAWN_AGENT_CALL', 'agent="fixer"'), why: 'fresh fixer dispatch, the canonical default' },
        {
          kind: 'runbook',
          id: 'task-fix',
          via: at('delegate', `${O}.runbook`, 'id: "task-fix"'),
          omit: ['native:Task.resume_or_spawn'],
          why: 'the chain runs after the fix completes; its first step is the fixer dispatch already counted',
        },
      ],
      reentersNormalPath: false,
      why: 'Worst-case prefix: the failure is taken at the last gate before task_complete, so every gate of the failed attempt counts and its task_complete does not.',
    },
  ],
  conditional: [
    {
      kind: 'site',
      ref: at('delegate', `${O}.describe`, 'If runbook unavailable, use `describe` to retrieve gate schemas'),
      why: 'fallback, only if the runbook action is unavailable',
    },
  ],
  excluded: [
    {
      ref: at('delegate', `${O}.task_complete`, 'summary: "<task summary>",'),
      kind: 'restatement',
      why: 'shows the provenance payload for the runbook terminal step, not a second call',
    },
  ],
};

const DELEGATION: IntentModel = {
  id: 'delegation',
  source: 'delegate',
  boundary: {
    label: 'transition delegate -> review',
    cite: { source: 'delegate', needle: 'The `delegate` → `review` transition requires guard `all-tasks-complete`' },
  },
  normal: [
    { kind: 'site', ref: at('delegate', `${O}.runbook`, 'id: "task-classification"'), why: 'pre-dispatch decision runbook, prescribed before dispatching' },
    { kind: 'site', ref: at('delegate', `${O}.runbook`, '**Dispatch strategy:**'), why: 'pre-dispatch decision runbook, prescribed before dispatching' },
    {
      kind: 'site',
      ref: at('delegate', `${O}.prepare`, 'action: "prepare", featureId: "<featureId>" })'),
      why: 'compiles the batch into the capsule every packet is built from, and announces its tasks in the same commit — the announcement the skill used to make first is the compilation\'s now',
    },
    {
      kind: 'site',
      ref: at('delegate', 'native:SPAWN_AGENT_CALL', 'agent="implementer"'),
      per: 'perTask',
      why: 'every independent task is dispatched, all in one message but one spawn each',
    },
    {
      kind: 'site',
      ref: at('delegate', 'native:SUBAGENT_RESULT_API', '{{SUBAGENT_RESULT_API}}\n```'),
      per: 'perTask',
      why: 'each background result is collected',
    },
    {
      kind: 'site',
      ref: at('delegate', `${O}.settle`, 'batchId: "<featureId>:wave-1",'),
      why: 'one call submits every claim; settlement adjudicates them and runs each accepted task\'s gates itself, so no per-task governance call follows',
    },
    {
      kind: 'mention',
      call: `${O}.serialize_merge`,
      cite: { source: 'delegate', needle: '**Land it through `serialize_merge`.**' },
      per: 'perTask',
      why: 'each task works in its own worktree, a worktree-bearing completion detours through merge-pending, and the skill names this action as the merge path. The plane compiles and settles the work; it does not land it',
    },
    {
      kind: 'site',
      ref: at('delegate', `${O}.check_integration_suite`, 'action: "check_integration_suite",'),
      why: 'the wave-boundary backstop, once per wave after the merges land',
    },
    { kind: 'site', ref: at('delegate', `${O}.check_operational_resilience`, 'action: "check_operational_resilience",') },
    {
      kind: 'site',
      ref: at('delegate', `${W}.transition`, 'target: "review" })'),
      why: 'the phase change, as a transition: settlement leaves the tasks complete and the guard admits it',
    },
  ],
  exceptions: [
    {
      id: 'settlement-rejected',
      label: 'settlement rejects a task, so a fixer is dispatched and the batch is resubmitted',
      trigger: { source: 'delegate', needle: '`verification-failed`: the task\'s segment halted on the named leaf' },
      through: `${O}.settle`,
      extra: [
        { kind: 'site', ref: at('delegate', 'native:SPAWN_AGENT_CALL', 'agent="fixer"'), why: 'fresh fixer dispatch to the rejected task\'s worktree' },
        {
          kind: 'site',
          ref: at('delegate', `${O}.settle`, 'batchId: "<featureId>:wave-1:retry-1",'),
          why: 'the corrected batch, resubmitted under a new id; tasks already complete are accepted without running again',
        },
      ],
      reentersNormalPath: false,
      why: 'Counted to the resubmission that settles. Landing, the backstop and the transition then follow as on the normal path; reading the halted segment\'s receipt names no call.',
    },
    {
      id: 'deviation-pending',
      label: 'a worker proposed a deviation, so the batch is held for a decision and settled again with it',
      trigger: { source: 'delegate', needle: '**`deviation-pending`** — a worker proposed a deviation' },
      through: `${O}.settle`,
      extra: [
        {
          kind: 'site',
          ref: at('delegate', `${O}.settle`, 'decisions: pendingDeviations.map'),
          why: 'the same batch settled again with the decisions and no claims: the one call the plane budgets for a decision',
        },
      ],
      reentersNormalPath: false,
      why: 'The decision is recorded as its own fact on that call, and an accepted one verifies the held work and settles the batch, after which landing and the transition follow as on the normal path. A rejected one rejects the batch; revising the plan and preparing again is the normal path, and recording the revision is the next slice of the divergence loop.',
    },
    {
      id: 'context-compaction',
      label: 'context compacts mid-delegation, so state is recovered before continuing',
      trigger: { source: 'delegate', needle: 'If context compaction occurs during delegation:' },
      through: null,
      extra: [
        { kind: 'site', ref: at('delegate', `${W}.get`, '`exarchos_workflow get`') },
        { kind: 'site', ref: at('delegate', `${W}.reconcile`, '`exarchos_workflow reconcile`') },
      ],
      reentersNormalPath: false,
      why: 'Counted as recovery calls added to a delegation that otherwise completes. Listing the worktrees is an unfenced shell step and is not counted.',
    },
    {
      id: 'integration-advanced',
      label: 'the integration branch advanced mid-wave, so one worktree is rebased and merged again',
      trigger: { source: 'delegate', needle: 'source branch <feature-branch> is not a descendant of <integration-branch>.' },
      through: null,
      extra: [
        { kind: 'site', ref: at('delegate', 'native:Bash', 'git rev-parse <feature-branch> > /tmp/rollback.sha') },
        { kind: 'site', ref: at('delegate', 'native:Bash', 'git fetch origin') },
        { kind: 'site', ref: at('delegate', `${O}.serialize_merge`, 'integrationRef: "<integration-branch>",') },
      ],
      reentersNormalPath: false,
      why: 'One diverged worktree: capture the rollback SHA, rebase, and land it again through the serialized merge.',
    },
    {
      id: 'integration-advanced-rollback',
      label: 'the rebase cannot be resolved, so the branch is rolled back and the abort recorded',
      trigger: { source: 'delegate', needle: 'If the rebase produces conflicts you cannot resolve safely' },
      through: null,
      extra: [
        { kind: 'site', ref: at('delegate', 'native:Bash', 'git rev-parse <feature-branch> > /tmp/rollback.sha') },
        { kind: 'site', ref: at('delegate', 'native:Bash', 'git fetch origin') },
        { kind: 'site', ref: at('delegate', 'native:Bash', 'git rebase --abort') },
        {
          kind: 'mention',
          call: `${E}.append`,
          cite: { source: 'delegate', needle: 'emitting a `merge.aborted` event' },
          why: 'the rollback prescribes recording the abort as an event',
        },
      ],
      reentersNormalPath: false,
      why: 'Marking the task failed names no call and is not counted. The fixer dispatch it leads to is the settlement-rejected path.',
    },
  ],
  conditional: [
    {
      kind: 'site',
      ref: at('delegate', `${O}.runbook`, 'lists the steps settlement composes'),
      why: 'a reference to the runbook settlement runs per accepted task, read when the caller wants to know the steps; the orchestrator does not fetch or run it on this path',
    },
    { kind: 'site', ref: at('delegate', `${W}.describe`, 'Use `exarchos_workflow({ action: "describe", actions: ["update", "init"] })` for'), why: SCHEMA_REFERENCE },
    { kind: 'site', ref: at('delegate', `${W}.describe`, 'playbook: "feature" })`'), why: SCHEMA_REFERENCE },
    {
      kind: 'site',
      ref: at('delegate', `${O}.describe`, '`exarchos_orchestrate({ action: "describe", actions: ["prepare", "settle"] })`'),
      why: SCHEMA_REFERENCE,
    },
  ],
  excluded: [
    {
      ref: at('delegate', `${O}.runbook`, 'id: "dispatch-decision" })`\n'),
      kind: 'restatement',
      why: 'restates the pre-dispatch decision runbook already fetched',
    },
    {
      ref: at('delegate', `${W}.transition`, '`exarchos_workflow transition` to `review`'),
      kind: 'restatement',
      why: 'the landing checklist names the transition the Transition section spells',
    },
    {
      ref: at('delegate', 'exarchos_view.delegation_timeline', 'delegation_timeline'),
      kind: 'alternate-mode',
      why: 'agent-team mode monitoring; this census counts the default subagent mode',
    },
    {
      ref: at('delegate', 'native:CHAIN', '{{CHAIN next="review"'),
      kind: 'beyond-boundary',
      why: 'invokes the review skill after the transition this intent ends at',
    },
    {
      ref: at('delegate', `${O}.prepare_delegation`, 'action: "prepare_delegation", featureId: "<featureId>", planPath:'),
      kind: 'alternate-mode',
      why: 'the primitive path, for the workflow types prepare does not compile; this census counts the capsule path',
    },
    {
      ref: at('delegate', `${W}.update`, 'with the tasks array'),
      kind: 'alternate-mode',
      why: 'the primitive path patches task statuses by hand; on the capsule path settlement leaves them complete',
    },
  ],
};

const REVIEW: IntentModel = {
  id: 'review',
  source: 'review',
  boundary: {
    label: 'transition review -> synthesize',
    cite: { source: 'review', needle: '`review → synthesize` requires `all-reviews-passed`' },
  },
  normal: [
    { kind: 'site', ref: at('review', `${O}.review_diff`, 'action: "review_diff"'), why: 'the orchestrator generates the integrated diff once' },
    {
      kind: 'mention',
      call: 'native:SPAWN_AGENT_CALL',
      cite: { source: 'review', needle: 'This skill runs in a SUBAGENT spawned by the orchestrator' },
      why: 'the reviewer is dispatched as a subagent; no placeholder spells the call',
    },
    { kind: 'site', ref: at('review', `${O}.runbook`, 'id: "review-strategy"') },
    {
      kind: 'site',
      ref: at('review', `${O}.check_test_adequacy`, 'riskTier: "<low|medium|high>",'),
      why: 'no loop is named, so it counts once',
      flag: 'The review recipe for the kill probe carries a single `taskId`, while the pass reviews the integrated diff across every task.',
    },
    {
      kind: 'runbook',
      id: 'quality-evaluation',
      via: at('review', `${O}.runbook`, 'id: "quality-evaluation"'),
      omit: [`${O}.check_invariant_conformance`, `${O}.check_review_verdict`],
      why: 'the runbook gates run first; the invariant pass and the verdict, which the skill spells separately after the check catalog, are counted where the skill places them',
    },
    {
      kind: 'mention',
      call: `${O}.prepare_review`,
      cite: { source: 'review', needle: '3. `prepare_review` — returns the deterministic check catalog' },
      why: 'item 3 of the gate list prescribes it by name only',
    },
    {
      kind: 'site',
      ref: at('review', `${O}.check_invariant_conformance`, 'diff: "<integrated diff>"'),
      why: 'prescribed whenever an invariant catalog is registered, counted on the normal path',
    },
    { kind: 'site', ref: at('review', `${O}.runbook`, 'id: "review-escalation"') },
    { kind: 'site', ref: at('review', `${O}.check_review_verdict`, 'pluginFindings: catalogFindings,') },
    { kind: 'site', ref: at('review', `${W}.update`, 'status: "pass", summary') },
    { kind: 'site', ref: at('review', `${W}.transition`, 'target: "synthesize" })') },
  ],
  exceptions: [
    {
      id: 'needs-fixes',
      label: 'the verdict is NEEDS_FIXES, so the failure is recorded and fixes are delegated',
      trigger: { source: 'review', needle: '**NEEDS_FIXES:**' },
      through: `${O}.check_review_verdict`,
      extra: [{ kind: 'site', ref: at('review', `${W}.update`, 'status: "fail", summary') }],
      reentersNormalPath: false,
      bound: { max: 5, cite: { source: 'review', needle: 'default **5**' } },
      why: 'The failed verdict is recorded and the review -> delegate edge fires on its guard; no transition call is named. The delegate --fixes run it hands to is beyond this boundary.',
    },
  ],
  conditional: [
    { kind: 'site', ref: at('review', `${W}.describe`, 'actions: ["update"] })` and'), why: SCHEMA_REFERENCE },
    { kind: 'site', ref: at('review', `${O}.describe`, '"check_invariant_conformance", "prepare_review"] })`'), why: SCHEMA_REFERENCE },
  ],
  excluded: [],
};

const SYNTHESIS: IntentModel = {
  id: 'synthesis',
  source: 'synthesize',
  boundary: {
    label: 'human checkpoint: merge the stack',
    cite: { source: 'synthesize', needle: '**Human checkpoint:**' },
  },
  normal: [
    {
      kind: 'site',
      ref: at('synthesize', `${O}.runbook`, 'id: "synthesis-flow"'),
      why: 'the fetched runbook is not expanded: the skill spells its own steps, and they differ from it',
    },
    { kind: 'site', ref: at('synthesize', `${O}.prepare_synthesis`, 'repoRoot: "<absolute path of the repo under synthesis>"') },
    {
      kind: 'site',
      ref: at('synthesize', 'native:Bash', 'cat > /tmp/pr-body.md'),
      per: 'perPr',
      why: 'a description is written for each PR in the stack',
    },
    {
      kind: 'site',
      ref: at('synthesize', `${O}.validate_pr_body`, 'bodyFile: "/tmp/pr-body.md"'),
      per: 'perPr',
      why: 'each PR body is validated before its PR is created',
    },
    {
      kind: 'site',
      ref: at('synthesize', `${O}.create_pr`, 'action: "create_pr",'),
      per: 'perPr',
      why: 'created for each branch in the stack, bottom-up',
    },
    {
      kind: 'site',
      ref: at('synthesize', `${O}.merge_pr`, 'action: "merge_pr",'),
      per: 'perPr',
      why: 'auto-merge is enabled for each branch in the stack',
    },
    { kind: 'site', ref: at('synthesize', `${O}.list_prs`, 'action: "list_prs"') },
    { kind: 'site', ref: at('synthesize', `${W}.update`, '"mergeOrder": [') },
    {
      kind: 'site',
      ref: at('synthesize', `${E}.append`, 'type: "stack.submitted",'),
      why: 'emitted after the PRs are created and auto-merge is enabled, before the checkpoint',
    },
  ],
  exceptions: [
    {
      id: 'pr-body-invalid',
      label: 'a PR body fails validation, so it is fixed and validated again',
      trigger: { source: 'synthesize', needle: 'If validation fails, fix the body and re-validate.' },
      through: null,
      extra: [
        {
          kind: 'site',
          ref: at('synthesize', `${O}.validate_pr_body`, 'bodyFile: "/tmp/pr-body.md"'),
          why: 're-validation after the fix, for one PR',
        },
      ],
      reentersNormalPath: false,
      why: 'One failed body, fixed and re-validated once. Fixing the body names no call.',
    },
    {
      id: 'readiness-fails',
      label: 'the readiness check fails, so synthesis returns to an earlier phase',
      trigger: { source: 'synthesize', needle: '**On failure:** The response identifies which check failed' },
      through: `${O}.prepare_synthesis`,
      extra: [],
      reentersNormalPath: false,
      why: 'The response names the remediation, typically returning to review or delegate, but no call is named for that return, so the path ends at the failed check.',
    },
  ],
  conditional: [
    {
      kind: 'site',
      ref: at('synthesize', `${O}.describe`, 'If runbook unavailable, use `describe` to retrieve action schemas'),
      why: 'fallback, only if the runbook action is unavailable',
    },
    {
      kind: 'site',
      ref: at('synthesize', 'native:Bash', 'git push --force-with-lease=<ref>:<expected-sha>'),
      why: 'direct edits to stack branches are optional, and the push applies only after one',
    },
    { kind: 'site', ref: at('synthesize', `${W}.describe`, 'actions: ["update", "init"] })` for'), why: SCHEMA_REFERENCE },
    { kind: 'site', ref: at('synthesize', `${W}.describe`, 'playbook: "feature" })`'), why: SCHEMA_REFERENCE },
    {
      kind: 'site',
      ref: at('synthesize', `${O}.describe`, 'actions: ["prepare_synthesis"] })`\nfor orchestrate action schemas'),
      why: SCHEMA_REFERENCE,
    },
  ],
  excluded: [
    {
      ref: at('synthesize', `${E}.append`, 'type: "shepherd.iteration",'),
      kind: 'beyond-boundary',
      why: 'emitted during shepherd iterations, after the checkpoint routes feedback to shepherd',
    },
    { ref: at('synthesize', `${W}.cleanup`, 'mergeVerified: true,'), kind: 'beyond-boundary', why: 'post-merge cleanup, after the checkpoint' },
    { ref: at('synthesize', `${O}.prune_worktrees`, '// dry-run (default)'), kind: 'beyond-boundary', why: 'post-merge worktree reclamation' },
    { ref: at('synthesize', `${O}.prune_worktrees`, '// apply'), kind: 'beyond-boundary', why: 'post-merge worktree reclamation' },
    {
      ref: at('synthesize', `${W}.transition`, 'action: "transition"`, `target: "completed"`'),
      kind: 'beyond-boundary',
      why: 'manual completion after a merged PR, an escape hatch past the checkpoint',
    },
    { ref: at('synthesize', `${W}.cleanup`, 'via `action: "cleanup"`'), kind: 'beyond-boundary', why: 'names the cleanup that normally owns completion' },
  ],
};

export const CALL_SHAPE_MODEL: CensusModel = {
  sources: {
    plan: 'content/design/skills/plan/SKILL.md',
    delegate: 'content/delivery/skills/delegate/SKILL.md',
    review: 'content/review/skills/review/SKILL.md',
    synthesize: 'content/synthesis/skills/synthesize/SKILL.md',
  },
  intents: [PLAN, DELEGATION, TASK_COMPLETION, REVIEW, SYNTHESIS],
};
