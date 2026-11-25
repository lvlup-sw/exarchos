/**
 * The guard for a revision that a caller names for a git command.
 * Git reads an argument that starts with a dash as an option, and some options write a file.
 * Each caller checks the revision with {@link isSafeRevision}, then puts {@link END_OF_OPTIONS}
 * before the revision in the argument list. Git then reads the revision only as a revision.
 */

/** The git mark after which git reads no argument as an option. */
export const END_OF_OPTIONS = '--end-of-options';

/** The maximum length of a revision. A longer value is not a ref that a caller names. */
const MAX_REVISION_LENGTH = 256;

/** A whitespace or control character. A split on it makes two arguments from one revision. */
const UNSAFE_REVISION_CHARACTER = /[\s\p{Cc}]/u;

/**
 * True for a revision that git can read only as a revision.
 * The check refuses an empty value, a value that starts with a dash, and a value with whitespace or a control character.
 */
export function isSafeRevision(revision: string): boolean {
  return (
    revision.length > 0 &&
    revision.length <= MAX_REVISION_LENGTH &&
    !revision.startsWith('-') &&
    !UNSAFE_REVISION_CHARACTER.test(revision)
  );
}
