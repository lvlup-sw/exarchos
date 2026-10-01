/**
 * The compatibility half of the closed contract. It holds three parts:
 *   - version negotiation: select a shared version from the client range and the server set.
 *   - directional migration: a plan that changes the version declares `forward` or `backward`. A
 *     plan across a major boundary is `incompatible`.
 *   - compatibility classes: classify a semver change and a contract change class.
 *
 * Version comparison uses `compareSemver` from `runtime/lib/plugin-compat.ts`. The module is pure.
 * The `contract-surface` authority digests the change classes and their severities, so a change to
 * them trips the authority freeze.
 */

import { compareSemver } from '../runtime/lib/plugin-compat.js';
import { assertNever, contractError, type ContractError } from './error-families.js';

/**
 * The version of the closed contract surface: envelope, error families, request context, and
 * compatibility. Increase it when the surface changes meaning. It is also the `version` of the
 * frozen `contract-surface` authority pin.
 */
export const CONTRACT_SURFACE_VERSION = '1.0.0';

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

/** A client's acceptable version window (inclusive). */
export interface VersionRange {
  readonly min: string;
  readonly max: string;
}

export type NegotiationOutcome =
  | { readonly ok: true; readonly version: string }
  | { readonly ok: false; readonly reason: 'unsupported-range'; readonly error: ContractError };

/**
 * Select the highest server version in the client `[min, max]` window. With no overlap, it returns
 * `unsupported-range` with `UNSUPPORTED_PROTOCOL_VERSION` and does not fall back. The result depends
 * only on the overlap, not on which side is newer.
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

/**
 * The direction of a payload migration. `forward` upcasts an older payload to a newer version.
 * `backward` downcasts a newer payload to an older version.
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
 * Plan the migration from `from` to `to`. Equal versions give `identity`. The same major gives
 * `migrate`, with the direction from semver precedence. A different major gives `incompatible` with
 * `VERSION_INCOMPATIBLE`.
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

/**
 * The compatibility relationship between two contract versions. `compatible` is identical,
 * `additive` is a different minor, `behavioral` is a different patch or prerelease, and `breaking`
 * is a different major.
 */
export type CompatibilityClass = 'compatible' | 'additive' | 'behavioral' | 'breaking';

export function classifyVersionChange(from: string, to: string): CompatibilityClass {
  if (compareSemver(from, to) === 0) return 'compatible';
  if (majorVersion(from) !== majorVersion(to)) return 'breaking';
  if (minorVersion(from) !== minorVersion(to)) return 'additive';
  return 'behavioral';
}

/**
 * The kinds of contract change that need an explicit compatibility class. The security-sensitive
 * classes are authorization, effect, safety, and idempotency.
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
 * The severity of a change class. The `assertNever` arm makes the switch exhaustive, so a new
 * change class without a severity fails the build.
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
 * Whether a change must refuse a mixed-version peer. A security-sensitive change refuses on any
 * version difference. Other classes refuse only on a breaking change.
 */
export function requiresMixedVersionRefusal(cls: ChangeClass, change: CompatibilityClass): boolean {
  if (change === 'compatible') return false;
  if (changeClassSeverity(cls) === 'security-sensitive') return true;
  return change === 'breaking';
}
