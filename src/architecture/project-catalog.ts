/**
 * Projects a merged invariant catalog onto a `(phase, workflow-type, touched-files)` key. The
 * projection is one filter over the catalog, with no I/O and no cache.
 *
 * - An absent `phase-affinity` matches all phases. Otherwise it must list the phase.
 * - An absent `workflow-affinity` matches all workflow types. Otherwise it must list the type.
 * - For `discovery`, the projection drops each invariant with `axis: 'substrate'`, so the review
 *   gate does not fire on code dimensions.
 * - In the delegate phase with `touchedFiles`, the `appliesTo` patterns of an invariant must match
 *   a touched file.
 */
import type { InvariantEntry } from './invariants-loader.js';
import { globToRegExp } from './glob-to-regexp.js';

/** The SDLC context of a projection. */
export interface ProjectCatalogKey {
  /** The SDLC phase, for example `'plan'` or `'delegate'`. */
  phase: string;
  /** The workflow type, for example `'feature'` or `'discovery'`. */
  workflowType: string;
  /**
   * Files the current task touches (delegate phase). When provided and the
   * phase is `'delegate'`, an invariant is included only if its `appliesTo`
   * patterns match at least one touched file.
   */
  touchedFiles?: string[] | undefined;
}

/** Returns the invariants of a merged catalog that apply to `key`. */
export function projectCatalog(
  catalog: InvariantEntry[],
  key: ProjectCatalogKey,
): InvariantEntry[] {
  return catalog.filter((entry) => {
    if (
      entry.phaseAffinity !== undefined &&
      !(entry.phaseAffinity as readonly string[]).includes(key.phase)
    ) {
      return false;
    }

    if (
      entry.workflowAffinity !== undefined &&
      !(entry.workflowAffinity as readonly string[]).includes(key.workflowType)
    ) {
      return false;
    }

    if (key.workflowType === 'discovery' && entry.axis === 'substrate') {
      return false;
    }

    if (key.phase === 'delegate' && key.touchedFiles !== undefined) {
      if (!appliesToIntersects(entry.appliesTo, key.touchedFiles)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * True when one or more `appliesTo` patterns match one or more touched files. The matcher has no
 * dependency, because `minimatch` is not a declared dependency of this package.
 */
function appliesToIntersects(appliesTo: string[], touchedFiles: string[]): boolean {
  return appliesTo.some((pattern) =>
    touchedFiles.some((file) => matchesPattern(pattern, file)),
  );
}

/**
 * Matches one glob pattern against one forward-slash path. A trailing `/**` or `/` matches the
 * directory and all paths below it, so the directory path itself also matches.
 */
function matchesPattern(pattern: string, filePath: string): boolean {
  let normalized = pattern;
  if (normalized.endsWith('/')) normalized = `${normalized}**`;
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -'/**'.length);
    if (filePath === prefix) return true;
  }
  return globToRegExp(normalized).test(filePath);
}
