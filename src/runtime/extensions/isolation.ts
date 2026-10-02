/**
 * The declared isolation policy of an extension. The manifest states the
 * capabilities that the extension can use, and its filesystem and network
 * reach. Admission enforces two fail-closed rules:
 *   1. The requested capabilities are a subset of the host posture capabilities
 *      in `workflow/capabilities/posture-mapping.ts`. Thus an extension cannot
 *      widen its trust tier. Extensions use the same posture model as agents.
 *   2. Filesystem reach needs the `fs:read` capability.
 */

import { z } from 'zod';
import { Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';
import { capabilitiesForPosture } from '../../workflow/capabilities/posture-mapping.js';

/** The declared reach of an extension. */
export const IsolationPolicySchema = z
  .object({
    /** Capabilities the extension is permitted to use. Must ⊆ host posture. */
    allowedCapabilities: z.array(Capability).readonly(),
    /** Declared filesystem reach. `worktree` requires `fs:read`. */
    filesystem: z.enum(['none', 'worktree']),
    /** Declared network reach. */
    network: z.boolean(),
  })
  .strict()
  .readonly();
export type IsolationPolicy = z.infer<typeof IsolationPolicySchema>;

/** Outcome of an isolation check. */
export type IsolationEvaluation =
  | { readonly contained: true }
  | { readonly contained: false; readonly detail: string };

/**
 * Prove `policy` stays inside the host `posture`'s trust boundary. Fails closed
 * if the extension requests any capability the posture does not grant, or if
 * its declared reach is inconsistent with its declared capabilities.
 */
export function evaluateIsolation(
  policy: IsolationPolicy,
  posture: AgentPosture,
): IsolationEvaluation {
  const hostCapabilities = capabilitiesForPosture(posture);

  const escalations = policy.allowedCapabilities.filter(
    (capability) => !hostCapabilities.has(capability),
  );
  if (escalations.length > 0) {
    return {
      contained: false,
      detail: `extension requests capabilities outside host posture ${posture}: ${escalations.join(', ')}`,
    };
  }

  if (policy.filesystem === 'worktree' && !policy.allowedCapabilities.includes('fs:read')) {
    return {
      contained: false,
      detail: 'filesystem reach "worktree" declared without fs:read capability',
    };
  }

  return { contained: true };
}
