// @ts-check
/**
 * @fileoverview Decides whether a comment's prose breaks the policy.
 *
 * The CI gate and the ESLint rule both reach this module through `comment-analysis.mjs`.
 * The patterns live in the policy datum, and this module applies them.
 *
 * It decides two classes. An ORDINAL names a planning artifact that a future
 * reader cannot resolve. CHANGELOG narration describes earlier behavior, which
 * version control already records.
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
 * Returns every span of `text` that a permitted reference covers. A forbidden match
 * inside such a span is not reported. An issue URL or a spec permalink can contain
 * text that looks like an ordinal, and the policy encourages those citations.
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
 * Renders the ordinal message and appends the remedy. The author must write a
 * constraint in place of the identifier, so the message tells them how.
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
