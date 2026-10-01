import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/**
 * The directories that hold the authored artifacts of a workflow. A project can configure them,
 * because a repository can keep its specs elsewhere or mount the directory as a symlink.
 *
 * Classification reads the event-folded artifact map, not the disk (see `classifyArtifactLayout`).
 * These strings are substrings to match against recorded paths, not directories to stat. They are
 * never an existence signal: whether a workflow exists is the answer of the event projection.
 */
export interface ArtifactDirs {
  /** Directory under which the flow writes its one unified spec. */
  readonly specDir: string;
  /**
   * Directory that marks a workflow as older two-artifact work. The current flow never writes a
   * path here, so a `design` artifact under it is an unambiguous legacy signal. It is
   * configurable, so a project that renamed its old design tree can still classify its
   * in-flight workflows.
   */
  readonly legacyDesignDir: string;
}

/** The default unified-spec directory. */
export const DEFAULT_SPEC_DIR = 'docs/specs/';

/** The default legacy design-doc directory, which marks two-artifact work. */
export const DEFAULT_LEGACY_DESIGN_DIR = 'docs/designs/';

export const DEFAULT_ARTIFACT_DIRS: ArtifactDirs = Object.freeze({
  specDir: DEFAULT_SPEC_DIR,
  legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
});

/**
 * Puts a configured directory into the form that the match expects: POSIX separators, no
 * duplicate slashes, no leading `./`, and exactly one trailing slash. Thus a Windows-authored
 * `docs\specs` matches a recorded POSIX path.
 *
 * The trailing slash prevents `docs/spec` from matching `docs/specifications/`. A blank or
 * separator-only input gives the empty string, and `resolveArtifactDirs` replaces it with the
 * default.
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
 * Layers the `artifacts:` block of a project over the built-in defaults. A value that normalizes
 * to empty falls back to the default. An empty string matches every path, so it classifies every
 * workflow as `'unified'` and strands in-flight two-artifact work.
 */
export function resolveArtifactDirs(config?: ArtifactsConfigInput): ArtifactDirs {
  const specDir = normalizeArtifactDir(config?.['spec-dir'] ?? '');
  const legacyDesignDir = normalizeArtifactDir(config?.['legacy-design-dir'] ?? '');
  return Object.freeze({
    specDir: specDir === '' ? DEFAULT_SPEC_DIR : specDir,
    legacyDesignDir: legacyDesignDir === '' ? DEFAULT_LEGACY_DESIGN_DIR : legacyDesignDir,
  });
}

/** Rewrites a path to POSIX separators, the storage form on every OS. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Returns the absolute, POSIX-normalized location of a configured artifact directory, with
 * symlinks resolved. A consumer that reads the directory needs this, because the directory can be
 * a symlink to a location outside the repository.
 *
 * On a missing directory, the function returns the unresolved absolute path and does not throw.
 * Thus the result is never an existence check. Whether a workflow exists is the answer of the
 * event projection, not of a filesystem stat.
 */
export function resolveArtifactDirPath(repoRoot: string, dir: string): string {
  const joined = nodePath.resolve(repoRoot, normalizeArtifactDir(dir));
  try {
    return toPosixPath(nodeFs.realpathSync(joined));
  } catch {
    return toPosixPath(joined);
  }
}
