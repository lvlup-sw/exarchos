/** Prefix matcher for the CODEOWNERS forms this repository uses. */
export function codeownersMatches(pattern: string, rel: string): boolean;

/** Curry `codeownersMatches` for `Array.filter`. */
export function codeownersMatcher(pattern: string): (rel: string) => boolean;
