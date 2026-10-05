import type { NdjsonEncoder } from './encoder.js';

/**
 * Write a `heartbeat` frame to `encoder` every `intervalMs` milliseconds
 * (default 30 s). Returns a function that stops the heartbeat.
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
