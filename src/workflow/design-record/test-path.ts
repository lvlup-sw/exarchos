/** Syntax checks for declared test paths. */
import { globToRegExp } from '../../glob-to-regexp.js';

const WHITESPACE = /\s/;

/** True when a glob of `globs` matches the repo-relative path. */
export function matchesAnyGlob(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/**
 * Returns a reason if a test path is malformed or matches no resolved glob.
 * A valid forward declaration returns null without checking the file system.
 */
export function testPathWellFormednessError(
  testPath: string,
  globs: readonly string[],
): string | null {
  if (testPath.trim().length === 0) {
    return 'Empty test path';
  }
  if (/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(testPath)) {
    return 'Absolute path — declare a repo-relative test path instead';
  }
  if (testPath.split(/[\\/]/).includes('..')) {
    return 'Path escapes the repo root via a ".." segment';
  }
  if (WHITESPACE.test(testPath)) {
    return 'Does not name a test file (a test path holds no whitespace)';
  }
  if (!matchesAnyGlob(testPath, globs)) {
    return 'Does not name a test file (no glob of tests.globs matches the path)';
  }
  return null;
}
