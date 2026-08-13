#!/usr/bin/env node
/**
 * consolidate-suite.mjs — de-diverge duplicate-location test pairs (DR-2 / DR-6).
 *
 * A "pair" is a single unit tested from TWO directories:
 *   - legacy copy      src/__tests__/<area>/<base>.test.ts
 *   - co-located copy   src/<area>/<base>.test.ts
 *
 * The pair identity key is strictly `(area, basename)`, so `workflow/schemas`
 * and `event-store/schemas` are DISTINCT pairs (likewise `workflow/tools` vs
 * `event-store/tools`). Enumeration is a real DIRECTORY INTERSECTION — never a
 * brace-glob (`git ls-files '{a,b}'` never expands the braces → vacuously empty).
 *
 * Modes:
 *   --enumerate            List every (area, basename) pair where BOTH files
 *                          exist — the authoritative inventory.
 *   --plan <pair>          Classify merge vs relocate by MODULE-SCOPE PREAMBLE
 *                          textual identity modulo import paths.
 *   --emit <pair>          Produce the de-diverged result (merge-append or
 *                          relocate-as-sibling) and remove the legacy copy.
 *   --verify <pair>        Assert every pre-image case survived into the PR-HEAD
 *                          result verbatim modulo import-path rewrites (or is a
 *                          textually-proven duplicate). This is the Task-004 gate.
 *
 * DESIGN CONSTRAINT (from adversarial review) — equivalence is TEXTUAL ONLY,
 * never a semantic/AST hash. Vitest module mocks are file-scoped and
 * non-composable, so a MERGE is sound ONLY when the two files' full module-scope
 * preambles are textually identical modulo import paths (guaranteeing no
 * divergent `vi.mock`/`vi.hoisted`/env stub and no colliding module-scope
 * symbol). Any preamble divergence forces RELOCATE — which never drops anything.
 *
 * The pure functions (`enumeratePairs`, `resolvePair`, `classifyPair`,
 * `computeEmit`, `verifyCases`, and the AST helpers) are exported so every path
 * is unit-testable without spawning a subprocess.
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
/** The source root the tool governs (repo-relative default; overridable for tests). */
export const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'servers', 'exarchos-mcp', 'src');
/**
 * Against the live tree the enumeration MUST find exactly this many remaining pairs.
 * 0 since the wave-3b de-divergence campaign (#1705) consolidated all 17 duplicate-location pairs.
 */
export const EXPECTED_PAIR_COUNT = 0;

export const EXIT_OK = 0;
/** A real finding: a lost/unproven case (verify) or a divergence needing action. */
export const EXIT_FINDING = 1;
/** The gate/tool itself could not run: bad args, missing file, tool-missing. */
export const EXIT_USAGE = 2;

/** vi.* calls that participate in the module-scope preamble (mock/hoist/env). */
const VI_PREAMBLE_METHODS = new Set(['mock', 'hoisted', 'stubEnv', 'stubGlobal']);
/** Top-level test lifecycle hooks that belong to the preamble. */
const HOOK_NAMES = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
/** Identifiers that root a test CASE call chain. */
const CASE_ROOTS = new Set(['it', 'test']);

/** @param {string} p */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Parse a TypeScript source (or a fragment) with parent pointers so chain and
 * position queries work. Uses `.tsx` off (plain `.ts`) to match the test files.
 * @param {string} text
 * @param {string} [fileName]
 * @returns {ts.SourceFile}
 */
function parse(text, fileName = 'frag.ts') {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
}

// ─── AST helpers ────────────────────────────────────────────────────────────

/**
 * The leftmost identifier of a call/property/tagged chain, e.g. `it` for
 * `it.each([...])`, `it.skip`, `test.concurrent(...)`. Returns undefined when
 * the chain is not rooted at a bare identifier.
 * @param {ts.Node} expr
 * @returns {string | undefined}
 */
function rootIdentifier(expr) {
  let e = expr;
  for (;;) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) { e = e.expression; continue; }
    if (ts.isElementAccessExpression(e)) { e = e.expression; continue; }
    if (ts.isCallExpression(e)) { e = e.expression; continue; }
    if (ts.isTaggedTemplateExpression(e)) { e = e.tag; continue; }
    if (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) { e = e.expression; continue; }
    return undefined;
  }
}

