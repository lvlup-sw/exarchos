/**
 * Thin pruner coordinator (DR-7, v2.11 hard-cut).
 *
 * Walks per-phase entries, looks up the typed `PhaseContract` from the
 * loaded `Topology`, and delegates to the pure `scoreStaleness` scorer.
 *
 * v2.11 invariant: the topology loader (`topology/loader.ts`) THROWS on
 * any phase missing a `staleness` block, so a production-loaded
 * `Topology` cannot reach this coordinator with an undefined contract.
 * If a caller constructs a synthetic Topology that lacks a contract for
 * the requested phase (test seam, internal bug), this coordinator
 * surfaces the missing-contract case loudly rather than silently falling
 * back. The v2.9 single-signal heuristic was deleted in Phase 5c.
 */
import type { Topology } from '../workflow/topology/phase-contract.js';
import { scoreStaleness, type StalenessState, type StalenessScore } from './score.js';

/**
 * Score one entry's staleness through the typed phase contract on
 * `topology`. Throws when the phase is absent from the topology or
 * declares no `staleness` block — both are violations of the v2.11
 * loader invariant and indicate either:
 *   - a synthetic test fixture (acceptable; tests should expect this throw); or
 *   - an internal bug bypassing the loader's hard-cut.
 */
export function scoreEntryThroughTopology(
  topology: Topology,
  phase: string,
  state: StalenessState,
): StalenessScore {
  const phaseEntry = topology.phases[phase];
  if (phaseEntry === undefined) {
    throw new Error(
      `Pruner cannot score phase "${phase}": phase is absent from topology. ` +
        `(v2.11 invariant: the topology loader hard-throws on missing contracts; ` +
        `reaching this branch indicates a synthetic Topology bypassing the loader.)`,
    );
  }
  const contract = phaseEntry.staleness;
  if (contract === undefined) {
    throw new Error(
      `Pruner cannot score phase "${phase}": no \`staleness\` contract declared. ` +
        `(v2.11 DR-7: every phase must declare a staleness block; the loader ` +
        `should have rejected this topology at startup.)`,
    );
  }
  return scoreStaleness(state, contract);
}
