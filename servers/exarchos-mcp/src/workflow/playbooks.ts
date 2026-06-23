import { getRequiredReviewsPrerequisite } from './review-contract.js';
import { getRegisteredEventTypes } from '../projections/rehydration/reducer.js';
import { EVENT_EMISSION_REGISTRY, type EventType } from '../event-store/schemas.js';
import { resolveVerificationPolicy } from './verification-policy-resolver.js';

// ─── Verification-Ladder Gate Guidance (vls1-b1, task 008) ──────────────────
//
// The delegate-phase guidance advertises the verification-ladder gates a task
// must clear. Those gate names are SOURCED FROM the verification policy via the
// single composer (`resolveVerificationPolicy`) — never hand-written, and never
// the frozen table directly (task 004 single-composer rule) — so any change to
// the policy propagates into the playbook text automatically. This guidance is
// config-blind by intent (no project config is in scope at module-load render
// time), so the resolver falls through to the built-in table here, leaving the
// rendered text byte-identical to the pre-task-004 table call. The medium tier
// base sequence is the minimum ladder a non-trivial task clears; the
// medium+boundary sequence surfaces the additional contract/mock gates that
// boundary-touching tasks pick up.

function verificationLadderGuidance(): string {
  const mediumGates = resolveVerificationPolicy('medium', false).sequence;
  const boundaryGates = resolveVerificationPolicy('medium', true).sequence;
  // The boundary-only delta — gates a boundary-touching task adds on top.
  const boundaryDelta = boundaryGates.filter((g) => !mediumGates.includes(g));
  const base = `Verification ladder (by riskTier/boundaryTouching): medium clears ${mediumGates.join(' → ')}`;
  const boundary =
    boundaryDelta.length > 0
      ? `; boundary adds ${boundaryDelta.join(' → ')}`
      : '';
  return `${base}${boundary}.`;
}

// ─── Phase Playbook Types ──────────────────────────────────────────────────

export interface ToolInstruction {
  readonly tool: string;
  readonly action: string;
  readonly purpose: string;
}

export interface EventInstruction {
  readonly type: string;
  readonly when: string;
  readonly fields?: string[];
}

/**
 * Auto-emitted event surface (#1227, T6). Lists events the runtime emits on
 * the model's behalf — e.g. `task.completed` / `task.failed` fired by the
 * `task_complete` / `task_fail` orchestrate handlers. Distinct from
 * {@link EventInstruction} to make it impossible to accidentally invite the
 * model to manually re-emit a runtime-owned event.
 *
 * `source` is fixed to `'auto'`; `emittedBy` names the runtime surface that
 * fires the event (typically an `exarchos_orchestrate <action>` invocation).
 */
export interface AutoEmittedEventInstruction extends EventInstruction {
  readonly source: 'auto';
  readonly emittedBy: string;
}

export interface PhasePlaybook {
  readonly phase: string;
  readonly workflowType: string;
  readonly skill: string;
  readonly skillRef: string;
  readonly tools: readonly ToolInstruction[];
  readonly events: readonly EventInstruction[];
  /**
   * Events the runtime emits on the model's behalf for this phase (#1227).
   * Phases without runtime-emitted events leave this undefined.
   */
  readonly autoEmittedEvents?: readonly AutoEmittedEventInstruction[];
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

