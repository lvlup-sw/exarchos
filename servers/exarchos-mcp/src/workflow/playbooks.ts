// ─── Phase Playbook Types ──────────────────────────────────────────────────

export interface ToolInstruction {
  readonly tool: string;
  readonly action: string;
  readonly purpose: string;
}

export interface EventInstruction {
  readonly type: string;
  readonly when: string;
  readonly fields?: readonly string[];
}

export interface PhasePlaybook {
  readonly phase: string;
  readonly workflowType: string;
  readonly skill: string;
  readonly skillRef: string;
  readonly tools: readonly ToolInstruction[];
  readonly events: readonly EventInstruction[];
  readonly transitionCriteria: string;
  readonly guardPrerequisites: string;
  readonly validationScripts: readonly string[];
  readonly humanCheckpoint: boolean;
  readonly compactGuidance: string;
}

// ─── Playbook Registry ────────────────────────────────────────────────────

const registry = new Map<string, PhasePlaybook>();

function register(playbook: PhasePlaybook): void {
  registry.set(`${playbook.workflowType}:${playbook.phase}`, playbook);
}

// ─── Lookup ───────────────────────────────────────────────────────────────

export function getPlaybook(
  workflowType: string,
  phase: string,
): PhasePlaybook | null {
  return registry.get(`${workflowType}:${phase}`) ?? null;
}

// ─── Renderer ─────────────────────────────────────────────────────────────

export function renderPlaybook(playbook: PhasePlaybook): string {
  const lines: string[] = [];

  lines.push('### Behavioral Guidance');
  const skillLink = playbook.skillRef
    ? playbook.skillRef
    : playbook.skill === 'none'
      ? 'None'
      : `@skills/${playbook.skill}/SKILL.md`;
  lines.push(`**Skill:** ${skillLink}`);

  if (playbook.tools.length > 0) {
    const toolEntries = playbook.tools
      .map((t) => `${t.tool} (${t.action}: ${t.purpose})`)
      .join(', ');
    lines.push(`**Tools:** ${toolEntries}`);
  } else {
    lines.push('**Tools:** None');
  }

  if (playbook.events.length > 0) {
    const eventEntries = playbook.events
      .map((e) => `${e.type} — ${e.when}`)
      .join(', ');
    lines.push(`**Events to emit:** ${eventEntries}`);
  } else {
    lines.push('**Events to emit:** None');
  }

  lines.push(
    `**Transition:** ${playbook.transitionCriteria} | Guard: ${playbook.guardPrerequisites || 'None'}`,
  );

  if (playbook.validationScripts.length > 0) {
    lines.push(`**Scripts:** ${playbook.validationScripts.join(', ')}`);
  }

  lines.push(playbook.compactGuidance);

  return lines.join('\n');
}

// ─── Terminal Playbook Factory ────────────────────────────────────────────

function terminalPlaybook(
  workflowType: string,
  phase: string,
  guidance: string,
): PhasePlaybook {
  return {
    phase,
    workflowType,
    skill: 'none',
    skillRef: '',
    tools: [],
    events: [],
    transitionCriteria: 'Terminal state',
    guardPrerequisites: '',
    validationScripts: [],
    humanCheckpoint: false,
    compactGuidance: guidance,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Feature Workflow Playbooks
// ═══════════════════════════════════════════════════════════════════════════

register({
  phase: 'ideate',
  workflowType: 'feature',
  skill: 'brainstorming',
  skillRef: '@skills/brainstorming/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record design decisions and artifacts',
    },
  ],
  events: [],
  transitionCriteria: 'Design artifact created → plan',
  guardPrerequisites: 'artifacts.design exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are brainstorming a feature design. Use exarchos_workflow set to record design decisions. Create design doc at docs/designs/. Transition to plan when design artifact is set in state. Key decision: problem-first exploration vs solution-first — exhaust constraints before converging on an approach. Anti-pattern: jumping to implementation details without understanding the problem space and constraints. Escalate: design scope remains unclear after 2 brainstorming iterations.',
});

