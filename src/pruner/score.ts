/**
 * Pure pruner staleness scorer (DR-7, v2.11 hard-cut).
 *
 * `scoreStaleness(state, contract)` is a pure function that decides
 * whether a workflow is stale based on a numeric snapshot (`state`) and
 * a typed `PhaseContract`.
 *
 * v2.11 behavior — typed-contract-only:
 *   - Reduce over the contract's declared signals according to
 *     `freshnessRequires`:
 *       - 'all' → fresh iff every declared signal is fresh
 *                 (stale iff ANY signal exceeds its threshold OR is
 *                  absent on `state` — absence = "no evidence", which
 *                  matches `selectPruneCandidates`'s `whenAbsent: true`
 *                  convention).
 *       - 'any' → fresh iff at least one declared signal is fresh
 *                 (stale iff EVERY declared signal exceeds its
 *                  threshold or is absent).
 *
 * The v2.10 untyped heuristic fallback (when `contract` was undefined)
 * was deleted in v2.11 (Phase 5c, DR-7). The topology loader now throws
 * on any phase missing a `staleness` block, so callers that follow the
 * canonical lifecycle wiring (loader → coordinator → scorer) cannot reach
 * the scorer without a typed contract. Callers that construct a synthetic
 * "no contract" call site are surfaced loudly via `scoreEntryThroughTopology`
 * (see `coordinator.ts`).
 *
 * The scorer accepts numeric minutes rather than ISO timestamps so it
 * stays clock-free; the handler layer (T48) does the timestamp math.
 */
import type { PhaseContract, StalenessSignalName } from '../workflow/topology/phase-contract.js';

/**
 * Pre-computed per-signal minute deltas. The scorer reads only the
 * signals named on the contract; extra fields are ignored (forward-
 * compatibility with future signals).
 *
 * Per-signal thresholds come from the typed contract
 * (`contract.signals[].thresholdMinutes`); there is no caller-supplied
 * default-threshold semantic in v2.11.
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

export function scoreStaleness(
  state: StalenessState,
  contract: PhaseContract,
): StalenessScore {
  // Contract path: reduce per-signal staleness verdicts.
  const verdicts: Partial<Record<StalenessSignalName, boolean>> = {};
  for (const signal of contract.signals) {
    const minutes = readSignalMinutes(state, signal.name);
    // Absent signal = "no evidence" → treat as stale, matching
    // `selectPruneCandidates`'s `whenAbsent: true` convention. Without
    // this, an `'all'` contract could classify partially-wired entries
    // as fresh by skipping over absent signals.
    const isStaleSignal =
      minutes === undefined ? true : minutes > signal.thresholdMinutes;
    verdicts[signal.name] = isStaleSignal;
  }

  const verdictValues = Object.values(verdicts);
  const isStale =
    contract.freshnessRequires === 'all'
      ? // 'all' fresh required → stale iff ANY signal stale
        verdictValues.some((v) => v === true)
      : // 'any' fresh sufficient → stale iff EVERY signal stale
        verdictValues.every((v) => v === true);

  return { isStale, signalsEvaluated: verdicts };
}