  // CodeRabbit major on PR #1297: render the autoEmittedEvents sibling
  // surface so the model knows which events the runtime fires on its
  // behalf. The `events:` line above is intentionally exclusive of these
  // (delegatePhaseEvents filters source==='model'); rendering them on a
  // separate line preserves that contract while making the auto-emit
  // surface visible to consumers reading the rendered guidance.
  if (playbook.autoEmittedEvents && playbook.autoEmittedEvents.length > 0) {
    const autoEntries = playbook.autoEmittedEvents
      .map((e) => `${e.type} (${e.emittedBy}) — ${e.when}`)
      .join(', ');
    lines.push(`**Auto-emitted events:** ${autoEntries}`);
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

// ─── Delegate-Phase Event Contract (SoT, #1180, DIM-3) ───────────────────
//
// Per-event prose metadata (`when` + required `fields`) for every event in
// the delegate-phase contract. The PHASE TYPES themselves come from
// `getRegisteredEventTypes(...)` in the rehydration reducer — this map is a
// LOOKUP keyed by event type, not an independent list. Adding an event to
// the playbook without first adding it to the reducer's registry is caught
// at module load by the assertion below: a SoT event with no metadata entry
// throws so the playbook can never silently advertise a bare event type.
//
// Conversely, removing an event from the SoT silently drops its playbook
// entry (the metadata entry simply becomes unused) — that direction is fine
// because the SoT is the contract; orphaned metadata does no harm.

const DELEGATE_PHASE_EVENT_METADATA: Readonly<
  Record<string, Pick<EventInstruction, 'when' | 'fields'>>
> = {
  'task.assigned': {
    when: 'On dispatch of each task',
    fields: ['taskId', 'title', 'worktree'],
  },
  'task.completed': {
    when: 'On task completion (typically via exarchos_orchestrate task_complete)',
    fields: ['taskId'],
  },
  'task.failed': {
    when: 'On task failure (typically via exarchos_orchestrate task_fail)',
    fields: ['taskId'],
  },
  'team.spawned': {
    when: 'After team creation',
    fields: ['teamSize', 'teammateNames', 'taskCount', 'dispatchMode'],
  },
  'team.task.planned': {
    when: 'For each task planned for the team',
  },
  'team.teammate.dispatched': {
    when: 'After each agent spawn',
  },
  'team.disbanded': {
    when: 'After all tasks collected',
    fields: ['totalDurationMs', 'tasksCompleted', 'tasksFailed'],
  },
  'task.progressed': {
    when: 'After each TDD phase transition (red/green/refactor)',
  },
};

/**
 * Derive a phase's `events` list from the SoT — the rehydration reducer's
 * registered event types (#1180, DIM-3) — filtered to model-emitted events.
 *
 * Auto-emitted events (e.g. `task.completed` / `task.failed`, fired by the
 * `task_complete` / `task_fail` orchestrate handlers) are recognised by the
 * reducer for state folding but never appear in the playbook because the
 * model never emits them directly — listing them would mislead the agent
 * into manually appending duplicates of events the runtime already emits.
 *
 * Metadata (`when`, `fields`) is looked up from
 * {@link DELEGATE_PHASE_EVENT_METADATA}; any SoT event missing a metadata
 * entry throws so the playbook cannot ship a bare event with no
 * human-readable guidance.
 */
function delegatePhaseEvents(phase: 'delegate' | 'overhaul-delegate'): readonly EventInstruction[] {
  return getRegisteredEventTypes(phase)
    .filter((type) => {
      const source = EVENT_EMISSION_REGISTRY[type as EventType];
      if (source === undefined) {
        throw new Error(
          `playbooks: SoT event '${type}' (phase '${phase}') is not registered in EVENT_EMISSION_REGISTRY. ` +
            `Register it (or fix the typo at the SoT) so phase-expected-events stays consistent.`,
        );
      }
      return source === 'model';
    })
    .map((type) => {
      const meta = DELEGATE_PHASE_EVENT_METADATA[type];
      if (!meta) {
        throw new Error(
          `playbooks: missing DELEGATE_PHASE_EVENT_METADATA entry for SoT event '${type}' (phase '${phase}'). ` +
            `Add the event to DELEGATE_PHASE_EVENT_METADATA in workflow/playbooks.ts.`,
        );
      }
      return { type, ...meta };
    });
}

// ─── Delegate-Phase Auto-Emitted Event Contract (#1227, T6) ──────────────────
//
// Sibling to {@link DELEGATE_PHASE_EVENT_METADATA} — surfaces events the
// runtime emits on the model's behalf (e.g. `task.completed` / `task.failed`
// fired by the `task_complete` / `task_fail` orchestrate handlers). The
// `events` array deliberately excludes these to avoid inviting duplicate
// emissions; this map exists so downstream surfaces (telemetry, docs, agent
// context) can still discover them as part of the phase contract.
//
// Same SoT discipline as the model-event side: any auto-source event in
// `getRegisteredEventTypes(phase)` without a metadata entry here throws at
// module load.

const DELEGATE_PHASE_AUTO_EVENT_METADATA: Readonly<
  Record<string, Pick<AutoEmittedEventInstruction, 'when' | 'fields' | 'emittedBy'>>
> = {
  'task.completed': {
    when: 'After task_complete orchestrate action succeeds',
    fields: ['taskId', 'evidence', 'verified', 'files', 'implements'],
    emittedBy: 'exarchos_orchestrate task_complete',
  },
  'task.failed': {
    when: 'After task_fail orchestrate action',
    fields: ['taskId', 'error', 'diagnostics'],
    emittedBy: 'exarchos_orchestrate task_fail',
  },
};

/**
 * Sibling to {@link delegatePhaseEvents} — derives the auto-emitted event
 * surface for a delegate phase from the SoT registry, filtered to events
 * with `source === 'auto'`. Throws if a SoT auto event has no metadata
 * entry in {@link DELEGATE_PHASE_AUTO_EVENT_METADATA}.
 */
function delegateAutoEmittedEvents(
  phase: 'delegate' | 'overhaul-delegate',
): readonly AutoEmittedEventInstruction[] {
  return getRegisteredEventTypes(phase)
    .filter((type) => {
      // CodeRabbit major on PR #1297 (playbooks.ts:257-264): mirror
      // the fail-fast behavior of `delegatePhaseEvents`. Treating
      // `EVENT_EMISSION_REGISTRY[type] === undefined` as a non-match
      // silently drops misregistered types from the auto-emit surface.
      // Throwing surfaces the misregistration at module load —
      // symmetric defense across both event sources.
      const source = EVENT_EMISSION_REGISTRY[type as EventType];
      if (source === undefined) {
        throw new Error(
          `playbooks: SoT event '${type}' (phase '${phase}') is not registered in EVENT_EMISSION_REGISTRY. ` +
            `Register it (or fix the typo at the SoT) so phase-auto-emitted-events stays consistent.`,
        );
      }
      return source === 'auto';
    })
    .map((type) => {
      const meta = DELEGATE_PHASE_AUTO_EVENT_METADATA[type];
      if (!meta) {
        throw new Error(
          `playbooks: missing DELEGATE_PHASE_AUTO_EVENT_METADATA entry for SoT auto-emitted event '${type}' (phase '${phase}'). ` +
            `Add the event to DELEGATE_PHASE_AUTO_EVENT_METADATA in workflow/playbooks.ts.`,
        );
      }
      return { type, source: 'auto' as const, ...meta };
    });
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
      action: 'update',
      purpose: 'Record design decisions and artifacts',
    },
  ],
  events: [],
  transitionCriteria: 'Design & Rationale section authored → continue to decomposition (same plan phase)',
  guardPrerequisites: 'artifacts.spec exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are authoring the Design & Rationale section of the ONE unified docs/specs/ artifact (#1581 — no separate design doc). Use exarchos_workflow update to record artifacts.spec at docs/specs/. The 2-3 approach divergent loop is the `deep` rung, not a default — at thin/standard, converge in one pass. Number requirements DR-1..DR-N each with acceptance criteria (one covering error handling). Do NOT transition (plan is the initial phase); chain to /plan to add the Decomposition section to the same doc. Anti-pattern: writing a separate docs/designs/ doc. Escalate: design scope unclear after 2 iterations (deep rung may offer the opt-in discover bridge). Follow the design-refinement runbook for two-pass authoring (reasoning first, then formatting), and the phase-compression runbook to compress into a carry-forward context package on phase exit.',
});

