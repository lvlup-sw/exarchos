// The detectors of the suite invariants.
//
// Each rule returns `Violation[]`. `suite-invariants.test.ts` proves each rule
// with a pair of in-memory fixtures: a positive that must fire and a negative
// that must not. A corpus sweep that reports zero violations has meaning only
// when the same run shows that the detector can report one.

import { sourceViews, codeAndStrings, lineOf } from './source-view.js';
import { matchedShapes } from './shapes.js';
import { resolveSpecifier, reachesModule } from './corpus.js';

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

export interface OracleDeclaration {
  readonly offset: number;
  readonly line: number;
  readonly authorities: readonly string[];
}

const ORACLE_ANNOTATION = /@oracle-sources:[ \t]*([^\r\n]*)/g;

/**
 * Parses the oracle-sources tag lines of a file. It reads the comment view
 * only, so a string literal in a test body is never a declaration.
 *
 * A tag line holds the tag, a colon, and the authorities as a comma-separated
 * list. The list stops at the end of the line. Each tag line is one
 * declaration.
 */
export function parseOracleDeclarations(source: string): readonly OracleDeclaration[] {
  const { comments } = sourceViews(source);
  const out: OracleDeclaration[] = [];
  ORACLE_ANNOTATION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ORACLE_ANNOTATION.exec(comments)) !== null) {
    const authorities = (m[1] ?? '')
      .split(',')
      .map((a) => a.trim().replace(/^\*+\s*/, '').trim())
      .filter((a) => a.length > 0);
    out.push({ offset: m.index, line: lineOf(source, m.index), authorities });
  }
  return out;
}

/**
 * Returns true when an authority token looks like a file path or a module
 * path. Such a token starts with `.` or `/`, or it ends in a known file
 * extension. Each other token is a label, so a prose label must not end in a
 * file name.
 */
export function isPathAuthority(token: string): boolean {
  return /^[./]/.test(token) || /\.(ts|tsx|js|mjs|json|md|ya?ml)$/.test(token);
}

export interface DerivationPair {
  readonly a: string;
  readonly b: string;
  readonly note: string;
}

export interface OracleRuleOptions {
  /**
   * Pairs of non-path authority labels with a known derivation that the import
   * graph cannot show. They are declared, not inferred (see `LIMITATIONS.md`).
   */
  readonly knownDerivations?: readonly DerivationPair[];
}

