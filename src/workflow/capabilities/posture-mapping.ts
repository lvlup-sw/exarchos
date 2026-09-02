// ─── Posture → capability set table (#1259 DR-6) ──────────────────────────
//
// Canonical mapping from `AgentPosture` to a capability set. The capability
// resolver consumes this table to derive `EffectiveCapabilities` from a
// spec's posture; the runtime handshake unions/overrides on top.
//
// Editing rules:
//   - Each posture must map to ≥1 capability (DIM-2 trust boundary).
//   - No two postures may share an identical capability set — a duplicate
//     silently collapses the three-tier model. The unit test enforces both.
//   - Use vocabulary from `agents/capabilities.ts` (the Zod-validated
//     `Capability` enum). Do not introduce ad-hoc capability strings here.
//
// The table is wrapped in `freezeMap` so downstream consumers cannot
// mutate the trust boundary at runtime (matches the freeze posture in
// `agents/capabilities.ts` and `resolver.ts`).

import type { Capability } from '../../runtime/agents/capabilities.js';
import type { AgentPosture } from '../../runtime/agents/spec.js';
import type { AgentSpecId } from '../../runtime/agents/types.js';

/**
 * The trust-boundary contract. Each posture's capability set is documented
 * with the rationale; the table is the single source of truth that the
 * resolver consults.
 */
const RAW_MAP: Readonly<Record<AgentPosture, ReadonlySet<Capability>>> = {
  // Read-only agents (e.g. reviewer): inspect code, no mutation. Implies
  // fs:read plus the readonly tier of the Exarchos MCP surface so the
  // reviewer can consult `exarchos_view` and other read-only composite
  // actions; mutating actions remain blocked at the dispatch layer
  // (`dispatch/core/dispatch.ts` readonly action allowlist).
  //
  // Updated in #1333: `mcp:exarchos:readonly` joined the read-only trust
  // tier when the resolver became the single source of truth for capability
  // derivation. Reviewer is the only `read-only` agent today, so this is a
  // tier-level implication rather than a per-agent overlay.
  'read-only': new Set<Capability>(['fs:read', 'mcp:exarchos:readonly']),

  // Task-isolated agents (e.g. implementer, fixer, scaffolder running in a
  // worktree): mutate freely inside their own worktree, but the worktree
  // boundary contains the blast radius. Implies fs:read + fs:write +
  // shell:exec + isolation:worktree + mcp:exarchos.
  //
  // Updated in #1333: `shell:exec` and `mcp:exarchos` joined this tier when
  // the resolver became the single source of truth and the legacy
  // `capabilities[]` array literals were dropped from `agents/definitions.ts`.
  // The earlier "shell:exec must come from the handshake" stance was
  // load-bearing for the v2.10 migration window only — every agent that
  // actually used this posture (implementer, fixer, scaffolder) declared
  // both capabilities in its legacy array, so promoting them to the trust
  // tier is consistent with the audited-as-shipped surface.
  'task-isolated': new Set<Capability>([
    'fs:read',
    'fs:write',
    'shell:exec',
    'isolation:worktree',
    'mcp:exarchos',
  ]),

  // Shared-mutating agents (e.g. orchestrator, migration runner): mutate
  // shared state (events, repo) without worktree isolation. Implies
  // fs:read + fs:write + shell:exec. Use sparingly — the analysis-of-
  // alternatives in DR-6 calls out this posture as the strictest review
  // tier (Approach C class).
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

// ─── #1333 / DR-6: posture + agentId → capability set ──────────────────────
//
// `resolveCapabilities` is the single source of truth at adapter render time
// after the v2.10-preview.1 substrate cut. It collapses two previous paths
// (`spec.capabilities` array literal + posture resolver) into one. Adapters
// call this rather than reading `spec.capabilities`.
//
// The `agentId` parameter exists so a posture that is (legitimately) shared
// across agents can carry a small per-id overlay for capabilities tied to
// one specific agent's role rather than its trust tier. Today this is
// `session:resume` on the implementer only — fixer/scaffolder share its
// `task-isolated` posture but do not participate in the resumable-session
// flow, so it would be wrong to promote `session:resume` into the posture
// table itself.
//
// This is NOT a synthetic-posture or `additionalCapabilities` escape hatch
// (#1333 design hard-bars both). The agentId-keyed overlay is bounded,
// audited inline, and exists only for capabilities tied to a specific
// agent's role rather than its trust tier. The list of overlays is
// expected to stay short — when a row would have to be added for a
// capability that fits a trust tier, prefer extending the posture table.

/**
 * Per-agent capability overlay. Add an entry only when the capability is
 * genuinely role-specific (not a trust-tier implication). Empty overlays
 * are omitted; the resolver treats a missing key as "no overlay."
 */
const PER_AGENT_OVERLAY: Readonly<Partial<Record<AgentSpecId, ReadonlySet<Capability>>>> = Object.freeze({
  implementer: freezeCapSet(new Set<Capability>(['session:resume'])),
});

/**
 * Resolve the full capability set for an agent given its posture and id.
 * Layers the per-agent overlay on top of the posture-derived trust-tier
 * set. Returns a frozen set whose mutators throw.
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
