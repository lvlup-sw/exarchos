/**
 * Snapshot retention config, shared by storage and projections.
 *
 * Both storage backends and the projections wrapper use the same per-coordinate
 * row cap. This neutral module holds it, so storage does not import projection
 * code. The WARN log on a prune stays in the projections wrapper.
 */

/** Default per-coordinate snapshot row cap when `SNAPSHOT_MAX_RECORDS` is unset or invalid. */
export const DEFAULT_SNAPSHOT_MAX_RECORDS = 500;

/**
 * Resolve the per-coordinate snapshot row cap from `SNAPSHOT_MAX_RECORDS`.
 *
 * Only a whole-string positive safe integer (`/^\d+$/`) is accepted. Any other
 * value falls back to {@link DEFAULT_SNAPSHOT_MAX_RECORDS}, so a bad value never
 * disables the cap. `Number.parseInt` alone reads `"10junk"` as 10, and a very
 * long digit string parses past the safe-integer range.
 *
 * @param env - Environment to read. Defaults to `process.env`.
 */
export function resolveMaxRecords(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SNAPSHOT_MAX_RECORDS;
  if (raw === undefined || raw === '') {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  if (!/^\d+$/.test(raw)) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_MAX_RECORDS;
  }
  return parsed;
}
