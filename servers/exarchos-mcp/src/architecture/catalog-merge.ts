/**
 * Layered invariant-catalog merge + per-invariant override-floor clamp
 * (issue: DR-6, tasks T-08 / T-09).
 *
 * ## DR-6 — per-catalog-relative override authority (NOT a global ladder)
 *
 * An invariant's `integrity-class` determines how far a consumer may tune it.
 * Authority is relative to the catalog that owns the entry, not a global
 * severity ladder:
 *
 *   - `substrate`  → immutable. Not user-tunable at all. (Exarchos's own
 *                    substrate invariants are devCatalog-gated and never
 *                    reach a consumer, so this is self-protection within a
 *                    catalog's own audience.)
 *   - `sdlc` /
 *     `authoring`  → tunable down to `advisory` but never fully removable.
 *                    Floor = `advisory`.
 *   - `user`       → fully owned by the consumer. No floor.
 *
 * An entry MAY carry an explicit `override-floor: advisory | disable` field
 * (it rides in the loader's raw passthrough, so we read it from `entry.raw`).
 * When present it overrides the integrity-class-derived default.
 *
 * ## Layering (T-08)
 *
 * `mergeCatalogs` concatenates three layers (dev, sdlc, user), tagging each
 * entry with its layer's `integrity-class`:
 *
 *   - dev   → keeps whatever class it already carries (substrate/authoring);
 *   - sdlc  → tagged `sdlc`;
 *   - user  → tagged `user`.
 *
 * The reserved `INV-*` and `SDLC-*` id namespaces may NOT appear in the user
 * layer — a consumer cannot impersonate a built-in invariant.
 */
import type { InvariantEntry } from './invariants-loader.js';
import type { InvariantEntryV3 } from './invariant-schema.js';

/** Resolved override floor for an invariant (DR-6). */
export type OverrideFloor = 'none' | 'advisory' | 'disable' | 'immutable';

/** Per-invariant override directive (mirrors `InvariantsConfigSchema.overrides`). */
export interface InvariantOverride {
  severity?: 'blocking' | 'advisory';
  enabled?: boolean;
}

/** Result of `applyOverrides`: clamped entries plus human-readable warnings. */
export interface ApplyOverridesResult {
  entries: InvariantEntry[];
  warnings: string[];
}

/**
 * Reserved id-namespace prefixes that the user layer may not occupy. These
 * belong to the built-in dev (`INV-*`) and sdlc (`SDLC-*`) catalogs.
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

function isReservedUserId(id: string): boolean {
  return RESERVED_USER_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Re-tag an entry's integrity-class without mutating the input. */
function tag(
  entry: InvariantEntry,
  integrityClass: NonNullable<InvariantEntryV3['integrity-class']>,
): InvariantEntry {
  return { ...entry, integrityClass };
}

/**
 * T-08 (DR-6): concatenate the dev / sdlc / user catalog layers, tagging each
 * entry with its layer's integrity-class. The dev layer keeps whatever class
 * it already carries (substrate/authoring set upstream); sdlc and user layers
 * are tagged from their layer name.
 *
 * Rejects any reserved-namespace id (`INV-*` / `SDLC-*`) in the user layer
 * with a `ReservedNamespaceError`.
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
    // Dev layer entries keep their existing class (substrate/authoring).
    ...dev,
    ...sdlc.map((e) => tag(e, 'sdlc')),
    ...user.map((e) => tag(e, 'user')),
  ];
}

/**
 * Resolve an invariant's override floor (DR-6). An explicit `override-floor`
 * field on the entry's raw passthrough wins; otherwise the floor is derived
 * from the entry's integrity-class.
 */
function resolveFloor(entry: InvariantEntry): OverrideFloor {
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
      // No integrity-class declared ⇒ treat as fully tunable (no floor).
      return 'none';
  }
}

/** Build an `advisory`-default severity, preserving any existing per-context map. */
function clampSeverityToAdvisory(entry: InvariantEntry): InvariantEntry {
  return {
    ...entry,
    severity: { ...entry.severity, default: 'advisory' },
  };
}

/**
 * T-09 (DR-6): apply per-invariant overrides, clamping to each invariant's
 * resolved floor.
 *
 *   - `severity` override: applied when the floor permits it. An `immutable`
 *     (substrate) floor rejects the override with a warning; an `advisory`
 *     floor permits lowering to `advisory` but rejects raising to `blocking`.
 *   - `enabled:false`: honored when the floor is `disable` or `none` (`user`);
 *     CLAMPED to `advisory` (entry stays present) with a warning when the
 *     floor is `advisory`; rejected with a warning when the floor is
 *     `immutable` (substrate).
 *
 * Overrides naming an id that is not present in `merged` are a no-op and emit
 * a warning (e.g. a substrate id whose dev layer was gated out — proven at the
 * merge level, not here).
 */
export function applyOverrides(
  merged: InvariantEntry[],
  overrides: Record<string, InvariantOverride>,
): ApplyOverridesResult {
  const warnings: string[] = [];
  const byId = new Map(merged.map((e) => [e.id, e]));

  // No-op warning for overrides naming an absent invariant.
  for (const id of Object.keys(overrides)) {
    if (!byId.has(id)) {
      warnings.push(
        `Override for '${id}' is a no-op: no such invariant is present ` +
          `(it may be devCatalog-gated or simply unknown).`,
      );
    }
  }

  const entries = merged.map((entry) => {
    const override = overrides[entry.id];
    if (override === undefined) return entry;

    const floor = resolveFloor(entry);
    let result = entry;

    // ── severity override ──
    if (override.severity !== undefined) {
      if (floor === 'immutable') {
        warnings.push(
          `Severity override for '${entry.id}' ignored: integrity-class ` +
            `'substrate' is immutable and not user-tunable.`,
        );
      } else if (override.severity === 'blocking' && floor === 'advisory') {
        // advisory floor permits lowering, not raising back to blocking.
        warnings.push(
          `Severity override for '${entry.id}' to 'blocking' ignored: ` +
            `floor is 'advisory' (can only lower to advisory, not raise).`,
        );
      } else {
        result = {
          ...result,
          severity: { ...result.severity, default: override.severity },
        };
      }
    }

    // ── enabled:false override ──
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
      // floor === 'disable' | 'none': caller may honor the disable downstream
      // by filtering on `override.enabled === false`. We leave the entry in
      // place here; the override record carries the intent.
    }

    return result;
  });

  return { entries, warnings };
}