register({
  phase: 'plan',
  workflowType: 'feature',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record plan artifact and task breakdown',
    },
  ],
  events: [],
  transitionCriteria: 'Unified spec decomposed → plan-review',
  guardPrerequisites: 'artifacts.plan exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'Unified `plan` phase (#1581, no separate design phase): author ONE docs/specs/ artifact via exarchos_workflow update, then → plan-review. FIRST the `## Design & Rationale` section (per @skills/brainstorming/SKILL.md): Problem Statement + DR-1..DR-N requirements + acceptance criteria (one for error handling), depth-scaled by frozen designDepth (2-3-approach divergent loop only at `deep` rung; else one pass, reasoning first then formatting); record artifacts.spec. THEN the Decomposition section (per @skills/implementation-planning/SKILL.md): tasks tracing to DR-N in the SAME doc; three-stage: (1) logical units, (2) concrete tasks, (3) parallelization plan; each 2-5 min, riskTier + Implements: DR-N. Record artifacts.plan (docs/specs/ path, planArtifactExists guard key) → plan-review. Use phase-compression runbook for self-contained per-task context packages. Anti-pattern: separate docs/designs/ or docs/plans/ file; monolith tasks. Escalate: ambiguous requirements block decomposition.',
});

register({
  phase: 'plan-review',
  workflowType: 'feature',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record review decision',
    },
  ],
  events: [],
  transitionCriteria: 'Plan approved → delegate | Gaps found → plan',
  guardPrerequisites: 'Plan review complete',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are at the plan-review checkpoint over the unified docs/specs/ artifact. plan-review is a DISPATCHED, fresh-context, adversarial pass (DR-10) — not an inline plan-vs-design delta (one artifact now): provision a read-only reviewer with only {artifact + spec} (never this authoring transcript) via prepare_review scope:"plan", prompted to refute the plan, depth scaled by the frozen designDepth (deep → a multi-voter panel applying varied framings / self-consistency; thin → a single light pass). On the refutation verdict: gaps → back to plan (--revise); survives → record approval with exarchos_workflow update updates: { planReview: { approved: true } } and transition to delegate. Anti-pattern: rubber-stamping without checking every DR-N requirement has a task. Escalate: 3+ revision cycles without convergence.',
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
      action: 'update',
      purpose:
        'Update task statuses, transition to review when all complete',
    },
    {
      tool: 'exarchos_event',
      action: 'append',
      purpose: 'Emit task.assigned on dispatch',
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
  // Events derived from the rehydration reducer's SoT registry
  // (#1180, DIM-3) — see `delegatePhaseEvents`. `gate.executed` was
  // previously listed here but is auto-emitted by the telemetry
  // middleware and explicitly excluded from the model-event contract.
  events: delegatePhaseEvents('delegate'),
  // Auto-emitted events (#1227, T6) — `task.completed` / `task.failed`
  // fired by the `task_complete` / `task_fail` orchestrate handlers.
  // Sibling to `events` so downstream surfaces (telemetry, docs, agent
  // context) can discover them without inviting the model to manually
  // re-emit runtime-owned events.
  autoEmittedEvents: delegateAutoEmittedEvents('delegate'),
  transitionCriteria: 'All tasks complete → review',
  guardPrerequisites:
    "tasks[].status = 'complete' for every task",
  validationScripts: ['post_delegation_check'],
  humanCheckpoint: false,
  // vls1-b1 (task 008): the verification-ladder gate names are appended from
  // `verificationLadderGuidance()`, which sources them from the policy via the
  // single composer (`resolveVerificationPolicy`) — changing the policy changes
  // this text.
  compactGuidance:
    'Dispatch implementation tasks. Emit task.assigned via exarchos_event per dispatch. Complete tasks via exarchos_orchestrate task_complete (emits event, syncs state). Use exarchos_workflow update only for metadata/phase transitions. Before task_complete, run check_test_adequacy (per-task, tier-scaled — the outcome-based kill probe, test-after not test-first) and check_static_analysis (once, mandatory). Run post-delegation-check.sh when all tasks finish. Transition to review when complete. Call exarchos_event describe(eventTypes: [...]) before first emission of any event type. Parallel vs sequential dispatch; self-contained subagent prompts. Anti-pattern: referencing plan without pasting context. Escalate: same task fails 3x or scope exceeds declared module. Build context packages via runbook(task-classification). ' +
    verificationLadderGuidance(),
});

