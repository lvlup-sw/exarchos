#!/usr/bin/env node
// tools/audit/gates/lint-test-first-drift.mjs — ENFORCING lint guarding against the return
// of test-FIRST ordering framing across the SDLC content surfaces (#1591, #1515
// Phase 4).
//
// The verification-ladder reconciliation (#1586–#1590) excised mandatory
// test-first ordering from commands/, agents/, and the skill sources. The drift
// returned last time precisely because nothing guarded these surfaces — and the
// first pass guarded only commands/ + agents/, leaving the skill sources
// (content/) uncovered, where two residual mandates survived silently. This
// lint fails CI when the retired framing reappears:
//   1. iron-law                  — the literal "Iron Law"
//   2. no-production-code-first  — "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"
//   3. unconditional-rgr-template — a [RED]/[GREEN]/[REFACTOR] task-phase template
//      (all three bracketed markers in one file), UNLESS the file carries an
//      explicit opt-in marker `<!-- ladder-rgr-optin -->` (the legitimate
//      high-tier opt-in lane). Rules 1 and 2 are never allowlisted.
//
// Scope: every *.md under the scanned directories (default: content/ and
// rendered/agents/). content/ is the source-of-truth for skills AND commands
// (authored at content/<domain>/commands/*.md); guarding it rather than the
// generated rendered/ trees catches drift at the authoring layer, mirroring how
// lint:inv6 scans content/.
//
// Defaults retargeted by task 042. They read `commands/ agents/ content/`, and
// the DR-4 render split retired the first two as top-level directories. CI
// coverage was never affected — `npm run lint:test-first-drift` passes
// `content rendered/agents` explicitly and always overrode these — but a
// default that contradicts the only real invocation is a trap: it is what a
// direct `node lint-test-first-drift.mjs` run uses, and what a reader takes as
// the declared scope. Aligning it removes the disagreement.
//
// Commands folded INTO content/, so that root needed no replacement. Agents are
// different and the asymmetry is deliberate: their .md is GENERATED from
// TypeScript under src/runtime/agents/, so there is no .md authoring layer to
// guard, and rendered/agents/ is the only surface this lint can see for them.
// Drift entering through a TS string literal is invisible to this gate either
// way — that gap is real and belongs to the generator's own tests, not here.
// Output: JSON to stdout: { findings: [...], advisory: false }.
// Exit code: 1 when findings exist (enforcing), else 0.
//
// Run via `npm run lint:test-first-drift`; also exercised by
// test/lint-test-first-drift.test.ts (seeded fixture must fail; clean tree must pass).

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

function walkMarkdown(dir) {
  const out = [];
  // Fail fast on a missing scan root: silently returning zero files would let
  // the guard PASS while scanning less than intended (a misconfigured dir list
  // reads as a clean tree). A missing subdir mid-walk is still tolerated below
  // (readdirSync try/catch) — only the requested root must exist.
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

function lintFile(file, findings) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');

  // Per-line literal rules (iron-law, no-production-code-first).
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

  // Whole-file rule: an unconditional [RED]/[GREEN]/[REFACTOR] task template —
  // all three bracketed phase markers present, with no explicit opt-in marker.
  // Case-insensitive so a trivial `[Red]`/`[red]` variant can't bypass the guard.
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
