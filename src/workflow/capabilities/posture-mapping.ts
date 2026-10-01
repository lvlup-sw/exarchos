// The canonical map from `AgentPosture` to a capability set. The capability
// resolver reads it to derive `EffectiveCapabilities`, and the runtime handshake
// adds overrides on top.
//
// Rules for an edit:
//   - Each posture must map to at least one capability.
//   - No two postures can share the same capability set, because a duplicate
//     collapses the three-tier model. The unit test enforces both rules.
//   - Use only the `Capability` enum from `agents/capabilities.ts`.
//
// `freezeCapSet` freezes each set, so no consumer can change the trust boundary
// at runtime.

import type { Capability } from '../../runtime/agents/capabilities.js';
import type { AgentPosture } from '../../runtime/agents/spec.js';
import type { AgentSpecId } from '../../runtime/agents/types.js';

/**
 * The trust-boundary contract, with the reason for each capability set. The
 * resolver reads this table as the single source of truth.
 */
const RAW_MAP: Readonly<Record<AgentPosture, ReadonlySet<Capability>>> = {
  /**
   * Read-only agents, such as the reviewer, inspect code and change nothing.
   * The readonly MCP tier lets them call `exarchos_view` and other read-only
   * actions. The readonly action allowlist in `dispatch/core/dispatch.ts`
   * blocks every mutating action.
   */
  'read-only': new Set<Capability>(['fs:read', 'mcp:exarchos:readonly']),

  /**
   * Task-isolated agents, such as the implementer, fixer, and scaffolder, run
   * in a worktree. They change files freely inside their own worktree, and the
   * worktree boundary contains the blast radius.
   */
  'task-isolated': new Set<Capability>([
    'fs:read',
    'fs:write',
    'shell:exec',
    'isolation:worktree',
    'mcp:exarchos',
  ]),

  /**
   * Shared-mutating agents, such as the orchestrator or a migration runner,
   * change shared state without worktree isolation. Use this posture rarely,
   * because it gets the strictest review.
   */
  'shared-mutating': new Set<Capability>(['fs:read', 'fs:write', 'shell:exec']),
};

function freezeCapSet(set: Set<Capability>): ReadonlySet<Capability> {
  const throwImmutable = (): never => {
    throw new TypeError('POSTURE_CAPABILITY_MAP entry is immutable; mutation is forbidden');
  };
  Object.defineProperty(set, 'add', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'delete', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'clear', { value: throwImmutable, writable: false, configurable: false });
  return Object.freeze(set);
}

/**
 * Frozen posture → capability set map. Direct lookups are O(1).
 */
export const POSTURE_CAPABILITY_MAP: Readonly<Record<AgentPosture, ReadonlySet<Capability>>> =
  Object.freeze({
    'read-only': freezeCapSet(new Set(RAW_MAP['read-only'])),
    'task-isolated': freezeCapSet(new Set(RAW_MAP['task-isolated'])),
    'shared-mutating': freezeCapSet(new Set(RAW_MAP['shared-mutating'])),
  });

/**
 * Enumerate the canonical postures. Use this rather than `Object.keys` so
 * the order is stable (handy in property tests).
 */
export function listPostures(): readonly AgentPosture[] {
  return ['read-only', 'task-isolated', 'shared-mutating'];
}

/**
 * Resolve a posture to its capability set. Returns the frozen reference
 * directly — callers must not mutate it.
 */
export function capabilitiesForPosture(posture: AgentPosture): ReadonlySet<Capability> {
  return POSTURE_CAPABILITY_MAP[posture];
}

/**
 * Per-agent capability overlay for a capability tied to the role of one agent,
 * not to its trust tier. `session:resume` belongs to the implementer only. The
 * fixer and scaffolder share its posture but not the resumable-session flow.
 * When a capability fits a trust tier, extend the posture table instead. A
 * missing key means no overlay.
 */
const PER_AGENT_OVERLAY: Readonly<Partial<Record<AgentSpecId, ReadonlySet<Capability>>>> = Object.freeze({
  implementer: freezeCapSet(new Set<Capability>(['session:resume'])),
});

/**
 * Resolve the full capability set for an agent from its posture and id. It adds
 * the per-agent overlay to the trust-tier set of the posture. Adapters call it
 * at render time and do not read `spec.capabilities`. The result is a frozen
 * set whose mutators throw.
 */
export function resolveCapabilities(
  posture: AgentPosture,
  agentId: AgentSpecId,
): ReadonlySet<Capability> {
  const out = new Set<Capability>(POSTURE_CAPABILITY_MAP[posture]);
  const overlay = PER_AGENT_OVERLAY[agentId];
  if (overlay) {
    for (const cap of overlay) out.add(cap);
  }
  return freezeCapSet(out);
}