register({
  phase: 'merge-pending',
  workflowType: 'feature',
  skill: 'merge-orchestrator',
  skillRef: '@skills/merge-orchestrator/SKILL.md',
  tools: [
    {
      tool: 'exarchos_orchestrate',
      action: 'merge_orchestrate',
      purpose:
        'Run preflight + execute merge for the worktree-associated task; resumes idempotently on retry',
    },
    {
      tool: 'exarchos_workflow',
      action: 'get',
      purpose: 'Read mergeOrchestrator state to detect prior phase and rollback points',
    },
    {
      tool: 'exarchos_event',
      action: 'query',
      purpose: 'Reconstruct merge timeline from merge.preflight/executed/rollback events',
    },
  ],
  events: [
    {
      type: 'merge.preflight',
      when: 'After dispatch-guard suite runs (before merge attempt or abort)',
      fields: ['taskId', 'sourceBranch', 'targetBranch', 'passed', 'ancestry', 'worktree', 'currentBranchProtection', 'drift', 'failureReasons'],
    },
    {
      type: 'merge.executed',
      when: 'After merge commit lands successfully on the target branch',
      fields: ['taskId', 'sourceBranch', 'targetBranch', 'mergeSha', 'rollbackSha', 'strategy'],
    },
    {
      type: 'merge.rollback',
      when: 'When merge fails post-commit and the rollback path runs',
      fields: ['taskId', 'sourceBranch', 'targetBranch', 'rollbackSha', 'reason', 'rollbackError'],
    },
  ],
  transitionCriteria:
    'merge.executed → delegate (next worktree) | merge.rollback / merge.aborted → delegate (drop back, mergeOrchestrator terminal)',
  guardPrerequisites:
    "mergeOrchestrator.phase ∉ {completed, rolled-back, aborted} AND latest task.completed carries a worktree association",
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'Local-git merge handoff. Call exarchos_orchestrate merge_orchestrate to land the subagent worktree branch on the integration branch via local git merge with recorded rollback sha. NOT a remote PR merge — that is merge_pr in synthesize. Runs preflight (ancestry / current-branch / main-worktree / drift), records HEAD as rollback anchor, runs git merge per strategy, and on failure runs the INV-14 recovery ladder (git merge --abort → git reset --keep <rollbackSha>, never --hard). Strategy required (no default). Resumable: terminal phases (completed / rolled-back / aborted) short-circuit on re-entry. Events auto-emitted: merge.preflight carries structured guard sub-results + failureReasons; merge.executed records mergeSha; merge.rollback records reason + optional recoveryError/rollbackError. Use exarchos_event describe before any manual emission. HSM exits merge-pending back to delegate on terminal merge event. Full guidance: @skills/merge-orchestrator/SKILL.md.',
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
      action: 'update',
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
  guardPrerequisites: getRequiredReviewsPrerequisite('feature'),
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are running two-stage code review (spec + quality). Use exarchos_event to emit gate.executed for each review gate. Use exarchos_workflow update to record review results. Transition to synthesize when all reviews pass, or back to delegate if fixes needed. Before first-time emission of any event type, call exarchos_event describe(eventTypes: [...]) to discover required fields. Key decision: pass vs fix-cycle vs block — assess severity of each finding. Anti-pattern: trusting passing tests as proof of completeness — check what the tests actually verify and look for missing coverage. Escalate: same finding appears in 2+ review cycles. Two-pass evaluation: first pass is high-recall (flag everything suspicious), second pass is high-precision (filter to actionable findings only). Follow the review-strategy runbook for structured evaluation criteria.',
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
      action: 'update',
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
    'pre_synthesis_check',
    'validate_pr_stack',
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
      action: 'update',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → delegate',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow update to record the decision and transition back to delegate.',
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
      action: 'update',
      purpose: 'Record triage findings and severity assessment',
    },
  ],
  events: [],
  transitionCriteria: 'Triage complete → investigate',
  guardPrerequisites: 'triageComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are triaging a bug report. Use exarchos_workflow update to record triage findings, severity, and reproduction steps. Transition to investigate when triage is complete. Key decision: severity assessment — P0 immediate (production impact) vs P1 planned (next sprint). Anti-pattern: skipping reproduction steps and jumping straight to investigation. Escalate: bug is not reproducible after 15 minutes of attempting reproduction.',
});

register({
  phase: 'investigate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
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
    'You are investigating the bug root cause. Use exarchos_workflow update to record investigation findings. Select thorough track (rca) for complex bugs or hotfix track for simple fixes. Transition based on track selection. Key decision: hotfix track (reproducible, <=3 files changed) vs thorough track (intermittent or cross-module). Anti-pattern: premature hotfix on complex bugs that need deeper root cause analysis. Escalate: 15 minutes without root cause identification.',
});

register({
  phase: 'rca',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record RCA document and root cause analysis',
    },
  ],
  events: [],
  transitionCriteria: 'RCA document complete → design',
  guardPrerequisites: 'rca document exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are performing root cause analysis. Use exarchos_workflow update to record the rca document path and findings. Transition to design when the rca document is complete. Key decision: immediate cause vs systemic root cause — trace the full causal chain. Anti-pattern: stopping at symptoms without tracing to the underlying root cause in the code. Escalate: root cause spans multiple subsystems requiring coordinated fixes.',
});

register({
  phase: 'design',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record fix design decisions',
    },
  ],
  events: [],
  transitionCriteria: 'Fix design complete → debug-implement',
  guardPrerequisites: 'fixDesign document exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are designing the fix based on the RCA. Before committing to a fix approach, surface a design-time Constraints section anchored to .exarchos/invariants.md (always-load entries, devCatalog-gated via .exarchos.yml invariants.devCatalog) per @skills/brainstorming/references/constraint-anchoring.md — the same shared source /ideate Phase 0 uses. Use exarchos_workflow update to record the fix design. Transition to debug-implement when the design is complete. Key decision: minimal targeted fix vs defensive fix with additional guards and validation. Anti-pattern: scope creep beyond the bug fix — resist adding unrelated improvements. Escalate: fix requires architectural change that cannot be contained to a targeted patch.',
});

register({
  phase: 'debug-implement',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record implementation progress and completion',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → debug-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing the fix based on the design. Use exarchos_workflow update to record implementation progress. Verification is risk-proportional — apply the gate ladder resolved for this phase (by task risk tier and boundary), reproducing the bug at a depth that matches its blast radius. Transition to debug-validate when implementation is complete. Key decision: match verification depth to the blast radius of the bug. Anti-pattern: shipping a fix without a regression check proportionate to its risk. Escalate: implementation touches >5 files, consider splitting.',
});

