/**
 * Snapshot cadence controller (T030, DR-2, DR-4).
 *
 * Bounds projection replay cost by deciding when a projection runtime
 * should emit a `workflow.snapshot_taken` event. Pure functions — no I/O,
 * no side effects — so the logic is trivially testable and safe to call
 * from hot paths in the projection runner.
 */

/** Default snapshot cadence when `SNAPSHOT_EVERY_N` is unset or invalid. */
export const DEFAULT_SNAPSHOT_CADENCE = 50;

/**
 * Decide whether a snapshot should be taken now.
 *
 * @param eventCountSinceLast - Events applied since the last snapshot (or
 *   since stream genesis if no snapshot has been taken yet). Must be a
 *   non-negative integer; upstream is expected to reset to 0 after a
 *   snapshot is captured.
 * @param cadence - Snapshot every N events. Must be a positive integer.
 * @returns `true` iff `eventCountSinceLast > 0` and is a positive multiple
 *   of `cadence`. Returns `false` for zero events or non-positive cadence
 *   (defensive — callers should resolve cadence via `resolveCadence`).
 */
export function shouldTakeSnapshot(
  eventCountSinceLast: number,
  cadence: number,
): boolean {
  if (!Number.isInteger(eventCountSinceLast) || eventCountSinceLast <= 0) {
    return false;
  }
  if (!Number.isInteger(cadence) || cadence <= 0) {
    return false;
  }
  return eventCountSinceLast % cadence === 0;
}

/**
 * Resolve the snapshot cadence from environment configuration.
 *
 * Reads `SNAPSHOT_EVERY_N` and parses it as a positive integer. Any missing,
 * non-numeric, zero, or negative value falls back to
 * {@link DEFAULT_SNAPSHOT_CADENCE} (50) so misconfiguration never disables
 * snapshotting or produces pathological cadence.
 *
 * @param env - Environment object to read from. Defaults to `process.env`
 *   so callers usually invoke with no args; an explicit object allows pure
 *   testing without mutating process state.
 */
export function resolveCadence(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SNAPSHOT_EVERY_N;
  if (raw === undefined || raw === '') {
    return DEFAULT_SNAPSHOT_CADENCE;
  }
  // Strict parse: `Number.parseInt('10abc', 10)` returns `10`, silently
  // accepting trailing garbage. Require the entire string to match a
  // positive-integer literal (no signs, no decimals, no leading zeros
  // beyond a single `0` — though we then reject `0` as non-positive
  // below). (CodeRabbit PR #1178 review.)
  if (!/^\d+$/.test(raw)) {
    return DEFAULT_SNAPSHOT_CADENCE;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SNAPSHOT_CADENCE;
  }
  return parsed;
}
