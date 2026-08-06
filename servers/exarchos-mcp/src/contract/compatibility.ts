// ─── Version negotiation, directional migration, compatibility (P03-02) ──────
//
// PROGRAM-03, API-006. The compatibility half of the closed contract:
//
//   • version negotiation — explicit, testable selection of a shared version
//     from a client's requested range and the server's supported set
//     (old-client/new-server, new-client/old-server, unsupported-range).
//   • directional migration — a migration that DECLARES its direction
//     (`forward` = upcast an older payload to a newer version; `backward` =
//     downcast a newer payload to an older one) rather than assuming, plus an
//     explicit `incompatible` outcome for cross-major changes.
//   • compatibility classes — the semver-relationship classification and the
//     change-class taxonomy (authorization/effect/safety/… changes) that force
//     explicit classification and mixed-version refusal/migration.
//
// Reuses `lib/plugin-compat.ts`'s `compareSemver` — the single semver
// precedence authority — rather than forking version comparison. Pure;
// digested as part of the frozen `contract-surface` authority.
// ────────────────────────────────────────────────────────────────────────────

import { compareSemver } from '../lib/plugin-compat.js';
import { assertNever, contractError, type ContractError } from './error-families.js';

/**
 * The version of the P03-02 closed contract surface (envelope + error families
 * + request context + compatibility). Bumped when the contract surface changes
 * meaning; also the `version` of the frozen `contract-surface` authority pin.
 */
export const CONTRACT_SURFACE_VERSION = '1.0.0';

// ─── Semver segment helpers ─────────────────────────────────────────────────

function coreSegments(version: string): readonly [number, number, number] {
  const core = version.replace(/^v/, '').split('+')[0]?.split('-')[0] ?? '';
  const parts = core.split('.');
  const toInt = (s: string | undefined): number => {
    if (s === undefined || s === '') return 0;
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return [toInt(parts[0]), toInt(parts[1]), toInt(parts[2])];
}

/** The major segment of a semver-ish version (`v2.3.1` → 2). */
export function majorVersion(version: string): number {
  return coreSegments(version)[0];
}

/** The minor segment of a semver-ish version (`v2.3.1` → 3). */
export function minorVersion(version: string): number {
  return coreSegments(version)[1];
}

// ─── Version negotiation ────────────────────────────────────────────────────

/** A client's acceptable version window (inclusive). */
export interface VersionRange {
  readonly min: string;
  readonly max: string;
}

export type NegotiationOutcome =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: 'unsupported-range'; readonly error: ContractError };

/**
 * Negotiate the highest server-supported version that falls within the client's
 * requested `[min, max]` window. Explicit and total:
 *
 *   - overlap exists → `{ ok:true, version }` (the newest shared version).
 *   - no overlap     → `{ ok:false, reason:'unsupported-range', error }`
 *     (`UNSUPPORTED_PROTOCOL_VERSION`, exit 1) — never a silent fallback.
 *
 * Works symmetrically for old-client/new-server and new-client/old-server: the
 * outcome depends only on window overlap, not on which side is newer.
 */
export function negotiateVersion(
  clientRange: VersionRange,
  serverSupported: readonly string[],
): NegotiationOutcome {
  const inRange = serverSupported.filter(
    (v) => compareSemver(v, clientRange.min) >= 0 && compareSemver(v, clientRange.max) <= 0,
  );
  if (inRange.length === 0) {
    return {
      ok: false,
      reason: 'unsupported-range',
      error: contractError(
        'protocol',
        `no supported version in the client range [${clientRange.min}, ${clientRange.max}]; ` +
          `server supports {${[...serverSupported].join(', ')}}`,
        {
          code: 'UNSUPPORTED_PROTOCOL_VERSION',
          detail: { clientRange, serverSupported: [...serverSupported] },
        },
      ),
    };
  }
  const best = inRange.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
  return { ok: true, version: best };
}

// ─── Directional migration ──────────────────────────────────────────────────

/**
 * The direction a payload is migrated.
 *
 * - `forward`  — UPCAST an older payload to a newer version (new server reading
 *   an old client's request).
 * - `backward` — DOWNCAST a newer payload to an older version (new server
 *   answering an old client).
 */
export type MigrationDirection = 'forward' | 'backward';

