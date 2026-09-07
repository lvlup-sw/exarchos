// ─── Phase event contract — the one declaration of what a phase emits ────────
//
// Which model-emitted events a workflow phase expects, and which events the
// runtime emits on the model's behalf while that phase runs. Every surface
// that used to hold its own copy of that fact now derives from this table:
//
//   - the `check-event-emissions` gate (`PHASE_EXPECTED_EVENTS`, the hint text)
//   - the phase playbooks (`events`, `autoEmittedEvents`)
//   - the skill prose comparator in `tests/architecture/`
//
// Before this module there were four copies — two literal lists in the
// rehydration reducer that called themselves a registry, four literal rows in
// the gate, per-phase arrays in the playbooks, and the skill prose — and they
// disagreed: the review playbook instructed `review.completed`, which nothing
// emitted and the gate never checked; four playbooks instructed the model to
// emit `gate.executed`, `shepherd.*` and `merge.*`, all runtime-owned. One
// declaration cannot disagree with itself.
//
// The rows are DECLARED, not derived: which phase expects which model event
// is a workflow fact the event catalog does not hold. What the catalog does
// hold is checked at load — every expected event is registered and
// `model`-sourced, every runtime emission is `auto`-sourced — and the phase
// keys are checked against the built-in HSM states where those live
// (`state-machine.ts`), so a phase renamed or retired in the HSM throws
// instead of leaving a dead row. This module imports only the event catalog
// so it can sit below every consumer without a cycle.

import type { EventType } from '../../events/schemas.js';
import { EVENT_EMISSION_REGISTRY } from '../../events/schemas.js';

/**
 * A model-emitted event the gate demands and the playbook instructs. Generic
 * over the event-name type so a seeded table in a test needs no cast; the live
 * table is `PhaseEventRow`, whose names the catalog's union checks.
 */
export interface PhaseEventRowOf<T extends string> {
  readonly type: T;
  /** When the model emits it — one sentence, playbook and hint share it. */
  readonly when: string;
  /** Payload fields the instruction calls out; the schema stays authoritative. */
  readonly fields?: readonly string[];
  /** Who emits it in a team dispatch. Absent means the orchestrating agent. */
  readonly emitter?: 'orchestrator' | 'subagent';
}

/** An event the runtime emits on the model's behalf — disclosed, never instructed. */
export interface PhaseRuntimeEmissionRowOf<T extends string> {
  readonly type: T;
  readonly when: string;
  /** The runtime surface that fires it. */
  readonly emittedBy: string;
  readonly fields?: readonly string[];
}

export interface PhaseEventContractOf<T extends string> {
  /** In emission order; the gate reports a missing one in this order. */
  readonly expects: readonly PhaseEventRowOf<T>[];
  readonly runtimeEmits: readonly PhaseRuntimeEmissionRowOf<T>[];
}

export type PhaseEventRow = PhaseEventRowOf<EventType>;
export type PhaseRuntimeEmissionRow = PhaseRuntimeEmissionRowOf<EventType>;
export type PhaseEventContract = PhaseEventContractOf<EventType>;

/** A contract table over any event-name type. */
export type PhaseEventContracts<T extends string> = Readonly<Record<string, PhaseEventContractOf<T>>>;

const TEAM_SPAWNED: PhaseEventRow = {
  type: 'team.spawned',
  when: 'After team creation',
  fields: ['teamSize', 'teammateNames', 'taskCount', 'dispatchMode'],
};
const TEAM_TASK_PLANNED: PhaseEventRow = {
  type: 'team.task.planned',
  when: 'For each task planned for the team',
};
const TEAM_TEAMMATE_DISPATCHED: PhaseEventRow = {
  type: 'team.teammate.dispatched',
  when: 'After each agent spawn',
};
const TEAM_DISBANDED: PhaseEventRow = {
  type: 'team.disbanded',
  when: 'After all tasks collected',
  fields: ['totalDurationMs', 'tasksCompleted', 'tasksFailed'],
};

const TASK_COMPLETED_BY_RUNTIME: PhaseRuntimeEmissionRow = {
  type: 'task.completed',
  when: 'After task_complete orchestrate action succeeds',
  emittedBy: 'exarchos_orchestrate task_complete',
  fields: ['taskId', 'evidence', 'verified', 'files', 'implements'],
};
const TASK_FAILED_BY_RUNTIME: PhaseRuntimeEmissionRow = {
  type: 'task.failed',
  when: 'After task_fail orchestrate action',
  emittedBy: 'exarchos_orchestrate task_fail',
  fields: ['taskId', 'error', 'diagnostics'],
};
const REVIEW_GATE_EXECUTED: PhaseRuntimeEmissionRow = {
  type: 'gate.executed',
  when: 'After each review gate runs',
  emittedBy: 'exarchos_orchestrate check_review_verdict and the review gates',
  fields: ['gateName', 'layer', 'passed'],
};

