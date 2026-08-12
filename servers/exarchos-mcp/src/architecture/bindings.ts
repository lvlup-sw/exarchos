/**
 * The composition root for the conformance censuses.
 *
 * Every other module in this package is pure with respect to the tree it
 * governs: it takes the tables, schemas and directories it needs as parameters
 * rather than importing them from the subject. This file is the one place where
 * that inversion is discharged — it imports the real values from the subject and
 * hands them to the censuses.
 *
 * Keeping the edge here rather than deleting it is deliberate. Re-typing the
 * subject's constants inside this package would remove the import and pass a
 * boundary check while quietly reintroducing the drift the constants exist to
 * prevent: the census would keep asserting against a copy that no longer matches
 * what ships. One honest edge at a named seam beats a dozen silent duplicates.
 *
 * The invariant the boundary test enforces is therefore "no *uninverted* edge
 * into the subject" — this module is the sole exception, by construction.
 */
import {
  DEFAULT_SPEC_DIR,
  DEFAULT_LEGACY_DESIGN_DIR,
} from '../config/artifacts.js';
import type { ArtifactDirs } from './vocabulary-lint.js';

/**
 * The artifact directories the vocabulary lint treats as dated record trees,
 * bound from their owner (DR-6).
 */
export const ARTIFACT_DIRS: ArtifactDirs = Object.freeze({
  specDir: DEFAULT_SPEC_DIR,
  legacyDesignDir: DEFAULT_LEGACY_DESIGN_DIR,
});