register({
  phase: 'plan',
  workflowType: 'feature',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record plan artifact and task breakdown',
    },
  ],
  events: [],
  transitionCriteria: 'Plan artifact created → plan-review',
  guardPrerequisites: 'artifacts.plan exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are creating an implementation plan from the design doc. Use exarchos_workflow set to record the plan artifact path. Break work into parallelizable TDD tasks. Transition to plan-review when plan is complete. Key decision: task granularity (target 2-5 min each) and parallel vs sequential grouping. Anti-pattern: monolith tasks that cannot be parallelized across agents. Escalate: design has ambiguous requirements that block decomposition into concrete tasks.',
});

register({
  phase: 'plan-review',
  workflowType: 'feature',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record review decision',
    },
  ],
  events: [],
  transitionCriteria: 'Plan approved → delegate | Gaps found → plan',
  guardPrerequisites: 'Plan review complete',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are at a human checkpoint reviewing the implementation plan. Wait for user approval or revision feedback. Record approval with exarchos_workflow set using updates: { planReview: { approved: true } }. Transition to delegate on approval or back to plan if gaps found. Key decision: approve plan as-is vs request revision with specific feedback. Anti-pattern: rubber-stamping without checking that every DR-N requirement has a corresponding task. Escalate: 3+ revision cycles without convergence on a viable plan.',
});

register({
  phase: 'delegate',
  workflowType: 'feature',
  skill: 'delegation',
  skillRef: '@skills/delegation/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read task list and worktree assignments',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose:
        'Update task statuses, transition to review when all complete',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose:
        'Emit task.assigned on dispatch, gate.executed on post-delegation check',
    },
    {
      tool: 'exarchos_event',
      action: 'batch_append',
      purpose: 'Batch emit team events',
    },
    {
      tool: 'exarchos_orchestrate',
      action: 'task_complete',
      purpose: 'Mark individual task complete',
    },
  ],
  events: [
    { type: 'task.assigned', when: 'On dispatch of each task', fields: ['taskId', 'title', 'worktree'] },
    { type: 'team.spawned', when: 'After team creation', fields: ['teamSize', 'teammateNames', 'taskCount', 'dispatchMode'] },
    {
      type: 'team.teammate.dispatched',
      when: 'After each agent spawn',
    },
    { type: 'team.disbanded', when: 'After all tasks collected', fields: ['totalDurationMs', 'tasksCompleted', 'tasksFailed'] },
    {
      type: 'gate.executed',
      when: 'After post-delegation-check.sh runs',
      fields: ['gateName', 'layer', 'passed'],
    },
    { type: 'task.progressed', when: 'After each TDD phase transition (red/green/refactor)' },
  ],
  transitionCriteria: 'All tasks complete → review',
  guardPrerequisites:
    "tasks[].status = 'complete' for every task",
  validationScripts: ['scripts/post-delegation-check.sh'],
  humanCheckpoint: false,
  compactGuidance:
    'You are dispatching implementation tasks. Use exarchos_event to emit task.assigned for each dispatch. Use exarchos_workflow set to mark tasks complete. Run post-delegation-check.sh when all tasks finish. Transition to review when all tasks complete. Key decision: parallel vs sequential dispatch; each subagent prompt must be self-contained. Anti-pattern: referencing "the plan" in subagent prompts instead of pasting full context. Verify test output independently — do not trust subagent self-assessment. Escalate: same task fails 3 times or task requires changes outside its declared module scope.',
});

