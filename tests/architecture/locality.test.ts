/**
 * No directory grows into a dumping ground (task 052, DR-2 / DR-9).
 *
 * `orchestrate/` once held 83 files flat. Nothing had permitted that; nothing
 * had noticed it either, because a directory gains one file at a time and no
 * single commit ever looks wrong. This is the rule that makes the 26th file the
 * one someone has to argue for.
 *
 * ── Why an exemption LIST and not a judgment call ───────────────────────────
 * Some breadth is honest. A directory of small, independent, declarative
 * modules is not the same failure as a directory of thirty interdependent
 * ones, and a rule that cannot say so gets suppressed rather than obeyed.
 * So exemptions exist — but each is PREDICATED: it names a reason and pins the
 * count it was granted at. An exempt directory that keeps growing trips this
 * test on its next file, which is the difference between an exemption and an
 * amnesty.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(REPO_ROOT, 'src');

/** Files that are not the directory's own subject matter. */
const IS_TEST = /\.(test|bench)\.[cm]?[jt]s$|\.test\.sh$/;

/** The cap. One directory's worth of code a reader can hold at once. */
const MAX_OWN_LEVEL_FILES = 25;

interface Exemption {
  /** Why this breadth is not the `orchestrate/` failure. */
  readonly reason: string;
  /** The count when the exemption was granted. Growth past it fails. */
  readonly grantedAt: number;
}

/**
 * Predicated exemptions. Each is a DEBT with a named owner task, not a licence:
 * the pinned count means the directory may shrink freely and may not grow.
 */
const EXEMPTIONS: Record<string, Exemption> = {
  'src/verbs/gates': {
    reason:
      'One module per quality gate — small, independent, uniform. Breadth here is a count of ' +
      'gates, not coupling, which is the honest case for an exemption. Reducing it means grouping ' +
      'the gates into families under subdirectories; until someone does, the count is pinned so ' +
      'adding a gate is a deliberate act rather than a drift.',
    grantedAt: 39,
  },
  'src/workflow': {
    reason:
      'The workflow HSM and its primitives. This IS the orchestrate/ failure mode in miniature. ' +
      'The composite-surface decomposition did NOT reduce it and was never going to: splitting ' +
      '`tools.ts` into `handlers/` replaced one large file with a small barrel plus a ' +
      'subdirectory, and own-level counts do not see subdirectories. Reducing this number means ' +
      'moving modules OUT of this level, which is different work. Recorded rather than ' +
      'suppressed so the number stays quotable and cannot grow in the meantime.',
    grantedAt: 35,
  },
  'src/workflow/admission': {
    reason:
      'Admission-control policy modules, largely declarative and independently testable. Owed the ' +
      'same grouping pass as its parent, and unchanged by the composite-surface split for the ' +
      'same reason: nothing moved out of this level.',
    grantedAt: 30,
  },
};

interface DirCount {
  readonly dir: string;
  readonly count: number;
}

/** Own-level, non-test file count for every directory under `src/`. */
function ownLevelCounts(): DirCount[] {
  const out: DirCount[] = [];
  const walk = (abs: string): void => {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const own = entries.filter((e) => e.isFile() && !IS_TEST.test(e.name)).length;
    out.push({ dir: path.relative(REPO_ROOT, abs).split(path.sep).join('/'), count: own });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist') {
        walk(path.join(abs, e.name));
      }
    }
  };
  walk(SRC);
  return out.sort((a, b) => b.count - a.count);
}

describe('locality', () => {
  const counts = ownLevelCounts();

  it('Locality_NoDirectoryHoldsMoreThanTwentyFiveNonTestFilesAtItsOwnLevel', () => {
    const over = counts
      .filter(({ dir, count }) => count > MAX_OWN_LEVEL_FILES && EXEMPTIONS[dir] === undefined)
      .map(({ dir, count }) => `${dir}: ${count} files (cap ${MAX_OWN_LEVEL_FILES})`);

    expect(
      over,
      'directories over the locality cap with no predicated exemption — split them, or add an ' +
        'exemption stating why the breadth is honest and pinning the count',
    ).toEqual([]);

    // Denominator: a walk that found nothing would satisfy the filter above.
    expect(counts.length, 'the locality walk found no directories').toBeGreaterThan(20);
  });

  it('Locality_DeclarativeBreadthExemption_IsExplicitlyPredicated', () => {
    const byDir = new Map(counts.map((c) => [c.dir, c.count]));

    for (const [dir, exemption] of Object.entries(EXEMPTIONS)) {
      const live = byDir.get(dir);

      // A phantom exemption is cover for a directory that no longer exists —
      // the same stale-rule class this workflow keeps finding elsewhere.
      expect(live, `exempt directory ${dir} does not exist`).toBeDefined();

      // The predicate has to say something. "Judgment call" is what this list
      // exists to replace.
      expect(exemption.reason.length, `${dir} has no stated reason`).toBeGreaterThan(40);

      // Pinned: may shrink, may not grow.
      expect(
        live,
        `${dir} grew to ${live} past its granted ${exemption.grantedAt} — split it or re-argue ` +
          'the exemption',
      ).toBeLessThanOrEqual(exemption.grantedAt);

      // An exemption for a directory already UNDER the cap is dead cover.
      expect(
        exemption.grantedAt,
        `${dir} is exempt but its granted count is within the cap — delete the exemption`,
      ).toBeGreaterThan(MAX_OWN_LEVEL_FILES);
    }
  });

  it('Locality_SeededOverflow_IsRejected', () => {
    // Teeth. A cap that no input can violate is decoration.
    const seeded = [...counts, { dir: 'src/__seeded_dumping_ground__', count: 84 }];
    const over = seeded
      .filter(({ dir, count }) => count > MAX_OWN_LEVEL_FILES && EXEMPTIONS[dir] === undefined)
      .map(({ dir }) => dir);

    expect(over).toEqual(['src/__seeded_dumping_ground__']);
  });
});