const DELEGATE_EXPECTS: readonly PhaseEventRow[] = [
  {
    type: 'task.assigned',
    when: 'On dispatch of each task',
    fields: ['taskId', 'title', 'worktree'],
  },
  TEAM_SPAWNED,
  TEAM_TASK_PLANNED,
  TEAM_TEAMMATE_DISPATCHED,
  TEAM_DISBANDED,
];

/**
 * The contract, keyed by phase name. A phase absent here expects nothing and
 * discloses nothing; the gate reports it complete and the playbook lists no
 * events. Presence with an empty `expects` is legitimate for a phase the
 * runtime drives (`merge-pending`); a row declaring nothing at all is refused
 * at load, because it would read as a decision nobody made.
 */
export const PHASE_EVENT_CONTRACTS: Readonly<Record<string, PhaseEventContract>> = Object.freeze({
  delegate: {
    expects: [
      ...DELEGATE_EXPECTS,
      {
        type: 'task.progressed',
        when: 'After each TDD phase transition (red/green/refactor)',
        emitter: 'subagent',
      },
    ],
    runtimeEmits: [TASK_COMPLETED_BY_RUNTIME, TASK_FAILED_BY_RUNTIME],
  },
  // The refactor track's delegation does not run TDD, so no progression beats.
  'overhaul-delegate': {
    expects: DELEGATE_EXPECTS,
    runtimeEmits: [TASK_COMPLETED_BY_RUNTIME, TASK_FAILED_BY_RUNTIME],
  },
  review: {
    expects: [TEAM_SPAWNED, TEAM_TASK_PLANNED, TEAM_TEAMMATE_DISPATCHED, TEAM_DISBANDED],
    runtimeEmits: [REVIEW_GATE_EXECUTED],
  },
  'overhaul-review': {
    expects: [TEAM_SPAWNED, TEAM_TASK_PLANNED, TEAM_TEAMMATE_DISPATCHED, TEAM_DISBANDED],
    runtimeEmits: [REVIEW_GATE_EXECUTED],
  },
  synthesize: {
    expects: [
      TEAM_SPAWNED,
      TEAM_DISBANDED,
      {
        type: 'shepherd.iteration',
        when: 'After each shepherd loop iteration',
        fields: ['iteration', 'prsAssessed', 'fixesApplied', 'status'],
      },
    ],
    runtimeEmits: [
      // One row per phase, so the four synthesize playbooks share this wording;
      // the debug/refactor/oneshot ones used to say "After synthesis validation
      // scripts" and "After pre-synthesis-check.sh runs" for the same gate.
      {
        type: 'gate.executed',
        when: 'After pre-synthesis-check.sh and validate-pr-stack.sh',
        emittedBy: 'the synthesis gates',
        fields: ['gateName', 'layer', 'passed'],
      },
      {
        type: 'shepherd.started',
        when: 'On first assess-stack invocation',
        emittedBy: 'exarchos_orchestrate assess_stack',
      },
      {
        type: 'shepherd.approval_requested',
        when: 'When all checks pass and approval is needed',
        emittedBy: 'exarchos_orchestrate assess_stack',
      },
      {
        type: 'shepherd.completed',
        when: 'When PR is merged or shepherd resolves',
        emittedBy: 'exarchos_orchestrate assess_stack',
      },
    ],
  },
  'overhaul-update-docs': {
    expects: [TEAM_SPAWNED, TEAM_DISBANDED],
    runtimeEmits: [],
  },
  'merge-pending': {
    expects: [],
    runtimeEmits: [
      {
        type: 'merge.preflight',
        when: 'After dispatch-guard suite runs (before merge attempt or abort)',
        emittedBy: 'exarchos_orchestrate merge_orchestrate',
        fields: [
          'taskId',
          'sourceBranch',
          'targetBranch',
          'passed',
          'ancestry',
          'worktree',
          'currentBranchProtection',
          'drift',
          'failureReasons',
        ],
      },
      {
        type: 'merge.executed',
        when: 'After merge commit lands successfully on the target branch',
        emittedBy: 'exarchos_orchestrate merge_orchestrate',
        fields: ['taskId', 'sourceBranch', 'targetBranch', 'mergeSha', 'rollbackSha', 'strategy'],
      },
      {
        type: 'merge.recovered',
        when: 'When merge fails post-commit and the INV-14 recovery path runs',
        emittedBy: 'exarchos_orchestrate merge_orchestrate',
        fields: [
          'taskId',
          'sourceBranch',
          'targetBranch',
          'recoveryPointSha',
          'reason',
          'recoveryError',
          'recoveryErrorDetail',
        ],
      },
    ],
  },
  implementing: {
    expects: [],
    runtimeEmits: [
      {
        type: 'synthesize.requested',
        when: 'On opt-in to the synthesize path at the end of implementation',
        emittedBy: 'the oneshot lifecycle guard',
      },
    ],
  },
});

