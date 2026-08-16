// ────────────────────────────────────────────────────────────────────────────
// DR-2 / task 072 — the kill fixture for THIS site's lexer port.
//
// `stripComments` was a hand-rolled character walk until task 072. A port that
// is never shown to DIFFER from what it replaced has not been shown to be
// needed, so the retired walk is kept verbatim in
// `test-helpers/superseded-site-lexers.ts`, assembled here into a lexer, and
// both instruments are run over the SAME inputs with BOTH answers asserted.
//
// The inputs are task 065's, read from the one shared table
// (`test-helpers/adversarial-lexer-inputs.ts`) — DR-2 forbids a fourth. Only the
// PAYLOAD is this site's: a census that hunts `git worktree add` cannot be
// killed by a hidden `node:fs` import.
// @oracle-sources: ./vcs-ownership.ts, ../test-helpers/superseded-site-lexers.ts
// ────────────────────────────────────────────────────────────────────────────

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
 * The census as it behaved BEFORE task 072: the same detection rules, driven by
 * the retired walk.
 *
 * Assembled here rather than exported from the helper. Its only use is measuring
 * the gap; nothing may drive a real census through it.
 */
const SUPERSEDED_LEXER: CommentLexer = (source: string) => ({
  commentMaskedSource: supersededStripComments(source),
});

/**
 * The payload this site looks for, placed by each construct where its defect can
 * act on it.
 *
 * A `git worktree add` written in a COMMENT, followed by real code. The correct
 * answer is "no mutation site" whenever the comment is genuinely a comment —
 * this module's whole reason for stripping comments is that documentation must
 * not be charged as a call.
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
    // KILL — the census INVENTING a mutation. The heuristic scores the `/` as
    // division, the backtick inside the regex opens a phantom template, and a
    // template is not line-bounded — so the `//` below never reads as a comment
    // opener. Comment prose survives the strip and this module reports a
    // `git worktree add` that only the documentation performs.
    name: 'a regex literal containing a BACKTICK, in operand position',
    parse: [],
    heuristic: ['worktree.add'],
  },
  {
    // KILL — the other direction. The payload sits inside a template nested in a
    // `${…}` substitution, so it is STRING CONTENT, and string content is
    // exactly what this census matches on (`['worktree', 'add']` is an argv
    // literal). The heuristic toggled on the nested backtick, read the body as
    // code, and stripped the vector as if it were a comment. The parse keeps
    // literals verbatim and sees it.
    name: 'a nested template literal inside a `${…}` substitution',
    parse: ['worktree.add'],
    heuristic: [],
  },
]);

const mutationsUnder = (lex: CommentLexer, source: string): string[] =>
  detectVcsMutationSites('x/y.ts', source, lex).map((site) => site.mutation);

describe('DR-2 kill fixture — vcs-ownership.stripComments, both instruments', () => {
  it('VcsOwnership_AdversarialSet_ParseAndHeuristicAnswersAreBothPinned', () => {
    // NON-EMPTY, DERIVED DENOMINATOR. The expectation table is checked against
    // the SHARED input table rather than trusted: a row silently dropped from
    // either side would shrink the scan without shrinking the claim.
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

    // The kill fixture's own vacuity guard. A table on which the two instruments
    // never differ would prove the port changed nothing here.
    expect(disagreeing).toEqual([
      'a regex literal containing a BACKTICK, in operand position',
      'a nested template literal inside a `${…}` substitution',
    ]);
  });

  it('VcsOwnership_RegexHoldingABacktick_MakesTheHeuristicChargeCommentProse', () => {
    // Carried to the verdict, in the direction that matters most for an
    // ownership ratchet: a module that performs NO git mutation is reported as
    // performing one, so `VCS_MUTATION_OWNERS` must grow cover for a call that
    // does not exist — or the census goes red over documentation.
    const source = ADVERSARIAL_INPUTS[3]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the backtick construct').toContain('isTick');

    expect(stripComments(source, SUPERSEDED_LEXER)).toContain("'worktree', 'add'");
    expect(stripComments(source, lexModule)).not.toContain("'worktree', 'add'");

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual(['worktree.add']);
    expect(mutationsUnder(lexModule, source)).toEqual([]);
  });

  it('VcsOwnership_NestedTemplateSubstitution_MadeTheHeuristicStripRealLiteralContent', () => {
    // The complementary direction. `stripComments` exists to remove COMMENTS and
    // keep LITERALS — the argv tokens it matches are literals. On a nested
    // template the heuristic did the opposite.
    const source = ADVERSARIAL_INPUTS[4]?.withPayload(PAYLOAD) ?? '';
    expect(source, 'the shared table no longer holds the nested-template construct').toContain(
      '${',
    );

    expect(supersededStripComments(source)).not.toContain("'worktree', 'add'");
    expect(stripComments(source, lexModule)).toContain("'worktree', 'add'");

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(mutationsUnder(lexModule, source)).toEqual(['worktree.add']);
  });

  it('VcsOwnership_ImportTypeQuery_IsNotACountedSurfaceHere', () => {
    // Task 065 flagged `import('p').T` miscounting as likely present in all
    // three surviving sites. It is NOT present here, and the reason is
    // structural rather than lucky: this site extracts no imports at all — its
    // subject is argv literals — so there is no import count to get wrong.
    // Asserted rather than asserted-in-prose: both instruments answer the same,
    // and the module's exported surface holds no specifier accessor.
    const source = [
      "export type H = import('node:fs').Stats;",
      "// historical: run(['merge', '--no-ff'])",
      'export const z = 0;',
    ].join('\n');

    expect(mutationsUnder(SUPERSEDED_LEXER, source)).toEqual([]);
    expect(mutationsUnder(lexModule, source)).toEqual([]);

    // The type query is not code this census can match, and it is preserved
    // verbatim by the strip — it is a literal-bearing expression, not a comment.
    expect(stripComments(source, lexModule)).toContain("import('node:fs')");
  });

  it('VcsOwnership_RecoveredParse_IsRefusedRatherThanSilentlyStripped', () => {
    // Inherited from the port and load-bearing here too: a partial tree loses
    // literal spans, so a module whose argv vectors vanished reads as
    // mutation-free and PASSES the ownership census.
    const broken = "run(['worktree', 'add', p])\nexport const x = {{{;";
    expect(() => stripComments(broken, lexModule)).toThrow(/did not parse cleanly/);
  });

  it('VcsOwnership_NoShippedModuleImportsTheSupersededSiteLexers', () => {
    // The retired walks are retained ONLY as the other half of the measurement
    // above. If shipped source imports them again, the defect is back.
    //
    // The sweep is a filesystem walk; `git ls-files` narrowed to the SAME scope
    // is the independent second authority for its denominator. Comparing the
    // walk with itself would be a comparison that cannot disagree (DR-8).
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
        listTrackedFiles(SRC_ROOT, {
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

    // An IMPORT, not a mention. Naming the retired walk in a header is how the
    // measurement stays findable; importing it is how the defect comes back.
    const offenders = walked.filter((module) =>
      lexModule(readFileSync(join(SRC_ROOT, module), 'utf8'), module).imports.some((ref) =>
        ref.specifier.includes('superseded-site-lexers'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
