/**
 * User-facing text for `installSkills()`, in one place.
 * Each function returns a plain string with no color codes, so tests can assert on substrings.
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

/** Emitted when auto-detection returns null and the install falls back to the generic runtime. */
export function noAgentDetectedFallbackMessage(genericName: string): string {
  return (
    `No agent detected on this host. Installing generic skills bundle ` +
    `(${genericName}). Pass --agent to target a specific runtime.`
  );
}

/** Written to errLog before the throw, when detection finds more than one agent in non-interactive mode. */
export function ambiguousNonInteractiveNoticeMessage(
  candidates: readonly string[],
): string {
  return (
    `Ambiguous runtime detection. Candidates: ${candidates.join(', ')}. ` +
    `Re-run with --agent <name> to disambiguate.`
  );
}

/**
 * The message of the Error thrown when detection finds more than one agent in non-interactive mode.
 * It is separate from the errLog notice, so the Error message is complete without that notice.
 */
export function ambiguousNonInteractiveThrowMessage(
  candidates: readonly string[],
): string {
  return (
    `Ambiguous runtime detection. Candidates: ${candidates.join(', ')}. ` +
    `Pass --agent <name> to disambiguate.`
  );
}

/**
 * Why `npx skills add` names no release tag. The version is not of release form, or the compiled
 * build did not run at the tag of its version.
 */
export type UnpinnedSkillsSourceCause = 'not-a-release-version' | 'not-a-release-build';

/**
 * Emitted before `npx skills add` when the source names no release tag, with the cause.
 * The skills then come from the default branch, and they can differ from this build.
 */
export function unpinnedSkillsSourceMessage(version: string, cause: UnpinnedSkillsSourceCause): string {
  const why =
    cause === 'not-a-release-build'
      ? `This build of Exarchos ${version} is not a release build, so it names no release tag. `
      : `Exarchos version "${version}" is not a release version, so it names no release tag. `;
  return why + `Installing skills from the default branch, which can differ from this build.`;
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
