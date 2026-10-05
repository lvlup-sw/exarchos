/**
 * Typed errors thrown by the `withSession` primitive. They live in a separate
 * module, so `atomic-appender.ts` can re-export them without a circular import.
 */

/** The fix that an {@link InvalidSessionOptionsError} suggests. */
export interface InvalidSessionOptionsSuggestedFix {
  readonly tool: string;
  readonly reason: string;
}

/**
 * Thrown when a `withSession` call has neither `operationId` nor
 * `allowNonIdempotent: true`. The check stops a retry from firing a
 * non-idempotent side effect again. The default fix names three safe options:
 * `decide`, an `operationId`, or `allowNonIdempotent: true`.
 */
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
 * Thrown when code calls `session.append` on a captured {@link Session} after the
 * `withSession` body resolves. A late append falls outside the OCC boundary,
 * after the commit.
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
