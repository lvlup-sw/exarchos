// ─── DR-2 — the ONE adversarial input table for the lexer port (task 072)
//
// Task 065 wrote this table inside `architecture/effect-ledger.test.ts` because
// the effect ledger was the only consumer. Task 072 gave the port three more
// consumers, and DR-2 says what must NOT happen next: *"No fourth adversarial
// table — reuse the existing one."* So the INPUTS live here, once, and every
// kill fixture reads them from this module.
//
// ── Inputs are shared; EXPECTATIONS are not, and cannot be ──────────────────
// Only the source text is common. What the retired heuristic answered is a fact
// about each site's own retired walk — `vcs-ownership.stripComments`,
// `remediation-purity.extractImportSpecifiers` and
// `delivery-safety.maskLiteralsAndComments` are three different walks and answer
// differently — and what the parse answers is a fact about each site's question.
// Both columns therefore stay at the site, next to the assertion that reads
// them. Sharing them would mean one table asserting four things, which is how a
// pinned expectation quietly becomes an unpinned average.
//
// ── Why two rows are BUILT rather than written ──────────────────────────────
// Rows 4 and 5 are the two on which the heuristic and a real parse actually
// disagree, so they are the two every site's kill fixture needs — with the
// SITE'S OWN payload inside, since a census that looks for `git worktree add`
// cannot be killed by a hidden `node:fs` import. They are exposed as
// {@link regexHoldingABacktick} and {@link nestedTemplateSubstitution}, and the
// rows below are built by calling them. A site instantiating a construct with
// its own payload is therefore provably exercising the SAME construct this table
// pins, not a look-alike that drifted.

/** One adversarial module source, and the lexical construct it is named for. */
export interface AdversarialInput {
  readonly name: string;
  /** The construct as task 065 wrote it, with its own `node:*` import payload. */
  readonly source: string;
  /**
   * The same construct carrying a DIFFERENT payload — the one the reading site
   * actually looks for.
   *
   * A census that hunts `git worktree add` cannot be killed by a hidden
   * `node:fs` import, so each site needs the construct to act on its own
   * subject. Where the payload has to GO is a property of the construct, not of
   * the site: inside the phantom template for row 4, inside the `${…}`
   * substitution for row 5, and simply appended for the rows whose defect (or
   * absence of one) does not depend on position. Encapsulating that here is what
   * lets four sites share one table instead of each writing a look-alike.
   */
  readonly withPayload: (payload: string) => string;
}

const appendPayload =
  (source: string) =>
  (payload: string): string =>
    [source, payload].join('\n');

/**
 * A regex literal containing a BACKTICK, in a position the retired
 * regex-versus-division heuristic scores as DIVISION.
 *
 * The backtick then opens a phantom template literal, and — unlike `'`/`"`,
 * which are line-bounded — a template is not, so it runs to EOF and swallows
 * every line of `payload`. Whatever the site was supposed to see below this
 * line, it does not see.
 */
export function regexHoldingABacktick(payload: string): string {
  return ['export function isTick(s: string): boolean { return /`/.test(s); }', payload].join('\n');
}

/**
 * A template literal nested inside a `${…}` substitution of another one.
 *
 * The retired walks TOGGLE on every backtick, so the nested template's opening
 * backtick reads as the outer one's close and its body is scanned as code. The
 * site sees text that is not code and reports something that is not there.
 */
export function nestedTemplateSubstitution(payload: string): string {
  return `export const doc = \`outer \${ \`inner ${payload} text\` } end\`;`;
}

const COMMENT_OPENER_IN_A_STRING = [
  "export const doc = 'note: // import x from \\'node:child_process\\'';",
  "import { readFile } from 'node:fs';",
  'export const read = readFile;',
].join('\n');

const UNBALANCED_BLOCK_COMMENT_ACROSS_TEMPLATES = [
  'export const head = `a /* b`;',
  "export const tail = `c */ import x from 'node:child_process'`;",
  "import { readFile } from 'node:fs';",
  'export const read = readFile;',
].join('\n');

const REGEX_HOLDING_A_QUOTE = [
  "export const RE = /['\"]/;",
  "import { readFile } from 'node:fs';",
  'export const read = readFile;',
].join('\n');

/** Task 065's adversarial set, as DATA. The only copy. */
export const ADVERSARIAL_INPUTS: readonly AdversarialInput[] = Object.freeze([
  Object.freeze({
    name: 'a `//` comment opener inside a string literal',
    source: COMMENT_OPENER_IN_A_STRING,
    withPayload: appendPayload(COMMENT_OPENER_IN_A_STRING),
  }),
  Object.freeze({
    name: 'an unbalanced `/* */` pair split across two template literals',
    source: UNBALANCED_BLOCK_COMMENT_ACROSS_TEMPLATES,
    withPayload: appendPayload(UNBALANCED_BLOCK_COMMENT_ACROSS_TEMPLATES),
  }),
  Object.freeze({
    name: "a regex literal containing a ' quote, in operand position",
    source: REGEX_HOLDING_A_QUOTE,
    withPayload: appendPayload(REGEX_HOLDING_A_QUOTE),
  }),
  Object.freeze({
    name: 'a regex literal containing a BACKTICK, in operand position',
    source: regexHoldingABacktick(
      ["import { readFile } from 'node:fs';", 'export const read = readFile;'].join('\n'),
    ),
    withPayload: regexHoldingABacktick,
  }),
  Object.freeze({
    name: 'a nested template literal inside a `${…}` substitution',
    source: nestedTemplateSubstitution("from 'node:child_process'"),
    withPayload: nestedTemplateSubstitution,
  }),
]);

/**
 * The source of the named adversarial input.
 *
 * Throws rather than returning `undefined` on a name that is not in the table:
 * a kill fixture handed an empty source passes for the same reason a fixed site
 * does, which is exactly the vacuity these fixtures exist to detect.
 */
export function adversarialInput(name: string): string {
  const row = ADVERSARIAL_INPUTS.find((input) => input.name === name);
  if (row === undefined) {
    const known = ADVERSARIAL_INPUTS.map((input) => `"${input.name}"`).join(', ');
    throw new Error(
      `adversarialInput: no input named "${name}". A kill fixture reading a ` +
        `missing input would assert over an empty source and pass vacuously. Known: ${known}.`,
    );
  }
  return row.source;
}