/**
 * True when `node` sits in the callee/tag/object position of a parent that
 * CONTINUES the same call chain (e.g. the inner `it.each([...])` of
 * `it.each([...])(...)`). Such inner nodes are NOT the case — the outermost
 * call is. This de-duplicates the walk so each case is recorded once.
 * @param {ts.Node} node
 */
function isChainContinuation(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isCallExpression(p) && p.expression === node) return true;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) return true;
  if (ts.isTaggedTemplateExpression(p) && p.tag === node) return true;
  if ((ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p)) && p.expression === node) return true;
  return false;
}

/**
 * Collect the outermost `it(...)`/`test(...)` call nodes — including `.each`,
 * `.skip`, `.only`, `.todo`, `.concurrent`, tagged-template `.each` variants.
 * @param {ts.SourceFile} sf
 * @returns {ts.CallExpression[]}
 */
function collectCaseNodes(sf) {
  /** @type {ts.CallExpression[]} */
  const cases = [];
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const root = rootIdentifier(node.expression);
      if (root !== undefined && CASE_ROOTS.has(root) && !isChainContinuation(node)) {
        cases.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return cases;
}

/**
 * The full source text of every case in `sf` (via `node.getText()`).
 * @param {ts.SourceFile} sf
 * @returns {string[]}
 */
function extractCaseTexts(sf) {
  return collectCaseNodes(sf).map((n) => n.getText(sf));
}

/** @param {ts.CallExpression} call — is it `vi.<mock|hoisted|stubEnv|stubGlobal>(...)`? */
function isViPreambleCall(call) {
  const callee = call.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'vi' &&
    ts.isIdentifier(callee.name) &&
    VI_PREAMBLE_METHODS.has(callee.name.text)
  );
}

/** @param {ts.CallExpression} call — is it a bare `beforeEach(...)` etc. lifecycle hook? */
function isHookCall(call) {
  const callee = call.expression;
  return ts.isIdentifier(callee) && HOOK_NAMES.has(callee.text);
}

/** @param {ts.CallExpression} call — is it a `describe(...)` suite wrapper? */
function isDescribeCall(call) {
  return rootIdentifier(call.expression) === 'describe';
}

/**
 * Lifecycle-hook statements declared directly inside a `describe(...)` callback
 * body (the "top-describe scope").
 * @param {ts.CallExpression} describeCall
 * @param {ts.SourceFile} sf
 * @returns {string[]}
 */
function describeScopeHooks(describeCall, sf) {
  /** @type {string[]} */
  const hooks = [];
  for (const arg of describeCall.arguments) {
    if (!(ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) continue;
    const body = arg.body;
    if (!body || !ts.isBlock(body)) continue;
    for (const stmt of body.statements) {
      if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression) && isHookCall(stmt.expression)) {
        hooks.push(stmt.getText(sf));
      }
    }
  }
  return hooks;
}

/**
 * The module-scope PREAMBLE text: imports + `vi.mock`/`vi.hoisted`/`vi.stubEnv`/
 * `vi.stubGlobal` calls + module-scope `const`/`function`/helper (class/type/
 * interface/enum) declarations + lifecycle hooks at module OR top-`describe`
 * scope. Top-level `it`/`test` cases and the bodies of `describe` blocks
 * (other than their own top-scope hooks) are excluded.
 * @param {ts.SourceFile} sf
 * @returns {string}
 */
function extractPreambleText(sf) {
  /** @type {string[]} */
  const parts = [];
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isVariableStatement(stmt) ||
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      parts.push(stmt.getText(sf));
      continue;
    }
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      if (isViPreambleCall(call) || isHookCall(call)) {
        parts.push(stmt.getText(sf));
        continue;
      }
      if (isDescribeCall(call)) {
        for (const h of describeScopeHooks(call, sf)) parts.push(h);
        continue;
      }
      // A top-level it/test is a CASE, not preamble → skip.
    }
  }
  return parts.join('\n');
}

// ─── import-path normalization (comparison) & rewriting (emit) ───────────────

/**
 * Every relative-path string literal (`./…` or `../…`) in `text`, with the
 * range and resolved POSIX target relative to `absFromDir`. Bare/absolute
 * specifiers (`vitest`, `node:fs`) are left untouched — they resolve identically
 * from either directory. Re-parses the fragment so callers pass raw text.
 * @param {string} text
 * @param {string} absFromDir
 * @returns {{ start: number, end: number, quote: string, target: string }[]}
 */
