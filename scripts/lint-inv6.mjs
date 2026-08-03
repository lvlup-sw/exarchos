#!/usr/bin/env node
// scripts/lint-inv6.mjs — advisory lint for INV-6 (workflow-agnosticism).
//
// ADVISORY(control: inv6-workflow-agnosticism) — non-blocking INV-6 grep lint; governance (owner, promotion/removal thresholds, expiry, kill fixture, unfiltered CI path) is enumerated in src/advisory-registry.ts (ADVISORY_REGISTRY), P07-07.
//
// Walks SKILL.md files under a given directory (default: skills-src/) and
// flags those whose body contains workflow-typed literals but whose
// frontmatter does NOT declare `metadata.workflow-type:`. Skills under a
// `_shared/` directory are exempt by convention.
//
// Output: JSON to stdout, shape:
//   { findings: [{file, line, snippet, rule, severity, message}, ...],
//     advisory: true }
//
// Exit code: 0 always (advisory). Designed to be run via
// `npm run lint:inv6` and to be wired into `skills:guard` with
// `|| true` so its findings are visible but its exit does not propagate.

import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW_LITERALS = [
  'feature/',
  'featureId',
  'merge-pending',
  'delegate',
  'synthesize',
  'review',
  'gathering',
];

const RULE = 'workflow-type-literal-without-declaration';
const SEVERITY = 'LOW';

const argDir = process.argv[2] ?? 'skills-src/';
const rootDir = path.resolve(process.cwd(), argDir);

function walkSkillFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
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
        // Skip `_shared/` by directory-segment match (any depth).
        if (ent.name === '_shared') continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out;
}

function splitFrontmatter(text) {
  // Returns {frontmatter: string, body: string, bodyStartLine: number (1-based)}
  // If no frontmatter, frontmatter is '' and body is the full text.
  if (!text.startsWith('---\n')) {
    return { frontmatter: '', body: text, bodyStartLine: 1 };
  }
  // Find the closing `\n---` followed by newline or EOF.
  const closingMatch = text.match(/^---\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!closingMatch) {
    return { frontmatter: '', body: text, bodyStartLine: 1 };
  }
  const frontmatter = closingMatch[1];
  const consumed = closingMatch[0];
  const body = text.slice(consumed.length);
  const bodyStartLine = consumed.split('\n').length;
  return { frontmatter, body, bodyStartLine };
}

function hasWorkflowTypeDeclaration(frontmatter) {
  if (!frontmatter) return false;
  // Match a `workflow-type:` key at any indentation (top-level or
  // nested under `metadata:`). Treat presence with any non-empty value
  // as a declaration.
  return /^\s*workflow-type\s*:\s*\S+/m.test(frontmatter);
}

function findLiteralFindings(file, body, bodyStartLine) {
  const findings = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const literal of WORKFLOW_LITERALS) {
      if (line.includes(literal)) {
        findings.push({
          file,
          line: bodyStartLine + i,
          snippet: line.trim().slice(0, 200),
          rule: RULE,
          severity: SEVERITY,
          message: `workflow-typed literal "${literal}" appears in skill body without metadata.workflow-type declaration`,
        });
        // One finding per line is enough — break after first literal hit.
        break;
      }
    }
  }
  return findings;
}

function main() {
  const allFindings = [];
  const skillFiles = walkSkillFiles(rootDir);
  for (const file of skillFiles) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body, bodyStartLine } = splitFrontmatter(text);
    if (hasWorkflowTypeDeclaration(frontmatter)) continue;
    const findings = findLiteralFindings(file, body, bodyStartLine);
    allFindings.push(...findings);
  }
  const output = { findings: allFindings, advisory: true };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  // Write synchronously to fd 1 to avoid truncation when stdout is a
  // pipe — `process.stdout.write` + `process.exit(0)` does not always
  // flush before the process exits.
  fs.writeSync(1, text);
  process.exit(0);
}

main();
