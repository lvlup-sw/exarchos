/**
 * Wave B: post-render vocabulary lint for the platform-agnostic skills
 * tree.
 *
 * Runs after each runtime's SKILL.md has been fully rendered (guards
 * elided + CALL macros expanded + tokens substituted + Claude-only
 * code blocks elided) and scans the output bytes for forbidden Claude-
 * only terms. If a term appears in a non-Claude render, the build
 * fails with an aggregated diagnostic listing every offender.
 *
 * Why post-render rather than source-side:
 *   - Source-side scanning would have to re-implement guard semantics
 *     to know whether a term is "actually" Claude-only or just sitting
 *     in a guard that elides on non-Claude. Doing it post-render lets
 *     us trust the rendered bytes — if it survived to OpenCode's
 *     output, it's a real leak.
 *   - The renderer pipeline is the single source of truth for what
 *     reaches a runtime; the lint piggybacks on that pipeline.
 *
 * Why the Claude render is exempt:
 *   - Claude is the canonical home for these terms. They're its
 *     first-class primitives. The lint is here to catch *non-Claude*
 *     leaks, not to police Claude's prose.
 *   - The exemption is keyed off a runtime's `supportedCapabilities`
 *     declaration of `team:agent-teams: native` (Claude is the only
 *     runtime that does), so a future runtime that gains real Agent
 *     Teams support would automatically be exempted without a code
 *     change here.
 *
 * What is NOT in the forbidden list (deliberately):
 *   - `agent-team` / `agent-teams` — appears as a substring of the
 *     capability identifier `team:agent-teams`, which legitimately
 *     ships in cross-runtime prose (e.g. as a YAML key in an embedded
 *     code sample). The original Task 10 spec listed `agent-team` here;
 *     Wave B explicitly omits it to dodge that false-positive class.
 *
 * Implements: delegation runtime parity Wave B (P4 prose layer).
 */

import type { RuntimeMap } from './runtimes/types.js';

/**
 * Canonical list of Claude-only API/primitive identifiers that must
 * not appear in non-Claude renders. Mirrors what Wave A migrated out
 * of the `delegation/` skill source. Exported as a typed `as const`
 * tuple so the lint and its tests share one source of truth.
 *
 * Adding to this list:
 *   - The term must be a Claude-specific primitive (a hook name, a
 *     tool name like `TaskOutput`, an Agent-Teams API like
 *     `TeamCreate`/`SendMessage`).
 *   - It must not appear as a substring in cross-runtime
 *     prose — e.g. `agent-team` is excluded because `team:agent-teams`
 *     is a legitimate cross-runtime capability identifier.
 *
 * Removing from this list:
 *   - Acceptable when the term becomes universally available
 *     (unlikely) or when a runtime gains native support for the
 *     underlying primitive (preferred remedy: just declare the cap
 *     in that runtime's YAML instead).
 */
export const FORBIDDEN_CLAUDE_ONLY_TERMS = [
  'TeammateIdle',
  'SubagentStart',
  'SubagentStop',
  'TaskOutput',
  'TaskList',
  'TaskUpdate',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
  'agentId',
] as const;

/**
 * String-literal union of `FORBIDDEN_CLAUDE_ONLY_TERMS`. Exported so
 * call sites that need to type-narrow on a found term don't have to
 * re-derive the union by hand.
 */
export type ForbiddenClaudeOnlyTerm = (typeof FORBIDDEN_CLAUDE_ONLY_TERMS)[number];

/**
 * A single lint finding: the offending term, the runtime whose render
 * surfaced it, the source SKILL.md path, and the 1-indexed line number
 * within the *rendered* output. Source-line tracking through guard
 * elision is hard; the rendered-line number is the best deterministic
 * pointer because it identifies exactly the byte-range that surfaced.
 * Authors can grep the source for the term to find the original spot.
 */
export interface VocabularyLintFinding {
  term: ForbiddenClaudeOnlyTerm;
  runtime: string;
  sourcePath: string;
  line: number;
}

/**
 * Decide whether a runtime is "Claude-like" — i.e. exempt from the
 * Claude-only forbidden-term lint.
 *
 * Heuristic: a runtime that declares `team:agent-teams: native` is one
 * where the entire Claude Agent-Teams API is first-class, and thus
 * `TaskList` / `SendMessage` / etc. are legitimately part of its
 * vocabulary. In production this matches only `claude.yaml`. A future
 * runtime that gains real Agent-Teams parity would naturally inherit
 * the exemption by declaring the capability.
 *
 * Why this single signal: every term in `FORBIDDEN_CLAUDE_ONLY_TERMS`
 * is either an Agent-Teams API surface (`TaskList`, `SendMessage`,
 * `TeamCreate`, `TeamDelete`, `TaskUpdate`, `agentId`), an Agent-Teams
 * monitoring primitive (`TaskOutput`), or a Claude hook
 * (`TeammateIdle`, `SubagentStart`, `SubagentStop`). All of them
 * presume the Claude Agent-Teams runtime model — `team:agent-teams`
 * is the cleanest single-bit proxy.
 */
