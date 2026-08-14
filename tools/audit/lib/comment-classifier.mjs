// @ts-check
/**
 * @fileoverview Decides whether a comment's prose breaks the policy.
 *
 * Authored once and imported by both consumers — the CI gate and the ESLint
 * rule. Neither carries a pattern of its own: the rules live in the policy
 * datum, this module applies them, and a standing check proves no consumer has
 * grown a private copy.
 *
 * Two classes are decided here. An ORDINAL names a planning artifact a future
 * reader cannot resolve. CHANGELOG narration describes what the code used to
 * do, which version control already records and a comment cannot keep true.
 */

import { compilePattern } from './comment-policy.mjs';

/**
 * @typedef {object} Finding
 * @property {string} patternId Which declared pattern matched.
 * @property {'ordinal' | 'changelog'} class
 * @property {string} match The matched text.
 * @property {number} index Offset of the match within the comment's prose.
 * @property {string} message Rendered message, naming the remedy.
 */

/**
 * @typedef {object} MatchSpan
 * @property {number} start
 * @property {number} end
 */

/**
 * Every span of `text` covered by a permitted reference.
 *
 * These are computed first and win outright. A durable reference frequently
 * contains something that looks like an ordinal — an issue URL ends in digits,
 * a spec permalink carries a fragment — and reporting those would punish
 * exactly the citation style the policy is trying to encourage.
 *
 * @param {string} text
 * @param {{ allowedReferences: readonly { pattern: string, flags?: string, id: string }[] }} policy
 * @returns {MatchSpan[]}
 */
export function allowedSpans(text, policy) {
  /** @type {MatchSpan[]} */
  const spans = [];
  for (const entry of policy.allowedReferences) {
    const re = compilePattern({ ...entry, enabled: true });
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length });
    }
  }
  return spans;
}

/**
 * @param {MatchSpan[]} spans
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
function coveredBy(spans, start, end) {
  return spans.some((span) => start >= span.start && end <= span.end);
}

/**
 * Render the message an author reads.
 *
 * The remedy is part of the message rather than a lookup elsewhere: the whole
 * point of the rule is that the author writes a constraint instead of an
 * identifier, and a bare "forbidden pattern" verdict does not tell them how.
 *
 * @param {string} matched
 * @param {string | undefined} remedy
 * @returns {string}
 */
function renderMessage(matched, remedy) {
  const head = `Comment names the planning ordinal "${matched}", which a reader of this file cannot resolve.`;
  return remedy ? `${head} ${remedy}` : head;
}

/**
 * @param {string} matched
 * @param {string | undefined} remedy
 * @returns {string}
 */
function renderChangelogMessage(matched, remedy) {
  const head = `Comment narrates a change ("${matched}") rather than describing present behavior.`;
  return remedy ? `${head} ${remedy}` : head;
}

/**
 * Classify one comment's prose.
 *
 * @param {string} text Marker-stripped prose.
 * @param {ReturnType<typeof import('./comment-policy.mjs').loadPolicy>} policy
 * @returns {Finding[]}
 */
export function classifyText(text, policy) {
  const permitted = allowedSpans(text, policy);
  /** @type {Finding[]} */
  const findings = [];

  for (const entry of policy.forbiddenOrdinals) {
    if (!entry.enabled) continue;
    for (const match of text.matchAll(compilePattern(entry))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (coveredBy(permitted, start, end)) continue;
      findings.push({
        patternId: entry.id,
        class: 'ordinal',
        match: match[0],
        index: start,
        message: renderMessage(match[0], entry.remedy),
      });
    }
  }

  for (const entry of policy.changelogPatterns) {
    if (!entry.enabled) continue;
    for (const match of text.matchAll(compilePattern(entry))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (coveredBy(permitted, start, end)) continue;
      findings.push({
        patternId: entry.id,
        class: 'changelog',
        match: match[0],
        index: start,
        message: renderChangelogMessage(match[0], entry.remedy),
      });
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

/**
 * Classify one extracted comment, carrying its position onto each finding.
 *
 * @param {import('./comment-prose.mjs').ExtractedComment} comment
 * @param {ReturnType<typeof import('./comment-policy.mjs').loadPolicy>} policy
 * @returns {(Finding & { line: number, column: number })[]}
 */
export function classifyComment(comment, policy) {
  return classifyText(comment.text, policy).map((finding) => ({
    ...finding,
    line: comment.line,
    column: comment.column,
  }));
}

/**
 * Whether any enabled pattern rejects this prose.
 *
 * @param {string} text
 * @param {ReturnType<typeof import('./comment-policy.mjs').loadPolicy>} policy
 * @returns {boolean}
 */
export function isRejected(text, policy) {
  return classifyText(text, policy).length > 0;
}
