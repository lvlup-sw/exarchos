// @ts-check
/**
 * @fileoverview ESLint rule: the comment baseline lists no block that no longer breaks a rule.
 *
 * A stale entry suppresses nothing today, but it can suppress a new block that has the same text.
 * So a fixed comment must leave the baseline in the same change.
 */

import { analysisFor } from './comment-context.js';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require the comment baseline to list only blocks that still break a comment rule.',
    },
    schema: [],
    messages: {
      stale:
        'The comment baseline lists {{count}} block(s) with hash {{hash}} in this file, but {{live}} still ' +
        'break a comment rule. Remove the extra entries: `npm run lint:comments -- baseline prune`.',
    },
  },

  create(context) {
    return {
      'Program:exit'() {
        const { analyzed, stale, locOf } = analysisFor(context);
        for (const entry of stale) {
          const first = analyzed.find((item) => item.hash === entry.hash);
          context.report({
            loc: first === undefined ? { line: 1, column: 0 } : locOf(first.block),
            messageId: 'stale',
            data: { hash: entry.hash, count: String(entry.count), live: String(entry.live) },
          });
        }
      },
    };
  },
};

export default rule;
