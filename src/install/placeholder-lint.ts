/**
 * Placeholder vocabulary lint for the skill sources. It reads each `SKILL.md`
 * under the sources root, finds each `{{TOKEN}}`, and flags a token that is not
 * in the vocabulary.
 *
 * It skips `references/` trees and `SKILL.<runtime>.md` overrides. The builder
 * copies an override verbatim. It renders a Markdown reference but keeps unknown
 * tokens, because a reference can hold other templating, such as `{{#each hints}}`.
 *
 * `buildAllSkills()` runs this lint before the renderer, so one error lists
 * each unknown token before a render can fail.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  PLACEHOLDER_REGEX,
  CALL_MACRO_REGEX,
  classifySkill,
  PREFIX_TOKENS,
  ORCHESTRATION_TOKENS,
  type SkillClass,
} from './skill-vocabulary.js';

/**
 * The default placeholder tokens that `content/` sources can use. These are
 * the `placeholders` keys of each `content/harness/runtimes/*.yaml`, and the
 * entries of `RuntimeTokenKey` in `src/install/runtimes/types.ts`.
 */
export const DEFAULT_PLACEHOLDER_VOCABULARY: readonly string[] = [
  'MCP_PREFIX',
  'COMMAND_PREFIX',
  'TASK_TOOL',
  'CHAIN',
  'SPAWN_AGENT_CALL',
  'SUBAGENT_COMPLETION_HOOK',
  'SUBAGENT_RESULT_API',
];

/**
 * Matches a raw MCP tool reference in the wire shape `mcp__<server>__<tool>`,
 * such as `mcp__plugin_exarchos_exarchos__exarchos_workflow`. This shape is
 * deprecated in favor of the `{{CALL ...}}` macro. The parts are lowercase, as
 * the MCP SDK emits them, so prose like "MCP__Placeholder" does not match.
 */
export const RAW_MCP_PATTERN = /mcp__[a-z0-9_]+__[a-z_]+/g;

/** An unknown token, the source file, and the 1-indexed line of the reference. */
export interface UnknownTokenFinding {
  token: string;
  file: string;
  line: number;
}

/**
 * A raw `mcp__...` reference that must move to the `{{CALL}}` macro. `pattern`
 * is the exact matched text, so diagnostics can echo it.
 */
export interface DeprecationWarning {
  pattern: string;
  file: string;
  line: number;
}

/**
 * A canonical token in a procedural skill. A procedural skill renders once for
 * all runtimes from logical prose, so it cannot carry a fork token. `kind`
 * names the rule that fired.
 *
 *   - `prefix`: a prefix token, `MCP_PREFIX` or `COMMAND_PREFIX`.
 *   - `orchestration`: an orchestration token. `classifySkill` makes each source
 *     with such a token an orchestration skill, so this rule does not fire in
 *     practice. The check keeps the rule explicit.
 */
export interface CollapsedVocabularyViolation {
  token: string;
  file: string;
  line: number;
  skillClass: SkillClass;
  kind: 'prefix' | 'orchestration';
}

/**
 * The result of a lint run. `passed` is true when there are no unknown tokens
 * and no collapsed-vocabulary violations. With `EXARCHOS_LINT_STRICT=1`, it
 * also needs no deprecation warnings. `message` always holds a readable summary.
 */
export interface PlaceholderLintResult {
  passed: boolean;
  unknownTokens: UnknownTokenFinding[];
  deprecationWarnings: DeprecationWarning[];
  collapsedVocabularyViolations: CollapsedVocabularyViolation[];
  message: string;
}

/** Options for `lintPlaceholders`. `vocabulary` defaults to `DEFAULT_PLACEHOLDER_VOCABULARY`. */
export interface LintPlaceholdersOptions {
  sourcesDir: string;
  vocabulary?: readonly string[];
  /**
   * Turn on the collapsed-vocabulary rules. It defaults to `false`. When it is
   * `false`, that pass does not run and `collapsedVocabularyViolations` is empty.
   */
  enforceCollapsedVocabulary?: boolean;
}

/**
 * Report each `{{TOKEN}}` in the `SKILL.md` files under `opts.sourcesDir` that
 * is not in the vocabulary. It does not throw for a violation, and the caller
 * decides what to do. A token inside a `{{CALL}}` macro does not count, because
 * `renderCallMacros()` expands macros first. The raw `mcp__` scan reads the
 * whole body, because a macro payload names a tool, not the wire shape. The
 * shared `/g` regexes get a `lastIndex` reset around each scan.
 *
 * @param opts.sourcesDir - Root of the skill sources. A missing root gives
 *   `passed: true` with no findings.
 */
