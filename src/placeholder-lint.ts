/**
 * Placeholder vocabulary lint for the platform-agnostic skills tree.
 *
 * Enforces a canonical set of `{{TOKEN}}` names that the skill source
 * authors are allowed to use. The lint walks `skills-src/` (or any
 * equivalent root passed via `sourcesDir`), pulls every `{{TOKEN}}`
 * reference out of every `SKILL.md` (and runtime-override
 * `SKILL.<runtime>.md`) file, and flags any identifier that is not a
 * member of the vocabulary.
 *
 * `references/**` subtrees are deliberately skipped: those files are
 * copied verbatim by `buildAllSkills()` and may legitimately contain
 * non-canonical handlebar-style templating (for example,
 * `{{#each hints}} ... {{hint}} ... {{/each}}` in a prompt fragment).
 * Subjecting references to the same lint would produce false positives.
 *
 * Wired into `buildAllSkills()` as a pre-flight step so an unknown
 * token fails fast with an aggregated error report *before* the
 * renderer runs — this is how DR-3 shifts the "unknown placeholder"
 * signal from per-variant render failure to a single top-level lint
 * error that lists every offender in one go.
 *
 * Implements: DR-3 (lint path).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { PLACEHOLDER_REGEX } from './build-skills.js';

/**
 * Canonical vocabulary of placeholder tokens that `skills-src/` sources
 * may reference. Derived as the union of `placeholders` keys across
 * every runtime YAML under `runtimes/` (verified in Task 024 GREEN
 * against the current six-runtime set; all six define exactly these
 * five keys).
 *
 * Expandable: adding a new entry here and to every `runtimes/*.yaml`
 * is enough to introduce a new token without code changes elsewhere.
 * Removing an entry requires sweeping `skills-src/` for any remaining
 * references first — the lint will catch stragglers.
 */
export const DEFAULT_PLACEHOLDER_VOCABULARY: readonly string[] = [
  'MCP_PREFIX',
  'COMMAND_PREFIX',
  'TASK_TOOL',
  'CHAIN',
  'SPAWN_AGENT_CALL',
];

/**
 * A single unknown-token finding: which identifier was referenced,
 * which source file referenced it, and on which 1-indexed line the
 * reference appeared.
 */
export interface UnknownTokenFinding {
  token: string;
  file: string;
  line: number;
}

/**
 * Result of a lint run. `passed === true` iff `unknownTokens` is empty.
 * `message` is always populated so callers can log a human-readable
 * summary regardless of outcome (a clean run reports "no unknown
 * placeholders found"; a dirty run aggregates every offender plus the
 * canonical vocabulary so the remediation is self-contained).
 */
export interface PlaceholderLintResult {
  passed: boolean;
  unknownTokens: UnknownTokenFinding[];
  message: string;
}

/**
 * Options for `lintPlaceholders`. `vocabulary` defaults to
 * `DEFAULT_PLACEHOLDER_VOCABULARY` — tests override it to exercise
 * edge cases without touching the default set.
 */
export interface LintPlaceholdersOptions {
  sourcesDir: string;
  vocabulary?: readonly string[];
}

/**
 * Walk `opts.sourcesDir` and return a structured report of every
 * `{{TOKEN}}` reference whose identifier is not in `opts.vocabulary`.
 * Runs in a single pass over the source tree and *never* throws for a
 * vocabulary violation — callers decide how to surface the result
 * (throw, process.exit, print). `buildAllSkills()` throws on a
 * non-passing result; a standalone CLI could print and exit.
 *
 * Files scanned:
 *   - `SKILL.md`
 *
 * Files NOT scanned:
 *   - `SKILL.<runtime>.md` runtime-specific override files — these
 *     are written verbatim by `buildAllSkills()` with no rendering,
 *     so they are intentionally allowed to carry arbitrary templating
 *     (e.g. another tool's native syntax) that the canonical
 *     vocabulary would reject.
 *   - anything under a `references/` subdirectory — also copied
 *     verbatim, also out of scope for the vocabulary lint.
 *   - anything that is not named `SKILL.md`
 *
 * @param opts.sourcesDir - Root of the skill source tree (e.g.
 *   `skills-src/`). Must exist; a missing root returns `passed: true`
 *   with an empty finding list so the lint is a no-op on empty
 *   projects rather than a hard error (the empty-tree failure mode is
 *   the responsibility of `buildAllSkills`, not the lint).
 * @param opts.vocabulary - Set of allowed token names. Defaults to
 *   `DEFAULT_PLACEHOLDER_VOCABULARY`.
 */