register({
  phase: 'review',
  workflowType: 'feature',
  skill: 'quality-review',
  skillRef: '@skills/quality-review/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read task and review state',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record review results and transition',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit gate.executed for review gates',
    },
  ],
  events: [
    { type: 'gate.executed', when: 'After each review gate runs', fields: ['gateName', 'layer', 'passed'] },
    { type: 'review.completed', when: 'After each review stage completes', fields: ['stage', 'verdict', 'findingsCount', 'summary'] },
  ],
  transitionCriteria:
    'All reviews passed → synthesize | Any review failed → delegate',
  guardPrerequisites:
    'reviews.spec-review.passed AND reviews.quality-review.passed',
  validationScripts: [
    'scripts/static-analysis-gate.sh',
    'scripts/security-scan.sh',
  ],
  humanCheckpoint: false,
  compactGuidance:
    'You are running two-stage code review (spec + quality). Use exarchos_event to emit gate.executed for each review gate. Use exarchos_workflow set to record review results. Transition to synthesize when all reviews pass, or back to delegate if fixes needed. Key decision: pass vs fix-cycle vs block — assess severity of each finding. Anti-pattern: trusting passing tests as proof of completeness — check what the tests actually verify and look for missing coverage. Escalate: same finding appears in 2+ review cycles.',
});

register({
  phase: 'synthesize',
  workflowType: 'feature',
  skill: 'synthesis',
  skillRef: '@skills/synthesis/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read synthesis state',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record PR URLs and synthesis metadata',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit gate.executed for pre-synthesis checks',
    },
  ],
  events: [
    {
      type: 'gate.executed',
      when: 'After pre-synthesis-check.sh and validate-pr-stack.sh',
      fields: ['gateName', 'layer', 'passed'],
    },
    { type: 'shepherd.started', when: 'On first assess-stack invocation' },
    { type: 'shepherd.approval_requested', when: 'When all checks pass and approval is needed' },
    { type: 'shepherd.completed', when: 'When PR is merged or shepherd resolves' },
  ],
  transitionCriteria: 'PR created and enqueued → completed',
  guardPrerequisites: 'artifacts.pr exists',
  validationScripts: [
    'scripts/pre-synthesis-check.sh',
    'scripts/validate-pr-stack.sh',
  ],
  humanCheckpoint: true,
  compactGuidance:
    'You are creating PRs via GitHub CLI. Run pre-synthesis-check.sh first. Use exarchos_event to emit gate.executed results. Wait for user confirmation to merge. This is a human checkpoint — pause and confirm before proceeding. Key decision: single PR vs stacked PRs based on change scope. Anti-pattern: merging without CI green on all checks. Escalate: CI fails 3+ times on the same issue.',
});

register(
  terminalPlaybook(
    'feature',
    'completed',
    'Workflow is complete. No further actions needed.',
  ),
);

register(
  terminalPlaybook(
    'feature',
    'cancelled',
    'Workflow was cancelled. No further actions needed.',
  ),
);

register({
  phase: 'blocked',
  workflowType: 'feature',
  skill: 'none',
  skillRef: '',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → delegate',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow set to record the decision and transition back to delegate.',
});

// ═══════════════════════════════════════════════════════════════════════════
// Debug Workflow Playbooks
// ═══════════════════════════════════════════════════════════════════════════

register({
  phase: 'triage',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record triage findings and severity assessment',
    },
  ],
  events: [],
  transitionCriteria: 'Triage complete → investigate',
  guardPrerequisites: 'triageComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are triaging a bug report. Use exarchos_workflow set to record triage findings, severity, and reproduction steps. Transition to investigate when triage is complete. Key decision: severity assessment — P0 immediate (production impact) vs P1 planned (next sprint). Anti-pattern: skipping reproduction steps and jumping straight to investigation. Escalate: bug is not reproducible after 15 minutes of attempting reproduction.',
});

register({
  phase: 'investigate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record investigation findings and track selection',
    },
  ],
  events: [],
  transitionCriteria:
    'Thorough track → rca | Hotfix track → hotfix-implement | Escalation → cancelled',
  guardPrerequisites:
    'thoroughTrackSelected OR hotfixTrackSelected OR escalationRequired',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are investigating the bug root cause. Use exarchos_workflow set to record investigation findings. Select thorough track (rca) for complex bugs or hotfix track for simple fixes. Transition based on track selection. Key decision: hotfix track (reproducible, <=3 files changed) vs thorough track (intermittent or cross-module). Anti-pattern: premature hotfix on complex bugs that need deeper root cause analysis. Escalate: 15 minutes without root cause identification.',
});

