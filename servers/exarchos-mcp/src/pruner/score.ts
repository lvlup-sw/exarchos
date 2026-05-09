/**
 * Pure pruner staleness scorer (DR-7).
 *
 * `scoreStaleness(state, contract)` is a pure function that decides
 * whether a workflow is stale based on a numeric snapshot (`state`) and
 * an optional typed `PhaseContract`.
 *
 * Two branches:
 *
 *   1. `contract` defined — reduce over the contract's declared signals
 *      according to `freshnessRequires`:
 *        - 'all' → fresh iff every declared signal is fresh
 *                  (stale iff ANY signal exceeds its threshold OR is
 *                   absent on `state` — absence = "no evidence", which
 *                   matches `selectPruneCandidates`'s `whenAbsent: true`
 *                   convention).
 *        - 'any' → fresh iff at least one declared signal is fresh
 *                  (stale iff EVERY declared signal exceeds its
 *                   threshold or is absent).
 *
 *   2. `contract === undefined` — two sub-cases:
 *        a. `lastActivityMinutes` absent → **fail-closed** (T66 /
 *           CR #6 / DIM-7): return `{ isStale: true, reason:
 *           'no-contract-no-signal' }`. Without a declared contract
 *           AND without an evidence signal, the safe default is to
 *           treat the workflow as stale (a candidate for pruning
 *           consideration), matching the design's "missing contract
 *           → degrade explicitly" principle.
 *        b. `lastActivityMinutes` present → fall back to the v2.9
 *           single-signal heuristic: stale iff
 *           `lastActivityMinutes > thresholdMinutes`. Mirrors the
 *           legacy path in
 *           `orchestrate/prune-stale-workflows.ts:selectPruneCandidates`
 *           (specifically, `hasSecondarySignal === false → isStale =
 *           lastActivityStale`). The strict `>` comparison is
 *           preserved so callers that switch from the legacy selector
 *           to this scorer observe identical verdicts.
 *
 * The scorer accepts numeric minutes rather than ISO timestamps so it
 * stays clock-free; the handler layer (T48) does the timestamp math.
 */
import type { PhaseContract, StalenessSignalName } from '../topology/phase-contract.js';

/**
 * Default threshold (minutes) for the v2.9 fallback path. 20_160 = 14
 * days, matching `DEFAULT_THRESHOLD_MINUTES` in
 * `orchestrate/prune-stale-workflows.ts` and
 * `ResolvedProjectConfig.prune.staleAfterDays`'s default.
 */
const DEFAULT_THRESHOLD_MINUTES = 20_160;

/**
 * Pre-computed per-signal minute deltas. The scorer reads only the
 * signals named on the contract; extra fields are ignored (forward-
 * compatibility with future signals).
 *
 * `thresholdMinutes` is consulted only on the fallback (no-contract)
 * path. Contract-aware scoring uses the per-signal threshold from
 * `contract.signals[].thresholdMinutes`.
 */
export interface StalenessState {
  lastActivityMinutes?: number;
  phaseTransitionMinutes?: number;
  branchActivityMinutes?: number;
  /** Fallback threshold; only consulted when `contract === undefined`. */
  thresholdMinutes?: number;
}

export interface StalenessScore {
  isStale: boolean;
  /** Per-signal verdicts when scoring against a contract. Empty on fallback. */
  signalsEvaluated: Partial<Record<StalenessSignalName, boolean>>;
  /**
   * Optional diagnostic. Set to `'no-contract-no-signal'` when the
   * fail-closed branch fires (T66 / CR #6 / DIM-7): no `PhaseContract`
   * was supplied AND `state.lastActivityMinutes` was absent, so the
   * scorer has neither a declared expectation nor evidence to measure
   * against. In that case it returns `isStale: true` to fail-closed
   * rather than fail-open. Absent on every other path.
   */
  reason?: 'no-contract-no-signal';
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
  contract: PhaseContract | undefined,
): StalenessScore {
  if (contract === undefined) {
    // T66 (CR #6 / DIM-7) — fail-closed when contract AND signal both
    // absent. The pre-T66 code used `lastActivityMinutes ?? 0`, which
    // treated a contractless phase with no activity signal as
    // `isStale: false` for any threshold > 0 — i.e. fresh forever. That
    // violates fail-closed: missing contract + missing signal = stale
    // by default; this is intentional fail-closed behavior per DIM-7,
    // mirroring the design's "missing contract → emit
    // `phase.contract_missing` and degrade explicitly" principle.
    // Degrading means erring toward staleness (a candidate for pruning
    // consideration), not freshness. A real `lastActivityMinutes: 0`
    // (just-happened) is evidence and goes through the v2.9 path
    // unchanged.
    if (state.lastActivityMinutes === undefined) {
      return {
        isStale: true,
        signalsEvaluated: {},
        reason: 'no-contract-no-signal',
      };
    }

    // v2.9 fallback: single-signal threshold check on lastActivity.
    const threshold = state.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
    return {
      isStale: state.lastActivityMinutes > threshold,
      signalsEvaluated: {},
    };
  }

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
