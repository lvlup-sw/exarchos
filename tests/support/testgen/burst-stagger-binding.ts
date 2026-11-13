import { burstStaggerDelayMs } from '../../../src/verbs/worktree/git-retry.js';

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
