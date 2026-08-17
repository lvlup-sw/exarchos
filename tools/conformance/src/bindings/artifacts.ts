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
 * The artifact directories the vocabulary lint treats as dated record trees,
 * bound from their owner (DR-6) rather than re-typed here — a default change
 * upstream cannot leave the lint walking a tree it is meant to skip.
 */
export const ARTIFACT_DIRS: ArtifactDirs = Object.freeze({
  specDir: DEFAULT_SPEC_DIR,
  legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
});
