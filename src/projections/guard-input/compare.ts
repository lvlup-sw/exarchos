/**
 * The comparator of the two guard inputs of one transition: the state document and the ledger fold.
 *
 * The comparator compares the phase, the edge-condition facts, the guard config keys and two keys of each task.
 * It also runs each guard that the machine can run from the document phase on both inputs.
 * Each difference gets a class. The comparator does no I/O, and a throw of a guard or of the facts step becomes a value.
 * It reads each input in place and never spreads or clones an input, because a spread reads each getter of the input.
 */
import { isDeepStrictEqual } from 'node:util';

import { FACT_DECLARATION } from '../../workflow/admission/built-in-workflow-ir.js';
import type { EdgeConditionFacts } from '../../workflow/admission/edge-condition-evaluate.js';
import { projectStateToFacts } from '../../workflow/admission/legacy-state-translation.js';
import { guards, type Guard } from '../../workflow/guards.js';
import { applyPhaseSkips } from '../../workflow/phase-skip.js';
import { getHSMDefinition, isBuiltInWorkflowType, type HSMDefinition } from '../../workflow/state-machine.js';
import { isPlainObject } from '../../workflow/state-mutation.js';
import type { GuardInput } from './fold.js';

/** The class of one difference between the state document and the ledger fold. */
export type DisagreementClass =
  | 'phase'
  | 'risk-tier'
  | 'task-status'
  | 'task-list'
  | 'merge-orchestrator'
  | 'unexplained';

/** The verdict of one guard on one input. The comparator ignores the failure text, because the projection seeds default fields. */
type Verdict = 'pass' | 'fail' | 'throw';

/** One key whose value differs between the two inputs. A key that is absent on one side holds `undefined` there. */
interface GuardInputDifference {
  readonly key: string;
  readonly document: unknown;
  readonly fold: unknown;
}

/** The verdict of one guard on each input, with the target of the transition that runs the guard. */
interface GuardVerdicts {
  readonly guardId: string;
  readonly to: string;
  readonly document: Verdict;
  readonly fold: Verdict;
}

/** The result of a comparison of the two guard inputs of one transition. */
export interface GuardInputComparison {
  /** The workflow type of the document. */
  readonly workflowType: string;
  /** The phase of each input. A phase that is not a string is an empty string here, and the difference keeps the raw value. */
  readonly phase: { readonly document: string; readonly fold: string };
  /** The keys that differ, in the order of the phase keys, the facts, the config keys and the task keys. */
  readonly differences: readonly GuardInputDifference[];
  /** Each guard that ran, so a caller can count the denominator. */
  readonly guards: readonly GuardVerdicts[];
  /** The classes of the differences, in the order of `CLASS_ORDER`, each one time. */
  readonly classes: readonly DisagreementClass[];
  /** True when no key differs and each guard gives the same verdict on both inputs. */
  readonly agrees: boolean;
}

/** A difference with its class. */
interface ClassedDifference extends GuardInputDifference {
  readonly disagreementClass: DisagreementClass;
}

/** The outcome of the facts step on one input. A throw of the step is the outcome `throw`. */
type FactsOutcome = { readonly ok: true; readonly facts: EdgeConditionFacts } | { readonly ok: false };

/** The task id and the status of one task entry of an input. */
interface TaskEntry {
  readonly id: string;
  readonly status: unknown;
}

/** The two task keys of one task id. */
interface TaskStanding {
  readonly complete: boolean;
  readonly failed: boolean;
}

/** A guard that the machine can run from a phase, and the target of the transition that runs it. */
interface RunnableGuard {
  readonly guard: Guard;
  readonly to: string;
}

/** The order of the classes in a comparison. */
const CLASS_ORDER: readonly DisagreementClass[] = [
  'phase',
  'risk-tier',
  'task-status',
  'task-list',
  'merge-orchestrator',
  'unexplained',
];

/** The config keys of the guard input: the risk tier, the boundary status and the injected keys, in the order of the transition handler. */
const CONFIG_KEYS: readonly string[] = [
  'riskTier',
  'boundaryTouching',
  '_requiredReviews',
  '_maxPlanRevisions',
  '_mutationEnforcement',
  '_mutationThreshold',
  '_maxNoCoverage',
];

/** The facts that summarize the task list. Their class comes from the two lists of task ids. */
const TASK_FACTS: ReadonlySet<string> = new Set(['tasks.allComplete', 'tasks.count']);

/** The facts that read the merge state. Their class comes from the two merge orchestrator phases. */
const MERGE_FACTS: ReadonlySet<string> = new Set(['mergePending.entryReady', 'mergePending.exitReady']);

