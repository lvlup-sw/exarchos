import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * The directories a workflow's authored artifacts live under (DR-6).
 *
 * These were two module-private literals inside `workflow/rehydrate.ts`, which
 * made the artifact location a property of the classifier rather than of the
 * project. A repository that keeps its specs somewhere other than `docs/specs/`
 * had no way to say so, and the coming docs exodus mounts the directory as a
 * symlink — so the location has to be a configured value with one owner.
 *
 * Deliberately NOT a filesystem concern. Classification reads the event-folded
 * artifact map, never disk (see `classifyArtifactLayout`); these strings are
 * prefixes to match against recorded paths, not directories to stat. Existence
 * of a workflow remains the projection's answer — the state-source-integrity
 * rule (`docs/rca/2026-05-30-state-source-integrity.md`) — and nothing here may
 * be read as an existence signal.
 */
export interface ArtifactDirs {
  /** Prefix the collapsed (post-#1581) flow writes its one unified spec under. */
  readonly specDir: string;
  /**
   * Prefix that marks a workflow as pre-collapse two-artifact work. This is a
   * *historical* discriminator, not a forward-looking convention: the collapsed
   * flow never emits a path here, so a `design` artifact under this prefix is
   * the unambiguous legacy signal. Configurable because a project that renamed
   * its old design tree still needs its in-flight workflows to classify, but a
   * project should rarely need to touch it.
   */
  readonly legacyDesignDir: string;
}

/** The unified-spec directory the post-collapse flow writes to. */
export const DEFAULT_SPEC_DIR = 'docs/specs/';

/** The legacy design-doc directory that marks pre-#1581 two-artifact work. */
export const DEFAULT_LEGACY_DESIGN_DIR = 'docs/designs/';

export const DEFAULT_ARTIFACT_DIRS: ArtifactDirs = Object.freeze({
  specDir: DEFAULT_SPEC_DIR,
  legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
});

/**
 * Put a configured directory into the one form the prefix match expects:
 * POSIX separators, no duplicate or leading-`./` noise, exactly one trailing
 * slash. INV-16 — a stored path is POSIX-normalized whatever separator form it
 * arrived in, so a Windows-authored `docs\specs` matches a recorded
 * `docs/specs/…` path.
 *
 * The trailing slash is load-bearing, not cosmetic: without it `docs/spec`
 * would prefix-match `docs/specifications/…`.
 *
 * Total by construction — a blank or separator-only input normalizes to the
 * empty string, which `resolveArtifactDirs` rejects in favour of the default
 * rather than matching every path.
 */
export function normalizeArtifactDir(raw: string): string {
  const posix = raw.trim().replace(/\\/g, '/');
  const collapsed = posix.replace(/\/{2,}/g, '/').replace(/^\.\//, '');
  const bare = collapsed.replace(/\/+$/, '');
  return bare === '' || bare === '.' ? '' : `${bare}/`;
}

/** The `.exarchos.yml` `artifacts:` block, as the schema hands it over. */
export interface ArtifactsConfigInput {
  readonly 'spec-dir'?: string | undefined;
  readonly 'legacy-design-dir'?: string | undefined;
}

/**
 * Layer a project's `artifacts:` block over the built-in defaults.
 *
 * A value that normalizes to empty falls back to the default: an empty prefix
 * matches every path, so honouring it would classify every workflow as
 * `'unified'` and silently strand in-flight two-artifact work on the wrong
 * path. Failing back is the safe direction; failing open is not.
 */
export function resolveArtifactDirs(config?: ArtifactsConfigInput): ArtifactDirs {
  const specDir = normalizeArtifactDir(config?.['spec-dir'] ?? '');
  const legacyDesignDir = normalizeArtifactDir(config?.['legacy-design-dir'] ?? '');
  return Object.freeze({
    specDir: specDir === '' ? DEFAULT_SPEC_DIR : specDir,
    legacyDesignDir: legacyDesignDir === '' ? DEFAULT_LEGACY_DESIGN_DIR : legacyDesignDir,
  });
}

/** Rewrite a path to POSIX separators (INV-16). Storage form, on every OS. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Absolute on-disk location of a configured artifact directory, with symlinks
 * resolved (DR-11).
 *
 * The coming docs exodus mounts the artifact directory as a symlink pointing
 * outside the repository, so a consumer that must actually READ the directory —
 * the eval corpus loader is the only one today — has to follow the link. The
 * returned path is POSIX-normalized so it is comparable on every platform.
 *
 * Deliberately total on a missing directory: it returns the unresolved absolute
 * path rather than throwing. A caller may then fail on its own terms, and more
 * importantly nothing here can be mistaken for an existence check. Whether a
 * workflow exists is the event projection's answer and never a filesystem stat
 * (`docs/rca/2026-05-30-state-source-integrity.md`); a configured directory
 * that is absent, dangling, or unreadable changes nothing about that.
 */
export function resolveArtifactDirPath(repoRoot: string, dir: string): string {
  const joined = nodePath.resolve(repoRoot, normalizeArtifactDir(dir));
  try {
    return toPosixPath(nodeFs.realpathSync(joined));
  } catch {
    return toPosixPath(joined);
  }
}