register({
  phase: 'debug-validate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record validation results',
    },
  ],
  events: [],
  transitionCriteria: 'Validation passed → debug-review',
  guardPrerequisites: 'validationPassed',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are validating the fix. Use exarchos_workflow update to record validation results. Run tests, verify the bug is fixed, and check for regressions. Transition to debug-review when validation passes. Key decision: regression testing scope — run full suite, not just the new test. Anti-pattern: only testing the fix without checking adjacent behavior for regressions. Escalate: new test failures appear during validation that are unrelated to the fix.',
});

register({
  phase: 'debug-review',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record review results',
    },
  ],
  events: [],
  transitionCriteria: 'Review passed → synthesize',
  guardPrerequisites: 'reviewPassed',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are reviewing the fix for code quality and correctness. Use exarchos_workflow update to record review results. Transition to synthesize when the review passes. Key decision: review depth proportional to fix scope — larger fixes need deeper review. Anti-pattern: skipping review for "simple" fixes that may have non-obvious side effects. Escalate: fix changes public API surface, requiring broader impact assessment.',
});

register({
  phase: 'hotfix-implement',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record hotfix implementation progress',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → hotfix-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing a hotfix. Use exarchos_workflow update to record implementation progress. This is the fast-track — apply minimal targeted fix within a 15-minute time budget. Verification is risk-proportional: apply the resolved gate ladder for this phase, kept minimal to fit the time budget. Transition to hotfix-validate when implementation is complete. Key decision: stay minimal and targeted within the time budget. Anti-pattern: hotfix growing into a full fix — if scope expands, switch to thorough track via rca. Escalate: time limit exceeded without a working fix.',
});

register({
  phase: 'hotfix-validate',
  workflowType: 'debug',
  skill: 'debug',
  skillRef: '@skills/debug/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
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
    'You are validating the hotfix. Use exarchos_workflow update to record validation results. Run tests and verify the fix. HUMAN CHECKPOINT: present results and await user decision. If PR is requested, transition to synthesize; otherwise transition to completed. Key decision: PR-based merge vs direct to main based on risk assessment. Anti-pattern: merging without running the full test suite. Escalate: validation reveals the fix is incomplete and needs thorough track.',
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
      action: 'update',
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
    'You are creating a PR for the debug fix via GitHub CLI. Use exarchos_workflow update to record PR URLs. Wait for user confirmation before merging. This is a human checkpoint — pause and confirm before proceeding. Key decision: single PR for targeted fixes, stacked PRs for multi-part fixes. Anti-pattern: merging without CI green on all checks. Escalate: CI fails 3+ times on the same issue.',
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
      action: 'update',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → previous phase',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow update to record the decision.',
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
      action: 'update',
      purpose: 'Record scope assessment and exploration findings',
    },
  ],
  events: [],
  transitionCriteria: 'Scope assessment complete → brief',
  guardPrerequisites: 'scopeAssessmentComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are exploring the codebase to assess refactoring scope. Use exarchos_workflow update to record exploration findings and scope assessment. Transition to brief when scope assessment is complete. Key decision: scope assessment — count affected files, assess complexity and risk level. Anti-pattern: exploring without setting a clear boundary on what is in and out of scope. Escalate: scope exceeds what can be delivered in a single PR.',
});

register({
  phase: 'brief',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
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
    'You are writing the refactoring brief. Before committing to an approach, surface a design-time Constraints section anchored to .exarchos/invariants.md (always-load entries, devCatalog-gated via .exarchos.yml invariants.devCatalog) per @skills/brainstorming/references/constraint-anchoring.md — the same shared source /ideate Phase 0 uses. Use exarchos_workflow update to record the brief and select polish (small) or overhaul (large) track. Transition based on track selection. Key decision: polish track (<=5 files, cosmetic/DRY) vs overhaul track (>5 files, structural changes). Anti-pattern: choosing polish for structural changes that actually need the overhaul track. Escalate: scope is unclear after exploration, revisit explore phase.',
});

register({
  phase: 'polish-implement',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record implementation progress and completion',
    },
  ],
  events: [],
  transitionCriteria: 'Implementation complete → polish-validate',
  guardPrerequisites: 'implementationComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are implementing polish-track refactoring changes directly. Use exarchos_workflow update to record progress. Verification is risk-proportional — apply the gate ladder resolved for this phase to any behavior change, sized to the risk of the change. Stay within brief scope. Transition to polish-validate when implementation is complete. Key decision: stay strictly within the brief scope for each change. Anti-pattern: scope creep beyond the brief — resist adding improvements not in the brief. Escalate: changes cascade beyond the declared scope, consider switching to overhaul track.',
});

register({
  phase: 'polish-validate',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record validation results',
    },
  ],
  events: [],
  transitionCriteria: 'Goals verified → polish-update-docs',
  guardPrerequisites: 'goalsVerified',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are validating the polish refactoring meets goals. Use exarchos_workflow update to record validation results. Run tests and verify refactoring goals are met. Transition to polish-update-docs when goals are verified. Key decision: verify all brief goals are met, not just a subset. Anti-pattern: accepting partial completion when some goals remain unmet. Escalate: goals are not achievable without switching to the overhaul track.',
});

register({
  phase: 'polish-update-docs',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record docs update status',
    },
  ],
  events: [],
  transitionCriteria: 'Docs updated → completed',
  guardPrerequisites: 'docsUpdated',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are updating documentation for the polish refactoring. Use exarchos_workflow update to record docs update completion. HUMAN CHECKPOINT: present updated docs summary and await user confirmation before transitioning to completed. Key decision: which docs need updates based on the changes made. Anti-pattern: skipping documentation updates for "obvious" changes that still affect developer understanding.',
});