register({
  phase: 'rca',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record RCA document and root cause analysis',
    },
  ],
  events: [],
  transitionCriteria: 'RCA document complete → design',
  guardPrerequisites: 'rca document exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are performing root cause analysis. Use exarchos_workflow set to record the rca document path and findings. Transition to design when the rca document is complete. Key decision: immediate cause vs systemic root cause — trace the full causal chain. Anti-pattern: stopping at symptoms without tracing to the underlying root cause in the code. Escalate: root cause spans multiple subsystems requiring coordinated fixes.',
});

register({
  phase: 'design',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record fix design decisions',
    },
  ],
  events: [],
  transitionCriteria: 'Fix design complete → debug-implement',
  guardPrerequisites: 'fixDesign document exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are designing the fix based on the RCA. Use exarchos_workflow set to record the fix design. Transition to debug-implement when the design is complete. Key decision: minimal targeted fix vs defensive fix with additional guards and validation. Anti-pattern: scope creep beyond the bug fix — resist adding unrelated improvements. Escalate: fix requires architectural change that cannot be contained to a targeted patch.',
});

register({
  phase: 'debug-implement',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record implementation progress and completion',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → debug-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing the fix based on the design. Use exarchos_workflow set to record implementation progress. Follow TDD — write failing test first, then implement fix. Transition to debug-validate when implementation is complete. Key decision: test-first verification — the failing test must reproduce the exact bug before writing the fix. Anti-pattern: fixing without a failing test that reproduces the bug. Escalate: implementation touches >5 files, consider splitting.',
});

register({
  phase: 'debug-validate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record validation results',
    },
  ],
  events: [],
  transitionCriteria: 'Validation passed → debug-review',
  guardPrerequisites: 'validationPassed',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are validating the fix. Use exarchos_workflow set to record validation results. Run tests, verify the bug is fixed, and check for regressions. Transition to debug-review when validation passes. Key decision: regression testing scope — run full suite, not just the new test. Anti-pattern: only testing the fix without checking adjacent behavior for regressions. Escalate: new test failures appear during validation that are unrelated to the fix.',
});

register({
  phase: 'debug-review',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record review results',
    },
  ],
  events: [],
  transitionCriteria: 'Review passed → synthesize',
  guardPrerequisites: 'reviewPassed',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are reviewing the fix for code quality and correctness. Use exarchos_workflow set to record review results. Transition to synthesize when the review passes. Key decision: review depth proportional to fix scope — larger fixes need deeper review. Anti-pattern: skipping review for "simple" fixes that may have non-obvious side effects. Escalate: fix changes public API surface, requiring broader impact assessment.',
});

register({
  phase: 'hotfix-implement',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record hotfix implementation progress',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → hotfix-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing a hotfix. Use exarchos_workflow set to record implementation progress. This is the fast-track — apply minimal targeted fix within a 15-minute time budget. Transition to hotfix-validate when implementation is complete. Key decision: stay minimal and targeted within the time budget. Anti-pattern: hotfix growing into a full fix — if scope expands, switch to thorough track via rca. Escalate: time limit exceeded without a working fix.',
});

register({
  phase: 'hotfix-validate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record validation results and PR decision',
    },
  ],
  events: [],
  transitionCriteria:
    'Validation passed + PR requested → synthesize | Validation passed → completed',
  guardPrerequisites: 'validationPassed',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are validating the hotfix. Use exarchos_workflow set to record validation results. Run tests and verify the fix. HUMAN CHECKPOINT: present results and await user decision. If PR is requested, transition to synthesize; otherwise transition to completed. Key decision: PR-based merge vs direct to main based on risk assessment. Anti-pattern: merging without running the full test suite. Escalate: validation reveals the fix is incomplete and needs thorough track.',
});

