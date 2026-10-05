#!/usr/bin/env node
// lint-test-first-drift.mjs: an enforcing lint against the return of mandatory test-first
// ordering in the SDLC content. It fails when the retired framing appears:
//   1. iron-law                   - the literal "Iron Law".
//   2. no-production-code-first   - "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST".
//   3. unconditional-rgr-template - all three of [RED], [GREEN] and [REFACTOR] in one file,
//      with no `<!-- ladder-rgr-optin -->` marker. Rules 1 and 2 have no opt-out.
//
// It scans every `.md` file under the given directories. The default is `content` and
// `rendered/agents`, the scope that `npm run lint:test-first-drift` passes. Agent `.md` files
// are generated from TypeScript, so `rendered/agents/` is the only agent surface it can see.
//
// Output: JSON on stdout, `{ findings: [...], advisory: false }`. Exit 1 when it finds a match.
// Self-test: `tests/scripts/lint-test-first-drift.test.ts`.

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_DIRS = ['content', 'rendered/agents'];
const OPT_IN_MARKER = '<!-- ladder-rgr-optin -->';

const RULES = {
  ironLaw: {
    id: 'iron-law',
    re: /iron law/i,
    message: 'retired "Iron Law" framing reappeared (test-first ordering was excised in #1587)',
    allowlistable: false,
  },
  noProdCodeFirst: {
    id: 'no-production-code-first',
    re: /no production code without a failing test first/i,
    message: 'retired "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" mandate reappeared (#1587)',
    allowlistable: false,
  },
};

const SEVERITY = 'HIGH';

/**
 * Lists every `.md` file under `dir`. Throws when `dir` does not exist, so a wrong
 * directory cannot pass as a clean tree. It skips a subdirectory that it cannot read.
 */
function walkMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    throw new Error(`lint-test-first-drift: scan directory does not exist: ${dir}`);
  }
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Applies the per-line rules and the whole-file template rule to one file.
 * The template check ignores case, so `[Red]` cannot bypass it.
 */
function lintFile(file, findings) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of Object.values(RULES)) {
      if (rule.re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
          rule: rule.id,
          severity: SEVERITY,
          message: rule.message,
        });
      }
    }
  }

  const hasRed = /\[red\]/i.test(text);
  const hasGreen = /\[green\]/i.test(text);
  const hasRefactor = /\[refactor\]/i.test(text);
  const optedIn = text.includes(OPT_IN_MARKER);
  if (hasRed && hasGreen && hasRefactor && !optedIn) {
    const redLine = lines.findIndex((l) => /\[red\]/i.test(l));
    findings.push({
      file,
      line: redLine >= 0 ? redLine + 1 : 1,
      snippet: (lines[redLine] ?? '').trim().slice(0, 200),
      rule: 'unconditional-rgr-template',
      severity: SEVERITY,
      message:
        'unconditional [RED]/[GREEN]/[REFACTOR] task template reappeared; verification is tier-scaled now ' +
        `(#1587). If this is a deliberate high-tier opt-in lane, mark it with ${OPT_IN_MARKER}.`,
    });
  }
}

function main() {
  const dirs = process.argv.slice(2);
  const scanDirs = dirs.length > 0 ? dirs : DEFAULT_DIRS;
  const findings = [];
  for (const dir of scanDirs) {
    const root = path.resolve(process.cwd(), dir);
    for (const file of walkMarkdown(root)) {
      lintFile(file, findings);
    }
  }
  const output = { findings, advisory: false };
  fs.writeSync(1, `${JSON.stringify(output, null, 2)}\n`);
  process.exit(findings.length > 0 ? 1 : 0);
}

main();
