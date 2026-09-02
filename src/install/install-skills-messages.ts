/**
 * Centralized user-facing copy for `installSkills()`.
 *
 * Every string shown to the user from `install-skills.ts` goes through this
 * module so copy can be reviewed, tested, and iterated on in one place rather
 * than scattered across control-flow branches. Each function returns a plain
 * string (no formatting, no color codes) so tests can do substring assertions.
 *
 * Implements: DR-7, DR-10.
 */

/** Emitted when --agent names a runtime not present in the runtimes/ dir. */
export function unknownRuntimeMessage(
  attempted: string,
  supported: readonly string[],
): string {
  const list = supported.length > 0 ? supported.join(', ') : '(none)';
  return `Unknown runtime: "${attempted}". Supported: ${list}.`;
}

/** Emitted when auto-detection returns null and no generic runtime exists. */
export function missingGenericFallbackMessage(): string {
  return (
    `No agent detected and no 'generic' runtime available as fallback. ` +
    `Pass --agent explicitly.`
  );
}

/** Emitted when auto-detection returns null but we're falling back to generic. */
export function noAgentDetectedFallbackMessage(genericName: string): string {
  return (
    `No agent detected on this host. Installing generic skills bundle ` +
    `(${genericName}). Pass --agent to target a specific runtime.`
  );
}

/**
 * Emitted to errLog when multiple agents are detected and we're in
 * non-interactive mode (pre-throw).
 */
export function ambiguousNonInteractiveNoticeMessage(
  candidates: readonly string[],
): string {
  return (
    `Ambiguous runtime detection. Candidates: ${candidates.join(', ')}. ` +
    `Re-run with --agent <name> to disambiguate.`
  );
}

/**
 * Thrown Error.message when multiple agents detected in non-interactive
 * mode. Kept separate from the errLog notice so the thrown Error still has a
 * full, self-contained message even if caller captured it before errLog.
 */
export function ambiguousNonInteractiveThrowMessage(
  candidates: readonly string[],
): string {
  return (
    `Ambiguous runtime detection. Candidates: ${candidates.join(', ')}. ` +
    `Pass --agent <name> to disambiguate.`
  );
}

/** Question passed to the interactive prompt. */
export const AMBIGUOUS_INTERACTIVE_QUESTION =
  'Multiple agents detected. Which one should we install skills for?';

/** Wrapper message for the Error thrown on non-zero child exit. */
export function childExitErrorMessage(code: number): string {
  return `install-skills: child process exited with code ${code}`;
}

/** First line of the "retry manually" block written to errLog on failure. */
export function childExitRetryHeader(code: number): string {
  return `Command failed with exit code ${code}. To retry manually:`;
}
