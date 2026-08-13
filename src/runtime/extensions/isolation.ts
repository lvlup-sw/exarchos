// ─── Extension isolation policy (P03-08) ──────────────────────────────────
//
// Isolation is a declared, typed, testable policy — not ambient trust. The
// manifest states, up front, exactly which capabilities the extension may
// reach and what filesystem/network posture it assumes. Admission enforces two
// invariants, both fail-closed:
//   1. The requested capabilities are a SUBSET of the host posture's capability
//      set (the canonical trust-boundary table in `capabilities/posture-
//      mapping.ts`). An extension can never widen the trust tier it runs under.
//   2. The declared reach is internally consistent — declaring filesystem reach
//      without the corresponding `fs:read` capability is a malformed,
//      over-reaching policy.
// This reuses the existing posture→capability model rather than inventing a
// parallel one, so extensions ride inside the same three-tier trust boundary as
// agents instead of bypassing it.

import { z } from 'zod';
import { Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';
import { capabilitiesForPosture } from '../capabilities/posture-mapping.js';

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
