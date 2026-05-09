/**
 * Phase contract types and Zod schema (DR-7).
 *
 * Each phase in `topology.yaml` may declare a `staleness` block describing
 * how the pruner should evaluate workflow staleness for that phase. The
 * pruner reads typed `PhaseContract` objects through `topology/loader.ts`;
 * malformed contracts are rejected at load time with structured errors.
 *
 * `signals` are named indicators the scorer reduces over. The `name` field
 * is loosely-typed (string) at this layer — T45 GREEN narrows it to a
 * known enum. `freshnessRequires` selects the reduction operator:
 *   - `'all'` → fresh iff every declared signal is fresh
 *   - `'any'` → fresh iff at least one declared signal is fresh
 */
import { z } from 'zod';

/**
 * Known staleness-signal names. Mirrors the secondary signals already
 * derived by `prune-stale-workflows.ts` for backward compatibility:
 *
 *   - `lastActivity`     ← `_checkpoint.lastActivityTimestamp`
 *   - `phaseTransition`  ← latest `workflow.transition` event timestamp
 *   - `branchActivity`   ← latest commit on the workflow's tracked branch
 *
 * Adding a new signal name requires updating both this enum AND the
 * scorer's reduction over signals (`pruner/score.ts`) — fail-closed at
 * load time keeps unknown names from silently no-op'ing.
 */
export const StalenessSignalNames = [
  'lastActivity',
  'phaseTransition',
  'branchActivity',
] as const;

export const StalenessSignalNameSchema = z.enum(StalenessSignalNames);

export type StalenessSignalName = z.infer<typeof StalenessSignalNameSchema>;

/**
 * A single staleness signal: a named indicator with a per-signal threshold
 * (in minutes). Per-signal thresholds let one phase mix signals with
 * different sensitivity windows (e.g. lastActivity at 60min, branchActivity
 * at 1440min for daily commits).
 */
export const StalenessSignalSchema = z.object({
  name: StalenessSignalNameSchema,
  thresholdMinutes: z.number().int().positive(),
});

export type StalenessSignal = z.infer<typeof StalenessSignalSchema>;

export const PhaseContractSchema = z.object({
  expectedMaxDwellMinutes: z.number().int().positive(),
  signals: z.array(StalenessSignalSchema).min(1),
  freshnessRequires: z.enum(['all', 'any']),
});

export type PhaseContract = z.infer<typeof PhaseContractSchema>;

/**
 * A phase entry in the topology — staleness is optional. When absent, the
 * pruner falls back to the v2.9 single-signal heuristic and a
 * `phase.contract_missing` event is emitted at load time.
 */
export const PhaseEntrySchema = z.object({
  staleness: PhaseContractSchema.optional(),
});

export type PhaseEntry = z.infer<typeof PhaseEntrySchema>;

export const TopologySchema = z.object({
  phases: z.record(z.string(), PhaseEntrySchema),
});

export type Topology = z.infer<typeof TopologySchema>;
