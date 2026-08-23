import type { RunbookDefinition } from './types.js';

export const TASK_COMPLETION: RunbookDefinition = {
  id: 'task-completion',
  phase: 'delegate',
  description: 'Complete a task after every blocking per-task gate has passed.',
  steps: [
    // Verification-ladder: the kill-probe gate is the load-bearing per-task
    // verification — the sole per-task gate after check_tdd_compliance was
    // retired (#1587). It reverts the task's source hunks, re-runs the
    // new/changed tests, and asserts at least one goes red — proving the tests
    // are not vacuous (outcome-based adequacy, test-after, NOT commit-order
    // test-first). Runs against the agent worktree (repoRoot:auto +
    // worktreePath, the #1330 resolver).
    // DR-3: `riskTier` + `boundaryTouching` are resolved and FROZEN at
    // prepare_delegation (deriveRiskTier / deriveBoundaryTouching, honoring
    // planner stamps). They must reach the gate that CONSUMES them, or the
    // frozen stamp is stranded: `interpretProbeVerdict` reads the tier to
    // decide whether an un-probed task blocks (medium/high) or degrades to an
    // advisory skip (low), and `resolvePolicySkip` needs BOTH fields to route
    // the gate at all. Dispatched with an undefined tier, a high-tier task that
    // adds no probe-able tests came back a PASS. The `<var>` placeholders
    // thread the matching templateVars below — the orchestrator fills them from
    // the classification prepare_delegation returned, never re-deriving them.
    { tool: 'exarchos_orchestrate', action: 'check_test_adequacy', onFail: 'stop',
      params: { taskId: '<taskId>', repoRoot: 'auto', worktreePath: '<worktreePath>',
        riskTier: '<riskTier>', boundaryTouching: '<boundaryTouching>' },
      note: 'kill probe: reverts source, re-runs new tests, asserts red — the load-bearing per-task gate' },
    // Verification-ladder slice 1 Bundle B3: the contract-drift gate regenerates
    // schema bindings, typechecks the regen, and runs a breaking-change diff
    // against the merge-base. Runs against the agent worktree (repoRoot:auto +
    // worktreePath, the #1330 resolver). Degrades to an advisory pass when no
    // contract tool resolves (INV-4), so onFail:'stop' only halts on real
    // breaking drift — a repo with no schema boundary is never blocked.
    // DR-3: policy-routed by the frozen stamp (see the kill-probe step above).
    { tool: 'exarchos_orchestrate', action: 'check_contract_drift', onFail: 'stop',
      params: { taskId: '<taskId>', repoRoot: 'auto', worktreePath: '<worktreePath>',
        riskTier: '<riskTier>', boundaryTouching: '<boundaryTouching>' },
      note: 'contract gate: codegen → typecheck → breaking-diff vs merge-base; advisory-skips when no contract tool resolves' },
    // Verification-ladder slice 1 SIV-4 (#1530): the mock-boundary gate scans the
    // task's NEW test hunks for unowned-dependency mocks and steers toward
    // hermetic fixtures. ADVISORY (onFail:'continue') — an unowned mock can be the
    // right call (acknowledged via the `reason` escape hatch), so it surfaces a
    // per-finding steer without blocking the task. Runs against the agent worktree
    // (repoRoot:auto + worktreePath, the #1330 resolver).
    // DR-3: policy-routed by the frozen stamp (see the kill-probe step above) —
    // mock-boundary is in the resolved sequence only for a boundary-touching
    // medium/high task, so the stamp is what keeps it off a low-blast edit.
    { tool: 'exarchos_orchestrate', action: 'check_mock_boundary', onFail: 'continue',
      params: { taskId: '<taskId>', repoRoot: 'auto', worktreePath: '<worktreePath>',
        riskTier: '<riskTier>', boundaryTouching: '<boundaryTouching>' },
      note: 'ADVISORY (SIV-4 #1530): flags unowned mocks in new test hunks; steers toward hermetic fixtures' },
    // #1330 / T-05: the static-analysis gate must run against the agent's
    // worktree, not the orchestrator's cwd. `repoRoot: 'auto'` triggers the
    // worktree-aware resolver (T-04, gate-utils.resolveRepoRoot); the
    // `<worktreePath>` placeholder threads the `worktreePath` template var so
    // the agent supplies its own worktree path at fill-in time.
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop',
      params: { taskId: '<taskId>', repoRoot: 'auto', worktreePath: '<worktreePath>' },
      note: '#1330: run against the agent worktree via repoRoot:auto + worktreePath template var' },
    // WFQ-004: `task_complete` is the TERMINAL step. Every blocking per-task
    // gate above must have passed before the task is recorded complete —
    // previously the cumulative integration suite ran AFTER this step, so a
    // task could be marked complete and only then fail its last blocking gate.
    // The cumulative suite now runs once at the wave boundary
    // (AGENT_TEAMS_SAGA), matching `check_integration_suite`'s own contract as
    // a post-merge backstop rather than a per-task gate.
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop',
      note: 'WFQ-004: terminal step — no blocking per-task gate may follow it' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId', 'branch', 'worktreePath',
    // DR-3: the frozen delegation stamp. Declared here so the orchestrator is
    // contractually obliged to supply the SAME values prepare_delegation
    // resolved — the `<riskTier>` / `<boundaryTouching>` placeholders on the
    // gate steps above have nothing to bind to otherwise.
    'riskTier', 'boundaryTouching'],
  // T-01/T-02: every check_* gate step above routes through the canonical
  // durable gate runner, which mints `gate.executed` from the SAME persisted
  // `admission.evidence-recorded` record it just wrote (registry.ts declares
  // both now — see the `runDurableGateProducer` comment on each action).
  autoEmits: ['admission.evidence-recorded', 'gate.executed', 'task.completed'],
};

