export type ExemptedFinding =
  | 'unreachable'
  | 'filtered-implementation-surface'
  | 'filename-coupled-entrypoint';

export interface GuardExemption {
  /** Repo-relative path of the guard whose hosting is knowingly imperfect. */
  readonly artifact: string;
  /**
   * The finding that this entry excuses. An entry for one finding does not cover
   * a different finding that appears later.
   */
  readonly excuses: ExemptedFinding;
  /** Why it cannot be fixed yet. Must name the blocking work. */
  readonly reason: string;
  /** The task or issue that unblocks it. */
  readonly blockedBy: string;
  /** ISO `YYYY-MM-DD`. Past this date the exemption FAILS rather than lapsing quietly. */
  readonly expires: string;
}

/**
 * The recorded, expiring reasons that a guard is not reachable from CI or is hosted imperfectly.
 * Each entry is a debt with an owner and a deadline. {@link auditGuardInventory} fails an entry whose
 * guard is absent, that does not exhibit its finding, or whose expiry is past or unparseable.
 */
export const GUARD_EXEMPTIONS: readonly GuardExemption[] = Object.freeze([
]);
