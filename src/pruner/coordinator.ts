/**
 * Pruner coordinator. It looks up the typed `PhaseContract` for a phase in the
 * loaded `Topology`, and delegates to the pure `scoreStaleness` scorer.
 *
 * The topology loader (`topology/loader.ts`) throws on a phase without a
 * `staleness` block. Thus only a synthetic `Topology` can reach this module
 * without a contract, and the coordinator throws for it.
 */
import type { Topology } from '../workflow/topology/phase-contract.js';
import { scoreStaleness, type StalenessState, type StalenessScore } from './score.js';

/**
 * Scores the staleness of one entry through the phase contract in `topology`.
 * Throws when the phase is absent from the topology or has no `staleness`
 * block. A loaded topology cannot cause this, so the cause is a synthetic
 * fixture or a bypass of the loader.
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