export const QUALITY_EVALUATION: RunbookDefinition = {
  id: 'quality-evaluation',
  phase: 'review',
  description: 'Run quality gates and compute review verdict.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'check_security_scan', onFail: 'continue' },
    { tool: 'exarchos_orchestrate', action: 'check_convergence', onFail: 'continue' },
    // DR-15 / task 027: invariant conformance as a review dimension. Now that
    // INV-13/14/16 carry mode:check (alongside INV-4), this gate produces
    // deterministic mechanical findings; a blocking-severity check violation
    // (INV-4/14/16) folds to a HIGH → NEEDS_FIXES and halts (onFail:'stop').
    // Audit-mode entries render into the review-subagent prompt, never gating
    // here. Evaluates check-mode trees against the review `diff` (supplied at
    // fill-in).
    { tool: 'exarchos_orchestrate', action: 'check_invariant_conformance', onFail: 'stop',
      note: 'DR-15: check-mode invariant findings gate; audit-mode entries stay advisory (prompt-only)' },
    { tool: 'exarchos_orchestrate', action: 'check_review_verdict', onFail: 'stop' },
  ],
  templateVars: ['featureId', 'high', 'medium', 'low'],
  // The review gates route through the canonical gate runner, which persists
  // durable evidence before reporting success — so every enforceable step here
  // also emits `admission.evidence-recorded` alongside `gate.executed`.
  autoEmits: ['admission.evidence-recorded', 'gate.executed'],
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
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'state.patched' },
      note: 'Store task correlation — emit state.patched directly (DR-4: `set({updates})` MCP surface removed in v2.11)' },
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
    // WFQ-004 / #1329: the cumulative full-suite gate runs ONCE here, at the
    // wave boundary after every wave merge has landed — not per task. It
    // surfaces the accumulated load cascade that per-task gates miss (a file
    // failing at import is "0 failed tests / 1 failed suite"). Running it once
    // per wave also removes the duplicate-ownership loop where the agent, the
    // lead, and the per-task runbook each re-verified the same claim.
    // WFQ-004 executability fix: `repoRoot: 'auto'` with NO worktreePath and
    // NO taskId can never resolve (gate-utils.resolveRepoRoot falls through
    // every branch → ok:false → INVALID_INPUT), so the saga always halted at
    // the wave boundary. The cumulative suite runs against the INTEGRATION
    // worktree — a wave-level location the per-task resolver cannot derive —
    // so the orchestrator must fill the `<repoRoot>` template var (declared in
    // templateVars below) with the integration worktree's absolute path.
    { tool: 'exarchos_orchestrate', action: 'check_integration_suite', onFail: 'stop',
      params: { repoRoot: '<repoRoot>' },
      note: 'WFQ-004: cumulative post-merge backstop — exactly once per wave, folds file-LOAD failures into failCount. Fill <repoRoot> with the INTEGRATION worktree path (not a per-task worktree).' },
    { tool: 'exarchos_orchestrate', action: 'post_delegation_check', onFail: 'stop',
      note: 'Verify all tasks complete, tests pass, branches exist' },
    { tool: 'exarchos_workflow', action: 'transition', onFail: 'stop',
      params: { target: 'review' },
      note: 'Auto-emits workflow.transition (DR-4: replaces `set({phase})` rerouting in v2.11)' },
  ],
  templateVars: ['featureId', 'streamId', 'stream', 'event', 'events', 'teamId', 'stateFile', 'repoRoot'],
  // T5a.1/DR-4 (#1259, v2.11): hard-cut of `workflow.set` removes the
  // `hsm.deprecated_action_invoked` emission path. State patches now
  // route through `exarchos_event.append` directly (the event type is
  // carried via `params.type`, not `action.autoEmits`); the canonical
  // phase-mutation event is `workflow.transition` emitted by the
  // `transition` action.
  autoEmits: ['admission.evidence-recorded', 'gate.executed', 'workflow.transition'],
};

