/**
 * Phase contract types and Zod schema. The `staleness` block of a phase in
 * `topology.yaml` tells the pruner how to judge workflow staleness for that
 * phase. The pruner reads typed `PhaseContract` objects through
 * `topology/loader.ts`, and the load rejects a malformed contract.
 *
 * `signals` are named indicators that the scorer reduces. `freshnessRequires`
 * selects the reduction:
 *   - `'all'`: fresh when every declared signal is fresh
 *   - `'any'`: fresh when at least one declared signal is fresh
 */
import { z } from 'zod';

/**
 * Known staleness-signal names, the same signals that
 * `prune-stale-workflows.ts` derives:
 *
 *   - `lastActivity`     ← `_checkpoint.lastActivityTimestamp`
 *   - `phaseTransition`  ← latest `workflow.transition` event timestamp
 *   - `branchActivity`   ← latest commit on the workflow's tracked branch
 *
 * A new signal name needs a change here and in the scorer in
 * `pruner/score.ts`. The load rejects an unknown name.
 */
export const StalenessSignalNames = [
  'lastActivity',
  'phaseTransition',
  'branchActivity',
] as const;

export const StalenessSignalNameSchema = z.enum(StalenessSignalNames);

export type StalenessSignalName = z.infer<typeof StalenessSignalNameSchema>;

/**
 * A single staleness signal: a named indicator with its own threshold in
 * minutes. Thus one phase can mix windows, such as `lastActivity` at 60 and
 * `branchActivity` at 1440.
 *
 * The topology object schemas use `.strict()`. Thus a key typo in
 * `topology.yaml` fails the load with an error that names the key, and Zod
 * does not strip it.
 */
export const StalenessSignalSchema = z
  .object({
    name: StalenessSignalNameSchema,
    thresholdMinutes: z.number().int().positive(),
  })
  .strict();

export type StalenessSignal = z.infer<typeof StalenessSignalSchema>;

/**
 * The staleness contract of one phase. Duplicate signal names fail the load,
 * because the scorer in `pruner/score.ts` keys verdicts by `signal.name`. A
 * duplicate hides the threshold of the earlier declaration.
 */
export const PhaseContractSchema = z
  .object({
    expectedMaxDwellMinutes: z.number().int().positive(),
    signals: z.array(StalenessSignalSchema).min(1),
    freshnessRequires: z.enum(['all', 'any']),
  })
  .strict()
  .superRefine(({ signals }, ctx) => {
    const seen = new Set<StalenessSignalName>();
    signals.forEach((signal, index) => {
      if (seen.has(signal.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['signals', index, 'name'],
          message: `Duplicate staleness signal name: ${signal.name}`,
        });
        return;
      }
      seen.add(signal.name);
    });
  });

export type PhaseContract = z.infer<typeof PhaseContractSchema>;

/**
 * A phase entry in the topology. The schema accepts a missing `staleness`, and
 * `loadTopology` then rejects the topology with an error that names the phase.
 */
export const PhaseEntrySchema = z
  .object({
    staleness: PhaseContractSchema.optional(),
  })
  .strict();

export type PhaseEntry = z.infer<typeof PhaseEntrySchema>;

export const TopologySchema = z
  .object({
    phases: z.record(z.string(), PhaseEntrySchema),
  })
  .strict();

export type Topology = z.infer<typeof TopologySchema>;
