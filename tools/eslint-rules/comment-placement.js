// @ts-check
/**
 * @fileoverview ESLint rule: a comment is a file header or a `/** *\/` description, nowhere else.
 *
 * The placement classes and their messages live in `.exarchos/comment-policy.json`. A `//`
 * description gets a suggestion, not an autofix, that rewrites it as `/** *\/`. An autofix rewrites
 * the text when an editor saves the file, and the new text is not in the baseline.
 */

import { analysisFor } from './comment-context.js';
import { PLACEMENT_RULE } from '../audit/lib/comment-placement.mjs';

/**
 * The block rewritten as a `/** *\/` comment, at the indentation of its first line.
 *
 * @param {string} raw
 * @param {string} indent
 * @returns {string}
 */
export function toJsdoc(raw, indent) {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\/\*+|\*+(?!\/))\s?/, '').replace(/\s*\*+\/\s*$/, '').trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  if (lines.length <= 1) return `/** ${lines[0] ?? ''} */`;
  return ['/**', ...lines.map((line) => (line.length === 0 ? `${indent} *` : `${indent} * ${line}`)), `${indent} */`].join('\n');
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    hasSuggestions: true,
    docs: {
      description: 'Allow comments only as the file header or as a `/** */` description of a declaration, member or test call.',
    },
    schema: [],
    messages: {
      commentPlacement: '{{detail}}',
      rewriteAsJsdoc: 'Rewrite this comment as a `/** */` description.',
    },
  },

  create(context) {
    return {
      'Program:exit'() {
        const { analyzed, locOf } = analysisFor(context);
        const { text } = context.sourceCode;
        for (const item of analyzed) {
          if (item.suppressed) continue;
          for (const finding of item.findings) {
            if (finding.rule !== PLACEMENT_RULE) continue;
            const { block } = item;
            const lineStart = text.lastIndexOf('\n', block.start - 1) + 1;
            const indent = text.slice(lineStart, block.start);
            context.report({
              loc: locOf(block),
              messageId: 'commentPlacement',
              data: { detail: finding.message },
              suggest:
                finding.checkId === 'non-jsdoc'
                  ? [{ messageId: 'rewriteAsJsdoc', fix: (fixer) => fixer.replaceTextRange([block.start, block.end], toJsdoc(block.raw, indent)) }]
                  : [],
            });
          }
        }
      },
    };
  },
};

export default rule;
