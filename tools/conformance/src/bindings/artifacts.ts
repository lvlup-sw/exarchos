/**
 * Bindings lifted from `config/artifacts` — the artifact directory defaults.
 *
 * See `./README.md` for why the composition root is split per subject.
 */
import {
  DEFAULT_SPEC_DIR,
  DEFAULT_LEGACY_DESIGN_DIR,
} from '../../../../src/config/artifacts.js';
import type { ArtifactDirs } from '../../../../src/architecture/vocabulary-lint.js';

/**
 * The artifact directories that the vocabulary lint treats as dated record trees. They bind to
 * their owner, so a default change upstream cannot make the lint walk a tree that it must skip.
 */
export const ARTIFACT_DIRS: ArtifactDirs = Object.freeze({
  specDir: DEFAULT_SPEC_DIR,
  legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
});
