// ─── The DR-30 detectors ────────────────────────────────────────────────────
//
// Five independent rules, each returning `Violation[]`. Every rule is proved
// live by an in-memory fixture pair (a positive that MUST fire and a negative
// that MUST NOT) in `suite-invariants.test.ts`. That fixture pairing is the
// anti-vacuity mechanism: a corpus sweep that reports "0 violations" is only
// meaningful if the detector that produced the 0 has been shown to be capable
// of producing a 1.

import { sourceViews, codeAndStrings, lineOf } from './source-view.js';
import { matchedShapes } from './shapes.js';
import { resolveSpecifier, reachesModule } from './corpus.js';

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
  readonly detail: string;
}

// ─── @oracle-sources annotation ─────────────────────────────────────────────

export interface OracleDeclaration {
  readonly offset: number;
  readonly line: number;
  readonly authorities: readonly string[];
}

const ORACLE_ANNOTATION = /@oracle-sources:[ \t]*([^\r\n]*)/g;

/**
 * Parse `// @oracle-sources: a, b` declarations. Read from the COMMENT view
 * only, so a string literal in a test body can never masquerade as a
 * governance declaration.
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

/** Does an authority token look like a file/module path we can resolve? */
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
   * Opaque (non-path) authority labels whose derivation relationship is known
   * but not statically walkable. Declared, never inferred — see LIMITATIONS.md.
   */
  readonly knownDerivations?: readonly DerivationPair[];
}

