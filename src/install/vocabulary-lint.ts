/**
 * Post-render vocabulary lint for the platform-agnostic skills tree.
 * It scans each fully rendered SKILL.md for Claude-only terms. A term in a render for another runtime fails the build with one diagnostic for all offenders.
 * The lint runs after the render, so it does not need to copy the guard semantics. A term in the rendered bytes is a real leak.
 *
 * A runtime that declares `team:agent-teams: native` is exempt, so a new runtime with Agent Teams gets the exemption with no code change.
 * The list does not hold `agent-team`, because the capability identifier `team:agent-teams` occurs in cross-runtime prose.
 */

import type { RuntimeMap } from './runtimes/types.js';

/**
 * Claude-only API and primitive names that must not occur in a render for another runtime. The lint and its tests share this tuple.
 * A new term must be a Claude-specific primitive, such as a hook, a tool, or an Agent Teams API.
 * It must not occur as a substring in cross-runtime prose.
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

/** String-literal union of `FORBIDDEN_CLAUDE_ONLY_TERMS`. */
export type ForbiddenClaudeOnlyTerm = (typeof FORBIDDEN_CLAUDE_ONLY_TERMS)[number];

/**
 * One lint finding: the term, the runtime, the source SKILL.md path, and the 1-based line in the rendered output.
 * Guard elision moves source lines, so the rendered line is the deterministic pointer. An author can search the source for the term.
 */
export interface VocabularyLintFinding {
  term: ForbiddenClaudeOnlyTerm;
  runtime: string;
  sourcePath: string;
  line: number;
}

/**
 * Return true when a runtime is exempt from the lint, because it declares `team:agent-teams: native`. Today only `claude.yaml` does.
 * Each forbidden term is an Agent Teams API, an Agent Teams monitor primitive, or a Claude hook. Thus this one capability is the signal.
 */
export function runtimeAllowsClaudeOnlyTerms(runtime: RuntimeMap): boolean {
  return runtime.supportedCapabilities?.['team:agent-teams'] === 'native';
}

/**
 * Scan one rendered SKILL.md for forbidden Claude-only terms. An exempt runtime gets an empty array, so callers do not branch.
 * Each term match uses `\b` anchors, so `TaskList` does not match inside `MyTaskListy`. The regex escapes each term.
 * The findings sort by the tuple position of the term, then by line, so the diagnostic is the same on each run.
 *
 * @param rendered - The rendered SKILL.md output, after all render passes.
 * @param sourcePath - The source SKILL.md path, for the diagnostic only. The lint does not read the source.
 * @param runtime - The runtime of the rendered output. It decides the exemption.
 */
export function lintRenderedSkill(
  rendered: string,
  sourcePath: string,
  runtime: RuntimeMap,
): VocabularyLintFinding[] {
  if (runtimeAllowsClaudeOnlyTerms(runtime)) return [];

  const findings: VocabularyLintFinding[] = [];
  for (const term of FORBIDDEN_CLAUDE_ONLY_TERMS) {
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
 * Format the findings as one diagnostic message: a count line, then one line for each finding:
 *
 *   <source-skill-path>:<line>: forbidden term '<term>' in <runtime>
 *     render — wrap in <!-- requires:<cap> --> or use a
 *     runtime:claude-only fenced code block
 *
 * No findings give an empty string, so callers can branch on `message.length === 0`.
 *
 * @param findings - The findings for all runtimes and skills. The caller collects them, and this function only formats.
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

/** The 1-based line number of `offset` in `source`. Character code 10 is the newline. */
function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}