const LIVE_EMISSION_SOURCES: ReadonlyMap<string, string> = new Map(
  Object.entries(EVENT_EMISSION_REGISTRY),
);

/**
 * Event-side refusals over a contract table. Every `expects` row must name a
 * registered, `model`-sourced event: a `retired` one is emitted by nobody, so
 * the expectation could never be met; an `auto` one is emitted by the runtime,
 * so the model would be nagged for what it cannot do. Every `runtimeEmits` row
 * must be `auto`-sourced for the mirror reason. A type may appear once per
 * phase, a row must declare something, and a type expected by several phases
 * carries one `when` — the gate's hint is one sentence per event, so two
 * phrasings would leave one of them silently unused. The registry is
 * injectable so each throw path is provable with a seeded map rather than
 * believed about the live one.
 */
export function assertPhaseEventContracts<T extends string>(
  contracts: PhaseEventContracts<T>,
  registry: ReadonlyMap<string, string> = LIVE_EMISSION_SOURCES,
): void {
  for (const [phase, contract] of Object.entries(contracts)) {
    if (contract.expects.length === 0 && contract.runtimeEmits.length === 0) {
      throw new Error(
        `PHASE_EVENT_CONTRACTS['${phase}'] declares nothing — a phase that expects and discloses ` +
          'no event has no business in the table. Delete the row; absence already means that.',
      );
    }
    const seen = new Set<string>();
    for (const row of [...contract.expects, ...contract.runtimeEmits]) {
      if (seen.has(row.type)) {
        throw new Error(
          `PHASE_EVENT_CONTRACTS['${phase}'] lists '${row.type}' twice — an event is either ` +
            'expected of the model or emitted by the runtime, and once.',
        );
      }
      seen.add(row.type);
    }
    for (const row of contract.expects) {
      const source = registry.get(row.type);
      if (source === undefined) {
        throw new Error(
          `PHASE_EVENT_CONTRACTS['${phase}'] expects '${row.type}', which is not registered in ` +
            'EVENT_EMISSION_REGISTRY — register it, or fix the typo here.',
        );
      }
      if (source === 'retired') {
        throw new Error(
          `PHASE_EVENT_CONTRACTS['${phase}'] expects '${row.type}', which is retired — nobody ` +
            'emits a retired event, so the expectation can never be met. Delete the row in the ' +
            'same change that retires the event.',
        );
      }
      if (source !== 'model') {
        throw new Error(
          `PHASE_EVENT_CONTRACTS['${phase}'] expects '${row.type}', whose emission source is ` +
            `'${source}' — the model does not emit it, so the gate would nag for what the runtime ` +
            'owns. Move it to `runtimeEmits` if the phase should disclose it.',
        );
      }
    }
    for (const row of contract.runtimeEmits) {
      const source = registry.get(row.type);
      if (source !== 'auto') {
        throw new Error(
          `PHASE_EVENT_CONTRACTS['${phase}'] discloses '${row.type}' as runtime-emitted, but its ` +
            `emission source is ${source === undefined ? 'unregistered' : `'${source}'`} — only ` +
            'an `auto`-sourced event belongs there.',
        );
      }
    }
  }
  const phrasing = new Map<string, { readonly phase: string; readonly when: string }>();
  for (const [phase, contract] of Object.entries(contracts)) {
    for (const row of contract.expects) {
      const first = phrasing.get(row.type);
      if (first === undefined) {
        phrasing.set(row.type, { phase, when: row.when });
      } else if (first.when !== row.when) {
        throw new Error(
          `PHASE_EVENT_CONTRACTS phrases '${row.type}' two ways — '${first.phase}' says ` +
            `"${first.when}", '${phase}' says "${row.when}" — and the gate's hint is one sentence ` +
            'per event. Share the row between the phases.',
        );
      }
    }
  }
}

