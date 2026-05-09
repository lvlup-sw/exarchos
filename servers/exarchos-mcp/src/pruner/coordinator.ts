/**
 * Thin pruner coordinator (DR-7, T48 GREEN).
 *
 * Walks per-phase entries, looks up the typed `PhaseContract` from the
 * loaded `Topology`, and delegates to the pure `scoreStaleness` scorer.
 *
 * This module is the wiring seam that T58 (lifecycle integration)
 * consumes from the orchestration handler in
 * `orchestrate/prune-stale-workflows.ts`. Keeping the topology lookup
 * here (and out of `score.ts`) preserves the scorer's purity — the
 * scorer takes a `PhaseContract | undefined`, never a `Topology`.
 */
import type { Topology } from '../topology/phase-contract.js';
import { scoreStaleness, type StalenessState, type StalenessScore } from './score.js';

/**
 * Score one entry's staleness through the typed phase contract on
 * `topology`. When the entry's phase has no contract (e.g. the phase
 * isn't declared, or its `staleness` block is omitted), `scoreStaleness`
 * falls back to the v2.9 single-signal heuristic.
 */
export function scoreEntryThroughTopology(
  topology: Topology,
  phase: string,
  state: StalenessState,
): StalenessScore {
  const phaseEntry = topology.phases[phase];
  // Phase absent from topology → undefined contract → fallback. This
  // mirrors `selectPruneCandidates`'s legacy single-signal path and
  // keeps undeclared phases pruning under the default 14-day window.
  const contract = phaseEntry?.staleness;
  return scoreStaleness(state, contract);
}