function normaliseOpaque(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Rules R1 to R4, the oracle-sources family. R2 to R4 apply to each tag line.
 *
 * - R1 `oracle-sources-missing`: the file is in scope and declares nothing.
 * - R2 `oracle-sources-too-few`: fewer than two distinct authorities. Tokens
 *   that resolve to one file, or that normalise to one label, are one authority.
 * - R3 `oracle-sources-derived`: one authority is reachable from another, in
 *   the static import graph for paths or in `knownDerivations` for labels.
 * - R4 `oracle-sources-unresolvable`: a path-shaped authority is not a file.
 *   A path resolves from the directory of the file that declares it.
 *
 * Scope comes from the assertion shapes alone (see `shapes.ts`), so a deleted
 * annotation does not remove a file from scope.
 */
export function checkOracleSources(
  file: string,
  source: string,
  opts: OracleRuleOptions = {},
): readonly Violation[] {
  const violations: Violation[] = [];
  const shapes = matchedShapes(source);
  const inScope = shapes.length > 0;
  const decls = parseOracleDeclarations(source);

  if (inScope && decls.length === 0) {
    violations.push({
      rule: 'oracle-sources-missing',
      file,
      line: 1,
      detail: `in scope via assertion shape(s) [${shapes.join(', ')}] but declares no \`@oracle-sources\`. Scope is determined by assertion shape, not by the annotation — deleting the annotation cannot remove a file from scope.`,
    });
  }

  for (const decl of decls) {
    const resolved = new Map<string, string | undefined>();
    for (const token of decl.authorities) {
      if (!isPathAuthority(token)) continue;
      const abs = resolveSpecifier(file, token.startsWith('.') ? token : `./${token}`);
      resolved.set(token, abs);
      if (abs === undefined) {
        violations.push({
          rule: 'oracle-sources-unresolvable',
          file,
          line: decl.line,
          detail: `declared authority \`${token}\` looks like a module path but does not resolve to a file`,
        });
      }
    }

    const identities = decl.authorities.map((t) => {
      const abs = resolved.get(t);
      return abs !== undefined ? `file:${abs}` : `label:${normaliseOpaque(t)}`;
    });
    const distinct = new Set(identities);
    if (distinct.size < 2) {
      violations.push({
        rule: 'oracle-sources-too-few',
        file,
        line: decl.line,
        detail: `declares ${distinct.size} distinct ${distinct.size === 1 ? 'authority' : 'authorities'} (${decl.authorities.join(' | ') || '<none>'}); DR-30 requires at least two. A single-source comparison can never disagree with itself.`,
      });
      continue;
    }

    const pathTokens = decl.authorities.filter((t) => resolved.get(t) !== undefined);
    for (let i = 0; i < pathTokens.length; i += 1) {
      for (let j = 0; j < pathTokens.length; j += 1) {
        if (i === j) continue;
        const a = pathTokens[i] as string;
        const b = pathTokens[j] as string;
        const absA = resolved.get(a) as string;
        const absB = resolved.get(b) as string;
        if (absA === absB) continue;
        if (reachesModule(absA, absB)) {
          violations.push({
            rule: 'oracle-sources-derived',
            file,
            line: decl.line,
            detail: `declared authority \`${b}\` is reachable from \`${a}\` in the static import graph — they are one authority wearing two names, not two.`,
          });
        }
      }
    }

    for (const pair of opts.knownDerivations ?? []) {
      const has = (t: string): boolean =>
        decl.authorities.some((x) => normaliseOpaque(x) === normaliseOpaque(t));
      if (has(pair.a) && has(pair.b)) {
        violations.push({
          rule: 'oracle-sources-derived',
          file,
          line: decl.line,
          detail: `declared authorities \`${pair.a}\` and \`${pair.b}\` are a registered derivation pair: ${pair.note}`,
        });
      }
    }
  }

  return violations;
}

export interface TestBlock {
  readonly name: string;
  /** Offset of the `it(`/`test(` token. */
  readonly start: number;
  /** Offset just past the block's closing paren. */
  readonly end: number;
  /** Offset of the block comment directly above the test, or `start` when there is none. */
  readonly docStart: number;
}

const TEST_OPENER =
  /\b(?:it|test)\s*(?:\.\s*(?:each\s*(?:\([^)]*\))?|only|skip|todo|concurrent|sequential|fails|runIf|skipIf)\s*(?:\([^)]*\))?\s*)*\(/g;

function matchParen(code: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i += 1) {
    const c = code[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/**
 * Splits a test file into `it(...)` and `test(...)` blocks. It balances
 * parentheses over the code view, so a parenthesis in a string or a comment
 * has no effect. Each block also records the block comment directly above it,
 * because the suite writes its `BLOCKING ARM` and `NEGATIVE TWIN` prose there.
 * A `//` line comment above the test, or a comment above a `describe` call, is
 * not part of a block. The code view blanks string bodies, so the test name
 * comes from the raw source.
 */
export function extractTestBlocks(source: string): readonly TestBlock[] {
  const { code } = sourceViews(source);
  const blocks: TestBlock[] = [];
  TEST_OPENER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEST_OPENER.exec(code)) !== null) {
    const openIdx = m.index + m[0].length - 1;
    const end = matchParen(code, openIdx);
    const nameMatch = /^\s*\(\s*['"`]([^'"`]*)/.exec(code.slice(openIdx, openIdx + 200));
    const rawName = /['"`]([^'"`]*)['"`]/.exec(source.slice(openIdx, openIdx + 200));
    let docStart = m.index;
    const before = source.slice(0, m.index);
    const trimmed = before.replace(/[\s]*$/, '');
    if (trimmed.endsWith('*/')) {
      const openDoc = trimmed.lastIndexOf('/*');
      if (openDoc >= 0) docStart = openDoc;
    }
    blocks.push({
      name: (rawName?.[1] ?? nameMatch?.[1] ?? '<anonymous>').trim(),
      start: m.index,
      end,
      docStart,
    });
    TEST_OPENER.lastIndex = Math.max(TEST_OPENER.lastIndex, end);
  }
  return blocks;
}

/**
 * R5: each blocking claim declares the seam that its kill fixture kills.
 *
 * The convention of the suite pairs a `BLOCKING ARM` comment with a
 * `NEGATIVE TWIN` comment. The twin is the kill fixture. It proves that the
 * guard, not the setup, causes the blocking assertion.
 *
 * The rule reads the comments of a test block and the block comment directly
 * above it. A block with a blocking claim must name the seam. The seam text
 * follows a `NEGATIVE TWIN` marker, or a `@kill-seam` annotation and its
 * colon, on the same line. Without divider characters, that text needs at
 * least `MIN_SEAM_CHARS` characters, so a bare divider declares no seam.
 */
export const BLOCKING_CLAIM_MARKER = /\bBLOCKING(?:\s+(?:ARM|CLAIM|arm|claim))\b|@blocking-claim\b/;
export const KILL_SEAM_ANNOTATION = /@kill-seam:[ \t]*([^\r\n]*)/g;
export const NEGATIVE_TWIN_MARKER = /\bNEGATIVE\s+TWIN\b([^\r\n]*)/g;
export const MIN_SEAM_CHARS = 12;

function seamProse(text: string): string {
  return text.replace(/[─\-=*/:()[\]|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function checkBlockingClaims(file: string, source: string): readonly Violation[] {
  const { comments } = sourceViews(source);
  const out: Violation[] = [];
  for (const block of extractTestBlocks(source)) {
    const scope = comments.slice(block.docStart, block.end);
    if (!BLOCKING_CLAIM_MARKER.test(scope)) continue;

    let best = '';
    KILL_SEAM_ANNOTATION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = KILL_SEAM_ANNOTATION.exec(scope)) !== null) {
      const prose = seamProse(m[1] ?? '');
      if (prose.length > best.length) best = prose;
    }
    NEGATIVE_TWIN_MARKER.lastIndex = 0;
    while ((m = NEGATIVE_TWIN_MARKER.exec(scope)) !== null) {
      const prose = seamProse(m[1] ?? '');
      if (prose.length > best.length) best = prose;
    }

    if (best.length < MIN_SEAM_CHARS) {
      out.push({
        rule: 'blocking-claim-without-kill-fixture',
        file,
        line: lineOf(source, block.start),
        detail: `test \`${block.name}\` raises a BLOCKING claim but declares no seam for its kill fixture (found ${best.length ? `only "${best}"` : 'nothing'}; need \`@kill-seam: <seam>\` or a NEGATIVE TWIN marker naming the seam, ≥${MIN_SEAM_CHARS} chars).`,
      });
    }
  }
  return out;
}

/**
 * R6: no test asserts `passed === true` on a verdict that did not run.
 *
 * The defect: a probe that did not run reports through the same channel as a
 * probe that ran and passed. The rule reads one test block with the comments
 * blank and the string bodies kept, because a verdict is usually a string. It
 * fires on a match of `PASSED_TRUE_ASSERT`, such as
 * `expect(<subject>.passed).toBe(true)`, in two cases:
 * - the subject itself matches `COULD_NOT_RUN_MARKER`
 * - the subject is one identifier, and its initializer in the block matches
 *
 * The rule does not fire on a block that only builds such a carrier to prove
 * that the system rejects it.
 */
export const COULD_NOT_RUN_MARKER =
  /\b(?:couldNotRun|could_not_run|COULD_NOT_RUN|could-not-run|could not run|didNotRun|did_not_run|notRun|not_run|NOT_RUN|not-run|unavailable|UNAVAILABLE|indeterminate|INDETERMINATE|neverRan|never_ran)\b/;

const PASSED_TRUE_ASSERT =
  /expect\s*\(\s*([\s\S]{0,600}?)\.\s*passed\s*\)\s*\.\s*(?:toBe\s*\(\s*true\s*\)|toEqual\s*\(\s*true\s*\)|toStrictEqual\s*\(\s*true\s*\)|toBeTruthy\s*\(\s*\))/g;


export function checkCouldNotRunVerdicts(file: string, source: string): readonly Violation[] {
  const view = codeAndStrings(source);
  const out: Violation[] = [];

  for (const block of extractTestBlocks(source)) {
    const scope = view.slice(block.start, block.end);

    PASSED_TRUE_ASSERT.lastIndex = 0;
    let m: RegExpExecArray | null;
    const flagged = new Set<string>();
    while ((m = PASSED_TRUE_ASSERT.exec(scope)) !== null) {
      const subject = (m[1] ?? '').trim();
      if (flagged.has(subject)) continue;

      if (COULD_NOT_RUN_MARKER.test(subject)) {
        flagged.add(subject);
        out.push({
          rule: 'passed-true-on-could-not-run',
          file,
          line: lineOf(source, block.start + m.index),
          detail: `test \`${block.name}\` asserts \`passed === true\` over an expression that is itself a could-not-run verdict: \`${subject.replace(/\s+/g, ' ').slice(0, 120)}\`.`,
        });
        continue;
      }

      const root = /^([A-Za-z_$][\w$]*)$/.exec(subject)?.[1];
      if (!root) continue;
      const bind = new RegExp(
        String.raw`(?:const|let|var)\s+${root}\b[^=;]{0,120}=\s*([\s\S]{0,800}?);`,
      ).exec(scope);
      const init = bind?.[1] ?? '';
      if (init && COULD_NOT_RUN_MARKER.test(init)) {
        flagged.add(subject);
        out.push({
          rule: 'passed-true-on-could-not-run',
          file,
          line: lineOf(source, block.start + m.index),
          detail: `test \`${block.name}\` asserts \`${root}.passed === true\` but \`${root}\` is bound to a could-not-run verdict in the same block.`,
        });
      }
    }
  }
  return out;
}

/**
 * R7: the integration tier must not synthesize its own root.
 *
 * The rule fires on an object that a file types as `DispatchContext` by an
 * annotation, a cast or `satisfies`. It also fires on a `vi.mock` of a
 * composite module. Without this rule, a file can give `dispatch` an object
 * literal as its context, and no test fails. The harness is the one module
 * that builds the context, and it uses the production composition root.
 *
 * The rule has no scope of its own: the caller selects the files. The mock
 * check reads the view with string bodies, because its subject is a module
 * specifier.
 */
const DISPATCH_CONTEXT_LITERAL =
  /:\s*DispatchContext\s*=\s*\{|as\s+DispatchContext\s*[;,)]|<\s*DispatchContext\s*>\s*\{|satisfies\s+DispatchContext/;
const COMPOSITE_MODULE_MOCK =
  /vi\s*\.\s*mock\s*\(\s*['"][^'"]*(?:core\/dispatch|core\/context|registry|index)(?:\.js)?['"]/;

export function checkNoSynthesizedRoot(file: string, source: string): readonly Violation[] {
  const { code } = sourceViews(source);
  const withStrings = codeAndStrings(source);
  const out: Violation[] = [];
  if (DISPATCH_CONTEXT_LITERAL.test(code)) {
    out.push({
      rule: 'synthesized-dispatch-context',
      file,
      line: 1,
      detail:
        'constructs a `DispatchContext` by object literal/cast. The integration tier must obtain its context from the production composition root via `createPublicRootHarness()` (DR-27).',
    });
  }
  if (COMPOSITE_MODULE_MOCK.test(withStrings)) {
    out.push({
      rule: 'composite-module-mocked',
      file,
      line: 1,
      detail:
        '`vi.mock`s a composite module (dispatch/context/registry/index). The integration tier proves the real wiring; mocking the wiring proves nothing (DR-27).',
    });
  }
  return out;
}
