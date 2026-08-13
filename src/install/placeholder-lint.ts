/**
 * Placeholder vocabulary lint for the platform-agnostic skills tree.
 *
 * Enforces a canonical set of `{{TOKEN}}` names that the skill source
 * authors are allowed to use. The lint walks `content/` (or any
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
import {
  PLACEHOLDER_REGEX,
  CALL_MACRO_REGEX,
  classifySkill,
  PREFIX_TOKENS,
  ORCHESTRATION_TOKENS,
  type SkillClass,
} from './skill-vocabulary.js';

/**
 * Canonical vocabulary of placeholder tokens that `content/` sources
 * may reference. Derived as the union of `placeholders` keys across
 * every runtime YAML under `runtimes/` (verified in Task 024 GREEN
 * against the current six-runtime set; all six define exactly these
 * five keys).
 *
 * Expandable: adding a new entry here and to every `runtimes/*.yaml`
 * is enough to introduce a new token without code changes elsewhere.
 * Removing an entry requires sweeping `content/` for any remaining
 * references first — the lint will catch stragglers.
 */
export const DEFAULT_PLACEHOLDER_VOCABULARY: readonly string[] = [
  'MCP_PREFIX',
  'COMMAND_PREFIX',
  'TASK_TOOL',
  'CHAIN',
  'SPAWN_AGENT_CALL',
  // Wave A (P4 prose layer) — capability-aware skill renderer tokens.
  // Mirror of `RuntimeTokenKey` in `src/runtimes/types.ts`. Skills use
  // these instead of hard-coded Claude primitives so prose tokenizes
  // cleanly across runtimes.
  'SUBAGENT_COMPLETION_HOOK',
  'SUBAGENT_RESULT_API',
];

/**
 * Matches a raw MCP tool reference in its canonical wire shape:
 * `mcp__<plugin_server>__<tool>`, e.g.
 * `mcp__plugin_exarchos_exarchos__exarchos_workflow`.
 *
 * Used to detect deprecated references that should be migrated to the
 * `{{CALL ...}}` macro (DR-2 + DR-8 transition window). The `/g` flag
 * lets callers iterate every occurrence in a file. The identifier parts
 * are lowercase-only because that is how the MCP SDK emits tool names;
 * any uppercase hit is intentionally ignored to avoid matching arbitrary
 * prose like "MCP__Placeholder".
 */
export const RAW_MCP_PATTERN = /mcp__[a-z0-9_]+__[a-z_]+/g;

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
 * A single deprecation finding: a literal `mcp__...` reference that
 * should be migrated to the `{{CALL}}` macro. `pattern` is the exact
 * matched text so the caller can echo it back verbatim in diagnostics.
 *
 * Implements DR-2 + DR-8 transition-window signal.
 */
export interface DeprecationWarning {
  pattern: string;
  file: string;
  line: number;
}

/**
 * A single collapsed-vocabulary finding: a canonical token that a source
 * references in violation of its derived skill class.
 *
 * Two rules produce these (both keyed on the source's `classifySkill` class):
 *
 *   - `prefix`        — a prefix token (`MCP_PREFIX`/`COMMAND_PREFIX`) appears
 *     in a *procedural* skill. In the collapsed vocabulary a procedural skill
 *     renders once for every runtime from logical prose, so it must not carry
 *     a per-harness prefix token.
 *   - `orchestration` — an orchestration token appears in a *procedural* skill.
 *     Orchestration tokens are valid ONLY in an orchestration-classified skill.
 *     (Because `classifySkill` derives `orchestration` from the presence of an
 *     orchestration token, a procedural source never carries one in practice;
 *     the rule is checked explicitly so the contract is literal and any future
 *     decoupling of classification still enforces it.)
 *
 * `skillClass` records the derived class of the offending source and `kind`
 * records which rule fired, so diagnostics can explain the violation precisely.
 */
export interface CollapsedVocabularyViolation {
  token: string;
  file: string;
  line: number;
  skillClass: SkillClass;
  kind: 'prefix' | 'orchestration';
}

/**
 * Result of a lint run. `passed === true` iff `unknownTokens` is empty
 * *and* `collapsedVocabularyViolations` is empty *and* (when
 * `EXARCHOS_LINT_STRICT=1`) `deprecationWarnings` is empty.
 * `message` is always populated so callers can log a human-readable
 * summary regardless of outcome (a clean run reports "no unknown
 * placeholders found"; a dirty run aggregates every offender plus the
 * canonical vocabulary so the remediation is self-contained).
 *
 * `deprecationWarnings` carries informational findings about raw
 * `mcp__...` references. Outside strict mode these never flip
 * `passed` — the build must keep succeeding during the migration
 * window. Once the window closes, setting `EXARCHOS_LINT_STRICT=1`
 * promotes them to hard failures without a code change.
 */
export interface PlaceholderLintResult {
  passed: boolean;
  unknownTokens: UnknownTokenFinding[];
  deprecationWarnings: DeprecationWarning[];
  collapsedVocabularyViolations: CollapsedVocabularyViolation[];
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
  /**
   * Opt-in switch for the collapsed-vocabulary rules (prefix token in a
   * procedural skill, orchestration token in a procedural skill). Defaults to
   * `false` so the current build stays green while `content/` procedural
   * skills still carry `MCP_PREFIX`/`COMMAND_PREFIX` tokens — those are only
   * rewritten to logical prose in a later task, which flips this flag on. When
   * `false` the collapsed-vocabulary pass does not run at all, so the result is
   * byte-for-byte identical to the pre-collapse lint (empty
   * `collapsedVocabularyViolations`, unchanged `passed`).
   */
  enforceCollapsedVocabulary?: boolean;
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
 *   `content/`). Must exist; a missing root returns `passed: true`
 *   with an empty finding list so the lint is a no-op on empty
 *   projects rather than a hard error (the empty-tree failure mode is
 *   the responsibility of `buildAllSkills`, not the lint).
 * @param opts.vocabulary - Set of allowed token names. Defaults to
 *   `DEFAULT_PLACEHOLDER_VOCABULARY`.
 * @param opts.enforceCollapsedVocabulary - Opt-in switch for the
 *   collapsed-vocabulary rules. `false` (default) keeps the current build green
 *   while procedural sources still carry prefix tokens; a later rewrite task
 *   flips it on. See {@link LintPlaceholdersOptions.enforceCollapsedVocabulary}.
 */