function relativeSpecifiers(text, absFromDir) {
  const sf = parse(text);
  /** @type {{ start: number, end: number, quote: string, target: string }[]} */
  const out = [];
  /** @param {ts.Node} n */
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const v = n.text;
      if (v.startsWith('./') || v.startsWith('../')) {
        const start = n.getStart(sf);
        out.push({ start, end: n.getEnd(), quote: text[start], target: toPosix(path.resolve(absFromDir, v)) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Normalize `text` for import-path differences ONLY: every relative specifier is
 * replaced by a canonical `\0MOD:<resolved-target>` token (resolved against
 * `absFromDir`), and CRLF is folded to LF. Two fragments that are identical
 * modulo import paths normalize to byte-identical strings. Nothing else is
 * altered — this is a TEXTUAL equivalence, not a semantic one.
 * @param {string} text
 * @param {string} absFromDir
 * @returns {string}
 */
export function normalizeImports(text, absFromDir) {
  const specs = relativeSpecifiers(text, absFromDir).sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of specs) {
    out = out.slice(0, s.start) + `${s.quote} MOD:${s.target}${s.quote}` + out.slice(s.end);
  }
  return out.replace(/\r\n/g, '\n');
}

/**
 * Rewrite every relative specifier in `text` so it resolves to the SAME target
 * from `absToDir` as it did from `absFromDir` — the mechanical fixup applied when
 * a file (or a case) moves directories. Non-relative specifiers are untouched.
 * @param {string} text
 * @param {string} absFromDir
 * @param {string} absToDir
 * @returns {string}
 */
export function rewriteRelativeImports(text, absFromDir, absToDir) {
  const specs = relativeSpecifiers(text, absFromDir).sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of specs) {
    let rel = toPosix(path.relative(absToDir, s.target));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    out = out.slice(0, s.start) + `${s.quote}${rel}${s.quote}` + out.slice(s.end);
  }
  return out;
}

// ─── public text-level analysis ──────────────────────────────────────────────

/**
 * Normalized (import-path-canonicalized) preamble text of a file.
 * @param {string} text
 * @param {string} absDir
 */
export function normalizedPreamble(text, absDir) {
  return normalizeImports(extractPreambleText(parse(text, 'file.ts')), absDir);
}

/**
 * Normalized case texts of a file, each canonicalized for import paths.
 * @param {string} text
 * @param {string} absDir
 * @returns {string[]}
 */
export function normalizedCases(text, absDir) {
  return extractCaseTexts(parse(text, 'file.ts')).map((c) => normalizeImports(c, absDir));
}

/**
 * Classify a pair as `merge` (preambles textually identical modulo imports) or
 * `relocate` (any preamble divergence — divergent mock/hoist/env or a colliding
 * module-scope symbol). Textual only; never semantic.
 * @param {{ text: string, absDir: string }} legacy
 * @param {{ text: string, absDir: string }} canonical
 * @returns {'merge' | 'relocate'}
 */
export function classifyPair(legacy, canonical) {
  const lp = normalizedPreamble(legacy.text, legacy.absDir);
  const cp = normalizedPreamble(canonical.text, canonical.absDir);
  return lp === cp ? 'merge' : 'relocate';
}

// ─── pair discovery ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} Pair
 * @property {string} area       Directory portion of the id (may be multi-segment).
 * @property {string} basename   File stem, minus `.test.ts`.
 * @property {string} id         `<area>/<basename>` — the CLI pair identifier.
 * @property {string} legacyPath Absolute path of the legacy `__tests__` copy.
 * @property {string} canonicalPath Absolute path of the co-located copy.
 * @property {string} legacyDir  Absolute directory of the legacy copy.
 * @property {string} canonicalDir Absolute directory of the co-located copy.
 */

/**
 * Enumerate every pair where BOTH the legacy `__tests__/<area>/<base>.test.ts`
 * AND the co-located `<area>/<base>.test.ts` exist. A real directory
 * intersection (recursive), keyed strictly on `(area, basename)`; sorted by id.
 * @param {string} srcRoot
 * @returns {Pair[]}
 */
export function enumeratePairs(srcRoot) {
  const legacyRoot = path.join(srcRoot, '__tests__');
  if (!existsSync(legacyRoot)) return [];
  /** @type {Pair[]} */
  const pairs = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.test.ts')) continue;
      const rel = toPosix(path.relative(legacyRoot, full)); // e.g. workflow/guards.test.ts
      const area = path.posix.dirname(rel);
      if (area === '.') continue; // a bare __tests__/<base>.test.ts has no co-located mirror
      const canonicalPath = path.join(srcRoot, rel);
      if (!existsSync(canonicalPath) || !statSync(canonicalPath).isFile()) continue;
      const basename = path.posix.basename(rel, '.test.ts');
      pairs.push({
        area,
        basename,
        id: `${area}/${basename}`,
        legacyPath: full,
        canonicalPath,
        legacyDir: path.dirname(full),
        canonicalDir: path.dirname(canonicalPath),
      });
    }
  };
  walk(legacyRoot);
  pairs.sort((a, b) => a.id.localeCompare(b.id));
  return pairs;
}

