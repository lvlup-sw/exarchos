/**
 * Merges the layered invariant catalogs and clamps each consumer override to the floor of the
 * invariant.
 *
 * The `integrity-class` of an entry sets how far a consumer can tune it. A `substrate` entry is
 * immutable. A consumer can lower an `sdlc` or `authoring` entry to `advisory`, but cannot remove
 * it. A `user` entry has no floor. An explicit `override-floor` in `entry.raw` replaces the default
 * of the class.
 *
 * The user layer cannot use the reserved `INV-*` and `SDLC-*` id namespaces, so a consumer cannot
 * impersonate a built-in invariant.
 */
import type { InvariantEntry } from './invariants-loader.js';
import type { InvariantEntryV3 } from './invariant-schema.js';

/** The resolved override floor of an invariant. */
export type OverrideFloor = 'none' | 'advisory' | 'disable' | 'immutable';

/** Per-invariant override directive (mirrors `InvariantsConfigSchema.overrides`). */
export interface InvariantOverride {
  severity?: 'blocking' | 'advisory' | undefined;
  enabled?: boolean | undefined;
}

/** Result of `applyOverrides`: clamped entries plus human-readable warnings. */
export interface ApplyOverridesResult {
  entries: InvariantEntry[];
  warnings: string[];
}

/**
 * The id prefixes that the user layer cannot use. The built-in dev (`INV-*`) and sdlc (`SDLC-*`)
 * catalogs own them.
 */
const RESERVED_USER_ID_PREFIXES = ['INV-', 'SDLC-'] as const;

/**
 * Thrown by `mergeCatalogs` when a user-layer entry claims an id in a
 * reserved namespace (`INV-*` / `SDLC-*`). Names the offending id so the
 * catalog author can rename it.
 */
export class ReservedNamespaceError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(
      `User catalog entry '${id}' uses a reserved id namespace ` +
        `(${RESERVED_USER_ID_PREFIXES.map((p) => `${p}*`).join(', ')}); ` +
        `rename it — these prefixes are reserved for built-in invariants.`,
    );
    this.name = 'ReservedNamespaceError';
    this.id = id;
  }
}

/**
 * True when `id` uses a prefix reserved for built-in invariants. The effective-catalog resolver
 * uses it to turn reserved user entries into warnings before `mergeCatalogs` can throw.
 */
export function isReservedUserId(id: string): boolean {
  return RESERVED_USER_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Re-tag an entry's integrity-class without mutating the input. */
function tag(
  entry: InvariantEntry,
  integrityClass: NonNullable<InvariantEntryV3['integrity-class']>,
): InvariantEntry {
  return { ...entry, integrityClass };
}

/** Sets the source tier of an entry without changing the input. */
function withTier(
  entry: InvariantEntry,
  tier: NonNullable<InvariantEntry['tier']>,
): InvariantEntry {
  return { ...entry, tier };
}

/**
 * Joins the dev, sdlc and user catalog layers and stamps each entry with its source `tier`. Dev
 * entries keep their integrity-class. Sdlc and user entries get the class of their layer.
 *
 * Only the user tier is subject to the reserved-namespace check. A user entry with an `INV-*` or
 * `SDLC-*` id throws a {@link ReservedNamespaceError}.
 */
export function mergeCatalogs(layers: {
  dev: InvariantEntry[];
  sdlc: InvariantEntry[];
  user: InvariantEntry[];
}): InvariantEntry[] {
  const { dev, sdlc, user } = layers;

  for (const entry of user) {
    if (isReservedUserId(entry.id)) {
      throw new ReservedNamespaceError(entry.id);
    }
  }

  return [
    ...dev.map((e) => withTier(e, 'dev')),
    ...sdlc.map((e) => withTier(tag(e, 'sdlc'), 'sdlc')),
    ...user.map((e) => withTier(tag(e, 'user'), 'user')),
  ];
}

/**
 * Resolves the override floor of an invariant. An explicit `override-floor` of `advisory` or
 * `disable` in `entry.raw` wins. Otherwise the integrity-class sets the floor, and an entry with no
 * class has no floor.
 *
 * `applyOverrides` keeps disabled entries. The effective-catalog resolver uses this floor to drop
 * an entry with `enabled: false` when the floor is `disable` or `none`.
 */
export function resolveFloor(entry: InvariantEntry): OverrideFloor {
  const explicit = entry.raw['override-floor'];
  if (explicit === 'advisory') return 'advisory';
  if (explicit === 'disable') return 'disable';

  switch (entry.integrityClass) {
    case 'substrate':
      return 'immutable';
    case 'sdlc':
    case 'authoring':
      return 'advisory';
    case 'user':
      return 'none';
    default:
      return 'none';
  }
}

/**
 * Sets an entry to `advisory` in every context. `applyOverrides` uses it when an `advisory` floor
 * refuses `enabled: false`. It drops the `by-phase` and `by-workflow` maps, because
 * `resolveSeverity` ranks them above `default`, and a kept map can make the entry blocking again.
 */
function clampSeverityToAdvisory(entry: InvariantEntry): InvariantEntry {
  return {
    ...entry,
    severity: { default: 'advisory' },
  };
}

/**
 * Applies the per-invariant overrides and clamps each one to the floor of the invariant.
 *
 * - A `severity` override replaces the whole severity profile, so it applies in every context. An
 *   `immutable` floor refuses it. An `advisory` floor refuses `blocking`.
 * - `enabled: false` clamps the entry to `advisory` on an `advisory` floor. An `immutable` floor
 *   refuses it. On a `disable` or `none` floor, the entry stays, and the caller filters it out.
 *
 * Each refusal, each clamp, and each override for an absent id adds a warning.
 */
export function applyOverrides(
  merged: InvariantEntry[],
  overrides: Record<string, InvariantOverride>,
): ApplyOverridesResult {
  const warnings: string[] = [];
  const byId = new Map(merged.map((e) => [e.id, e]));

  for (const id of Object.keys(overrides)) {
    if (!byId.has(id)) {
      warnings.push(
        `Override for '${id}' is a no-op: no such invariant is present ` +
          `(no catalog registering it is loaded, or the id is unknown).`,
      );
    }
  }

  const entries = merged.map((entry) => {
    const override = overrides[entry.id];
    if (override === undefined) return entry;

    const floor = resolveFloor(entry);
    let result = entry;

    if (override.severity !== undefined) {
      if (floor === 'immutable') {
        warnings.push(
          `Severity override for '${entry.id}' ignored: integrity-class ` +
            `'substrate' is immutable and not user-tunable.`,
        );
      } else if (override.severity === 'blocking' && floor === 'advisory') {
        warnings.push(
          `Severity override for '${entry.id}' to 'blocking' ignored: ` +
            `floor is 'advisory' (can only lower to advisory, not raise).`,
        );
      } else {
        result = {
          ...result,
          severity: { default: override.severity },
        };
      }
    }

    if (override.enabled === false) {
      if (floor === 'immutable') {
        warnings.push(
          `Disable override for '${entry.id}' ignored: integrity-class ` +
            `'substrate' is immutable and cannot be disabled.`,
        );
      } else if (floor === 'advisory') {
        warnings.push(
          `Disable override for '${entry.id}' clamped to 'advisory': its ` +
            `floor is 'advisory' (sdlc/authoring invariants are never fully ` +
            `removable).`,
        );
        result = clampSeverityToAdvisory(result);
      }
    }

    return result;
  });

  return { entries, warnings };
}
