// The one table of adversarial inputs for the lexer port. The kill fixtures read their inputs
// from this module, so no site writes its own table.
//
// Only the source text is shared. Each site keeps its expectations next to its own assertion,
// because each site has its own retired walk and asks its own question.
//
// A real parse and the retired heuristic disagree on two constructs. The builders
// {@link regexHoldingABacktick} and {@link nestedTemplateSubstitution} make them, and the table
// rows call these builders. A site that builds a construct with its own payload then exercises
// the same construct that the table pins.

/** One adversarial module source, and the lexical construct it is named for. */
export interface AdversarialInput {
  readonly name: string;
  /** The construct with its own `node:*` import payload. */
  readonly source: string;
  /**
   * Builds the same construct with a different payload: the text that the reading site looks for.
   * The construct decides where the payload goes. The backtick-regex row puts it inside the phantom
   * template, and the nested-template row puts it inside the `${…}` substitution. The other rows append it.
   */
  readonly withPayload: (payload: string) => string;
}

const appendPayload =
  (source: string) =>
  (payload: string): string =>
    [source, payload].join('\n');

/**
 * Builds a regex literal that holds a backtick, in a position the retired heuristic scores as division.
 * The backtick then opens a phantom template literal. A template is not line-bounded, so it runs to
 * EOF and hides every line of `payload`.
 */
export function regexHoldingABacktick(payload: string): string {
  return ['export function isTick(s: string): boolean { return /`/.test(s); }', payload].join('\n');
}

/**
 * Builds a template literal nested inside a `${…}` substitution of another one.
 * The retired walks toggle on every backtick, so the inner opening backtick reads as the outer close.
 * The walk then scans the inner body as code.
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

/** The adversarial inputs as data. This is the only copy. */
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
 * Returns the source of the named adversarial input.
 * Throws on an unknown name, because a kill fixture with an empty source passes vacuously.
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
