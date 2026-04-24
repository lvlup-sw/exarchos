import type { NdjsonEncoder } from './encoder.js';

/**
 * NDJSON heartbeat emitter (DR-9, T028).
 *
 * Schedules a `heartbeat` frame to be written to the given encoder every
 * `intervalMs` milliseconds (default 30s). Returns a cancel function that
 * stops further emissions.
 */
export function startHeartbeat(
  encoder: NdjsonEncoder,
  intervalMs: number = 30_000,
): () => void {
  const handle = setInterval(() => {
    encoder.write({
      type: 'heartbeat',
      timestamp: new Date().toISOString(),
    });
  }, intervalMs);

  return (): void => {
    clearInterval(handle);
  };
}