function normaliseOpaque(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * RULES R1–R4, the `@oracle-sources` family.
 *
 * R1 `oracle-sources-missing`      — in scope, no declaration at all
 * R2 `oracle-sources-too-few`      — fewer than two DISTINCT authorities
 * R3 `oracle-sources-derived`      — one authority reachable from another
 * R4 `oracle-sources-unresolvable` — a path-shaped authority that is not a file
 *
 * `inScope` is passed in by the caller and is computed from ASSERTION SHAPE
 * alone (see `shapes.ts`). It is never a function of the annotation, which is
 * what makes "delete the annotation to escape the rule" fail instead of pass.
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
    // Resolve path authorities; anything unresolvable is a violation in its
    // own right (you may not declare an authority that does not exist).
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

    // Distinctness: two tokens naming the same resolved file, or two opaque
    // labels that normalise to the same string, are ONE authority.
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

    // Derivation: a real transitive static-module-reachability walk for path
    // authorities; a declared table for opaque labels.
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

// ─── Test-block extraction ──────────────────────────────────────────────────

export interface TestBlock {
  readonly name: string;
  /** Offset of the `it(`/`test(` token. */
  readonly start: number;
  /** Offset just past the block's closing paren. */
  readonly end: number;
  /** Offset of the start of the immediately-preceding docblock, if any. */
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
 * Split a test file into `it(...)`/`test(...)` blocks by balanced parens over
 * the CODE view (so parens inside strings/comments cannot unbalance it). Each
 * block is widened backwards to absorb an immediately-preceding `/** … *\/`
 * docblock, because that is where this repo's suite writes its BLOCKING /
 * NEGATIVE TWIN prose.
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
    // The code view blanks string bodies, so recover the name from raw source.
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

// ─── R5: blocking claim must declare the seam its kill fixture kills ────────

/**
 * The suite's established convention (T-37, `test/integration/governance/**`)
 * is a `BLOCKING ARM` comment paired with a `NEGATIVE TWIN` comment: the twin
 * IS the kill fixture — it is the arm that proves the blocking assertion is
 * attributable to the guard rather than to the setup.
 *
 * DR-30: "Every blocking claim declares the seam its kill fixture kills."
 * Mechanically: a block that raises a blocking claim must carry a kill-fixture
 * declaration that NAMES something — either an explicit
 * `@kill-seam: <seam>` annotation, or a `NEGATIVE TWIN` marker followed by at
 * least `MIN_SEAM_CHARS` characters of prose. A bare `── NEGATIVE TWIN ──`
 * rule with no words after it does not declare a seam.
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

// ─── R6: no `passed === true` on a "could not run" verdict ──────────────────

/**
 * The defect: a probe that could not execute is reported through the same
 * channel as a probe that executed and passed, so `passed: true` means either
 * "it worked" or "we never looked". `src/verbs/
 * test-adequacy.production-path.test.ts` names this class explicitly
 * ("REPRESENTABILITY"). This rule forbids reproducing it.
 *
 * Mechanically, within one test block (comments blanked, string BODIES kept
 * because verdicts are usually string literals), the rule fires only where an
 * assertion actually CLAIMS a pass over a could-not-run subject:
 *   (a) inline — `expect(<expr>.passed).toBe(true)` where `<expr>` itself
 *       carries a could-not-run marker, or
 *   (b) by binding — `expect(x.passed).toBe(true)` where root `x` is bound, in
 *       the same block, to an initializer carrying a could-not-run marker.
 *
 * DELIBERATELY NOT FIRED ON: a block that merely *constructs* a could-not-run
 * carrier in order to prove the system rejects it. Two such negative fixtures
 * exist in the corpus today —
 * `verbs/pure/static-analysis.test.ts::NormalizeGateVerdict_SkippedStaticAnalysis_…`
 * and `verbs/gates/test-adequacy.production-path.test.ts::VerdictOf_LegacyVacuousCarrier_…`
 * — and both assert `'indeterminate'` / `passed === false`. An earlier draft
 * of this rule keyed on "an object literal carrying both markers" and flagged
 * exactly those two, i.e. it punished the tests that already enforce the
 * property. The rule keys on the ASSERTED CLAIM instead.
 */
export const COULD_NOT_RUN_MARKER =
  /\b(?:couldNotRun|could_not_run|COULD_NOT_RUN|could-not-run|could not run|didNotRun|did_not_run|notRun|not_run|NOT_RUN|not-run|unavailable|UNAVAILABLE|indeterminate|INDETERMINATE|neverRan|never_ran)\b/;

const PASSED_TRUE_ASSERT =
  /expect\s*\(\s*([\s\S]{0,600}?)\.\s*passed\s*\)\s*\.\s*(?:toBe\s*\(\s*true\s*\)|toEqual\s*\(\s*true\s*\)|toStrictEqual\s*\(\s*true\s*\)|toBeTruthy\s*\(\s*\))/g;


export function checkCouldNotRunVerdicts(file: string, source: string): readonly Violation[] {
  // String bodies are load-bearing here: verdicts are usually string literals
  // (`discriminant: 'could-not-run'`), which the plain code view blanks.
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

      // (a) the subject expression itself carries the could-not-run marker.
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

      // (b) the subject is a bare identifier bound to a could-not-run value.
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

// ─── R7: the integration tier may not synthesize its own root ───────────────

/**
 * Handed over by T-36: "no synthesized dispatch context" is currently enforced
 * BY CONSTRUCTION (nothing in the tier does it) rather than BY ASSERTION. A
 * future file could import `dispatch` directly and hand it an object literal,
 * and nothing would fail. This rule makes it an assertion.
 *
 * Scoped to `test/integration/**` minus the harness itself, which is the one
 * module allowed to know how the context is built (and builds it through the
 * production composition root, not by literal).
 */
const DISPATCH_CONTEXT_LITERAL =
  /:\s*DispatchContext\s*=\s*\{|as\s+DispatchContext\s*[;,)]|<\s*DispatchContext\s*>\s*\{|satisfies\s+DispatchContext/;
const COMPOSITE_MODULE_MOCK =
  /vi\s*\.\s*mock\s*\(\s*['"][^'"]*(?:core\/dispatch|core\/context|registry|index)(?:\.js)?['"]/;

export function checkNoSynthesizedRoot(file: string, source: string): readonly Violation[] {
  const { code } = sourceViews(source);
  // The mock check must see string BODIES: its subject is a module specifier,
  // which the plain code view blanks.
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