export function runtimeAllowsClaudeOnlyTerms(runtime: RuntimeMap): boolean {
  return runtime.supportedCapabilities?.['team:agent-teams'] === 'native';
}

/**
 * Scan a single rendered SKILL.md output for forbidden Claude-only
 * terms. Returns an empty array when the runtime is exempt (Claude-
 * like) so callers can call this uniformly across all runtimes
 * without branching.
 *
 * Term matching uses word-boundary (`\b`) anchors so substring hits
 * inside a longer identifier do not flag — e.g. `TaskList` does not
 * match inside the prose word `MyTaskListy`. This pairs with the
 * "no `agent-team` in the forbidden list" defensive choice to keep
 * false positives at zero.
 *
 * Findings are sorted by `(term, line)` for deterministic output so
 * the aggregated diagnostic message is reproducible across runs.
 *
 * @param rendered - The rendered SKILL.md output bytes (post all
 *   render passes).
 * @param sourcePath - The originating source SKILL.md path (for
 *   diagnostic display; the lint never actually reads source).
 * @param runtime - The runtime whose rendered output is being
 *   scanned. Drives the exemption check via
 *   `runtimeAllowsClaudeOnlyTerms`.
 */
export function lintRenderedSkill(
  rendered: string,
  sourcePath: string,
  runtime: RuntimeMap,
): VocabularyLintFinding[] {
  if (runtimeAllowsClaudeOnlyTerms(runtime)) return [];

  const findings: VocabularyLintFinding[] = [];
  for (const term of FORBIDDEN_CLAUDE_ONLY_TERMS) {
    // All current forbidden terms are alphanumeric identifiers, so a
    // simple `\b<term>\b` regex is sufficient. If a future term
    // contains regex metacharacters, the escape below keeps the
    // construction safe.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(rendered)) !== null) {
      findings.push({
        term: term as ForbiddenClaudeOnlyTerm,
        runtime: runtime.name,
        sourcePath,
        line: lineOf(rendered, match.index),
      });
    }
  }

  // Stable sort by (term, line) so the diagnostic order is the same
  // every run. Term ordering follows the `FORBIDDEN_CLAUDE_ONLY_TERMS`
  // tuple position so the diagnostic groups by category sensibly
  // (TeammateIdle before TaskOutput, etc.).
  const termRank = new Map<string, number>(
    FORBIDDEN_CLAUDE_ONLY_TERMS.map((t, i) => [t, i]),
  );
  findings.sort((a, b) => {
    const ra = termRank.get(a.term)!;
    const rb = termRank.get(b.term)!;
    if (ra !== rb) return ra - rb;
    return a.line - b.line;
  });

  return findings;
}

/**
 * Format a list of vocabulary-lint findings into a single human-
 * readable diagnostic message. Each line follows the contract:
 *
 *   <source-skill-path>:<line>: forbidden term '<term>' in <runtime>
 *     render — wrap in <!-- requires:<cap> --> or use a
 *     runtime:claude-only fenced code block
 *
 * Returns an empty string when there are no findings so callers can
 * branch on `message.length === 0`.
 *
 * @param findings - Aggregated findings across every runtime × every
 *   skill. The caller is responsible for collecting; this function
 *   only formats.
 */
export function formatVocabularyLintMessage(
  findings: VocabularyLintFinding[],
): string {
  if (findings.length === 0) return '';
  const lines: string[] = [
    `[vocabulary-lint] found ${findings.length} forbidden Claude-only term occurrence(s) in non-Claude renders:`,
  ];
  for (const f of findings) {
    lines.push(
      `  ${f.sourcePath}:${f.line}: forbidden term '${f.term}' in ${f.runtime} render — ` +
        `wrap in <!-- requires:<cap> --> or use a runtime:claude-only fenced code block`,
    );
  }
  return lines.join('\n');
}

/**
 * 1-indexed line number of `offset` within `source`. Same helper as
 * `build-skills.ts` and `placeholder-lint.ts`; duplicated here to
 * avoid widening either module's public surface for a single internal
 * helper.
 */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}
