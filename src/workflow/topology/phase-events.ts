// This module declares the events that a workflow phase expects from the model. It also declares
// the events that the runtime emits for the model during that phase. The `check-event-emissions`
// gate, the phase playbooks, and the skill prose comparator in `tests/architecture/` derive from it.
// A playbook never tells the model to emit a runtime-owned event such as `gate.executed`.
//
// The rows are declared, not derived, because the event catalog does not hold the phase of an event.
// A load-time check makes sure that each expected event is registered and `model`-sourced, and that
// each runtime emission is `auto`-sourced. `state-machine.ts` checks the phase keys against the
// built-in HSM states, so a renamed or retired phase throws. This module imports only the event
// catalog, so it sits below every consumer without a cycle.

import type { EventType } from '../../events/schemas.js';
import { EVENT_EMISSION_REGISTRY } from '../../events/schemas.js';

/**
 * A model-emitted event that the gate demands and the playbook instructs.
 * The type is generic over the event name, so a seeded test table needs no cast.
 */
export interface PhaseEventRowOf<T extends string> {
  readonly type: T;
  /** When the model emits it — one sentence, playbook and hint share it. */
  readonly when: string;
  /** Payload fields that the instruction names. The schema stays authoritative. */
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
  /** In emission order. The gate reports missing events in this order. */
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

const TASK_ASSIGNED_BY_RUNTIME: PhaseRuntimeEmissionRow = {
  type: 'task.assigned',
  when:
    'When the batch is compiled — one per planned task the stream has not yet heard of, in the ' +
    'same commit as the prepared record; on the primitive path, when prepare_delegation reads ' +
    'readiness',
  emittedBy: 'exarchos_orchestrate prepare (the capsule path) and prepare_delegation (the primitive path)',
  fields: ['taskId', 'title'],
};
const TASK_COMPLETED_BY_RUNTIME: PhaseRuntimeEmissionRow = {
  type: 'task.completed',
  when: 'After task_complete orchestrate action succeeds — called directly, or as the terminal leaf of the task-completion segment settle runs per accepted task',
  emittedBy: 'exarchos_orchestrate task_complete (directly, or as the terminal leaf settle composes)',
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

/** The team events of the delegate phases. The runtime appends `task.assigned`, so that event is in `TASK_ASSIGNED_BY_RUNTIME` and not here. */
const DELEGATE_EXPECTS: readonly PhaseEventRow[] = [
  TEAM_SPAWNED,
  TEAM_TASK_PLANNED,
  TEAM_TEAMMATE_DISPATCHED,
  TEAM_DISBANDED,
];

/**
 * The contract, keyed by phase name. A phase absent here expects nothing and discloses nothing.
 * A phase that the runtime drives (`merge-pending`) can have an empty `expects`.
 * A row that declares nothing fails at load, because it reads as a decision that nobody made.
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
    runtimeEmits: [TASK_ASSIGNED_BY_RUNTIME, TASK_COMPLETED_BY_RUNTIME, TASK_FAILED_BY_RUNTIME],
  },
  /** The delegation of the refactor track does not run TDD, so it has no progression events. */
  'overhaul-delegate': {
    expects: DELEGATE_EXPECTS,
    runtimeEmits: [TASK_ASSIGNED_BY_RUNTIME, TASK_COMPLETED_BY_RUNTIME, TASK_FAILED_BY_RUNTIME],
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
      /** The synthesize playbooks share this wording. */
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
        when: 'When the model opts into the synthesize path by calling request_synthesize',
        emittedBy: 'exarchos_orchestrate request_synthesize',
      },
    ],
  },
});

const LIVE_EMISSION_SOURCES: ReadonlyMap<string, string> = new Map(
  Object.entries(EVENT_EMISSION_REGISTRY),
);

/**
 * Event-side refusals over a contract table.
 * Each `expects` row must name a registered, `model`-sourced event, and each `runtimeEmits` row an `auto`-sourced one.
 * A type appears once in a phase, and a row must declare something.
 * A type that several phases expect has one `when`, because the gate hint is one sentence for each event.
 * The `registry` parameter lets a test prove each throw with a seeded map.
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
 * Phase-side refusal: each key must name a phase that a built-in HSM registers.
 * `state-machine.ts` calls it at load with the states of its registry, because this module cannot import the HSM definitions without a cycle.
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
 * The gate hint for a missing event, phrased from `when`.
 * `assertPhaseEventContracts` refuses two phrasings of one type, so the first row is the only phrasing.
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
 * The playbook `autoEmittedEvents` rows for a phase, or `undefined` when the phase discloses nothing.
 * The serialized playbook then omits the field.
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
