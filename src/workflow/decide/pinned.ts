/**
 * Reads the parts of a definition and of a project config that a decide call needs.
 *
 * A capsule pins the definition of its workflow, and an earlier compiler pinned the kernel only. So a pinned
 * definition can hold no extension.
 *
 * The transition options come from the project config. The transition handler and the settle commit read
 * the same options, so both compute the guard config of the fold in the same way.
 */

import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { GuardConfigOptions } from '../../projections/guard-input/config.js';
import type { CheckpointEnforcementConfig } from '../checkpoint.js';
import { parseExtension, type ExarchosExtension } from '../definitions/extension.js';

/**
 * Returns the parsed extension of a pinned definition. A kernel-only definition and an extension that does
 * not parse give `undefined`.
 */
export function pinnedExtensionOf(definition: unknown): ExarchosExtension | undefined {
  const parsed = parseExtension(definition);
  return parsed.ok ? parsed.extension : undefined;
}

/** The options of a transition: the guard config, the skipped phases and the checkpoint gate. */
export interface TransitionOptions extends GuardConfigOptions {
  readonly skipPhases?: readonly string[];
  readonly checkpoint?: CheckpointEnforcementConfig;
}

/**
 * Returns the transition options of a project config. A config value goes into the options only when its
 * rule holds. A NoCoverage budget that is negative or not an integer becomes the strict default of 0. The
 * budget goes in only when a mutation enforcement mode resolves. No config, or a config that sets no option,
 * gives `undefined`.
 */
export function transitionOptionsOf(projectConfig: ResolvedProjectConfig | undefined): TransitionOptions | undefined {
  const skipPhases = projectConfig?.workflow.skipPhases;
  const requiredReviews = projectConfig?.workflow.requiredReviews;
  const checkpoint: CheckpointEnforcementConfig | undefined = projectConfig?.checkpoint;
  const maxPlanRevisions = projectConfig?.workflow.maxPlanRevisions;
  const mutationEnforcement = projectConfig?.review.mutationEnforcement;
  const mutationParams = projectConfig?.review.gates['mutation-adequacy']?.params;
  const mutationThreshold = mutationParams?.threshold;
  const maxNoCoverageRaw = mutationParams?.maxNoCoverage;
  const maxNoCoverage =
    typeof maxNoCoverageRaw === 'number' && Number.isInteger(maxNoCoverageRaw) && maxNoCoverageRaw >= 0
      ? maxNoCoverageRaw
      : 0;
  const options: TransitionOptions = {
    ...(skipPhases !== undefined && skipPhases.length > 0 ? { skipPhases } : {}),
    ...(requiredReviews !== undefined && requiredReviews.length > 0 ? { requiredReviews } : {}),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(typeof maxPlanRevisions === 'number' ? { maxPlanRevisions } : {}),
    ...(mutationEnforcement !== undefined ? { mutationEnforcement, maxNoCoverage } : {}),
    ...(typeof mutationThreshold === 'number' ? { mutationThreshold } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}