export function lintPlaceholders(
  opts: LintPlaceholdersOptions,
): PlaceholderLintResult {
  const vocabulary = opts.vocabulary ?? DEFAULT_PLACEHOLDER_VOCABULARY;
  const vocabSet = new Set(vocabulary);

  const findings: UnknownTokenFinding[] = [];

  if (existsSync(opts.sourcesDir)) {
    const skillFiles = collectSkillFiles(opts.sourcesDir);
    for (const file of skillFiles) {
      const body = readFileSync(file, 'utf8');
      // Reset the stateful /g regex before each file so prior scans
      // don't leak `lastIndex` into this one.
      PLACEHOLDER_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PLACEHOLDER_REGEX.exec(body)) !== null) {
        const token = match[1];
        if (!vocabSet.has(token)) {
          findings.push({
            token,
            file,
            line: lineOf(body, match.index),
          });
        }
      }
      PLACEHOLDER_REGEX.lastIndex = 0;
    }
  }

  const passed = findings.length === 0;
  const message = passed
    ? '[placeholder-lint] no unknown placeholders found'
    : formatFailureMessage(findings, vocabulary);

  return { passed, unknownTokens: findings, message };
}

/**
 * Recursively collect every `SKILL.md` file under `root`, skipping
 * `references/` subdirectories and runtime-specific override files
 * (`SKILL.<runtime>.md`). Returns absolute paths sorted for
 * determinism (so the aggregated failure message is reproducible
 * across filesystems).
 */
function collectSkillFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Skip `references/` — those files are copied verbatim by
        // buildAllSkills and are out of scope for the vocabulary lint.
        if (entry === 'references') continue;
        stack.push(full);
        continue;
      }
      // Only lint `SKILL.md`. Runtime override files `SKILL.<rt>.md`
      // are copied verbatim by the builder with no rendering, so
      // subjecting them to the canonical vocabulary would block the
      // very escape hatch they exist to provide.
      if (st.isFile() && entry === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/**
 * 1-indexed line number of `offset` within `source`. Same helper as
 * `build-skills.ts`; duplicated here to avoid widening the public
 * surface of that module for a single internal helper.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Build a human-readable aggregated error message that:
 *   1. Names every offending `{{token}}` with its `file:line`.
 *   2. Lists the canonical vocabulary so developers can see what *is*
 *      allowed without digging through source.
 *   3. Points at the remediation: add the token to `runtimes/*.yaml`
 *      or remove it from the source.
 *
 * The vocabulary list is sorted so the message is deterministic even
 * if a future caller passes an unsorted array.
 */
function formatFailureMessage(
  findings: UnknownTokenFinding[],
  vocabulary: readonly string[],
): string {
  const sortedVocab = [...vocabulary].sort().join(', ');
  const lines: string[] = [
    `[placeholder-lint] found ${findings.length} unknown placeholder token(s):`,
  ];
  for (const f of findings) {
    lines.push(`  - {{${f.token}}} at ${f.file}:${f.line}`);
  }
  lines.push('');
  lines.push(`Canonical vocabulary: [${sortedVocab}]`);
  lines.push(
    'To fix: add the token to every runtimes/*.yaml placeholders map, or remove it from the source.',
  );
  return lines.join('\n');
}