/**
 * Resolve a `<area>/<basename>` id to its concrete Pair paths (no existence
 * check — the caller decides whether missing files are an error).
 * @param {string} srcRoot
 * @param {string} id
 * @returns {Pair}
 */
export function resolvePair(srcRoot, id) {
  const rel = `${id}.test.ts`;
  const legacyPath = path.join(srcRoot, '__tests__', rel);
  const canonicalPath = path.join(srcRoot, rel);
  return {
    area: path.posix.dirname(id),
    basename: path.posix.basename(id),
    id,
    legacyPath,
    canonicalPath,
    legacyDir: path.dirname(legacyPath),
    canonicalDir: path.dirname(canonicalPath),
  };
}

// ─── emit ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} EmitPlan
 * @property {'merge'|'relocate'} mode
 * @property {{ path: string, content: string }[]} writes  Files to create/overwrite.
 * @property {string[]} deletes                            Files to remove.
 * @property {number} droppedDuplicates                    Legacy cases textually deduped (merge).
 * @property {number} appendedCases                        Legacy cases carried into the result.
 */

/** @param {string} block @param {string} indent — prefix every non-empty line. */
function indentBlock(block, indent) {
  return block
    .split('\n')
    .map((line) => (line.length === 0 ? line : indent + line))
    .join('\n');
}

/**
 * Insert the (already import-rewritten) legacy case blocks into the canonical
 * file. When the canonical file has exactly ONE top-level `describe`, the cases
 * go just inside its closing brace so they inherit the same top-describe hooks
 * (which — under a merge — are textually identical to the legacy's). Otherwise
 * they are appended at end-of-file as top-level cases.
 * @param {string} canonicalText
 * @param {ts.SourceFile} canonicalSf
 * @param {string[]} blocks
 * @param {Pair} pair
 * @returns {string}
 */
function insertCases(canonicalText, canonicalSf, blocks, pair) {
  if (blocks.length === 0) return canonicalText;
  const banner = `// ── merged from __tests__/${pair.id}.test.ts (Task 001 de-divergence) ──`;
  const describes = canonicalSf.statements
    .filter((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && isDescribeCall(s.expression))
    .map((s) => /** @type {ts.CallExpression} */ (/** @type {ts.ExpressionStatement} */ (s).expression));

  if (describes.length === 1) {
    const fn = describes[0].arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && fn.body && ts.isBlock(fn.body)) {
      const insertPos = fn.body.getEnd() - 1; // just before the closing `}`
      const body = blocks.map((b) => `${indentBlock(b, '  ')};`).join('\n\n');
      const injection = `\n  ${banner}\n${body}\n`;
      return canonicalText.slice(0, insertPos) + injection + canonicalText.slice(insertPos);
    }
  }
  const body = blocks.map((b) => `${b};`).join('\n\n');
  return `${canonicalText.replace(/\s*$/, '\n')}\n${banner}\n${body}\n`;
}

/**
 * Compute the merge result: start from the co-located canonical file and append
 * the legacy cases, dropping only legacy cases textually identical (modulo
 * imports) to a case already present. Legacy `__tests__` copy is removed.
 * @param {Pair} pair
 * @param {string} legacyText
 * @param {string} canonicalText
 * @returns {Omit<EmitPlan, 'mode'>}
 */
