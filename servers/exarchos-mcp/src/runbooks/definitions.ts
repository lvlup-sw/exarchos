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
      params: { agent: 'teammate' },
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
  autoEmits: ['state.patched', 'workflow.transition'],
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
  autoEmits: ['gate.executed', 'state.patched', 'workflow.transition'],
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
  autoEmits: ['gate.executed', 'shepherd.approval_requested', 'shepherd.completed', 'shepherd.started'],
};

export const TASK_FIX: RunbookDefinition = {
  id: 'task-fix',
  phase: 'delegate',
  description: 'Fix a failed task. Platforms with resume use agent context continuity; others dispatch fixer agent with failure context from event store.',
  steps: [
    { tool: 'native:Task', action: 'resume_or_spawn', onFail: 'stop',
      params: {
        resumeAgent: 'agentId',
        fallbackAgent: 'fixer',
      },
      note: 'CC: resume agentId with full context. Others: agent_spec("fixer") + fresh dispatch.' },
    { tool: 'exarchos_orchestrate', action: 'check_tdd_compliance', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId', 'branch', 'agentId', 'failureContext'],
  autoEmits: ['gate.executed', 'task.completed'],
};

export const TRIAGE_DECISION: RunbookDefinition = {
  id: 'triage-decision',
  phase: 'triage',
  description: 'Decide between hotfix and thorough investigation tracks based on reproducibility and scope.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is the bug reproducible with a specific test case?',
        source: 'human',
        branches: {
          'yes': { label: 'Reproducible', guidance: 'Write the failing test first, then proceed to scope check. A reproducible bug with a test is the ideal starting point for hotfix.', nextStep: 'check-scope' },
          'no': { label: 'Not reproducible', guidance: 'Add logging and check error patterns. Intermittent bugs require thorough investigation — do not attempt hotfix.', nextStep: 'thorough-track' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-scope',
      decide: {
        question: 'Does the fix touch more than 3 files or cross module boundaries?',
        source: 'human',
        branches: {
          'yes': { label: 'Large scope', guidance: 'Switch to thorough track — cross-module fixes need RCA to avoid incomplete patches.' },
          'no': { label: 'Small scope', guidance: 'Proceed with hotfix track. Apply minimal targeted fix within 15-minute time limit.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'thorough-track',
      decide: {
        question: 'Has 15 minutes elapsed without identifying the root cause?',
        source: 'human',
        branches: {
          'yes': { label: 'Time exceeded', guidance: 'Escalate to user — the bug may require domain expertise or access to systems you cannot inspect.', escalate: true },
          'no': { label: 'Still investigating', guidance: 'Continue investigation. Document hypotheses tested and their results for the RCA document.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const INVESTIGATION_DECISION: RunbookDefinition = {
  id: 'investigation-decision',
  phase: 'investigate',
  description: 'Decide when to escalate investigation to full RCA based on complexity signals.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'How many hypotheses have been tested without finding root cause?',
        source: 'event-count',
        field: 'investigation.hypothesesTested',
        branches: {
          '< 3': { label: 'Few hypotheses', guidance: 'Continue investigating. Systematically eliminate possibilities — check logs, add breakpoints, trace data flow.' },
          '>= 3': { label: 'Many hypotheses', guidance: 'Pattern suggests deeper issue. Transition to formal RCA with structured 5-whys analysis.', nextStep: 'check-cross-module' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-cross-module',
      decide: {
        question: 'Does the bug involve interactions between multiple subsystems?',
        source: 'human',
        branches: {
          'yes': { label: 'Cross-module', guidance: 'Escalate to user — cross-module bugs often require architectural context the agent lacks.', escalate: true },
          'no': { label: 'Single module', guidance: 'Proceed with RCA within the module. Focus the 5-whys on the module boundary.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const SCOPE_DECISION: RunbookDefinition = {
  id: 'scope-decision',
  phase: 'explore',
  description: 'Decide between polish and overhaul refactoring tracks based on scope assessment.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'How many files does the refactoring touch?',
        source: 'state-field',
        field: 'exploration.fileCount',
        branches: {
          '<= 5': { label: 'Small scope', guidance: 'Polish track is appropriate. Focus on DRY, naming, and small structural improvements within the affected files.', nextStep: 'check-structural' },
          '> 5': { label: 'Large scope', guidance: 'Overhaul track recommended. Create a formal plan with parallelizable tasks and dependency analysis.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-structural',
      decide: {
        question: 'Does the change alter module boundaries, public APIs, or data flow?',
        source: 'human',
        branches: {
          'yes': { label: 'Structural change', guidance: 'Override to overhaul track — structural changes need planning even if file count is low.' },
          'no': { label: 'Cosmetic change', guidance: 'Confirm polish track. Implement changes directly without formal planning phase.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the refactoring scope exceed what can ship in a single PR?',
        source: 'human',
        branches: {
          'yes': { label: 'Multi-PR scope', guidance: 'Escalate to user — discuss phasing the refactor across multiple PRs with clear milestones.', escalate: true },
          'no': { label: 'Single PR scope', guidance: 'Proceed with selected track. The entire refactor ships as one PR.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const DISPATCH_DECISION: RunbookDefinition = {
  id: 'dispatch-decision',
  phase: 'delegate',
  description: 'Decide dispatch strategy: parallel vs sequential, team sizing, and isolation mode.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Do any tasks modify the same files or share module boundaries?',
        source: 'state-field',
        field: 'tasks[].modules',
        branches: {
          'yes': { label: 'File overlap', guidance: 'Sequence overlapping tasks. Only parallelize tasks with zero file overlap to avoid merge conflicts in worktrees.' },
          'no': { label: 'Independent tasks', guidance: 'Full parallel dispatch is safe. Create one worktree per task for maximum throughput.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'How many independent tasks are there?',
        source: 'state-field',
        field: 'tasks.length',
        branches: {
          '<= 3': { label: 'Small team', guidance: 'Use subagent dispatch with run_in_background. Simple orchestration, no team coordination overhead.' },
          '> 3': { label: 'Large team', guidance: 'Consider agent-team mode if tmux is available. Otherwise batch subagents in groups of 3-4 to manage context.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Has the same task failed 3 or more times?',
        source: 'event-count',
        field: 'task.failed',
        branches: {
          'yes': { label: 'Repeated failure', guidance: 'Escalate to user — repeated failures suggest a design issue, missing dependency, or environment problem that the agent cannot resolve alone.', escalate: true },
          'no': { label: 'Normal progress', guidance: 'Continue dispatch. For failed tasks, use the fixer agent with adversarial verification posture.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const REVIEW_ESCALATION: RunbookDefinition = {
  id: 'review-escalation',
  phase: 'review',
  description: 'Decide review outcome: pass to synthesis, route to fix cycle, or block for redesign.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Are there any HIGH severity findings?',
        source: 'gate-result',
        field: 'review.highFindings',
        branches: {
          'yes': { label: 'High findings', guidance: 'Check if findings indicate design-level issues. If so, route to BLOCKED for redesign. If implementation-only, route to fix cycle.', nextStep: 'check-design-alignment' },
          'no': { label: 'No high findings', guidance: 'Check medium findings and fix cycle count to determine pass vs minor fixes.', nextStep: 'check-fix-cycles' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-design-alignment',
      decide: {
        question: 'Do the findings indicate a gap in the design specification?',
        source: 'human',
        branches: {
          'yes': { label: 'Design gap', guidance: 'Verdict: BLOCKED. The implementation cannot converge without design changes. Route back to ideate phase.', escalate: true },
          'no': { label: 'Implementation issue', guidance: 'Verdict: NEEDS_FIXES. Route to delegation with --fixes flag. Include specific findings in the fix task descriptions.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-fix-cycles',
      decide: {
        question: 'How many fix cycles have already been attempted?',
        source: 'event-count',
        field: 'workflow.fix-cycle',
        branches: {
          '0': { label: 'First review', guidance: 'If medium findings exist, route to fix cycle. If only low findings, consider APPROVED with advisory notes.' },
          '1-2': { label: 'Fix cycles attempted', guidance: 'Findings should be decreasing. If the same finding reappears, escalate — the fix approach may be wrong.' },
          '>= 3': { label: 'Many fix cycles', guidance: 'Escalate to user — the review-fix loop is not converging. May need design revision or manual intervention.', escalate: true },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const SHEPHERD_ESCALATION: RunbookDefinition = {
  id: 'shepherd-escalation',
  phase: 'synthesize',
  description: 'Decide whether to continue shepherd iterations or escalate to user.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'How many shepherd iterations have been completed?',
        source: 'event-count',
        field: 'shepherd.iteration',
        branches: {
          '<= 3': { label: 'Early iterations', guidance: 'Continue iterating. Fix CI failures, address review comments, and re-push. Most PRs converge within 3 iterations.' },
          '> 3': { label: 'Many iterations', guidance: 'Check if CI failures are stable or flaky. If the same failure repeats, escalate rather than retry.', nextStep: 'check-ci-stability' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'check-ci-stability',
      decide: {
        question: 'Is the CI failure the same as in the previous iteration?',
        source: 'human',
        branches: {
          'yes': { label: 'Same failure', guidance: 'Escalate to user — repeated identical CI failure suggests an environment issue, flaky test, or infrastructure problem the agent cannot fix.', escalate: true },
          'no': { label: 'Different failure', guidance: 'New failure type — one more iteration is warranted. If this also fails, escalate regardless.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Are all review comments addressed and CI passing?',
        source: 'gate-result',
        field: 'shepherd.allGreen',
        branches: {
          'yes': { label: 'All green', guidance: 'PR is ready. Request approval or enable auto-merge. No further shepherd iterations needed.' },
          'no': { label: 'Outstanding items', guidance: 'Continue iterating on remaining items. Prioritize CI fixes over review comments — a red CI blocks everything.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const TASK_CLASSIFICATION: RunbookDefinition = {
  id: 'task-classification',
  phase: 'delegate',
  description: 'Classify task complexity and select the appropriate agent spec and effort level.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is this task low-complexity (scaffolding, boilerplate, config wiring, simple glue code, or single-file changes with minimal logic)?',
        source: 'human',
        branches: {
          'yes': { label: 'Low complexity', guidance: 'Use scaffolder agent spec (sonnet, effort low). Low-complexity tasks have predictable structure and need no deep reasoning.' },
          'no': { label: 'Not low-complexity', guidance: 'Proceed to complexity assessment to determine the right agent spec and effort level.', nextStep: 'complexity-check' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      note: 'complexity-check',
      decide: {
        question: 'Does the task involve edge cases, algorithms, or multi-dependency coordination?',
        source: 'human',
        branches: {
          'yes': { label: 'High complexity', guidance: 'Use high-complexity agent spec (opus, effort high). These tasks need careful reasoning and adversarial testing.' },
          'no': { label: 'Standard complexity', guidance: 'Use standard implementer agent spec (sonnet, effort medium). Typical feature work with clear requirements.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is the context package size greater than 500 tokens?',
        source: 'state-field',
        field: 'contextPackage.tokenEstimate',
        branches: {
          'yes': { label: 'Large context', guidance: 'Compress the context package before dispatch. Summarize reference material, trim examples, and keep only load-bearing content to stay within agent context budget.', escalate: false },
          'no': { label: 'Acceptable context', guidance: 'Context size is within budget. Dispatch with the full context package — no compression needed.' },
        },
      },
    },
  ],
  templateVars: ['featureId', 'taskId'],
  autoEmits: [],
};

export const REVIEW_STRATEGY: RunbookDefinition = {
  id: 'review-strategy',
  phase: 'review',
  description: 'Select review strategy based on change characteristics: single-pass vs two-pass, and stage-specific guidance.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the diff touch more than 5 files or span multiple modules?',
        source: 'state-field',
        field: 'review.diffStats',
        branches: {
          'yes': { label: 'Large change', guidance: 'Use two-pass review: first pass with high recall to surface all potential issues, second pass with high precision to filter false positives and confirm real findings.' },
          'no': { label: 'Small change', guidance: 'Single-pass review is sufficient for focused changes. Apply standard review checklist within the module.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is this a prior review failure (fix cycle iteration)?',
        source: 'event-count',
        field: 'workflow.fix-cycle',
        branches: {
          'yes': { label: 'Fix cycle', guidance: 'Force two-pass review regardless of change size. Prior failure means the single-pass missed something — use high-recall first pass to catch regression, then high-precision second pass to verify the fix.', escalate: false },
          'no': { label: 'First review', guidance: 'Use the strategy selected in the previous step. No prior failures to account for.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Is this a spec-review stage or a quality-review stage?',
        source: 'state-field',
        field: 'review.stage',
        branches: {
          'spec-review': { label: 'Spec review', guidance: 'Focus on design alignment: does the implementation match the specification? Check interfaces, data flow, and architectural constraints. Ignore style and optimization.' },
          'quality-review': { label: 'Quality review', guidance: 'Focus on implementation quality: correctness, test coverage, error handling, performance, and maintainability. Assume design alignment is already verified.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const DESIGN_REFINEMENT: RunbookDefinition = {
  id: 'design-refinement',
  phase: 'ideate',
  description: 'Multi-pass design process: separate reasoning from formatting to improve design quality through circuit iteration.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the design task involve 3+ requirements, architectural trade-offs, or cross-cutting concerns?',
        source: 'human',
        branches: {
          'yes': { label: 'Complex design', guidance: 'Use two-pass design. Pass 1 (reasoning): determine architectural decisions, trade-offs, constraints, and requirement interactions — output decisions only, not formatted prose. Pass 2 (formatting): take pass 1 decisions and format into the design document template with sections, diagrams, and DR-N requirements.' },
          'no': { label: 'Simple design', guidance: 'Single-pass design is sufficient. Combine reasoning and formatting in one step for straightforward features.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Before starting pass 2, has the brainstorming discussion been compressed into a summary?',
        source: 'human',
        branches: {
          'yes': { label: 'Compressed', guidance: 'Proceed with pass 2. Use the compressed summary (~300 tokens: problem statement, key decisions, chosen approach, constraints) as input to the formatting pass — not the full brainstorming transcript.' },
          'no': { label: 'Not compressed', guidance: 'Compress first. Distill the brainstorming into ~300 tokens covering: problem statement, key decisions made, chosen approach with rationale, and hard constraints. Discard exploratory tangents and rejected alternatives.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const PLAN_COVERAGE_CHECK: RunbookDefinition = {
  id: 'plan-coverage-check',
  phase: 'plan-review',
  description: 'Self-consistency check using 3 independent framings to verify plan covers all design requirements.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Framing A (gap detection): Are there any DR-N requirements in the design that have NO corresponding task in the plan?',
        source: 'human',
        branches: {
          'yes': { label: 'Gaps found', guidance: 'Record each uncovered DR-N. These are confirmed gaps — the plan must be revised to add tasks covering them before approval.' },
          'no': { label: 'No gaps', guidance: 'All DR-N requirements have at least one corresponding task. Proceed to framing B for depth check.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Framing B (depth check): Does each DR-N have a task that FULLY addresses it — not just mentions it, but implements all its acceptance criteria?',
        source: 'human',
        branches: {
          'yes': { label: 'Full coverage', guidance: 'Each requirement is fully addressed by at least one task. Proceed to framing C for orphan check.' },
          'no': { label: 'Partial coverage', guidance: 'Record which DR-N requirements are only partially covered. These need task scope expansion or additional tasks. Note the specific gap (e.g., "DR-7 task covers reasoning separation but not the compression step").' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Framing C (orphan check): Are there tasks in the plan that do NOT trace back to any DR-N requirement?',
        source: 'human',
        branches: {
          'yes': { label: 'Orphan tasks found', guidance: 'Orphan tasks indicate scope creep or missing requirements. Either remove the orphan tasks or identify which requirement they should trace to and update the design.' },
          'no': { label: 'No orphans', guidance: 'All tasks trace to requirements. Proceed to convergence assessment.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Do all 3 framings agree on coverage completeness?',
        source: 'human',
        branches: {
          'yes': { label: 'Convergence', guidance: 'All framings agree — present the plan for human approval with confidence. The self-consistency check passed.' },
          'no': { label: 'Disagreement', guidance: 'Surface the specific DR-N requirements where framings disagree to the human reviewer. Disagreement indicates ambiguous requirements — these must be clarified before the plan can be approved. Do not resolve ambiguity autonomously.', escalate: true },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const PHASE_COMPRESSION: RunbookDefinition = {
  id: 'phase-compression',
  phase: 'delegate',
  description: 'Compress phase artifacts at transition boundaries to carry forward only load-bearing context.',
  steps: [
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'What is the source artifact being compressed?',
        source: 'human',
        branches: {
          'brainstorm-to-design': { label: 'Brainstorm → Design', guidance: 'Compress to ~300 tokens. Keep: problem statement, key decisions with rationale, chosen approach, hard constraints. Discard: exploratory tangents, rejected alternatives, conversational back-and-forth.' },
          'design-to-plan': { label: 'Design → Plan', guidance: 'Compress to ~500-token context packages per task. Each package quotes the specific DR-N requirements and design sections relevant to that task. Do not reference external documents — subagent prompts must be self-contained.' },
          'plan-to-review': { label: 'Plan → Review', guidance: 'Compress to ~300-token summary per task. Include: what was implemented, which DR-N it addresses, key design decisions. Review receives integration diff (not full files) plus these summaries.' },
        },
      },
    },
    {
      tool: 'none', action: 'decide', onFail: 'stop',
      decide: {
        question: 'Does the compressed output preserve all load-bearing information? Spot-check: can you reconstruct the key decisions from the summary alone?',
        source: 'human',
        branches: {
          'yes': { label: 'Verified', guidance: 'Compression is complete. Pass the compressed artifact to the next phase.' },
          'no': { label: 'Information lost', guidance: 'Identify what was lost and add it back. Common losses: constraint rationale (why a decision was made), interaction effects (how requirements depend on each other), and scope boundaries (what is explicitly excluded). Re-compress with these included.' },
        },
      },
    },
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const ALL_RUNBOOKS: readonly RunbookDefinition[] = [
  TASK_COMPLETION,
  QUALITY_EVALUATION,
  AGENT_TEAMS_SAGA,
  SYNTHESIS_FLOW,
  SHEPHERD_ITERATION,
  TASK_FIX,
  TRIAGE_DECISION,
  INVESTIGATION_DECISION,
  SCOPE_DECISION,
  DISPATCH_DECISION,
  REVIEW_ESCALATION,
  SHEPHERD_ESCALATION,
  TASK_CLASSIFICATION,
  REVIEW_STRATEGY,
  DESIGN_REFINEMENT,
  PLAN_COVERAGE_CHECK,
  PHASE_COMPRESSION,
];