export function lintPlaceholders(
  opts: LintPlaceholdersOptions,
): PlaceholderLintResult {
  const vocabulary = opts.vocabulary ?? DEFAULT_PLACEHOLDER_VOCABULARY;
  const vocabSet = new Set(vocabulary);
  const enforceCollapsed = opts.enforceCollapsedVocabulary === true;

  const prefixSet: ReadonlySet<string> = PREFIX_TOKENS;
  const orchestrationSet: ReadonlySet<string> = ORCHESTRATION_TOKENS;

  const findings: UnknownTokenFinding[] = [];
  const deprecationWarnings: DeprecationWarning[] = [];
  const collapsedVocabularyViolations: CollapsedVocabularyViolation[] = [];

  if (existsSync(opts.sourcesDir)) {
    const skillFiles = collectSkillFiles(opts.sourcesDir);
    for (const file of skillFiles) {
      const body = readFileSync(file, 'utf8');

      const skillClass: SkillClass | undefined = enforceCollapsed
        ? classifySkill(body).skillClass
        : undefined;

      const callRanges: Array<[number, number]> = [];
      const callRegex = new RegExp(CALL_MACRO_REGEX.source, 'g');
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(body)) !== null) {
        callRanges.push([callMatch.index, callMatch.index + callMatch[0].length]);
      }

      PLACEHOLDER_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PLACEHOLDER_REGEX.exec(body)) !== null) {
        const token = match[1];
        if (token === undefined) continue;
        const offset = match.index;
        const insideCall = callRanges.some(
          ([start, end]) => offset >= start && offset < end,
        );
        if (insideCall) continue;

        if (!vocabSet.has(token)) {
          findings.push({
            token,
            file,
            line: lineOf(body, match.index),
          });
        }

        if (enforceCollapsed && skillClass === 'procedural') {
          if (prefixSet.has(token)) {
            collapsedVocabularyViolations.push({
              token,
              file,
              line: lineOf(body, match.index),
              skillClass,
              kind: 'prefix',
            });
          } else if (orchestrationSet.has(token)) {
            collapsedVocabularyViolations.push({
              token,
              file,
              line: lineOf(body, match.index),
              skillClass,
              kind: 'orchestration',
            });
          }
        }
      }
      PLACEHOLDER_REGEX.lastIndex = 0;

      RAW_MCP_PATTERN.lastIndex = 0;
      let mcpMatch: RegExpExecArray | null;
      while ((mcpMatch = RAW_MCP_PATTERN.exec(body)) !== null) {
        deprecationWarnings.push({
          pattern: mcpMatch[0],
          file,
          line: lineOf(body, mcpMatch.index),
        });
      }
      RAW_MCP_PATTERN.lastIndex = 0;
    }
  }

  const strict = process.env.EXARCHOS_LINT_STRICT === '1';
  const passed =
    findings.length === 0 &&
    collapsedVocabularyViolations.length === 0 &&
    (!strict || deprecationWarnings.length === 0);
  const message = formatMessage(
    findings,
    deprecationWarnings,
    collapsedVocabularyViolations,
    vocabulary,
    strict,
  );

  return {
    passed,
    unknownTokens: findings,
    deprecationWarnings,
    collapsedVocabularyViolations,
    message,
  };
}

/**
 * Collect each `SKILL.md` under `root`, and skip `references/` directories.
 * The lint does not read references or `SKILL.<runtime>.md` overrides, because
 * they can hold other templating. The sorted result keeps the message stable.
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
        if (entry === 'references') continue;
        stack.push(full);
        continue;
      }
      if (st.isFile() && entry === 'SKILL.md') {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** 1-indexed line number of `offset` in `source`. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Build one readable message for all findings. It has a section for unknown
 * tokens with the sorted vocabulary, one for raw `mcp__` references, and one
 * for collapsed-vocabulary violations. Each entry gives `file:line`, and each
 * section gives a fix. A clean run gives one line.
 */
function formatMessage(
  findings: UnknownTokenFinding[],
  deprecationWarnings: DeprecationWarning[],
  collapsedVocabularyViolations: CollapsedVocabularyViolation[],
  vocabulary: readonly string[],
  strict: boolean,
): string {
  if (
    findings.length === 0 &&
    deprecationWarnings.length === 0 &&
    collapsedVocabularyViolations.length === 0
  ) {
    return '[placeholder-lint] no unknown placeholders found';
  }

  const lines: string[] = [];

  if (findings.length > 0) {
    lines.push(
      `[placeholder-lint] found ${findings.length} unknown placeholder token(s):`,
    );
    for (const f of findings) {
      lines.push(`  - {{${f.token}}} at ${f.file}:${f.line}`);
    }
    lines.push('');
    const sortedVocab = [...vocabulary].sort().join(', ');
    lines.push(`Canonical vocabulary: [${sortedVocab}]`);
    lines.push(
      'To fix: add the token to every content/harness/runtimes/*.yaml placeholders map, or remove it from the source.',
    );
  }

  if (deprecationWarnings.length > 0) {
    if (lines.length > 0) lines.push('');
    const label = strict ? 'error' : 'warning';
    lines.push(
      `[placeholder-lint] found ${deprecationWarnings.length} deprecated mcp__ reference(s) (${label}):`,
    );
    for (const w of deprecationWarnings) {
      lines.push(`  - ${w.pattern} at ${w.file}:${w.line}`);
    }
    lines.push('');
    lines.push(
      'Migrate raw `mcp__...` references to the `{{CALL <tool> <action> <jsonArgs>}}` macro.',
    );
    if (!strict) {
      lines.push(
        'Set EXARCHOS_LINT_STRICT=1 to promote these warnings to errors once migration is complete.',
      );
    }
  }

  if (collapsedVocabularyViolations.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `[placeholder-lint] found ${collapsedVocabularyViolations.length} collapsed-vocabulary violation(s):`,
    );
    for (const v of collapsedVocabularyViolations) {
      const reason =
        v.kind === 'prefix'
          ? 'prefix token in a procedural skill'
          : 'orchestration token in a procedural skill';
      lines.push(`  - {{${v.token}}} at ${v.file}:${v.line} (${reason})`);
    }
    lines.push('');
    lines.push(
      'Procedural skills render once for all runtimes from logical prose and ' +
        'must not reference canonical fork tokens. Rewrite the reference to ' +
        'logical prose, or move the skill to the orchestration residual.',
    );
  }

  return lines.join('\n');
}