register({
  phase: 'overhaul-plan',
  workflowType: 'refactor',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record plan artifact and task breakdown',
    },
  ],
  events: [],
  transitionCriteria: 'Plan artifact exists → overhaul-plan-review',
  guardPrerequisites: 'planArtifactExists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are creating an implementation plan for the overhaul refactoring. Use exarchos_workflow update to record the plan artifact path. Break work into parallelizable TDD tasks. Transition to overhaul-plan-review when plan artifact exists. Key decision: task granularity for the large refactor — target 2-5 min per task. Anti-pattern: monolith tasks that cannot be distributed across agents. Escalate: plan exceeds 20 tasks, split into sequential phases.',
});

register({
  phase: 'overhaul-plan-review',
  workflowType: 'refactor',
  skill: 'implementation-planning',
  skillRef: '@skills/implementation-planning/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record review decision',
    },
  ],
  events: [],
  transitionCriteria: 'Plan approved → overhaul-delegate | Gaps found → overhaul-plan | Revisions exhausted → blocked',
  guardPrerequisites: 'Plan review complete',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'You are at a human checkpoint reviewing the overhaul refactoring plan. Wait for user approval or revision feedback. Record approval with exarchos_workflow update using updates: { planReview: { approved: true } }. Transition to overhaul-delegate on approval, back to overhaul-plan if gaps found, or to blocked when revisions are exhausted. Key decision: approve vs revise with specific actionable feedback. Anti-pattern: rubber-stamping without checking task coverage of all brief goals. Escalate: 3+ revision cycles without convergence.',
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
      action: 'update',
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
  // Events derived from the rehydration reducer's SoT registry
  // (#1180, DIM-3) — see `delegatePhaseEvents`.
  events: delegatePhaseEvents('overhaul-delegate'),
  // Auto-emitted events (#1227, T6) — see `delegateAutoEmittedEvents`.
  autoEmittedEvents: delegateAutoEmittedEvents('overhaul-delegate'),
  transitionCriteria: 'All tasks complete → overhaul-review',
  guardPrerequisites: 'allTasksComplete',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'Dispatch overhaul tasks. Emit task.assigned via exarchos_event per dispatch. Complete tasks via exarchos_orchestrate task_complete (emits event, syncs state). Use exarchos_workflow update only for metadata/phase transitions. Before task_complete, run check_test_adequacy (per-task, tier-scaled — the outcome-based kill probe, test-after not test-first) and check_static_analysis (once, mandatory). Transition to overhaul-review when complete. Parallel dispatch: each agent gets own worktree and self-contained prompt. Anti-pattern: sharing worktrees or referencing shared state without explicit context. Escalate: 3 failures on same task.',
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
      action: 'update',
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
    'You are reviewing the overhaul refactoring. Use exarchos_event to emit gate.executed for review gates. Use exarchos_workflow update to record review results. Transition to overhaul-update-docs when all reviews pass, or back to overhaul-delegate if fixes needed. Key decision: review depth proportional to change scope. Anti-pattern: trusting subagent self-assessment — independently verify test output and coverage. Escalate: regression findings appear in modules unrelated to the refactoring.',
});

register({
  phase: 'overhaul-update-docs',
  workflowType: 'refactor',
  skill: 'refactor',
  skillRef: '@skills/refactor/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record docs update status',
    },
  ],
  events: [],
  transitionCriteria: 'Docs updated → synthesize',
  guardPrerequisites: 'docsUpdated',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are updating documentation for the overhaul refactoring. Use exarchos_workflow update to record docs update completion. Transition to synthesize when docs are updated. Key decision: documentation scope — update all docs affected by the structural changes. Anti-pattern: skipping documentation updates for refactoring that changes module boundaries or APIs.',
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
      action: 'update',
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
    'pre_synthesis_check',
    'validate_pr_stack',
  ],
  humanCheckpoint: true,
  compactGuidance:
    'You are creating PRs via GitHub CLI for the overhaul refactoring. Use exarchos_workflow update to record PR URLs. Wait for user confirmation before merging. This is a human checkpoint — pause and confirm before proceeding. Key decision: single PR vs stacked PRs based on change scope. Anti-pattern: merging without CI green on all checks. Escalate: CI fails 3+ times on the same issue.',
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
      action: 'update',
      purpose: 'Record unblock decision',
    },
  ],
  events: [],
  transitionCriteria: 'Human unblock → previous phase',
  guardPrerequisites: 'Human decision',
  validationScripts: [],
  humanCheckpoint: true,
  compactGuidance:
    'Workflow is blocked waiting for human intervention. Wait for user to provide unblock decision. Use exarchos_workflow update to record the decision.',
});

// ═══════════════════════════════════════════════════════════════════════════
// Oneshot Workflow Playbooks (T10)
// ═══════════════════════════════════════════════════════════════════════════
//
// The oneshot workflow is a lightweight in-session flow for one-line fixes,
// config tweaks, and exploratory changes that do not warrant the ceremony of
// the feature workflow. Lifecycle:
//
//   plan ──► implementing ──┬── [synthesisOptedOut] ──► completed
//                           └── [synthesisOptedIn]  ──► synthesize ──► completed
//
// The `implementing → ?` branch is a choice state resolved by pure guards
// over (synthesisPolicy, synthesize.requested events). See T8 / T11 for the
// guard implementations and HSM transitions.
//
// The `plan` and `implementing` playbooks reference the `oneshot-workflow`
// skill which is authored in T17 — the skillRef is declared here so that
// the skill-ref check in compactGuidance drift tests skips min-length /
// tool-keyword assertions for these in-session phases whose guidance is
// delegated to the skill.