export const SYNTHESIS_FLOW: RunbookDefinition = {
  id: 'synthesis-flow',
  phase: 'synthesize',
  description: 'Verify readiness, create PR, submit for merge.',
  steps: [
    // DR-8 (#1756): `repoRoot` is a REQUIRED field on the action schema — the
    // four readiness legs shell out and the gate refuses to guess which tree
    // they measure. Fill `<repoRoot>` with the absolute path of the repo the
    // verdict is about (the integration worktree during a stacked synthesis),
    // not the directory the MCP server happens to be running in.
    { tool: 'exarchos_orchestrate', action: 'prepare_synthesis', onFail: 'stop',
      params: { repoRoot: '<repoRoot>' },
      note: 'Fill <repoRoot> with the absolute path of the repo under synthesis; all four legs (tests, typecheck, stack, changed files) run there' },
    { tool: 'exarchos_orchestrate', action: 'validate_pr_stack', onFail: 'stop' },
    { tool: 'exarchos_orchestrate', action: 'validate_pr_body', onFail: 'stop' },
    { tool: 'native:bash', action: 'gh_pr_create', onFail: 'stop',
      note: 'Create PR via gh CLI' },
    { tool: 'exarchos_event', action: 'append', onFail: 'stop',
      params: { type: 'state.patched' },
      note: 'Record PR URL in artifacts.prUrl — emit state.patched directly (DR-4: `set` MCP surface removed in v2.11)' },
  ],
  // T5a.1/DR-4 (v2.11): added `stream` and `event` template vars to cover
  // the new `event.append` step's required schema fields.
  templateVars: ['featureId', 'baseBranch', 'repoRoot', 'stream', 'event'],
  // T5a.1/DR-4 (v2.11): `set` removed. The `hsm.deprecated_action_invoked`
  // emission disappeared with it; remaining auto-emits are the canonical
  // event types this synthesis flow still produces. `state.patched` is
  // emitted via `event.append({type: 'state.patched'})` — that's a
  // `params.type` value rather than an action-level `autoEmits` entry,
  // so it does not appear in the computed-from-registry view.
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
    // #1587 retired check_tdd_compliance; TASK_COMPLETION received check_test_adequacy
    // (the kill-probe) as its replacement per-task gate, but the fix chain had no
    // equivalent — a fixed task could complete without the adequacy probe a
    // first-time completion gets. Mirror TASK_COMPLETION here: revert the fix's
    // source hunks, re-run the new/changed tests, assert red. Advisory carrier —
    // it self-skips low-tier and passes when the fix adds no tests, so it only
    // halts on a genuinely vacuous test. Runs against the agent worktree
    // (repoRoot:auto + worktreePath, #1330 resolver).
    // DR-3: the fix chain threads the SAME frozen `riskTier` /
    // `boundaryTouching` stamp prepare_delegation resolved for the task, so a
    // re-dispatched fix is judged at its real tier. Without them the gate
    // reached `interpretProbeVerdict` with an undefined tier and a high-tier
    // fix that added no probe-able tests was laundered into an advisory pass.
    { tool: 'exarchos_orchestrate', action: 'check_test_adequacy', onFail: 'stop',
      params: { taskId: '<taskId>', repoRoot: 'auto', worktreePath: '<worktreePath>',
        riskTier: '<riskTier>', boundaryTouching: '<boundaryTouching>' },
      note: 'kill probe: reverts source, re-runs new tests, asserts red — the load-bearing per-task gate' },
    // NOTE: unlike TASK_COMPLETION's step, this one threads no `repoRoot:'auto'`
    // / `worktreePath`, so the gate runs against the orchestrator's cwd rather
    // than the agent worktree. Pre-existing and orthogonal to the taskId thread
    // below; left as-is rather than widened here.
    { tool: 'exarchos_orchestrate', action: 'check_static_analysis', onFail: 'stop',
      params: { taskId: '<taskId>' } },
    { tool: 'exarchos_orchestrate', action: 'task_complete', onFail: 'stop' },
  ],
  templateVars: ['taskId', 'featureId', 'streamId', 'branch', 'agentId', 'failureContext', 'worktreePath',
    // DR-3: the frozen delegation stamp — see TASK_COMPLETION.templateVars.
    'riskTier', 'boundaryTouching'],
  // T-01/T-02: check_test_adequacy + check_static_analysis both route through
  // the canonical durable gate runner — see TASK_COMPLETION.autoEmits.
  autoEmits: ['admission.evidence-recorded', 'gate.executed', 'task.completed'],
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
  description: 'Select review strategy based on change characteristics: single-pass vs two-pass.',
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
  ],
  templateVars: ['featureId'],
  autoEmits: [],
};

