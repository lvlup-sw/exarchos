/**
 * Scans the tracked sources for the two artifact-directory literals.
 * `src/config/artifacts.ts` owns both. A new `path.join` call on a re-typed
 * literal looks ordinary in review, so this scan keeps the literals with their
 * owner.
 *
 * The scan puts each line that holds a literal into one of two tiers:
 * - Functional: the literal drives a path construction, a prefix comparison, or
 *   a directory constant. Such a use makes a configured directory unreachable.
 *   The allowlist is closed.
 * - Prose: the literal appears in agent-facing text, such as a tool description
 *   or an error message. It shapes behavior and gates nothing. A budget for
 *   each file makes new prose coupling visible.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');

const LITERALS = ['docs/specs', 'docs/designs'] as const;

/** The one owner of the two prefixes. Every other module imports them from this file. */
const OWNER = 'src/config/artifacts.ts';

/** The only files that can hold a functional literal. */
const FUNCTIONAL_ALLOWLIST: ReadonlyArray<string> = [
  /** Declares the two defaults. */
  OWNER,
  /**
   * Holds `SPEC_PATH`, which names one frozen document at a fixed path in this
   * repository. It cannot follow the `artifacts.spec-dir` that a project
   * configures.
   */
  'tools/audit/gates/guard-inventory/paths.ts',
  /**
   * Names the mounted planning-corpus prefixes so that an unmounted checkout
   * can skip them. Like `SPEC_PATH`, they are locations in this repository,
   * not a configured spec directory.
   */
  'tools/audit/gates/check-measured-premises.mjs',
];

/**
 * The count of prose lines that hold a literal, for each file. The table is a
 * ratchet: a lower count is welcome, and a higher count or a new file needs a
 * deliberate edit here.
 */
const PROSE_BUDGET: Readonly<Record<string, number>> = {
  'tools/audit/gates/check-measured-premises.mjs': 1,
  'tools/evals/evals/benchmarks/plan-format-corpus.ts': 1,
  'src/verbs/gates/design-completeness.ts': 1,
  'src/verbs/tasks/discover-bridge.ts': 1,
  'src/verbs/team/prepare-review.ts': 1,
  'src/registry/actions/workflow.ts': 1,
  'src/registry/actions/orchestrate/gates.ts': 2,
  'src/registry/actions/orchestrate/review-ops.ts': 1,
  'src/workflow/playbooks.ts': 2,
  'tools/audit/measure-reference-census.mjs': 1,
};

/**
 * Blanks comments and keeps line numbers, so a literal in a JSDoc block does
 * not count as a use. A `//` after an odd number of quote characters is inside
 * a string, such as a URL or a glob, and stays.
 *
 * The block pattern pairs each block-comment opener with the next closer in
 * the file. Thus an opener inside a string blanks the code up to that closer,
 * and the scan does not see a literal there.
 */
function stripComments(src: string): string {
  const blockless = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blockless
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      const before = line.slice(0, i);
      if ((before.match(/['"`]/g) ?? []).length % 2 === 1) return line;
      if (before.endsWith(':') || before.endsWith('/')) return line;
      return before;
    })
    .join('\n');
}

/** True when the line uses the literal in a path call, a prefix comparison, or a constant. */
function isFunctionalUse(line: string): boolean {
  return (
    /path\.(join|resolve)\([^)]*['"`][^'"`]*docs\/(specs|designs)/.test(line) ||
    /\.(includes|startsWith|endsWith)\(\s*['"`][^'"`]*docs\/(specs|designs)/.test(line) ||
    /^\s*(export\s+)?const\s+\w+\s*[:=][^=]*['"`]docs\/(specs|designs)/.test(line)
  );
}

interface Scan {
  readonly functional: string[];
  readonly prose: Map<string, number>;
  readonly filesScanned: number;
}

async function scan(): Promise<Scan> {
  const tracked = (await execFileAsync('git', ['-C', REPO_ROOT, 'ls-files', '*.ts', '*.mjs', '*.js']))
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.includes('node_modules') && !f.endsWith('.test.ts') && !f.includes('__fixtures__'));

  const functional: string[] = [];
  const prose = new Map<string, number>();

  for (const file of tracked) {
    let src: string;
    try {
      src = readFileSync(path.join(REPO_ROOT, file), 'utf-8');
    } catch {
      continue;
    }
    if (!LITERALS.some((l) => src.includes(l))) continue;

    for (const [idx, line] of stripComments(src).split('\n').entries()) {
      if (!LITERALS.some((l) => line.includes(l))) continue;
      if (isFunctionalUse(line)) {
        functional.push(`${file}:${idx + 1}: ${line.trim().slice(0, 140)}`);
      } else {
        prose.set(file, (prose.get(file) ?? 0) + 1);
      }
    }
  }

  return { functional, prose, filesScanned: tracked.length };
}

const result = await scan();

describe('artifact-directory literals have exactly one owner (DR-6)', () => {
  /**
   * A scan that reads no file finds no functional use. This test fails when
   * the glob, the git call, or the comment stripper breaks.
   */
  it('the scan is not vacuous', () => {
    expect(result.filesScanned).toBeGreaterThan(500);
    expect(result.prose.size).toBeGreaterThan(0);
  });

  it('ArtifactDir_NoModuleRetainsAHardCodedLiteral: no unowned functional use', () => {
    const offenders = result.functional.filter(
      (rec) => !FUNCTIONAL_ALLOWLIST.some((allowed) => rec.startsWith(`${allowed}:`)),
    );
    expect(
      offenders,
      'These construct or compare an artifact path from a re-typed literal. Import ' +
        `DEFAULT_SPEC_DIR / DEFAULT_LEGACY_DESIGN_DIR from ${OWNER}, or read ` +
        'ResolvedProjectConfig.artifacts when the project’s configured directory should win.',
    ).toEqual([]);
  });

  it('ArtifactDir_NoModuleRetainsAHardCodedLiteral: the owner really does declare them', () => {
    const owner = readFileSync(path.join(REPO_ROOT, OWNER), 'utf-8');
    expect(owner).toContain("'docs/specs/'");
    expect(owner).toContain("'docs/designs/'");
  });

  it('ArtifactDir_NoModuleRetainsAHardCodedLiteral: rehydrate no longer declares its own', () => {
    const rehydrate = readFileSync(
      path.join(REPO_ROOT, 'src/workflow/rehydrate.ts'),
      'utf-8',
    );
    expect(stripComments(rehydrate)).not.toMatch(/const\s+(UNIFIED_SPEC_DIR|LEGACY_DESIGN_DIR)\s*=/);
  });

  it('agent-facing prose stays within its pinned budget', () => {
    const actual = Object.fromEntries([...result.prose.entries()].sort());
    const expected = Object.fromEntries(Object.entries(PROSE_BUDGET).sort());
    expect(
      actual,
      'Agent-facing text naming docs/specs/ changed. Lowering a count is good — update ' +
        'the table. A new file or a higher count means new prose coupling: prefer wording ' +
        'that does not pin the directory, or record the increase deliberately.',
    ).toEqual(expected);
  });
});
