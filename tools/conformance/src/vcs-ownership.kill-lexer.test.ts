// Kill fixture for the lexer port of `stripComments` in `vcs-ownership.ts`.
// The retired character walk stays in `tools/test-helpers/superseded-site-lexers.ts`. This file runs
// it and the port over the same inputs and asserts both answers, so the port is shown to differ.
// The inputs come from the shared table in `tools/test-helpers/adversarial-lexer-inputs.ts`.
// Only the payload belongs to this site, because this census looks for `git worktree add`.
// @oracle-sources: ./vcs-ownership.ts, ../../test-helpers/superseded-site-lexers.ts

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  detectVcsMutationSites,
  stripComments,
  isScannableFile,
  EXCLUDED_DIRS,
  type CommentLexer,
} from './vcs-ownership.js';
import { lexModule } from '../../test-helpers/module-lexer.js';
import { supersededStripComments } from '../../test-helpers/superseded-site-lexers.js';
import { ADVERSARIAL_INPUTS } from '../../test-helpers/adversarial-lexer-inputs.js';
import { listTrackedFiles, trackedFilesMissedBy } from '../../test-helpers/tracked-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The census detection rules, driven by the retired walk.
 * It exists to measure the difference. A real census must not use it.
 */
const SUPERSEDED_LEXER: CommentLexer = (source: string) => ({
  commentMaskedSource: supersededStripComments(source),
});

/**
 * A `git worktree add` in a comment, followed by real code. Each construct places it where its defect acts.
 * When the comment is a real comment, the correct answer is "no mutation site", because documentation is not a call.
 */
const PAYLOAD = ["// doc: run(['worktree', 'add', path])", 'export const after = 1;'].join('\n');

/** What each instrument answers for {@link PAYLOAD} carried by each construct. */
const EXPECTATIONS: readonly {
  readonly name: string;
  readonly parse: readonly string[];
  readonly heuristic: readonly string[];
}[] = Object.freeze([
  { name: 'a `//` comment opener inside a string literal', parse: [], heuristic: [] },
  {
    name: 'an unbalanced `/* */` pair split across two template literals',
    parse: [],
    heuristic: [],
  },
  { name: "a regex literal containing a ' quote, in operand position", parse: [], heuristic: [] },
  {
    /**
     * Kill: the heuristic invents a mutation. It scores the `/` as division, so the backtick opens a phantom template.
     * The `//` after it then does not read as a comment opener, and the comment prose survives the strip.
     */
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: [],
    heuristic: ['worktree.add'],
  },
  {
    /**
     * Kill in the other direction: the payload is string content in a template nested in a `${…}` substitution.
     * This census matches string content. The heuristic read the nested body as code and stripped the payload as a comment.
     * The parse keeps literals as written and finds the payload.
     */
    name: 'a nested template literal inside a `${…}` substitution',
    parse: ['worktree.add'],
    heuristic: [],
  },
]);

const mutationsUnder = (lex: CommentLexer, source: string): string[] =>
  detectVcsMutationSites('x/y.ts', source, lex).map((site) => site.mutation);

