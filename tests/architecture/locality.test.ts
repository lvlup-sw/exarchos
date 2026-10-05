/**
 * No directory holds more than 25 non-test files at its own level.
 *
 * A directory gains one file at a time, and no single commit looks wrong. This
 * rule makes a person argue for the 26th file.
 *
 * An exemption list replaces a judgment call. A directory of small, independent
 * modules is not the same failure as a directory of interdependent modules.
 * Each exemption names a reason and pins the count at the time of the grant. An
 * exempt directory that grows past that count fails this test.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The structural roots that the cap applies to. The walk covers all six, so an
 * overfull directory cannot hide outside `src/`.
 */
const WALK_ROOTS = ['src', 'tools', 'tests', 'content', 'docs', 'rendered'] as const;

/** Matches test and benchmark files, which do not count toward the cap. */
const IS_TEST = /\.(test|bench)\.[cm]?[jt]s$|\.test\.sh$/;

/** The cap on non-test files at the own level of one directory. */
const MAX_OWN_LEVEL_FILES = 25;

interface Exemption {
  /** Why this breadth is not a dumping ground. */
  readonly reason: string;
  /** The count at the time of the grant. Growth past it fails. */
  readonly grantedAt: number;
}

/**
 * The exemptions. Each one is a debt and not a license: the directory can
 * shrink, and it must not grow past the pinned count.
 */
const EXEMPTIONS: Record<string, Exemption> = {
  'src/verbs/gates': {
    reason:
      'One module per quality gate — small, independent, uniform. Breadth here is a count of ' +
      'gates, not coupling, which is the honest case for an exemption. Reducing it means grouping ' +
      'the gates into families under subdirectories; until someone does, the count is pinned so ' +
      'adding a gate is a deliberate act rather than a drift.',
    grantedAt: 40,
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
      'same reason: nothing moved out of this level. Re-argued once for ActionId admission, which ' +
      'evaluates a registry ActionId against the same snapshot the phase-edge evaluator already ' +
      'reads here — housing it beside its evidence and requirement modules is what keeps the two ' +
      'admission paths comparable; a sibling directory would have split one subject in half.',
    grantedAt: 31,
  },
  'tools/audit': {
    reason:
      'Repo-automation oracles, baselines and CLIs that the product tree is not allowed to hold. ' +
      'Breadth here is a count of instruments, not a second orchestrate/. Grouping them into ' +
      'subdirectories is the reduction; until then the count is pinned so the next file is argued.',
    grantedAt: 56,
  },
  'tools/audit/gates': {
    reason:
      'One script or module per gate, same honest-breadth case as src/verbs/gates. The ' +
      'guard-inventory split moved a monolith into a subdirectory and left this level as the ' +
      'index of every other gate. Pinned so adding a gate is deliberate. Raised to 41 for the ' +
      'comment gate, which the enforcer-wiring checker can see only as a primary at this level.',
    grantedAt: 41,
  },
  'src/install': {
    reason:
      'Twenty-three install-pipeline `.ts` modules plus three `.js` re-export shims that ' +
      'mirror the bridge \`.js → .ts\` NodeNext contract (see `.gitignore` whitelist and ' +
      'the shim headers). The shims do not add new functionality — they exist so vite-node ' +
      'finds a literal `.js` file at the bridge\'s specifier paths and bun follows the ' +
      're-exports. Reducing this number means consolidating the install pipeline into a ' +
      'subdirectory tree, which is a separate refactor; until then the count is pinned so ' +
      'the next file is argued for.',
    grantedAt: 26,
  },
};

interface DirCount {
  readonly dir: string;
  readonly count: number;
}

/** The count of non-test files at the own level of each directory under the walk roots. */
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
  for (const root of WALK_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new Error(
        `locality walk root "${root}" is missing — a misspelled or deleted structural root would silently skip that tree`,
      );
    }
    walk(abs);
  }
  return out.sort((a, b) => b.count - a.count);
}

describe('locality', () => {
  const counts = ownLevelCounts();

  /** The last assertion is the denominator, because a walk that finds nothing satisfies the filter. */
  it('Locality_NoDirectoryHoldsMoreThanTwentyFiveNonTestFilesAtItsOwnLevel', () => {
    const over = counts
      .filter(({ dir, count }) => count > MAX_OWN_LEVEL_FILES && EXEMPTIONS[dir] === undefined)
      .map(({ dir, count }) => `${dir}: ${count} files (cap ${MAX_OWN_LEVEL_FILES})`);

    expect(
      over,
      'directories over the locality cap with no predicated exemption — split them, or add an ' +
        'exemption stating why the breadth is honest and pinning the count',
    ).toEqual([]);

    expect(counts.length, 'the locality walk found no directories').toBeGreaterThan(20);
  });

  /**
   * Each exemption must name a directory that exists and state a reason. The
   * directory must not grow past the granted count. A granted count within the
   * cap covers nothing, so the test rejects it.
   */
  it('Locality_DeclarativeBreadthExemption_IsExplicitlyPredicated', () => {
    const byDir = new Map(counts.map((c) => [c.dir, c.count]));

    for (const [dir, exemption] of Object.entries(EXEMPTIONS)) {
      const live = byDir.get(dir);

      expect(live, `exempt directory ${dir} does not exist`).toBeDefined();

      expect(exemption.reason.length, `${dir} has no stated reason`).toBeGreaterThan(40);

      expect(
        live,
        `${dir} grew to ${live} past its granted ${exemption.grantedAt} — split it or re-argue ` +
          'the exemption',
      ).toBeLessThanOrEqual(exemption.grantedAt);

      expect(
        exemption.grantedAt,
        `${dir} is exempt but its granted count is within the cap — delete the exemption`,
      ).toBeGreaterThan(MAX_OWN_LEVEL_FILES);
    }
  });

  /** A seeded directory over the cap must be the only result of the filter expression. */
  it('Locality_SeededOverflow_IsRejected', () => {
    const seeded = [...counts, { dir: 'src/__seeded_dumping_ground__', count: 84 }];
    const over = seeded
      .filter(({ dir, count }) => count > MAX_OWN_LEVEL_FILES && EXEMPTIONS[dir] === undefined)
      .map(({ dir }) => dir);

    expect(over).toEqual(['src/__seeded_dumping_ground__']);
  });
});
