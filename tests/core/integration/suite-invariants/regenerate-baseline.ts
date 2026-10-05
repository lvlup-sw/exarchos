// Baseline regeneration. This file is a maintenance script, not a test.
//
//   npx tsx tests/core/integration/suite-invariants/regenerate-baseline.ts
//
// The script writes `legacy-shape-debt.ts` again from the current corpus. Run it
// when the ratchet reports stale entries: an annotated file, a file out of
// scope, or a deleted file. Do not run it to hide a new unregistered file,
// because new debt must fail. A run that adds entries makes the list longer,
// and the diff shows that in review.

import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from './corpus.js';
import { matchedShapes } from './shapes.js';
import { parseOracleDeclarations } from './detectors.js';
import { ACCEPTED_GAPS } from './registry.js';

/**
 * The files of each individually registered gap. They stay out of the bulk
 * list, so each of those gaps stays visible on its own.
 */
const INDIVIDUALLY_REGISTERED = new Set(
  ACCEPTED_GAPS.filter((g) => g.id !== 'legacy/shape-annotation-debt').flatMap((g) => g.files),
);

const corpus = loadCorpus();
const debt = corpus
  .filter((f) => matchedShapes(f.source).length > 0)
  .filter((f) => parseOracleDeclarations(f.source).length === 0)
  .map((f) => f.rel)
  .filter((r) => !INDIVIDUALLY_REGISTERED.has(r));

const header = `// GENERATED BASELINE — the pre-existing \`@oracle-sources\` debt (DR-30).
//
// Every path below is a test file that DOES match a covered assertion shape
// (see \`shapes.ts\`) and does NOT carry an \`@oracle-sources\` declaration.
// They were all written before the convention existed. Requiring the
// annotation on all ${debt.length} of them at once would make the meta-test red on
// arrival and therefore useless, so DR-30's ratchet is applied instead:
//
//   • this list is EXHAUSTIVE and EXPLICIT — not a count, not a threshold.
//     A NEW in-scope file that lacks the annotation is not on the list and
//     fails immediately.
//   • the list may only SHRINK. \`suite-invariants.test.ts\` asserts that every
//     entry is still in scope and still unannotated; the moment one is fixed
//     (or falls out of scope, or is deleted) the entry goes stale and the
//     suite goes RED until it is removed. There is no way to leave a fixed
//     file parked here.
//   • the whole list is owned and expires — see the
//     \`legacy/shape-annotation-debt\` entry in \`registry.ts\`.
//
// Regenerate with \`regenerate-baseline.ts\`; do NOT hand-edit to silence a
// failure.

export const LEGACY_SHAPE_DEBT: readonly string[] = Object.freeze([
`;

const body = debt.map((r) => `  '${r}',`).join('\n');
const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, 'legacy-shape-debt.ts'), `${header}${body}\n]);\n`, 'utf8');
// eslint-disable-next-line no-console
console.log(`wrote ${debt.length} entries to legacy-shape-debt.ts`);