describe('DR-2 kill fixture — vcs-ownership.stripComments, both instruments', () => {
  /**
   * Checks the expectation table against the shared input table, so a dropped row on either side fails.
   * The two instruments must disagree on some rows, or the port changed nothing here.
   */
  it('VcsOwnership_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    expect(ADVERSARIAL_INPUTS.length).toBeGreaterThan(0);
    expect(EXPECTATIONS.map((row) => row.name)).toEqual(
      ADVERSARIAL_INPUTS.map((input) => input.name),
    );

    const disagreeing: string[] = [];
    for (const [index, input] of ADVERSARIAL_INPUTS.entries()) {
      const row = EXPECTATIONS[index];
      if (row === undefined) throw new Error(`no expectation for "${input.name}"`);
      const source = input.withPayload(PAYLOAD);
      const parsed = mutationsUnder(lexModule, source);
      const heuristic = mutationsUnder(SUPERSEDED_LEXER, source);
      expect(parsed, `${row.name} — parse`).toEqual([...row.parse]);
      expect(heuristic, `${row.name} — heuristic`).toEqual([...row.heuristic]);
      if (JSON.stringify(parsed) !== JSON.stringify(heuristic)) disagreeing.push(row.name);
    }

    expect(disagreeing).toEqual([
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  /**
   * Under the heuristic, a module with no git mutation reads as one. `VCS_MUTATION_OWNERS` then needs
   * cover for a call that does not exist, or the census fails on documentation.
   */
  it('VcsOwnership_RegexHoldingABacktick_MakesTheHeuristicChargeCommentProse', () => {
    const source = ADVERSARIAL_INPUTS[3]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the backtick construct').toContain('isTick');

    expect(stripComments(source, SUPERSEDED_LEXER)).toContain("'worktree', 'add'");
    expect(stripComments(source, lexModule)).not.toContain("'worktree', 'add'");

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual(['worktree.add']);
    expect(mutationsUnder(lexModule, source)).toEqual([]);
  });

  /** `stripComments` must remove comments and keep literals. On a nested template, the heuristic does the opposite. */
  it('VcsOwnership_NestedTemplateSubstitution_MadeTheHeuristicStripRealLiteralContent', () => {
    const source = ADVERSARIAL_INPUTS[4]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the nested-template construct').toContain(
      '${',
    );

    expect(supersededStripComments(source)).not.toContain("'worktree', 'add'");
    expect(stripComments(source, lexModule)).toContain("'worktree', 'add'");

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(mutationsUnder(lexModule, source)).toEqual(['worktree.add']);
  });

  /**
   * An `import('p').T` type query cannot be miscounted here, because this site extracts no imports.
   * Its subject is argv literals. The strip keeps the type query as written.
   */
  it('VcsOwnership_ImportTypeQuery_IsNotACountedSurfaceHere', () => {
    const source = [
      "export type H = import('node:fs').Stats;",
      "// historical: run(['merge', '--no-ff'])",
      'export const z = 0;',
    ].join('\n');

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(mutationsUnder(lexModule, source)).toEqual([]);

    expect(stripComments(source, lexModule)).toContain("import('node:fs')");
  });

  /** A partial tree loses literal spans, so a module with lost argv vectors reads as mutation-free. */
  it('VcsOwnership_RecoveredParse_IsRefusedRatherThanSilentlyStripped', () => {
    const broken = "run(['worktree', 'add', p])\nexport const x = {{{;";
    expect(() => stripComments(broken, lexModule)).toThrow(/did not parse cleanly/);
  });

  /**
   * The retired walks exist for the measurement above, so a shipped module must not import them.
   * `git ls-files` over the same scope is the second authority for the denominator of the filesystem walk.
   * The check reads imports, not mentions, because a header can name a retired walk.
   */
  it('VcsOwnership_NoShippedModuleImportsTheSupersededSiteLexers', async () => {
    const walked: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(SRC_ROOT, dir), { withFileTypes: true })) {
        const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) walk(rel);
        } else if (entry.isFile() && isScannableFile(entry.name)) {
          walked.push(rel);
        }
      }
    };
    walk('');

    expect(walked.length).toBeGreaterThan(0);
    expect(
      trackedFilesMissedBy(
        walked,
        await listTrackedFiles(SRC_ROOT, {
          exclude: (path) => {
            const segments = path.split('/');
            const name = segments[segments.length - 1] ?? '';
            return (
              segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir)) || !isScannableFile(name)
            );
          },
        }),
      ),
      'the superseded-site-lexer sweep did not reach every tracked module in its ' +
        'scope — a shipped import of a retired walk could sit in the gap',
    ).toEqual([]);

    const offenders = walked.filter((module) =>
      lexModule(readFileSync(join(SRC_ROOT, module), 'utf8'), module).imports.some((ref) =>
        ref.specifier.includes('superseded-site-lexers'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
