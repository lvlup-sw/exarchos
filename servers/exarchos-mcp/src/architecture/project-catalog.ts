/**
 * Projection of a merged invariant catalog by `(phase, workflow-type,
 * touched-files)` key (DR-5, tasks T-10 / T-11).
 *
 * `projectCatalog` is a **pure left-fold** over the merged catalog — no
 * mutable cache that could drift from the catalog source (INV-1). Given a
 * projection key it returns the subset of invariants relevant to that
 * context. The function performs no I/O and caches nothing.
 *
 * ## Affinity semantics (DR-5)
 *
 *   - `phase-affinity` absent ⇒ all phases; present ⇒ include only if it
 *     contains the requested phase.
 *   - `workflow-affinity` absent ⇒ all workflow types; present ⇒ include only
 *     if it contains the requested type. For `discover`, code-axis invariants
 *     (`axis: 'substrate'`) are additionally excluded so the review gate does
 *     not fire on code dimensions.
 *   - `touched-files` (delegate phase only): include an invariant only if its
 *     `appliesTo` intersects the touched files. A docs-only task therefore
 *     injects no code invariant.
 */
import type { InvariantEntry } from './invariants-loader.js';
import { globToRegExp } from './glob-to-regexp.js';

/** Projection key: the SDLC context an invariant set is being projected for. */
export interface ProjectCatalogKey {
  /** SDLC phase — e.g. `'ideate' | 'plan' | 'delegate' | 'review' | 'synthesize'`. */
  phase: string;
  /** Workflow kind — e.g. `'feature' | 'debug' | 'refactor' | 'discover' | 'oneshot'`. */
  workflowType: string;
  /**
   * Files the current task touches (delegate phase). When provided and the
   * phase is `'delegate'`, an invariant is included only if its `appliesTo`
   * patterns match at least one touched file.
   */
  touchedFiles?: string[];
}

/**
 * Project a merged catalog down to the invariants relevant to `key`.
 *
 * Pure function — a single `Array.filter` (left-fold) over `catalog`. No I/O,
 * no memoization; safe to call repeatedly with the same or different keys.
 */
export function projectCatalog(
  catalog: InvariantEntry[],
  key: ProjectCatalogKey,
): InvariantEntry[] {
  return catalog.filter((entry) => {
    // ── phase-affinity ──
    // Absent ⇒ all phases. Present ⇒ must list the requested phase.
    if (
      entry.phaseAffinity !== undefined &&
      !(entry.phaseAffinity as readonly string[]).includes(key.phase)
    ) {
      return false;
    }

    // ── workflow-affinity ──
    // Absent ⇒ all workflow types. Present ⇒ must list the requested type.
    if (
      entry.workflowAffinity !== undefined &&
      !(entry.workflowAffinity as readonly string[]).includes(key.workflowType)
    ) {
      return false;
    }

    // For `discover`, code-axis (substrate) invariants are excluded so the
    // review gate does not fire on code dimensions.
    if (key.workflowType === 'discover' && entry.axis === 'substrate') {
      return false;
    }

    // ── touched-files (delegate phase only) ──
    // Include only if the invariant's appliesTo patterns match a touched file.
    if (key.phase === 'delegate' && key.touchedFiles !== undefined) {
      if (!appliesToIntersects(entry.appliesTo, key.touchedFiles)) {
        return false;
      }
    }

    return true;
  });
}

/**
 * True when any `appliesTo` glob/path pattern matches any touched file.
 *
 * We avoid pulling in `minimatch` (not a declared dependency of this package)
 * and use a small, dependency-free matcher covering the patterns the catalog
 * actually uses: trailing `/**` directory globs, single `*` wildcards within a
 * path segment, and exact prefixes/paths.
 */
function appliesToIntersects(appliesTo: string[], touchedFiles: string[]): boolean {
  return appliesTo.some((pattern) =>
    touchedFiles.some((file) => matchesPattern(pattern, file)),
  );
}

/** Match a single glob-ish pattern against a single (forward-slash) path. */
function matchesPattern(pattern: string, filePath: string): boolean {
  // A trailing `/**` (or a bare directory like `docs/`) means "this directory
  // and everything beneath it" — so the directory prefix alone also matches.
  let normalized = pattern;
  if (normalized.endsWith('/')) normalized = `${normalized}**`;
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -'/**'.length);
    if (filePath === prefix) return true;
  }
  return globToRegExp(normalized).test(filePath);
}