export function lintPlaceholders(
  opts: LintPlaceholdersOptions,
): PlaceholderLintResult {
  const vocabulary = opts.vocabulary ?? DEFAULT_PLACEHOLDER_VOCABULARY;
  const vocabSet = new Set(vocabulary);
  const enforceCollapsed = opts.enforceCollapsedVocabulary === true;

  // Widen the canonical token sets to `ReadonlySet<string>` so raw `{{...}}`
  // identifiers (strings) can be membership-tested without narrowing each one
  // to `RuntimeTokenName` first. These are the single source of the prefix /
  // orchestration split — never re-listed here (imported from build-skills.ts).
  const prefixSet: ReadonlySet<string> = PREFIX_TOKENS;
  const orchestrationSet: ReadonlySet<string> = ORCHESTRATION_TOKENS;

  const findings: UnknownTokenFinding[] = [];
  const deprecationWarnings: DeprecationWarning[] = [];
  const collapsedVocabularyViolations: CollapsedVocabularyViolation[] = [];

  if (existsSync(opts.sourcesDir)) {
    const skillFiles = collectSkillFiles(opts.sourcesDir);
    for (const file of skillFiles) {
      const body = readFileSync(file, 'utf8');

      // Collapsed-vocabulary pass is opt-in. When enabled, derive the skill's
      // class once per file from the single source of truth (`classifySkill`);
      // a source is `orchestration` iff it references an orchestration token,
      // `procedural` otherwise. The per-token checks below key off this class.
      const skillClass: SkillClass | undefined = enforceCollapsed
        ? classifySkill(body).skillClass
        : undefined;

      // Collect the byte-ranges occupied by CALL macros so we can skip
      // placeholder hits that fall inside a macro. CALL macros are
      // handled by `renderCallMacros()` before `render()`, so they
      // are not vocabulary tokens.
      const callRanges: Array<[number, number]> = [];
      const callRegex = new RegExp(CALL_MACRO_REGEX.source, 'g');
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(body)) !== null) {
        callRanges.push([callMatch.index, callMatch.index + callMatch[0].length]);
      }

      // Reset the stateful /g regex before each file so prior scans
      // don't leak `lastIndex` into this one.
      PLACEHOLDER_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PLACEHOLDER_REGEX.exec(body)) !== null) {
        const token = match[1];
        if (token === undefined) continue;
        // Skip tokens that fall inside a CALL macro range.
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

        // Collapsed-vocabulary rules (opt-in). Both fire only for a
        // *procedural* skill: in the collapsed vocabulary a procedural skill
        // renders once for every runtime from logical prose and must not carry
        // any canonical fork token.
        //   - Rule 1: a prefix token in a procedural skill is a violation.
        //   - Rule 2: an orchestration token is valid ONLY in an
        //     orchestration-classified skill; in a procedural skill it is a
        //     violation. (Because `classifySkill` derives `orchestration` from
        //     an orchestration token's presence, this branch is inert for
        //     `classifySkill`-derived classes but is checked so the rule holds
        //     literally regardless of how the class was obtained.)
        // Orchestration skills legitimately reference both kinds, so no
        // violation is raised for them.
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

      // Second pass: detect deprecated raw `mcp__...` references
      // anywhere in the file body. These are intentionally scanned
      // across the full text (not gated by CALL ranges) because a CALL
      // macro's payload names a tool like `exarchos_workflow`, not the
      // wire shape `mcp__...__...`, so there is no legitimate overlap.
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

  // Unknown placeholders and collapsed-vocabulary violations are always hard
  // failures. Deprecation warnings are informational by default;
  // `EXARCHOS_LINT_STRICT=1` promotes them to failures once the migration
  // transition window closes. (Collapsed-vocabulary violations are only ever
  // produced when `enforceCollapsedVocabulary` is on, so the default build is
  // unaffected.)
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
 * Build a human-readable aggregated message that combines two kinds of
 * findings:
 *
 *   1. Unknown placeholder tokens — always hard failures, always
 *      reported. The section names every offending `{{token}}` with its
 *      `file:line`, lists the canonical vocabulary, and points at the
 *      remediation (add the token to `runtimes/*.yaml` or remove it
 *      from the source).
 *
 *   2. Deprecated `mcp__...` references — informational during the
 *      DR-2/DR-8 transition window; hard failures under
 *      `EXARCHOS_LINT_STRICT=1`. Each entry carries the exact matched
 *      pattern and `file:line`, and points authors at the `{{CALL}}`
 *      macro migration path.
 *
 *   3. Collapsed-vocabulary violations — always hard failures, but only ever
 *      produced when `enforceCollapsedVocabulary` is on. Each entry names the
 *      offending canonical `{{token}}` with its `file:line` and the derived
 *      skill class, and points authors at the logical-prose remediation.
 *
 * A clean run (no findings of any kind) yields a single "all clear" line so
 * callers that always print `result.message` do something sensible on success.
 *
 * The vocabulary list is sorted so the message is deterministic even
 * if a future caller passes an unsorted array.
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
      'To fix: add the token to every runtimes/*.yaml placeholders map, or remove it from the source.',
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
