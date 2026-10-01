/**
 * The pure staleness scorer of the pruner. It decides from minute values and a typed `PhaseContract` whether a workflow is stale.
 * The topology loader throws on a phase with no `staleness` block, so the normal wiring always gives a contract.
 * The scorer takes minutes, not timestamps, so it reads no clock. The handler layer does the timestamp math.
 */
import type { PhaseContract, StalenessSignalName } from '../workflow/topology/phase-contract.js';

/**
 * The minutes since each signal. The scorer reads only the signals that the contract names, and ignores other fields.
 * The thresholds come from the contract, not from the caller.
 */
export interface StalenessState {
  lastActivityMinutes?: number;
  phaseTransitionMinutes?: number;
  branchActivityMinutes?: number;
}

export interface StalenessScore {
  isStale: boolean;
  /** Per-signal verdicts when scoring against a contract. */
  signalsEvaluated: Partial<Record<StalenessSignalName, boolean>>;
}

/**
 * Read the minutes value for a signal name from `state`. Returns
 * `undefined` when the caller did not supply that signal.
 */
function readSignalMinutes(
  state: StalenessState,
  name: StalenessSignalName,
): number | undefined {
  switch (name) {
    case 'lastActivity':
      return state.lastActivityMinutes;
    case 'phaseTransition':
      return state.phaseTransitionMinutes;
    case 'branchActivity':
      return state.branchActivityMinutes;
  }
}

/**
 * Scores a workflow against its contract. A signal is stale when its minutes exceed its threshold, or when `state` does not have it.
 * Absence is "no evidence", as in the `whenAbsent: true` rule of `selectPruneCandidates`. Thus an `'all'` contract cannot skip an absent signal.
 * With `freshnessRequires: 'all'`, the workflow is stale when any signal is stale. With `'any'`, it is stale when every signal is stale.
 */
export function scoreStaleness(
  state: StalenessState,
  contract: PhaseContract,
): StalenessScore {
  const verdicts: Partial<Record<StalenessSignalName, boolean>> = {};
  for (const signal of contract.signals) {
    const minutes = readSignalMinutes(state, signal.name);
    const isStaleSignal =
      minutes === undefined ? true : minutes > signal.thresholdMinutes;
    verdicts[signal.name] = isStaleSignal;
  }

  const verdictValues = Object.values(verdicts);
  const isStale =
    contract.freshnessRequires === 'all'
      ?
        verdictValues.some((v) => v === true)
      :
        verdictValues.every((v) => v === true);

  return { isStale, signalsEvaluated: verdicts };
}
