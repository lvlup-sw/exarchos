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
//
// ─── Literal narrowing (T-22 / DR-15) ───────────────────────────────────────
//
// The literals in WORKFLOW_LITERALS fall into three groups, and each needs
// its own detection strategy (or, for `featureId`, none at all — see below):
//
//   - STRUCTURAL_LITERALS (`feature/`, `merge-pending`) are genuinely
//     TYPE-specific: `feature/` hardcodes ONE workflow type's branch-naming
//     convention (a `refactor` or `debug` workflow may use a different
//     prefix entirely), and `merge-pending` hardcodes ONE workflow type's
//     state-machine value. Their exact spelling essentially never occurs by
//     accident in ordinary prose, so a plain substring match is already
//     discriminating. Left as `.includes()`, unchanged.
//
//   - `featureId` was REMOVED from the literal set entirely (T-22 second
//     pass) rather than narrowed. It is not a workflow-TYPE literal: it is
//     the universal stream/workflow identifier parameter, used identically
//     by every workflow type this tool supports (`feature`, `refactor`,
//     `debug`, `oneshot`, `discover`, ...). A skill that reads/writes
//     `featureId` is being workflow-AGNOSTIC — that is exactly what INV-6
//     asks for, not a violation of it. Unlike the phrase literals below,
//     there is no syntactic context that would distinguish a "bad" use of
//     `featureId` from a "good" one, because every use is the same generic
//     parameter reference — so no context filter would ever separate a real
//     positive from the noise, and removal (not narrowing) is the correct
//     fix. This was 96 of the pre-fix 196 residual findings — the single
//     largest component — and was a miscalibration of the detector's
//     subject rather than an acceptable residual.
//
//   - PHRASE_LITERALS (`delegate`, `synthesize`, `review`, `gathering`) are
//     bare English verbs/nouns that appear constantly in ordinary prose
//     ("review the changes", "delegate to a subagent", "the gathering
//     phase") and, unqualified, make the advisory's zero-findings promotion
//     threshold structurally unreachable. Two independent narrowings apply:
//
//       1. WORD-BOUNDARY matching, so the literal must stand alone rather
//          than merely appear as a substring of a longer word — the
//          previous `.includes()` flagged `reviewer`, `reviewed`,
//          `previewing`, and `delegated` as if they were the bare literal.
//
//       2. A DISCRIMINATING SYNTACTIC CONTEXT is required beyond the word
//          boundary — a phrase literal occurring in a plain prose sentence
//          is NOT flagged. It only counts as a candidate INV-6 leak when it
//          appears as one of:
//            - a quoted literal or inline code span: 'delegate', "review",
//              `synthesize`
//            - inside a fenced code block (``` ... ```)
//            - a phase-valued assignment, e.g. `phase: delegate`,
//              `workflowType: refactor`
//            - a slash command, e.g. `/delegate`
//          These are the shapes that indicate the term is being used
//          STRUCTURALLY (as a value, a command, or literal code) rather
//          than descriptively (as an English verb in a sentence) — which is
//          the actual signal INV-6 cares about.
//
//     Unlike `featureId`, these ARE distinguishable this way: a skill can
//     genuinely mention "review" in prose without hardcoding a phase value,
//     but every use of `featureId` IS the same generic parameter — there is
//     no equivalent "prose" sense of `featureId` to exempt.

import * as fs from 'node:fs';
import * as path from 'node:path';

// Identifier-/path-shaped literals that are genuinely workflow-TYPE-specific
// (see the module banner above for why `featureId` is not among them):
// matched as a plain substring (unchanged behavior).
const STRUCTURAL_LITERALS = ['feature/', 'merge-pending'];

// Bare-verb/noun literals: matched only with a word boundary AND a
// discriminating structural context (see the module banner above).
const PHRASE_LITERALS = ['delegate', 'synthesize', 'review', 'gathering'];

const RULE = 'workflow-type-literal-without-declaration';
const SEVERITY = 'LOW';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `literal` occurs in `line` as a standalone word (not as a
 * substring of a longer word — `reviewer`, `previewing`, `delegated`). */
function hasWordBoundaryMatch(line, literal) {
  const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(literal)}(?:$|[^A-Za-z0-9_])`);
  return re.test(line);
}

/** True when `line` is a Markdown fenced-code-block delimiter (``` or ~~~). */
function isFenceDelimiter(line) {
  return /^\s*(```|~~~)/.test(line);
}

/**
 * True when `literal` appears in `line` inside one of the discriminating
 * structural contexts described in the module banner above: a quoted
 * literal / inline code span, a phase-valued assignment, or a slash
 * command. `insideFence` short-circuits to true because any content
 * inside a fenced code block is already structural by construction.
 */
function hasDiscriminatingContext(line, literal, insideFence) {
  if (insideFence) return true;
  const esc = escapeRegExp(literal);
  // Quoted literal or inline code span: 'literal', "literal", `literal`.
  if (new RegExp(`(['"\`])${esc}\\1`).test(line)) return true;
  // Slash command: /literal
  if (new RegExp(`/${esc}(?:$|[^A-Za-z0-9_])`).test(line)) return true;
  // Phase-valued assignment / frontmatter-like key-value, e.g.
  // `phase: delegate`, `workflowType: refactor`.
  if (new RegExp(`^\\s*[\\w-]+\\s*:\\s*['"\`]?${esc}(?:$|[^A-Za-z0-9_])`).test(line)) {
    return true;
  }
  return false;
}

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
    // Toggle fence state AFTER evaluating this line — a fence delimiter
    // line itself is not treated as "inside" the block it opens/closes.
    if (isFenceDelimiter(line)) insideFence = !insideFence;
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
