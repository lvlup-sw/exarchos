/**
 * A sample TestGen binding over a pure stagger delay in a band of 100 to 500 ms.
 * A jitter value in `[-1, 1]` gives a delay that is clamped to the band.
 * The worktree burst stagger that first owned this function left the governor with worktree provisioning.
 */

/** Maps a jitter value to a delay in the 100 to 500 ms band. A jitter of 0 gives the 300 ms midpoint. */
function burstStaggerDelayMs(jitter: () => number): number {
  const minMs = 100;
  const maxMs = 500;
  const mid = (minMs + maxMs) / 2;
  const halfBand = (maxMs - minMs) / 2;
  return Math.max(minMs, Math.min(maxMs, Math.round(mid + halfBand * jitter())));
}

export function isValid(input: readonly bigint[]): boolean {
  const [jitter] = input;
  return input.length === 1 && jitter !== undefined && jitter >= -5n && jitter <= 5n;
}

export function observe([jitter]: readonly bigint[]): number {
  return burstStaggerDelayMs(() => Number(jitter));
}

export function predicate([jitter]: readonly bigint[], observed: number): boolean {
  if (jitter === undefined) return false;
  if (jitter < 0n) return observed === 100;
  if (jitter > 0n) return observed === 500;
  return observed === 300;
}

export function transform([jitter]: readonly bigint[]): bigint[] {
  return [-jitter!];
}

export function relation(_source: readonly bigint[], _follow: readonly bigint[], sourceResult: number, followResult: number): boolean {
  return sourceResult + followResult === 600;
}