register({
  phase: 'synthesize',
  workflowType: 'debug',
  skill: 'synthesis',
  skillRef: '@skills/synthesis/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read synthesis state',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record PR URLs and synthesis metadata',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit gate.executed for synthesis checks',
    },
  ],
  events: [
    {
      type: 'gate.executed',
      when: 'After synthesis validation scripts',
      fields: ['gateName', 'layer', 'passed'],
    },
  ],
  transitionCriteria: 'PR URL exists → completed',
  guardPrerequisites: 'artifacts.pr exists',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are creating a PR for the debug fix via GitHub CLI. Use exarchos_workflow set to record PR URLs. Wait for user confirmation before merging. This is a human checkpoint — pause and confirm before proceeding. Key decision: single PR for targeted fixes, stacked PRs for multi-part fixes. Anti-pattern: merging without CI green on all checks. Escalate: CI fails 3+ times on the same issue.',
});

register(
  terminalPlaybook(
    'debug',
    'completed',
    'Workflow is complete. No further actions needed.',
  ),
);

register(
  terminalPlaybook(
    'debug',
    'cancelled',
    'Workflow was cancelled. No further actions needed.',
  ),
);

register({
  phase: 'blocked',
  workflowType: 'debug',
  skill: 'none',
  skillRef: '',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → previous phase',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow set to record the decision.',
});

// ═══════════════════════════════════════════════════════════════════════════
// Refactor Workflow Playbooks
// ═══════════════════════════════════════════════════════════════════════════

register({
  phase: 'explore',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record scope assessment and exploration findings',
    },
  ],
  events: [],
  transitionCriteria: 'Scope assessment complete → brief',
  guardPrerequisites: 'scopeAssessmentComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are exploring the codebase to assess refactoring scope. Use exarchos_workflow set to record exploration findings and scope assessment. Transition to brief when scope assessment is complete. Key decision: scope assessment — count affected files, assess complexity and risk level. Anti-pattern: exploring without setting a clear boundary on what is in and out of scope. Escalate: scope exceeds what can be delivered in a single PR.',
});

register({
  phase: 'brief',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record refactoring brief and track selection',
    },
  ],
  events: [],
  transitionCriteria:
    'Polish track → polish-implement | Overhaul track → overhaul-plan',
  guardPrerequisites: 'polishTrackSelected OR overhaulTrackSelected',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are writing the refactoring brief. Use exarchos_workflow set to record the brief and select polish (small) or overhaul (large) track. Transition based on track selection. Key decision: polish track (<=5 files, cosmetic/DRY) vs overhaul track (>5 files, structural changes). Anti-pattern: choosing polish for structural changes that actually need the overhaul track. Escalate: scope is unclear after exploration, revisit explore phase.',
});

register({
  phase: 'polish-implement',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record implementation progress and completion',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → polish-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing polish-track refactoring changes directly. Use exarchos_workflow set to record progress. Follow TDD if changing behavior. Stay within brief scope. Transition to polish-validate when implementation is complete. Key decision: stay strictly within the brief scope for each change. Anti-pattern: scope creep beyond the brief — resist adding improvements not in the brief. Escalate: changes cascade beyond the declared scope, consider switching to overhaul track.',
});

register({
  phase: 'polish-validate',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record validation results',
    },
  ],
  events: [],
  transitionCriteria: 'Goals verified → polish-update-docs',
  guardPrerequisites: 'goalsVerified',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are validating the polish refactoring meets goals. Use exarchos_workflow set to record validation results. Run tests and verify refactoring goals are met. Transition to polish-update-docs when goals are verified. Key decision: verify all brief goals are met, not just a subset. Anti-pattern: accepting partial completion when some goals remain unmet. Escalate: goals are not achievable without switching to the overhaul track.',
});

register({
  phase: 'polish-update-docs',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record docs update status',
    },
  ],
  events: [],
  transitionCriteria: 'Docs updated → completed',
  guardPrerequisites: 'docsUpdated',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are updating documentation for the polish refactoring. Use exarchos_workflow set to record docs update completion. HUMAN CHECKPOINT: present updated docs summary and await user confirmation before transitioning to completed. Key decision: which docs need updates based on the changes made. Anti-pattern: skipping documentation updates for "obvious" changes that still affect developer understanding.',
});