export const DESIGN_REFINEMENT: RunbookDefinition = {
  id: 'design-refinement',
  phase: 'plan',
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

export const MERGE_ORCHESTRATION: RunbookDefinition = {
  id: 'merge-orchestration',
  phase: 'merge-pending',
  description: 'Land a subagent worktree branch onto integration with preflight + recorded rollback.',
  steps: [
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      params: { dryRun: true }, onFail: 'stop',
      note: 'Preflight: ancestry, target-worktree-availability (post-#1356), current-branch, drift.' },
    { tool: 'exarchos_orchestrate', action: 'merge_orchestrate',
      onFail: 'continue',
      note: 'Real merge. preflight-fail → aborted (no executor). merge-fail → rolled-back (post-#1356: structured target-worktree-busy categorization).' },
    { tool: 'exarchos_workflow', action: 'transition',
      params: { target: 'delegate' }, onFail: 'continue',
      note: 'HSM exits merge-pending back to delegate regardless of merge outcome.' },
  ],
  templateVars: ['featureId', 'taskId', 'sourceBranch', 'targetBranch', 'strategy', 'repoRoot'],
  // DR-2 (task 006): recovery emits ONLY `merge.recovered`; the legacy
  // `merge.rollback` write path is retired (read-tolerant, not emittable).
  autoEmits: ['merge.preflight', 'merge.executed', 'merge.recovered', 'workflow.transition'],
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
  MERGE_ORCHESTRATION,
];