function computeMerge(pair, legacyText, canonicalText) {
  const canonicalSf = parse(canonicalText, 'canonical.ts');
  const present = new Set(extractCaseTexts(canonicalSf).map((c) => normalizeImports(c, pair.canonicalDir)));
  const legacySf = parse(legacyText, 'legacy.ts');
  /** @type {string[]} */
  const blocks = [];
  let dropped = 0;
  for (const node of collectCaseNodes(legacySf)) {
    const raw = node.getText(legacySf);
    const norm = normalizeImports(raw, pair.legacyDir);
    if (present.has(norm)) { dropped++; continue; }
    present.add(norm); // also dedup identical cases repeated within the legacy file
    blocks.push(rewriteRelativeImports(raw, pair.legacyDir, pair.canonicalDir));
  }
  const merged = insertCases(canonicalText, canonicalSf, blocks, pair);
  return {
    writes: [{ path: pair.canonicalPath, content: merged }],
    deletes: [pair.legacyPath],
    droppedDuplicates: dropped,
    appendedCases: blocks.length,
  };
}

/**
 * Compute the de-diverged emit plan for a pair (reads both files from disk;
 * does NOT mutate). `merge` when preambles are identical modulo imports;
 * otherwise `relocate` the legacy file into the co-located directory as a
 * distinct `<base>.legacy.test.ts` sibling (import paths rewritten). Either way
 * the legacy `__tests__` copy is deleted.
 * @param {Pair} pair
 * @returns {EmitPlan}
 */
export function computeEmit(pair) {
  const legacyText = readFileSync(pair.legacyPath, 'utf8');
  const canonicalText = readFileSync(pair.canonicalPath, 'utf8');
  const mode = classifyPair(
    { text: legacyText, absDir: pair.legacyDir },
    { text: canonicalText, absDir: pair.canonicalDir },
  );
  if (mode === 'relocate') {
    const destPath = path.join(pair.canonicalDir, `${pair.basename}.legacy.test.ts`);
    const rewritten = rewriteRelativeImports(legacyText, pair.legacyDir, pair.canonicalDir);
    return {
      mode,
      writes: [{ path: destPath, content: rewritten }],
      deletes: [pair.legacyPath],
      droppedDuplicates: 0,
      appendedCases: extractCaseTexts(parse(legacyText, 'legacy.ts')).length,
    };
  }
  return { mode, ...computeMerge(pair, legacyText, canonicalText) };
}

/**
 * Apply an emit plan to disk: write every file (creating parent dirs) then
 * delete the legacy copies.
 * @param {EmitPlan} plan
 */
export function applyEmit(plan) {
  for (const w of plan.writes) {
    mkdirSync(path.dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.content);
  }
  for (const d of plan.deletes) {
    if (existsSync(d)) rmSync(d);
  }
}

// ─── verify ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} VerifyReport
 * @property {boolean} ok
 * @property {boolean} preamblesIdentical
 * @property {{ side: 'legacy'|'canonical', text: string }[]} lost  Pre-image cases with no surviving copy.
 * @property {number} preimageCases
 * @property {number} resultCases
 */

/**
 * Assert every pre-image case (from EITHER side) survives into the result
 * verbatim modulo import-path rewrites, OR is a textually-proven duplicate
 * (identical case body AND identical file preamble, both modulo imports — the
 * only legitimate reason a specific case-copy may be absent, since the surviving
 * twin carries the same normalized body). Any pre-image case whose normalized
 * body is absent from the result is a LOST/UNPROVEN case → not ok.
 * @param {{ text: string, absDir: string }} legacyPre
 * @param {{ text: string, absDir: string }} canonicalPre
 * @param {{ text: string, absDir: string }[]} resultFiles
 * @returns {VerifyReport}
 */
