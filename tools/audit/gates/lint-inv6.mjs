#!/usr/bin/env node
// Advisory lint for workflow agnosticism in skills.
//
// ADVISORY(control: inv6-workflow-agnosticism) — non-blocking. `ADVISORY_REGISTRY` in
// `src/install/advisory-registry.ts` holds its governance.
//
// It walks the SKILL.md files under a directory (default `content/`) and skips `_shared/`.
// It flags a body line with a workflow-type literal when the frontmatter declares no
// `workflow-type:`. It prints `{ findings, advisory: true }` as JSON and always exits 0.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Literals that name one workflow type: a branch prefix and a state value. They are
 * rare in prose, so a plain substring match is enough. `featureId` is not here,
 * because each workflow type uses it.
 */
const STRUCTURAL_LITERALS = ['feature/', 'merge-pending'];

/**
 * English words that also name phases. Prose uses them often, so one counts only as a
 * standalone word in a structural context ({@link hasDiscriminatingContext}).
 */
const PHRASE_LITERALS = ['delegate', 'synthesize', 'review', 'gathering'];

const RULE = 'workflow-type-literal-without-declaration';
const SEVERITY = 'LOW';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `literal` occurs in `line` as a standalone word, not inside a longer word such as `reviewer`. */
function hasWordBoundaryMatch(line, literal) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(literal)}(?:$|[^A-Za-z0-9_])`);
  return re.test(line);
}

/** True when `line` is a Markdown fenced-code-block delimiter (``` or ~~~). */
function isFenceDelimiter(line) {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * True when `literal` is in a structural context, which uses the word as a value and not
 * as prose. The contexts are a fenced code block, a quoted string or code span, a slash
 * command, and a `key: value` line such as `phase: delegate`.
 */
function hasDiscriminatingContext(line, literal, insideFence) {
  if (insideFence) return true;
  const esc = escapeRegExp(literal);
  if (new RegExp(`(['"\`])${esc}\\1`).test(line)) return true;
  if (new RegExp(`/${esc}(?:$|[^A-Za-z0-9_])`).test(line)) return true;
  if (new RegExp(`^\\s*[\\w-]+\\s*:\\s*['"\`]?${esc}(?:$|[^A-Za-z0-9_])`).test(line)) {
    return true;
  }
  return false;
}

const argDir = process.argv[2] ?? 'content/';
const rootDir = path.resolve(process.cwd(), argDir);

/** Returns the SKILL.md files under `dir`. It skips each `_shared/` directory at any depth. */
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
        if (ent.name === '_shared') continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Returns `{ frontmatter, body, bodyStartLine }`, with a 1-based start line. Without
 * a closed frontmatter block, `frontmatter` is `''` and `body` is the full text.
 */
function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) {
    return { frontmatter: '', body: text, bodyStartLine: 1 };
  }
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

/** True when the frontmatter has a `workflow-type:` key with a value, at any indentation. */
function hasWorkflowTypeDeclaration(frontmatter) {
  if (!frontmatter) return false;
  return /^\s*workflow-type\s*:\s*\S+/m.test(frontmatter);
}

function matchedLiteralForLine(line, insideFence) {
  for (const literal of STRUCTURAL_LITERALS) {
    if (line.includes(literal)) return literal;
  }
  for (const literal of PHRASE_LITERALS) {
    if (hasWordBoundaryMatch(line, literal) && hasDiscriminatingContext(line, literal, insideFence)) {
      return literal;
    }
  }
  return null;
}

/**
 * Returns one finding per matched body line. A fence delimiter toggles the fence state
 * after its own check, so the delimiter line is not inside the block.
 */
function findLiteralFindings(file, body, bodyStartLine) {
  const findings = [];
  const lines = body.split('\n');
  let insideFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const literal = matchedLiteralForLine(line, insideFence);
    if (literal) {
      findings.push({
        file,
        line: bodyStartLine + i,
        snippet: line.trim().slice(0, 200),
        rule: RULE,
        severity: SEVERITY,
        message: `workflow-typed literal "${literal}" appears in skill body without metadata.workflow-type declaration`,
      });
    }
    if (isFenceDelimiter(line)) insideFence = !insideFence;
  }
  return findings;
}

/** Writes the JSON to fd 1 with `writeSync`, because `process.exit` can cut off a buffered pipe write. */
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
  fs.writeSync(1, text);
  process.exit(0);
}

main();
