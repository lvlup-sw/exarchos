import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Artifact-directory literal scan (DR-6, task 005) ────────────────────────
//
// `docs/specs/` and `docs/designs/` used to be re-typed wherever they were
// needed. Task 005 gave them one owner (`config/artifacts.ts`); this scan is
// what keeps them there, because the coupling re-accumulates silently — a new
// `path.join(root, 'docs/specs')` looks perfectly ordinary in review.
//
// Two tiers, because the two failure modes are different:
//
//   1. FUNCTIONAL — the literal drives a path construction, a prefix
//      comparison, or a directory constant. This is the real coupling: it makes
//      a configured directory unreachable. The allowlist is closed.
//   2. PROSE — the literal appears in agent-facing text (tool descriptions,
//      phase playbooks, error messages). It shapes behaviour without gating it,
//      so it is a known, bounded debt rather than a defect. Pinned per file so
//      new prose coupling is visible; task 021+ retires it with the docs move.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../');

const LITERALS = ['docs/specs', 'docs/designs'] as const;

/**
 * The single owner of the two prefixes. Every other module must import from
 * here rather than re-declaring the string.
 */
const OWNER = 'src/config/artifacts.ts';

/**
 * The only files allowed a functional literal.
 *
 *   - the OWNER, which is where the two defaults are declared;
 *   - `guard-inventory.ts`, which pins ONE named historical document rather
 *     than the tree — it could not follow a project's configured
 *     `artifacts.spec-dir` even in principle, because it names a specific file
 *     at a specific path in this repository's history.
 */
const FUNCTIONAL_ALLOWLIST: ReadonlyArray<string> = [OWNER, 'tools/audit/gates/guard-inventory.ts'];

/**
 * Agent-facing prose carrying the literal, file → occurrence count. A ratchet:
 * lowering an entry is always welcome, raising one (or adding a file) must be a
 * deliberate edit to this table.
 */
const PROSE_BUDGET: Readonly<Record<string, number>> = {
  'tools/audit/gates/check-measured-premises.mjs': 1,
  'tools/evals/evals/benchmarks/plan-format-corpus.ts': 1,
  'src/verbs/gates/design-completeness.ts': 1,
  'src/verbs/tasks/discover-bridge.ts': 1,
  'src/verbs/team/prepare-review.ts': 1,
  // These three replace a single `src/registry.ts: 1` entry. The registry's
  // action declarations were split across modules and the count rose 1 -> 4
  // with no new prose: the same six occurrences exist (four in descriptions,
  // two in comments), verbatim.
  //
  // The old count was low because `stripComments` pairs `/*` with the NEXT
  // `*/` across the whole file. Run against the 4,587-line original it blanked
  // the regions three of the four sat in — measured directly: the original
  // strips to one surviving line, the three modules below to four between
  // them, from identical text. So this is the honest count becoming visible,
  // and the budget it ratchets against is now a real one.
  'src/registry/actions/workflow.ts': 1,
  'src/registry/actions/orchestrate/gates.ts': 2,
  'src/registry/actions/orchestrate/review-ops.ts': 1,
  'src/workflow/playbooks.ts': 2,
  'tests/helpers/preflight.ts': 1,
  'tools/audit/measure-reference-census.mjs': 1,
};

/**
 * Blank out comments while preserving line numbers, so a literal explaining the
 * convention in a JSDoc block is never mistaken for one driving behaviour.
 */
function stripComments(src: string): string {
  const blockless = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return blockless
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      if (i === -1) return line;
      const before = line.slice(0, i);
      // Inside an unterminated string (a URL, a glob) — not a comment.
      if ((before.match(/['"`]/g) ?? []).length % 2 === 1) return line;
      if (before.endsWith(':') || before.endsWith('/')) return line;
      return before;
    })
    .join('\n');
}

/** Does this line USE the literal, rather than merely mention it? */
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

function scan(): Scan {
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*.ts', '*.mjs', '*.js'], {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
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

describe('artifact-directory literals have exactly one owner (DR-6)', () => {
  const result = scan();

  it('the scan is not vacuous', () => {
    // A scan that walks nothing passes everything. If the glob, the git call,
    // or the comment stripper breaks, this is the test that says so.
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