register({
  phase: 'overhaul-plan',
  workflowType: 'refactor',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record plan artifact and task breakdown',
    },
  ],
  events: [],
  transitionCriteria: 'Plan artifact exists → overhaul-plan-review',
  guardPrerequisites: 'planArtifactExists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are creating an implementation plan for the overhaul refactoring. Use exarchos_workflow set to record the plan artifact path. Break work into parallelizable TDD tasks. Transition to overhaul-plan-review when plan artifact exists. Key decision: task granularity for the large refactor — target 2-5 min per task. Anti-pattern: monolith tasks that cannot be distributed across agents. Escalate: plan exceeds 20 tasks, split into sequential phases.',
});

register({
  phase: 'overhaul-plan-review',
  workflowType: 'refactor',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record review decision',
    },
  ],
  events: [],
  transitionCriteria: 'Plan approved → overhaul-delegate | Gaps found → overhaul-plan | Revisions exhausted → blocked',
  guardPrerequisites: 'Plan review complete',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are at a human checkpoint reviewing the overhaul refactoring plan. Wait for user approval or revision feedback. Record approval with exarchos_workflow set using updates: { planReview: { approved: true } }. Transition to overhaul-delegate on approval, back to overhaul-plan if gaps found, or to blocked when revisions are exhausted. Key decision: approve vs revise with specific actionable feedback. Anti-pattern: rubber-stamping without checking task coverage of all brief goals. Escalate: 3+ revision cycles without convergence.',
});

register({
  phase: 'overhaul-delegate',
  workflowType: 'refactor',
  skill: 'delegation',
  skillRef: '@skills/delegation/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read task list and worktree assignments',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Update task statuses',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit task.assigned on dispatch',
    },
    {
      tool: 'exarchos_orchestrate',
      action: 'task_complete',
      purpose: 'Mark individual task complete',
    },
  ],
  events: [
    { type: 'task.assigned', when: 'On dispatch of each task', fields: ['taskId', 'title', 'worktree'] },
    { type: 'team.spawned', when: 'After team creation', fields: ['teamSize', 'teammateNames', 'taskCount', 'dispatchMode'] },
    { type: 'team.disbanded', when: 'After all tasks collected', fields: ['totalDurationMs', 'tasksCompleted', 'tasksFailed'] },
  ],
  transitionCriteria: 'All tasks complete → overhaul-review',
  guardPrerequisites: 'allTasksComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are dispatching overhaul implementation tasks. Use exarchos_event to emit task.assigned for each dispatch. Use exarchos_workflow set to mark tasks complete. Transition to overhaul-review when all tasks complete. Key decision: parallel dispatch strategy — each agent gets its own worktree and self-contained prompt. Anti-pattern: sharing worktrees between agents or referencing shared state without explicit context. Escalate: 3 task failures on the same task.',
});

register({
  phase: 'overhaul-review',
  workflowType: 'refactor',
  skill: 'quality-review',
  skillRef: '@skills/quality-review/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read task and review state',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record review results and transition',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit gate.executed for review gates',
    },
  ],
  events: [
    { type: 'gate.executed', when: 'After each review gate runs', fields: ['gateName', 'layer', 'passed'] },
  ],
  transitionCriteria:
    'All reviews passed → overhaul-update-docs | Any review failed → overhaul-delegate',
  guardPrerequisites: 'allReviewsPassed',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are reviewing the overhaul refactoring. Use exarchos_event to emit gate.executed for review gates. Use exarchos_workflow set to record review results. Transition to overhaul-update-docs when all reviews pass, or back to overhaul-delegate if fixes needed. Key decision: review depth proportional to change scope. Anti-pattern: trusting subagent self-assessment — independently verify test output and coverage. Escalate: regression findings appear in modules unrelated to the refactoring.',
});