export const oneshotPlaybook: readonly PhasePlaybook[] = [
  {
    phase: 'plan',
    workflowType: 'oneshot',
    skill: 'oneshot-workflow',
    skillRef: '@skills/oneshot-workflow/SKILL.md',
    tools: [
      {
        tool: 'exarchos_workflow',
        action: 'update',
        purpose: 'Persist the one-page plan to state.artifacts.plan (required by the oneshot-plan-set guard); oneshot.planSummary is an optional pipeline-view label',
      },
    ],
    events: [],
    transitionCriteria: 'Plan ready → implementing',
    guardPrerequisites:
      "state.artifacts.plan set — a one-page plan captured before implementation. oneshot.planSummary is a pipeline-view hint, not a substitute.",
    validationScripts: [],
    humanCheckpoint: false,
    compactGuidance:
      'Lightweight in-session planning for a oneshot workflow. Capture a one-page plan (goal, approach, files to touch, tests to add) via exarchos_workflow update using updates: { "artifacts.plan": "..." }. Optionally also set oneshot.planSummary for a one-line pipeline-view label, but artifacts.plan is the guard-required artifact. No design doc required; no subagent dispatch. Transition to implementing once the plan artifact is recorded. Follow the oneshot-workflow skill for the full procedure.',
  },
  {
    phase: 'implementing',
    workflowType: 'oneshot',
    skill: 'oneshot-workflow',
    skillRef: '@skills/oneshot-workflow/SKILL.md',
    tools: [
      {
        tool: 'exarchos_workflow',
        action: 'update',
        purpose: 'Record implementation progress and synthesis choice',
      },
      {
        tool: 'exarchos_event',
        action: 'append',
        purpose:
          'Optionally append synthesize.requested to opt into PR-based synthesis at runtime',
      },
    ],
    events: [
      {
        type: 'synthesize.requested',
        when: 'On opt-in to the synthesize path at the end of implementation',
      },
    ],
    transitionCriteria:
      'synthesize opted in → synthesize | opted out → completed',
    guardPrerequisites:
      'Tests pass + synthesis choice made (policy or event): synthesisPolicy=always|on-request+synthesize.requested → synthesize; synthesisPolicy=never or on-request without event → completed',
    validationScripts: [],
    humanCheckpoint: false,
    compactGuidance:
      'In-session implementation for a oneshot workflow. Verification is risk-proportional — apply the gate ladder resolved for this phase (advisory severity for oneshot), sized to the risk of the change. After the resolved checks pass, the main agent resolves the choice state using pure guards over (synthesisPolicy, synthesize.requested events). If opting into the synthesize path at runtime, append a synthesize.requested event via exarchos_event append. The HSM evaluates the choice state on the next transition attempt. Follow the oneshot-workflow skill for the full procedure.',
  },
  {
    phase: 'synthesize',
    workflowType: 'oneshot',
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
        action: 'update',
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
        when: 'After pre-synthesis-check.sh runs',
        fields: ['gateName', 'layer', 'passed'],
      },
    ],
    transitionCriteria: 'PR merged → completed',
    guardPrerequisites:
      'artifacts.pr exists AND PR merge verified (merge.verified or shepherd.completed event)',
    validationScripts: ['pre_synthesis_check'],
    humanCheckpoint: true,
    compactGuidance:
      'Oneshot synthesis reuses the existing synthesize pipeline. Create the PR via GitHub CLI (gh pr create), run pre-synthesis-check.sh, emit gate.executed via exarchos_event. Wait for merge verification before transitioning to completed. This is a human checkpoint — pause and confirm before merge. Anti-pattern: merging without CI green.',
  },
  terminalPlaybook(
    'oneshot',
    'completed',
    'Workflow is complete. No further actions needed.',
  ),
];

for (const pb of oneshotPlaybook) {
  register(pb);
}

// ═══════════════════════════════════════════════════════════════════════════
// Discovery Workflow Playbooks
// ═══════════════════════════════════════════════════════════════════════════

register({
  phase: 'gathering',
  workflowType: 'discovery',
  skill: 'discovery',
  skillRef: '@skills/discovery/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record research sources and artifacts',
    },
  ],
  events: [],
  transitionCriteria: 'Sources collected → synthesizing',
  guardPrerequisites: 'artifacts.sources is a non-empty array',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are gathering research sources and materials. Use exarchos_workflow update to record sources in artifacts.sources (array of paths/URLs). No TDD requirement — this workflow produces documents, not code. Transition to synthesizing when sources are collected. Key decision: breadth vs depth of research. Anti-pattern: starting to write the deliverable before gathering sufficient sources.',
});

register({
  phase: 'synthesizing',
  workflowType: 'discovery',
  skill: 'discovery',
  skillRef: '@skills/discovery/SKILL.md',
  tools: [
    {
      tool: 'exarchos_workflow',
      action: 'update',
      purpose: 'Record report artifact path',
    },
  ],
  events: [],
  transitionCriteria: 'Report artifact created → completed',
  guardPrerequisites: 'artifacts.report exists',
  validationScripts: [],
  humanCheckpoint: false,
  compactGuidance:
    'You are synthesizing gathered sources into a deliverable document. Write the report and commit it to the repo. Use exarchos_workflow update to record the report path in artifacts.report. Transition to completed when the report is committed. Optional: if discovery surfaces implementation needs, bridge to /exarchos:ideate with the report as design input.',
});

