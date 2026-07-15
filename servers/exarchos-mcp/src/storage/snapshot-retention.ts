/**
 * Snapshot retention config — neutral module shared by storage and projections.
 *
 * Both storage backends (SQLite, in-memory) and the projections wrapper need
 * the same per-coordinate row cap (DR-18) to enforce snapshot eviction. Prior
 * to #1346 this constant lived in `projections/store.ts` and was imported by
 * the storage backends, which inverted the intended layer boundary (storage
 * is below projections; storage should not know about projection adapter
 * code). Hoisting the constant and the env resolver into this neutral
 * `storage/`-adjacent module restores the layering: both layers depend on
 * shared config, not on each other.
 *
 * Scope: cap value only. The WARN-on-prune log emission stays at the
 * projections wrapper boundary so the observable surface for snapshot-store
 * pruning is unchanged.
 */

/** Default per-coordinate snapshot row cap when `SNAPSHOT_MAX_RECORDS` is unset or invalid. */
export const DEFAULT_SNAPSHOT_MAX_RECORDS = 500;

/**
 * Resolve the per-coordinate snapshot row cap from environment configuration.
 *
 * Reads `SNAPSHOT_MAX_RECORDS` and accepts it only when the WHOLE value is a
 * positive, safe integer (`/^\d+$/`). Anything else — missing, empty, signed,
 * fractional, digit-prefixed (`"10junk"`), non-numeric, zero, or beyond
 * `Number.MAX_SAFE_INTEGER` — falls back to
 * {@link DEFAULT_SNAPSHOT_MAX_RECORDS} (500). So misconfiguration never
 * disables the cap or produces a pathological value: an unparseable env var is
 * treated as "unset", never as "no limit". The whole-string and safe-integer
 * checks are what make that sentence true rather than aspirational — see the
 * parser below for the prefix-parse cases that used to slip through.
 *
 * This total-fallback pattern was shared with `projections/cadence.ts`'s
 * `resolveCadence`, which was retired alongside the global projection scope;
 * this resolver is now its sole surviving instance.
 *
 * @param env - Environment object to read from. Defaults to `process.env`
 *   so callers usually invoke with no args; explicit passthrough enables
 *   pure testing without mutating process state.
 */
export function resolveMaxRecords(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SNAPSHOT_MAX_RECORDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  // Require the WHOLE string to be digits. `Number.parseInt` is a prefix parser:
  // it happily reads "10junk" as 10 and "1.5" as 1, so it cannot distinguish a
  // valid setting from a typo'd one. Those two only tighten the cap, but the
  // same laxness has a genuinely unsafe case — "999999999999999999999" parses to
  // 1e21, which is finite and positive and therefore sailed through the old
  // guard as a cap of one sextillion, i.e. exactly the "no limit" the contract
  // above promises is unreachable.
  if (!/^\d+$/.test(raw)) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  const parsed = Number.parseInt(raw, 10);
  // Beyond the safe-integer range the value is no longer an exact integer, so it
  // is not a cap anyone authored — treat it as unset like any other unparseable
  // input rather than as an effectively-infinite limit.
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  return parsed;
}