register({
  phase: 'overhaul-update-docs',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record docs update status',
    },
  ],
  events: [],
  transitionCriteria: 'Docs updated → synthesize',
  guardPrerequisites: 'docsUpdated',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are updating documentation for the overhaul refactoring. Use exarchos_workflow set to record docs update completion. Transition to synthesize when docs are updated. Key decision: documentation scope — update all docs affected by the structural changes. Anti-pattern: skipping documentation updates for refactoring that changes module boundaries or APIs.',
});

register({
  phase: 'synthesize',
  workflowType: 'refactor',
  skill: 'synthesis',
  skillRef: '@skills/synthesis/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read synthesis state',
    },
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record PR URLs and synthesis metadata',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit gate.executed for synthesis checks',
    },
  ],
  events: [
    {
      type: 'gate.executed',
      when: 'After synthesis validation scripts',
      fields: ['gateName', 'layer', 'passed'],
    },
  ],
  transitionCriteria: 'PR URL exists → completed',
  guardPrerequisites: 'artifacts.pr exists',
  validationScripts: [
    'scripts/pre-synthesis-check.sh',
    'scripts/validate-pr-stack.sh',
  ],
  humanCheckpoint: true,
  compactGuidance:
    'You are creating PRs via GitHub CLI for the overhaul refactoring. Use exarchos_workflow set to record PR URLs. Wait for user confirmation before merging. This is a human checkpoint — pause and confirm before proceeding. Key decision: single PR vs stacked PRs based on change scope. Anti-pattern: merging without CI green on all checks. Escalate: CI fails 3+ times on the same issue.',
});

register(
  terminalPlaybook(
    'refactor',
    'completed',
    'Workflow is complete. No further actions needed.',
  ),
);

register(
  terminalPlaybook(
    'refactor',
    'cancelled',
    'Workflow was cancelled. No further actions needed.',
  ),
);

register({
  phase: 'blocked',
  workflowType: 'refactor',
  skill: 'none',
  skillRef: '',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'set',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → previous phase',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow set to record the decision.',
});

// ─── Serialization Types ─────────────────────────────────────────────────────

export interface SerializedPlaybooks {
  readonly workflowType: string;
  readonly phases: Record<string, SerializedPhasePlaybook>;
  readonly phaseCount: number;
}

export interface SerializedPhasePlaybook {
  readonly skill: string;
  readonly skillRef: string;
  readonly tools: readonly ToolInstruction[];
  readonly events: readonly EventInstruction[];
  readonly transitionCriteria: string;
  readonly guardPrerequisites: string;
  readonly validationScripts: readonly string[];
  readonly humanCheckpoint: boolean;
  readonly compactGuidance: string;
}

// ─── Serialization Functions ─────────────────────────────────────────────────

/**
 * Serialize all playbooks for a given workflow type into a plain
 * JSON-serializable object keyed by phase name.
 *
 * Pure function with no side effects. Throws for unknown workflow types.
 */
export function serializePlaybooks(workflowType: string): SerializedPlaybooks {
  const phases: Record<string, SerializedPhasePlaybook> = {};

  for (const [, playbook] of registry) {
    if (playbook.workflowType !== workflowType) continue;

    phases[playbook.phase] = {
      skill: playbook.skill,
      skillRef: playbook.skillRef,
      tools: [...playbook.tools],
      events: [...playbook.events],
      transitionCriteria: playbook.transitionCriteria,
      guardPrerequisites: playbook.guardPrerequisites,
      validationScripts: [...playbook.validationScripts],
      humanCheckpoint: playbook.humanCheckpoint,
      compactGuidance: playbook.compactGuidance,
    };
  }

  const phaseCount = Object.keys(phases).length;
  if (phaseCount === 0) {
    throw new Error(`Unknown workflow type: ${workflowType}`);
  }

  return {
    workflowType,
    phases,
    phaseCount,
  };
}

/**
 * List distinct workflow types that have playbooks registered.
 *
 * Pure function with no side effects.
 */
export function listPlaybookWorkflowTypes(): string[] {
  const types = new Set<string>();
  for (const playbook of registry.values()) {
    types.add(playbook.workflowType);
  }
  return [...types];
}