register(
  terminalPlaybook(
    'discovery',
    'completed',
    'Discovery workflow is complete. Report artifact has been committed.',
  ),
);

register(
  terminalPlaybook(
    'discovery',
    'cancelled',
    'Discovery workflow was cancelled.',
  ),
);

// ─── Aggregate Export: workflowPlaybooks ─────────────────────────────────────
//
// Map of workflow type → the declared playbook entries for that type, for
// consumers that want to iterate phase-by-phase without touching the private
// registry. The oneshot entry is the canonical example used by T10 tests; the
// built-in feature/debug/refactor entries are derived from the registry on
// first access so they stay in sync with the individual register() calls.

function collectRegisteredForType(workflowType: string): readonly PhasePlaybook[] {
  const out: PhasePlaybook[] = [];
  for (const pb of registry.values()) {
    if (pb.workflowType === workflowType) out.push(pb);
  }
  return out;
}

export const workflowPlaybooks: ReadonlyMap<string, readonly PhasePlaybook[]> =
  new Map<string, readonly PhasePlaybook[]>([
    ['feature', collectRegisteredForType('feature')],
    ['debug', collectRegisteredForType('debug')],
    ['refactor', collectRegisteredForType('refactor')],
    ['oneshot', oneshotPlaybook],
    ['discovery', collectRegisteredForType('discovery')],
  ]);

// ─── Serialization Types ─────────────────────────────────────────────────────

export interface SerializedPlaybooks {
  readonly workflowType: string;
  readonly phases: Record<string, SerializedPhasePlaybook>;
  readonly phaseCount: number;
}

export interface SerializedPhasePlaybook {
  readonly skill: string;
  readonly skillRef: string;
  // Array-level readonly dropped so this matches the schema-inferred
  // type at `RehydrationDocumentV3['phasePlaybook']` (PhasePlaybookSchema's
  // arrays are mutable). Element-level readonly modifiers stay on
  // ToolInstruction / EventInstruction — only the array container is mutable.
  readonly tools: ToolInstruction[];
  readonly events: EventInstruction[];
  /**
   * Auto-emitted event surface for delegate-shaped phases (#1227, T6).
   * Carried through serialization so CLI describe / telemetry / agent
   * context consumers see the runtime-emitted events as part of the
   * phase contract. Phases without auto-emit leave this undefined —
   * explicit absence (not `[]`) keeps the contract minimal.
   */
  readonly autoEmittedEvents?: AutoEmittedEventInstruction[];
  readonly transitionCriteria: string;
  readonly guardPrerequisites: string;
  readonly validationScripts: string[];
  readonly humanCheckpoint: boolean;
  readonly compactGuidance: string;
}

// ─── Serialization Functions ─────────────────────────────────────────────────

/**
 * Serialize a single {@link PhasePlaybook} into the
 * {@link SerializedPhasePlaybook} JSON shape. Pure of side effects.
 *
 * Used by handler-time playbook composition (T-20: `handleRehydrate` /
 * checkpoint envelopes attach a single phase's serialized playbook to the
 * rehydration document). `serializePlaybooks` below delegates per-phase to
 * this helper so the entry shape lives in one place.
 *
 * Spread-on-condition for `autoEmittedEvents` preserves absence (vs `[]`)
 * for phases that don't declare auto-emit — matching the PhasePlaybook
 * shape and the digest-stable contract from #1297 / T6.
 */
export function serializePhasePlaybookEntry(
  playbook: PhasePlaybook,
): SerializedPhasePlaybook {
  // Deep-copy each instruction object and any nested `fields` array. F-07
  // dropped array-level `readonly` from `SerializedPhasePlaybook` so the
  // schema-derived (mutable) target type accepts these arrays. With mutable
  // payloads, a downstream consumer that mutates a returned `tools[i]` /
  // `events[i].fields` would corrupt the registry-backed playbook unless
  // the per-element clone happens here.
  const cloneEvent = <E extends EventInstruction>(e: E): E => ({
    ...e,
    ...(e.fields !== undefined && { fields: [...e.fields] }),
  });
  return {
    skill: playbook.skill,
    skillRef: playbook.skillRef,
    tools: playbook.tools.map((t) => ({ ...t })),
    events: playbook.events.map(cloneEvent),
    ...(playbook.autoEmittedEvents !== undefined && {
      autoEmittedEvents: playbook.autoEmittedEvents.map(cloneEvent),
    }),
    transitionCriteria: playbook.transitionCriteria,
    guardPrerequisites: playbook.guardPrerequisites,
    validationScripts: [...playbook.validationScripts],
    humanCheckpoint: playbook.humanCheckpoint,
    compactGuidance: playbook.compactGuidance,
  };
}

/**
 * Resolve and serialize the playbook for a single (workflowType, phase)
 * pair. Used by handler-time composition (T-20: `handleRehydrate`; T-23:
 * `handleCheckpoint`) so callers get a single entry point that returns a
 * JSON-serializable shape directly attachable to the rehydration envelope.
 *
 * Returns `null` when no playbook is registered for the pair (terminal
 * phases, unknown workflow types, or phases that legitimately have no
 * authoring playbook). Surfacing the null explicitly is the contract — the
 * v:3 rehydration envelope's `phasePlaybook` field is nullable, not
 * optional, so callers can spread the return value directly without
 * guarding for `undefined`.
 *
 * Pure function with no side effects.
 */
export function composePhasePlaybook(
  workflowType: string,
  phase: string,
): SerializedPhasePlaybook | null {
  const playbook = getPlaybook(workflowType, phase);
  return playbook !== null ? serializePhasePlaybookEntry(playbook) : null;
}

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

    phases[playbook.phase] = serializePhasePlaybookEntry(playbook);
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