export function verifyCases(legacyPre, canonicalPre, resultFiles) {
  const preamblesIdentical =
    normalizedPreamble(legacyPre.text, legacyPre.absDir) ===
    normalizedPreamble(canonicalPre.text, canonicalPre.absDir);

  const resultSet = new Set();
  let resultCases = 0;
  for (const f of resultFiles) {
    for (const c of normalizedCases(f.text, f.absDir)) {
      resultSet.add(c);
      resultCases++;
    }
  }

  const legacyNorm = normalizedCases(legacyPre.text, legacyPre.absDir);
  const canonicalNorm = normalizedCases(canonicalPre.text, canonicalPre.absDir);
  const legacySet = new Set(legacyNorm);
  const canonicalSet = new Set(canonicalNorm);

  /** @type {{ side: 'legacy'|'canonical', text: string }[]} */
  const lost = [];
  /**
   * A pre-image case is preserved iff its normalized body is present in the
   * result. A body absent from the result can NEVER be rescued by the
   * proven-duplicate clause: that clause requires a surviving twin, and a
   * surviving twin carries the same normalized body — which would make the body
   * present. So "absent" is always a genuine loss.
   * @param {string} norm @param {'legacy'|'canonical'} side @param {string} raw
   */
  const check = (norm, side, raw) => {
    if (resultSet.has(norm)) return;
    lost.push({ side, text: raw });
  };

  const legacyRaw = extractCaseTexts(parse(legacyPre.text, 'legacy.ts'));
  const canonicalRaw = extractCaseTexts(parse(canonicalPre.text, 'canonical.ts'));
  legacyNorm.forEach((norm, i) => check(norm, 'legacy', legacyRaw[i] ?? norm));
  canonicalNorm.forEach((norm, i) => check(norm, 'canonical', canonicalRaw[i] ?? norm));

  // Retained for report parity with the spec's duplicate-clause reasoning.
  void legacySet;
  void canonicalSet;

  return {
    ok: lost.length === 0,
    preamblesIdentical,
    lost,
    preimageCases: legacyNorm.length + canonicalNorm.length,
    resultCases,
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `consolidate-suite — de-diverge duplicate-location test pairs (DR-2/DR-6)

Usage:
  consolidate-suite --enumerate [--json]
  consolidate-suite --plan   <area>/<basename>
  consolidate-suite --emit   <area>/<basename> [--dry-run]
  consolidate-suite --verify <area>/<basename> [--base <ref>]

Options:
  --json         (enumerate) emit the pair inventory as JSON.
  --dry-run      (emit) print the plan; do not touch the filesystem.
  --base <ref>   (verify) git ref holding the pre-image (default: origin/main).
  --src <dir>    override the governed source root (default: the MCP src tree).
  --help         show this help.
`;

/**
 * Parse argv into a small option bag. Positional (non-flag) tokens collect into
 * `_`. Value flags consume the next token.
 * @param {string[]} argv
 * @returns {{ _: string[], flags: Record<string, string | boolean> }}
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const _ = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  const valueFlags = new Set(['base', 'src']);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      if (valueFlags.has(name)) {
        flags[name] = argv[++i] ?? '';
      } else {
        flags[name] = true;
      }
    } else {
      _.push(tok);
    }
  }
  return { _, flags };
}

/**
 * Read a repo path at a git ref (pre-image). Returns undefined when the file did
 * not exist at that ref (a legacy copy created inside the PR, or already gone).
 * @param {string} ref
 * @param {string} repoRelPath
 * @returns {string | undefined}
 */
function gitShow(ref, repoRelPath) {
  const res = spawnSync('git', ['show', `${ref}:${repoRelPath}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) return undefined;
  return res.stdout;
}

/**
 * In-process CLI body. Returns an exit code; never calls `process.exit` so it is
 * unit-testable. All I/O goes through the injected `log`/`errlog`.
 * @param {string[]} argv
 * @param {{ srcRoot?: string, log?: (m: string) => void, errlog?: (m: string) => void }} [opts]
 * @returns {number}
 */
export function run(argv, opts = {}) {
  const log = opts.log ?? ((m) => process.stdout.write(`${m}\n`));
  const errlog = opts.errlog ?? ((m) => process.stderr.write(`${m}\n`));
  const { _, flags } = parseArgs(argv);
  const srcRoot = typeof flags.src === 'string' ? path.resolve(flags.src) : (opts.srcRoot ?? DEFAULT_SRC_ROOT);

  if (flags.help || (_.length === 0 && Object.keys(flags).length === 0)) {
    log(USAGE);
    return EXIT_OK;
  }

  if (flags.enumerate) {
    const pairs = enumeratePairs(srcRoot);
    if (flags.json) {
      log(JSON.stringify(pairs.map((p) => ({ id: p.id, area: p.area, basename: p.basename })), null, 2));
    } else {
      for (const p of pairs) log(p.id);
      log(`# ${pairs.length} pair${pairs.length === 1 ? '' : 's'}`);
    }
    return EXIT_OK;
  }

  const id = _[0];
  if (flags.plan) {
    if (!id) { errlog('[consolidate] --plan requires a <area>/<basename> pair'); return EXIT_USAGE; }
    const pair = resolvePair(srcRoot, id);
    if (!existsSync(pair.legacyPath) || !existsSync(pair.canonicalPath)) {
      errlog(`[consolidate] --plan: both files must exist for ${id} (legacy=${existsSync(pair.legacyPath)}, canonical=${existsSync(pair.canonicalPath)})`);
      return EXIT_USAGE;
    }
    const mode = classifyPair(
      { text: readFileSync(pair.legacyPath, 'utf8'), absDir: pair.legacyDir },
      { text: readFileSync(pair.canonicalPath, 'utf8'), absDir: pair.canonicalDir },
    );
    log(mode === 'merge'
      ? `${id}: merge (module-scope preambles are textually identical modulo import paths)`
      : `${id}: relocate (module-scope preambles diverge — mock/hoist/env or a colliding symbol)`);
    return EXIT_OK;
  }

  if (flags.emit) {
    if (!id) { errlog('[consolidate] --emit requires a <area>/<basename> pair'); return EXIT_USAGE; }
    const pair = resolvePair(srcRoot, id);
    if (!existsSync(pair.legacyPath) || !existsSync(pair.canonicalPath)) {
      errlog(`[consolidate] --emit: both files must exist for ${id}`);
      return EXIT_USAGE;
    }
    const plan = computeEmit(pair);
    if (flags['dry-run']) {
      log(`${id}: ${plan.mode} — ${plan.writes.length} write(s), ${plan.deletes.length} delete(s), ` +
        `${plan.appendedCases} case(s) carried, ${plan.droppedDuplicates} duplicate(s) dropped`);
      for (const w of plan.writes) log(`  write   ${toPosix(path.relative(REPO_ROOT, w.path))}`);
      for (const d of plan.deletes) log(`  delete  ${toPosix(path.relative(REPO_ROOT, d))}`);
      return EXIT_OK;
    }
    applyEmit(plan);
    log(`${id}: ${plan.mode} applied — ${plan.appendedCases} case(s) carried, ${plan.droppedDuplicates} duplicate(s) dropped`);
    return EXIT_OK;
  }

  if (flags.verify) {
    if (!id) { errlog('[consolidate] --verify requires a <area>/<basename> pair'); return EXIT_USAGE; }
    const base = typeof flags.base === 'string' ? flags.base : 'origin/main';
    const pair = resolvePair(srcRoot, id);
    const legacyRel = toPosix(path.relative(REPO_ROOT, pair.legacyPath));
    const canonicalRel = toPosix(path.relative(REPO_ROOT, pair.canonicalPath));
    const legacyPreText = gitShow(base, legacyRel) ?? '';
    const canonicalPreText = gitShow(base, canonicalRel) ?? '';

    /** @type {{ text: string, absDir: string }[]} */
    const resultFiles = [];
    if (existsSync(pair.canonicalPath)) {
      resultFiles.push({ text: readFileSync(pair.canonicalPath, 'utf8'), absDir: pair.canonicalDir });
    }
    const relocated = path.join(pair.canonicalDir, `${pair.basename}.legacy.test.ts`);
    if (existsSync(relocated)) {
      resultFiles.push({ text: readFileSync(relocated, 'utf8'), absDir: pair.canonicalDir });
    }

    const report = verifyCases(
      { text: legacyPreText, absDir: pair.legacyDir },
      { text: canonicalPreText, absDir: pair.canonicalDir },
      resultFiles,
    );
    if (report.ok) {
      log(`${id}: OK — ${report.preimageCases} pre-image case(s) all preserved across ${report.resultCases} result case(s).`);
      return EXIT_OK;
    }
    errlog(`[consolidate] --verify FAIL: ${report.lost.length} pre-image case(s) lost/unproven for ${id}:`);
    for (const c of report.lost) errlog(`    (${c.side}) ${c.text.split('\n')[0].slice(0, 120)}`);
    return EXIT_FINDING;
  }

  errlog(USAGE);
  return EXIT_USAGE;
}

/** True when this module is the process entry point (not an import). */
function invokedAsCli() {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  process.exit(run(process.argv.slice(2)));
}