assertPhaseEventContracts(PHASE_EVENT_CONTRACTS);

/**
 * Phase-side refusal: every key names a phase some built-in HSM registers.
 * Called from `state-machine.ts` at load with the union of its registry's
 * states — this module cannot import the HSM definitions without a cycle, and
 * the check belongs where the phase set is authoritative anyway.
 */
export function assertContractPhasesAreRegistered<T extends string>(
  contracts: PhaseEventContracts<T>,
  registeredPhases: ReadonlySet<string>,
): void {
  const dead = Object.keys(contracts)
    .filter((phase) => !registeredPhases.has(phase))
    .sort();
  if (dead.length > 0) {
    throw new Error(
      `PHASE_EVENT_CONTRACTS names ${dead.length} phase(s) no built-in HSM registers: ` +
        `${dead.join(', ')}. A renamed or retired phase takes its row with it.`,
    );
  }
}

// ─── Derivations ─────────────────────────────────────────────────────────────

/** The gate's expectation table: phase → expected model events, in order. */
export function expectedEventsByPhase<T extends string>(
  contracts: PhaseEventContracts<T>,
): Readonly<Record<string, readonly T[]>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(contracts)
        .filter(([, contract]) => contract.expects.length > 0)
        .map(([phase, contract]) => [phase, contract.expects.map((row) => row.type)]),
    ),
  );
}

/**
 * The gate's hint for a missing event: the instruction, phrased from `when`.
 * One sentence per event; `assertPhaseEventContracts` refuses a table that
 * phrases one type two ways, so the first row seen is the only phrasing.
 */
export function hintDescriptions<T extends string>(
  contracts: PhaseEventContracts<T>,
): Readonly<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  for (const contract of Object.values(contracts)) {
    for (const row of contract.expects) {
      descriptions[row.type] ??= `Emit ${row.type} via exarchos_event — ${lowerFirst(row.when)}`;
    }
  }
  return Object.freeze(descriptions);
}

function lowerFirst(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** A playbook `events` row: the instruction to the model, with a fresh `fields` copy. */
export interface EventInstructionOf<T extends string> {
  readonly type: T;
  readonly when: string;
  readonly fields?: string[];
}

/** A playbook `autoEmittedEvents` row: the disclosure of a runtime emission. */
export interface RuntimeEmissionInstructionOf<T extends string> extends EventInstructionOf<T> {
  readonly source: 'auto';
  readonly emittedBy: string;
}

/** The playbook's `events` rows for a phase of `contracts` — a fresh copy each call. */
export function eventInstructionsFor<T extends string>(
  contracts: PhaseEventContracts<T>,
  phase: string,
): EventInstructionOf<T>[] {
  return (contracts[phase]?.expects ?? []).map((row) => ({
    type: row.type,
    when: row.when,
    ...(row.fields !== undefined && { fields: [...row.fields] }),
  }));
}

/**
 * The playbook's `autoEmittedEvents` rows for a phase of `contracts`, or
 * `undefined` when the phase discloses nothing — the serialized playbook omits
 * the field in that case, as it always has.
 */
export function runtimeEmissionsFor<T extends string>(
  contracts: PhaseEventContracts<T>,
  phase: string,
): RuntimeEmissionInstructionOf<T>[] | undefined {
  const rows = contracts[phase]?.runtimeEmits ?? [];
  if (rows.length === 0) return undefined;
  return rows.map((row): RuntimeEmissionInstructionOf<T> => ({
    type: row.type,
    source: 'auto',
    when: row.when,
    emittedBy: row.emittedBy,
    ...(row.fields !== undefined && { fields: [...row.fields] }),
  }));
}

/** {@link eventInstructionsFor} over the live table. */
export function phaseEventInstructions(phase: string): EventInstructionOf<EventType>[] {
  return eventInstructionsFor(PHASE_EVENT_CONTRACTS, phase);
}

/** {@link runtimeEmissionsFor} over the live table. */
export function phaseRuntimeEmissions(
  phase: string,
): RuntimeEmissionInstructionOf<EventType>[] | undefined {
  return runtimeEmissionsFor(PHASE_EVENT_CONTRACTS, phase);
}
