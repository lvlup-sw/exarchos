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
 * Reads `SNAPSHOT_MAX_RECORDS` and parses it as a positive integer. Any
 * missing, non-numeric, zero, or negative value falls back to
 * {@link DEFAULT_SNAPSHOT_MAX_RECORDS} (500) so misconfiguration never
 * disables the cap or produces a pathological value — an unparseable env var
 * is treated as "unset", never as "no limit".
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
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  return parsed;
}
