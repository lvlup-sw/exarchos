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

import type { Capability } from '../agents/capabilities.js';
import type { AgentPosture } from '../agents/spec.js';

/**
 * The trust-boundary contract. Each posture's capability set is documented
 * with the rationale; the table is the single source of truth that the
 * resolver consults.
 */
const RAW_MAP: Readonly<Record<AgentPosture, ReadonlySet<Capability>>> = {
  // Read-only agents (e.g. reviewer): inspect code, no mutation.
  // Filesystem reads only; no shell, no isolation, no FS writes.
  'read-only': new Set<Capability>(['fs:read']),

  // Task-isolated agents (e.g. implementer, fixer, scaffolder running in a
  // worktree): mutate freely inside their own worktree, but the worktree
  // boundary contains the blast radius. Implies fs:read + fs:write +
  // worktree isolation. shell:exec is NOT included — when needed it must
  // come from the runtime handshake explicitly so a posture upgrade alone
  // does not silently grant shell access.
  'task-isolated': new Set<Capability>(['fs:read', 'fs:write', 'isolation:worktree']),

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
