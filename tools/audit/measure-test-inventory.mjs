// @ts-check
/**
 * @fileoverview Records every test in the tree under a PATH-INDEPENDENT id, so
 * a refactor that moves 1,141 files can still prove it lost none of them.
 *
 * The identity choice is the whole design. An id keyed on file path is
 * invalidated by the very moves this oracle exists to check — comparing
 * strictly would report all 1,141 as missing, and comparing loosely would
 * conflate the many identically-named tests that live in different files. So an
 * id is `(suite path within the file, test name, runner)`, which survives a
 * move, plus the source path carried alongside as metadata rather than as
 * identity. Reconciliation is `oracle − relocations`, and an unexplained delta
 * names the missing source.
 *
 * Tests are found by PARSING rather than by running. That matters for three
 * reasons: the oracle must be capturable while part of the suite is red, a
 * runner only reports what its own globs collect (which is what hid four
 * uncollected oracles earlier in this workflow), and shell suites are invisible
 * to vitest entirely.
 *
 * Reports. Never fails — the assertions live in the accompanying test.
 *
 * Usage: `node tools/audit/measure-test-inventory.mjs [--out FILE]`
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const REPO_ROOT = process.cwd();

/** Discovery is by extension, not by runner glob — a glob is what goes stale. */
const TEST_FILE = /\.(test|spec|bench)\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const SHELL_TEST_FILE = /\.test\.sh$/;

const SUITE_FNS = new Set(['describe', 'suite']);
const CASE_FNS = new Set(['it', 'test', 'bench']);

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
    .split('\0')
    .filter((rel) => rel.length > 0);
}

/**
 * The leading callee name of a call expression, unwrapping the modifier chains
 * vitest supports (`it.each`, `describe.skipIf(...)`, `it.concurrent.only`).
 * Without the unwrap, every modified test silently drops out of the inventory.
 *
 * @param {ts.Expression} expr
 * @returns {string | undefined}
 */
function rootCalleeName(expr) {
  let node = expr;
  for (;;) {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node)) {
      node = node.expression;
      continue;
    }
    if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
      node = node.expression;
      continue;
    }
    return undefined;
  }
}

/**
 * The literal title of a test or suite, when it is statically knowable.
 *
 * A computed title (a template with substitutions, a variable) has no stable
 * text, so it is recorded as a positional placeholder rather than guessed at —
 * an invented title would reconcile against nothing.
 *
 * @param {ts.Expression | undefined} arg
 * @returns {string | undefined}
 */
function literalTitle(arg) {
  if (arg === undefined) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return undefined;
}

/**
 * @param {string} rel
 * @param {string} source
 */
function extractFromSource(rel, source) {
  const sourceFile = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    rel.endsWith('.tsx') || rel.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  /** @type {{ suite: string, name: string, dynamic: boolean }[]} */
  const cases = [];
  /** @type {string[]} */
  const stack = [];
  let dynamicIndex = 0;

  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = rootCalleeName(node.expression);
      const title = literalTitle(node.arguments[0]);

      if (callee !== undefined && SUITE_FNS.has(callee)) {
        stack.push(title ?? `<dynamic-suite-${(dynamicIndex += 1)}>`);
        ts.forEachChild(node, visit);
        stack.pop();
        return;
      }
      if (callee !== undefined && CASE_FNS.has(callee)) {
        cases.push({
          suite: stack.join(' > '),
          name: title ?? `<dynamic-case-${(dynamicIndex += 1)}>`,
          dynamic: title === undefined,
        });
        // Still descend: a nested `it` inside a helper closure is unusual but
        // skipping the subtree would drop it silently.
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return cases;
}

function main() {
  const argv = process.argv.slice(2);
  const outFlag = argv.indexOf('--out');
  const outPath = outFlag >= 0 ? argv[outFlag + 1] : undefined;

  const tracked = trackedFiles();
  const tsFiles = tracked.filter((rel) => TEST_FILE.test(rel));
  const shFiles = tracked.filter((rel) => SHELL_TEST_FILE.test(rel));

  /** @type {Record<string, { file: string, runner: string, cases: { suite: string, name: string, dynamic: boolean }[] }>} */
  const byFile = {};
  /** @type {string[]} */
  const unparseable = [];
  let caseCount = 0;
  let dynamicCount = 0;

  for (const rel of tsFiles) {
    let source;
    try {
      source = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    let cases;
    try {
      cases = extractFromSource(rel, source);
    } catch {
      unparseable.push(rel);
      continue;
    }
    // Which runner owns the file matters for reconciliation. There were two
    // vitest workspaces until task 019 dissolved the nested package into the
    // root one; the surviving distinction that a runner-derived inventory can
    // still get wrong is vitest-vs-shell, since vitest cannot see shell suites
    // at all. The trees a single workspace can under-report are asserted by
    // top-level root instead — see `TestInventory_EveryTestBearingRoot_IsRepresented`.
    const runner = 'vitest:root';
    byFile[rel] = { file: rel, runner, cases };
    caseCount += cases.length;
    dynamicCount += cases.filter((c) => c.dynamic).length;
  }

  for (const rel of shFiles) {
    // Shell suites are recorded at FILE granularity. Their cases are shaped by
    // whatever convention each script uses, and inventing a parse for them
    // would produce ids that reconcile against nothing.
    byFile[rel] = { file: rel, runner: 'shell', cases: [] };
  }

  const payload = {
    capturedAt: new Date().toISOString().slice(0, 10),
    discovery: 'extension-based over tracked files; not a runner glob',
    identity: '(suite path within the file, test name, runner) — path is metadata, never identity',
    countingSemantics:
      'Cases are CALL SITES, not expanded executions. A table-driven `it.each([...])` is one entry here and N tests at runtime, which is why this total sits below the runners\' combined count (root 1,731 including skips, nested 11,662). The call site is the right unit for reconciliation: it survives a move, whereas an expansion index depends on the table contents and would churn on any data edit. A drop in call sites is the signal this oracle exists to catch.',
    totals: {
      testFiles: tsFiles.length + shFiles.length,
      parsedFiles: tsFiles.length,
      shellFiles: shFiles.length,
      cases: caseCount,
      dynamicTitles: dynamicCount,
      unparseableFiles: unparseable.length,
    },
    unparseable,
    // Every move task appends here. Reconciliation is `oracle − relocations`.
    relocations: [],
    files: byFile,
  };

  const json = JSON.stringify(payload, null, 2);
  if (outPath) fs.writeFileSync(outPath, `${json}\n`, 'utf8');
  else process.stdout.write(`${json}\n`);
}

main();