/** The guards that read the merge state. Their class comes from the two merge orchestrator phases. */
const MERGE_GUARDS: ReadonlySet<string> = new Set(['merge-pending-entry', 'merge-pending-exit']);

/** Returns the value when it is a string, and otherwise an empty string. */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Orders two strings by their UTF-16 code units. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** Returns one classed difference when the two values are not deeply equal, and otherwise no difference. */
function differenceOf(
  key: string,
  document: unknown,
  fold: unknown,
  disagreementClass: DisagreementClass,
): readonly ClassedDifference[] {
  return isDeepStrictEqual(document, fold) ? [] : [{ key, document, fold, disagreementClass }];
}

/** Runs the facts step on one input and catches a throw. */
function factsOf(input: GuardInput): FactsOutcome {
  try {
    return { ok: true, facts: projectStateToFacts(input) };
  } catch {
    return { ok: false };
  }
}

/**
 * Returns the fact differences: each field of `FACT_DECLARATION`, then the key `events[<type>]` for each declared event type.
 * When the facts step throws on one side, only the key `facts` differs. When it throws on both sides, nothing differs.
 */
function factDifferences(
  document: FactsOutcome,
  fold: FactsOutcome,
  taskClass: DisagreementClass,
  mergeClass: DisagreementClass,
): readonly ClassedDifference[] {
  if (!document.ok || !fold.ok) {
    return differenceOf('facts', document.ok ? 'ok' : 'throw', fold.ok ? 'ok' : 'throw', 'unexplained');
  }
  const fieldDifferences = Object.keys(FACT_DECLARATION.fields).flatMap((field) => {
    const factClass = TASK_FACTS.has(field) ? taskClass : MERGE_FACTS.has(field) ? mergeClass : 'unexplained';
    return differenceOf(field, document.facts.fields[field], fold.facts.fields[field], factClass);
  });
  const eventDifferences = (FACT_DECLARATION.events ?? []).flatMap((type) =>
    differenceOf(`events[${type}]`, document.facts.events.includes(type), fold.facts.events.includes(type), 'unexplained'),
  );
  return [...fieldDifferences, ...eventDifferences];
}

/** Returns the task entries of an input, in list order. An entry with no string `id` gets the id `#<index>`. */
function taskEntries(input: GuardInput): readonly TaskEntry[] {
  const tasks = input.tasks;
  if (!Array.isArray(tasks)) return [];
  const list: readonly unknown[] = tasks;
  return list.map((task, index) => ({
    id: isPlainObject(task) && typeof task.id === 'string' ? task.id : `#${index}`,
    status: isPlainObject(task) ? task.status : undefined,
  }));
}

/**
 * Returns the two task keys of each task id.
 * A task id is complete when each entry of the id is complete, and failed when an entry of the id is failed.
 */
function taskStandings(entries: readonly TaskEntry[]): ReadonlyMap<string, TaskStanding> {
  const standings = new Map<string, TaskStanding>();
  for (const entry of entries) {
    const prior = standings.get(entry.id);
    standings.set(entry.id, {
      complete: (prior?.complete ?? true) && entry.status === 'complete',
      failed: (prior?.failed ?? false) || entry.status === 'failed',
    });
  }
  return standings;
}

/** Returns the differences of the keys `tasks[<id>].complete` and `tasks[<id>].failed` for each task id in either list, by sorted task id. */
function taskDifferences(
  document: readonly TaskEntry[],
  fold: readonly TaskEntry[],
  taskClass: DisagreementClass,
): readonly ClassedDifference[] {
  const documentStandings = taskStandings(document);
  const foldStandings = taskStandings(fold);
  const ids = [...new Set([...documentStandings.keys(), ...foldStandings.keys()])].sort(compareText);
  return ids.flatMap((id) => {
    const documentStanding = documentStandings.get(id);
    const foldStanding = foldStandings.get(id);
    return [
      ...differenceOf(`tasks[${id}].complete`, documentStanding?.complete, foldStanding?.complete, taskClass),
      ...differenceOf(`tasks[${id}].failed`, documentStanding?.failed, foldStanding?.failed, taskClass),
    ];
  });
}

/** Returns the sorted list of the task ids of the entries. */
function sortedTaskIds(entries: readonly TaskEntry[]): readonly string[] {
  return entries.map((entry) => entry.id).sort(compareText);
}

/** Returns the phase of the merge orchestrator of an input, or `undefined` when the input holds none. */
function mergePhaseOf(input: GuardInput): unknown {
  const merge = input.mergeOrchestrator;
  return isPlainObject(merge) ? merge.phase : undefined;
}

