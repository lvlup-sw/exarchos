/**
 * No gate module invents a base branch.
 *
 * Ten of the modules under `src/verbs/gates/` defaulted the diff base to the
 * literal `'main'`. That is a name a governed repository need not have, and a
 * gate that diffs against a branch which does not exist reports a scope it
 * never measured — the failure is silent in both directions, because a
 * repository whose trunk is `master`, `develop` or `trunk` gets either an empty
 * diff (nothing flagged, reads as a pass) or a git error the gate converts into
 * its own vocabulary.
 *
 * The replacement is `resolveBaseBranch`, which answers with a DETECTED name or
 * a typed `unresolved`. This file is what keeps the eleventh site from being
 * written: the literal is cheap to reach for, the seam is one import away, and
 * nothing else in the tree can tell the two apart.
 *
 * Scope is `src/verbs/gates/` deliberately. Other trees still carry the
 * literal — `verbs/review/review-diff.ts`, `verbs/tasks/extract-intent.ts` and
 * `verbs/team/prepare-synthesis.ts` each hold one — and pinning them here as
 * expected offenders would turn this guard vacuous the moment they are fixed.
 * They are named in prose so a reader knows the sweep is partial, not complete.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATES_DIR = fileURLToPath(new URL('../../src/verbs/gates/', import.meta.url));

/**
 * A base-branch default written as a literal: `?? 'main'`, `|| "main"`, or the
 * same with the name spelled `master`.
 *
 * Matching the DEFAULTING form rather than the bare string is what keeps this
 * from firing on the many legitimate mentions of the word — a comment, an error
 * message, a test fixture name. The two operators are the whole vocabulary a
 * fallback is written in.
 */
const LITERAL_BASE_DEFAULT = /(?:\?\?|\|\|)\s*(['"`])(?:main|master)\1/;

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Scan a set of `name -> source` pairs.
 *
 * Takes its subject as an argument so the same matcher the live assertion runs
 * can be pointed at a seeded violation. A guard nobody has watched fail is a
 * guard nobody has checked.
 */
function findLiteralBaseDefaults(sources: ReadonlyMap<string, string>): Offender[] {
  const offenders: Offender[] = [];
  for (const [file, source] of sources) {
    source.split('\n').forEach((text, index) => {
      if (LITERAL_BASE_DEFAULT.test(text)) {
        offenders.push({ file, line: index + 1, text: text.trim() });
      }
    });
  }
  return offenders;
}

function gateSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const entry of readdirSync(GATES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    sources.set(entry.name, readFileSync(join(GATES_DIR, entry.name), 'utf-8'));
  }
  return sources;
}

describe('Base-branch resolution: the gate surface never invents a branch', () => {
  it('NoGateModule_ContainsALiteralMainFallback', () => {
    const sources = gateSources();

    // Guard the guard on the DENOMINATOR: a glob that stopped matching, or a
    // directory that moved, would report zero offenders for the same reason a
    // clean tree does.
    expect(
      sources.size,
      'no gate modules were read — the scan resolved nothing, so an empty result proves nothing',
    ).toBeGreaterThan(30);

    const offenders = findLiteralBaseDefaults(sources);
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      'a gate must not default its diff base to a literal branch name — call ' +
        '`resolveDiffBase(repoRoot, args.baseBranch)` and, when it answers ' +
        '`unresolved`, report the cause in the gate\'s own verdict vocabulary ' +
        '(inconclusive, or the fail-closed cause its policy already names). ' +
        'Whichever it is, still emit the row the action declares',
    ).toEqual([]);
  });

  it('SeededLiteralFallback_IsDetected', () => {
    // The same matcher, over a subject that must fail. Without this the
    // assertion above is green whether the pattern works or not.
    const seeded = new Map([
      ['seeded-nullish.ts', "  const baseRef = args.baseBranch ?? 'main';\n"],
      ['seeded-or.ts', '  const baseBranch = args.baseBranch || "master";\n'],
    ]);

    expect(findLiteralBaseDefaults(seeded).map((o) => o.file).sort()).toEqual([
      'seeded-nullish.ts',
      'seeded-or.ts',
    ]);
  });

  it('MentioningTheBranchName_IsNotAViolation', () => {
    // The matcher targets the defaulting form, not the word. A gate is free to
    // name a branch in a message, a comment, or a comparison.
    const innocent = new Map([
      ['comment.ts', "// the repository's trunk is usually called 'main'\n"],
      ['comparison.ts', "  if (branch === 'main') return true;\n"],
      ['message.ts', "  return `no such branch: 'main'`;\n"],
    ]);

    expect(findLiteralBaseDefaults(innocent)).toEqual([]);
  });
});
