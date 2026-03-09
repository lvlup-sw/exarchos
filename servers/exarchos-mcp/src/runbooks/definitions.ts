import type { RunbookDefinition } from './types.js';

export const TASK_COMPLETION: RunbookDefinition = {
  id: 'task-completion',
  phase: 'delegate',
  description: 'Complete a task after execution: run blocking gates, then mark complete.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'check_tdd_compliance', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId', 'branch'],
  autoEmits: ['gate.executed', 'task.completed'],
};

export const QUALITY_EVALUATION: RunbookDefinition = {
  id: 'quality-evaluation',
  phase: 'review',
  description: 'Run quality gates and compute review verdict.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_security_scan', onFail: 'continue' },
    { tool: 'exarchos_orchestrate', action: 'check_convergence', onFail: 'continue' },
    { tool: 'exarchos_orchestrate', action: 'check_review_verdict', onFail: 'stop' },
  ],
  templateVars: ['featureId', 'high', 'medium', 'low'],
  autoEmits: ['gate.executed'],
};

export const AGENT_TEAMS_SAGA: RunbookDefinition = {
  id: 'agent-teams-saga',
  phase: 'delegate',
  description: 'Full delegation saga: create team, plan tasks, dispatch teammates, monitor, disband.',
  steps: [
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.spawned' },
      note: 'Event-first: emit before TeamCreate' },
    { tool: 'native:TeamCreate', action: 'create', onFail: 'stop' },
    { tool: 'exarchos_event', action: 'batch_append', onFail: 'stop',
      params: { type: 'team.task.planned' },
      note: 'Atomic batch: ALL task events in one call' },
    { tool: 'native:TaskCreate', action: 'create', onFail: 'stop',
      note: 'Create N tasks, then wire dependencies' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      note: 'Store task correlation — orchestrator is sole writer of workflow.tasks[]' },
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.teammate.dispatched' },
      note: 'Emit per teammate. PIVOT POINT: past here, compensation is partial' },
    { tool: 'native:Task', action: 'spawn', onFail: 'stop',
      note: 'Spawn N teammates in worktrees' },
    { tool: 'exarchos_view', action: 'workflow_status', onFail: 'continue',
      note: 'Monitor: poll every 30-60s (~85 tokens)' },
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'team.disbanded' },
      note: 'Event-first: emit before SendMessage shutdown' },
    { tool: 'native:SendMessage', action: 'shutdown', onFail: 'continue',
      note: 'Shutdown N teammates, then TeamDelete' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      params: { phase: 'review' },
      note: 'Auto-emits workflow.transition' },
  ],
  templateVars: ['featureId', 'streamId', 'stream', 'event', 'events', 'teamId'],
  autoEmits: ['workflow.transition'],
};

export const SYNTHESIS_FLOW: RunbookDefinition = {
  id: 'synthesis-flow',
  phase: 'synthesize',
  description: 'Verify readiness, create PR, submit for merge.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'prepare_synthesis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'run_script', onFail: 'stop',
      params: { script: 'validate-pr-body.sh' } },
    { tool: 'native:bash', action: 'gh_pr_create', onFail: 'stop',
      note: 'Create PR via gh CLI' },
    { tool: 'exarchos_workflow', action: 'set', onFail: 'stop',
      note: 'Record PR URL in artifacts.prUrl' },
  ],
  templateVars: ['featureId'],
  autoEmits: ['gate.executed'],
};

export const SHEPHERD_ITERATION: RunbookDefinition = {
  id: 'shepherd-iteration',
  phase: 'synthesize',
  description: 'Assess PR stack health, fix issues, re-push.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'assess_stack', onFail: 'stop',
      note: 'Returns actionItems[] and recommendation' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'shepherd.iteration' },
      note: 'Record iteration for convergence tracking' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'remediation.attempted' },
      note: 'Per action item: emit before fix attempt' },
    { tool: 'native:bash', action: 'fix', onFail: 'continue',
      note: 'Apply fixes for each action item' },
    { tool: 'exarchos_event', action: 'append', onFail: 'continue',
      params: { type: 'remediation.succeeded' },
      note: 'Per action item: emit after successful fix' },
    { tool: 'native:bash', action: 'push', onFail: 'stop',
      note: 'git push to trigger CI re-run' },
  ],
  templateVars: ['featureId', 'streamId', 'stream', 'event', 'prNumbers'],
  autoEmits: ['shepherd.started', 'shepherd.approval_requested', 'shepherd.completed'],
};

export const ALL_RUNBOOKS: readonly RunbookDefinition[] = [
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SHEPHERD_ITERATION,
];