/**
 * Returns each guard that `executeTransition` can run from `phase`, in the order of the transitions, and then `merge-verified`.
 * A final phase runs no guard. The first transition to a target decides, as `findTransition` does.
 * A transition to the phase itself and a transition to a final `cancelled` state run no guard.
 * The list holds a guard and a target one time.
 */
function guardsOutOf(machine: HSMDefinition, phase: string): readonly RunnableGuard[] {
  if (machine.states[phase]?.type === 'final') return [];
  const runnable: RunnableGuard[] = [];
  const targets = new Set<string>();
  for (const transition of machine.transitions) {
    if (transition.from !== phase || transition.to === phase || targets.has(transition.to)) continue;
    targets.add(transition.to);
    const cancels = transition.to === 'cancelled' && machine.states['cancelled']?.type === 'final';
    if (transition.guard !== undefined && !cancels) runnable.push({ guard: transition.guard, to: transition.to });
  }
  const mergeVerified = guards.mergeVerified;
  if (!runnable.some((entry) => entry.guard.id === mergeVerified.id && entry.to === 'completed')) {
    runnable.push({ guard: mergeVerified, to: 'completed' });
  }
  return runnable;
}

/** Runs one guard on one input. A guard that throws gives `throw`. */
function verdictOf(guard: Guard, input: GuardInput): Verdict {
  try {
    return guard.evaluate(input) === true ? 'pass' : 'fail';
  } catch {
    return 'throw';
  }
}

/**
 * Compares the guard input of the state document with the guard input of the ledger fold.
 * The type of the document selects the machine, with `applyPhaseSkips` for `options.skipPhases`, as the transition guard builds it.
 * The guards come from the document phase. A type that is not built in gives no comparison and runs no guard.
 * @throws when `options.skipPhases` names a phase that the machine cannot skip, as the transition guard does.
 */
export function compareGuardInputs(
  document: GuardInput,
  fold: GuardInput,
  options: { readonly skipPhases?: readonly string[] } = {},
): GuardInputComparison | undefined {
  const workflowType = document.workflowType;
  if (typeof workflowType !== 'string' || !isBuiltInWorkflowType(workflowType)) return undefined;
  const base = getHSMDefinition(workflowType);
  const machine = options.skipPhases === undefined ? base : applyPhaseSkips(base, options.skipPhases);

  const documentPhase = document.phase;
  const foldPhase = fold.phase;
  const documentTasks = taskEntries(document);
  const foldTasks = taskEntries(fold);
  const taskClass: DisagreementClass = isDeepStrictEqual(sortedTaskIds(documentTasks), sortedTaskIds(foldTasks))
    ? 'task-status'
    : 'task-list';
  const mergeClass: DisagreementClass = isDeepStrictEqual(mergePhaseOf(document), mergePhaseOf(fold))
    ? 'unexplained'
    : 'merge-orchestrator';

  const classed: readonly ClassedDifference[] = [
    ...differenceOf('phase', documentPhase, foldPhase, 'phase'),
    ...differenceOf('workflowType', workflowType, fold.workflowType, 'unexplained'),
    ...factDifferences(factsOf(document), factsOf(fold), taskClass, mergeClass),
    ...CONFIG_KEYS.flatMap((key) => differenceOf(key, document[key], fold[key], 'risk-tier')),
    ...taskDifferences(documentTasks, foldTasks, taskClass),
  ];

  const verdicts: readonly GuardVerdicts[] = guardsOutOf(machine, textOf(documentPhase)).map(({ guard, to }) => ({
    guardId: guard.id,
    to,
    document: verdictOf(guard, document),
    fold: verdictOf(guard, fold),
  }));

  const found = new Set<DisagreementClass>(classed.map((difference) => difference.disagreementClass));
  for (const verdict of verdicts) {
    if (verdict.document === verdict.fold) continue;
    if (MERGE_GUARDS.has(verdict.guardId)) found.add(mergeClass);
    else if (classed.length === 0) found.add('unexplained');
  }

  return {
    workflowType,
    phase: { document: textOf(documentPhase), fold: textOf(foldPhase) },
    differences: classed.map(({ key, document: documentValue, fold: foldValue }) => ({
      key,
      document: documentValue,
      fold: foldValue,
    })),
    guards: verdicts,
    classes: CLASS_ORDER.filter((disagreementClass) => found.has(disagreementClass)),
    agrees: classed.length === 0 && verdicts.every((verdict) => verdict.document === verdict.fold),
  };
}