export type MigrationPlan =
  | { readonly kind: 'identity'; readonly from: string; readonly to: string }
  | {
      readonly kind: 'migrate';
      readonly direction: MigrationDirection;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: 'incompatible';
      readonly direction: MigrationDirection;
      readonly from: string;
      readonly to: string;
      readonly error: ContractError;
    };

/**
 * Plan the migration from `from` to `to`, DECLARING direction rather than
 * assuming it:
 *
 *   - equal versions          → `identity` (no migration).
 *   - same major, different    → `migrate` with `direction` derived from semver
 *     precedence (older→newer = `forward`, newer→older = `backward`).
 *   - different major          → `incompatible` (`VERSION_INCOMPATIBLE`, exit 1):
 *     a breaking boundary requires explicit conflict/migration, never an
 *     invalid same-shape replay.
 */
export function planMigration(from: string, to: string): MigrationPlan {
  const cmp = compareSemver(from, to);
  if (cmp === 0) return { kind: 'identity', from, to };
  const direction: MigrationDirection = cmp < 0 ? 'forward' : 'backward';
  if (majorVersion(from) !== majorVersion(to)) {
    return {
      kind: 'incompatible',
      direction,
      from,
      to,
      error: contractError(
        'protocol',
        `cannot migrate across a major-version boundary (${from} → ${to}); ` +
          'an explicit upcast/downcast or a typed conflict is required',
        { code: 'VERSION_INCOMPATIBLE', detail: { from, to, direction } },
      ),
    };
  }
  return { kind: 'migrate', direction, from, to };
}

// ─── Compatibility classes ──────────────────────────────────────────────────

/**
 * The compatibility relationship between two contract versions.
 *
 * - `compatible` — identical versions.
 * - `additive`   — same major, different minor (new optional surface).
 * - `behavioral` — same major/minor, different patch (behavior fix, shape stable).
 * - `breaking`   — different major (requires migration/refusal).
 */
export type CompatibilityClass = 'compatible' | 'additive' | 'behavioral' | 'breaking';

export function classifyVersionChange(from: string, to: string): CompatibilityClass {
  if (compareSemver(from, to) === 0) return 'compatible';
  if (majorVersion(from) !== majorVersion(to)) return 'breaking';
  if (minorVersion(from) !== minorVersion(to)) return 'additive';
  return 'behavioral';
}

// ─── Change-class taxonomy ──────────────────────────────────────────────────

/**
 * The kinds of contract change that must trigger explicit compatibility
 * classification (API-006). Security-sensitive classes (authorization, effect,
 * safety, idempotency) never downgrade to a silent compatible change.
 */
export const CONTRACT_CHANGE_CLASSES = [
  'schema',
  'authorization',
  'effect',
  'safety',
  'idempotency',
  'dry-run',
  'task',
  'cancellation',
  'evidence',
  'economy',
  'cache',
  'presentation',
] as const;

export type ChangeClass = (typeof CONTRACT_CHANGE_CLASSES)[number];

/** How closely a change class must be reviewed before shipping. */
export type ChangeSeverity = 'presentation-only' | 'compat-review' | 'security-sensitive';

/**
 * Total severity classification of a change class. The `default` arm's
 * `assertNever(cls)` is the mandated `never` exhaustiveness proof over the
 * {@link ChangeClass} union — adding a change class without a severity fails the
 * build, so a new policy dimension can never silently ship unclassified.
 */
export function changeClassSeverity(cls: ChangeClass): ChangeSeverity {
  switch (cls) {
    case 'authorization':
    case 'effect':
    case 'safety':
    case 'idempotency':
      return 'security-sensitive';
    case 'schema':
    case 'task':
    case 'cancellation':
    case 'evidence':
    case 'economy':
    case 'cache':
    case 'dry-run':
      return 'compat-review';
    case 'presentation':
      return 'presentation-only';
    default:
      return assertNever(cls, 'ChangeClass');
  }
}

/**
 * Whether a change of the given class at the given compatibility relationship
 * must REFUSE a mixed-version peer rather than silently interoperate. Security-
 * sensitive changes refuse on anything but an identical version; other classes
 * refuse only on a breaking (major) change.
 */
export function requiresMixedVersionRefusal(cls: ChangeClass, change: CompatibilityClass): boolean {
  if (change === 'compatible') return false;
  if (changeClassSeverity(cls) === 'security-sensitive') return true;
  return change === 'breaking';
}
