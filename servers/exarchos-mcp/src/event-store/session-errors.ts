/**
 * Typed errors raised by the `withSession` R-2 primitive (Wave 3).
 *
 * Kept in a sibling module so the primitive layer (`atomic-appender.ts`)
 * can re-export them without creating a circular import with
 * `concurrency-error.ts` / `storage-busy-error.ts`. Wave 4 consumers
 * import these by name to handle the corresponding failure modes.
 */

/**
 * Raised at step 0 of `withSession` when the call elides BOTH
 * `operationId` AND the `allowNonIdempotent: true` opt-in. The runtime
 * check prevents retry storms from re-firing non-idempotent side
 * effects inside the closure (audit §F1.1; Microsoft Saga §"pivot
 * transactions").
 *
 * The suggestedFix points callers at either of two safe shapes:
 *   - Use `decide` for pure state machines (no side effects).
 *   - Supply `operationId` so the substrate dedupes retries.
 *   - Or, set `allowNonIdempotent: true` to acknowledge the at-least-
 *     once delivery semantics explicitly.
 */
export interface InvalidSessionOptionsSuggestedFix {
  readonly tool: string;
  readonly reason: string;
}

export class InvalidSessionOptionsError extends Error {
  readonly code = 'INVALID_SESSION_OPTIONS' as const;
  readonly suggestedFix: InvalidSessionOptionsSuggestedFix;

  constructor(suggestedFix?: InvalidSessionOptionsSuggestedFix) {
    super(
      'INVALID_SESSION_OPTIONS: withSession requires either operationId (for idempotent retry) or allowNonIdempotent: true (explicit opt-in). Use decide() for pure state machines.',
    );
    this.name = 'InvalidSessionOptionsError';
    this.suggestedFix = suggestedFix ?? {
      tool: 'decide',
      reason:
        'Use decide() for pure state machines; or supply operationId; or set allowNonIdempotent: true to opt out.',
    };
  }
}

/**
 * Raised when a captured {@link Session} object is used after the
 * `withSession` body has resolved. Closure-captured sessions are a
 * common antipattern — they let handler logic queue events outside
 * the OCC boundary, where the commit happened with stale state.
 *
 * The session-closed flag is flipped at the end of `withSession`'s
 * body; any subsequent `session.append(evt)` throws this error.
 */
export class SessionClosedError extends Error {
  readonly code = 'SESSION_CLOSED' as const;

  constructor(streamId?: string) {
    super(
      `SESSION_CLOSED: session for stream ${streamId !== undefined ? JSON.stringify(streamId) : '<unknown>'} was used after withSession resolved`,
    );
    this.name = 'SessionClosedError';
  }
}
