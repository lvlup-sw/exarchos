// @ts-check
/**
 * @fileoverview ESLint rule: a comment names no planning ordinal and narrates no change.
 *
 * The patterns live in `.exarchos/comment-policy.json`. This file holds no pattern of its own.
 * The rule reports once per finding, at the comment block, and skips blocks that the baseline covers.
 */

import { analysisFor } from './comment-context.js';
import { CONTENT_RULE } from '../audit/lib/comment-analysis.mjs';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require comments to state their constraint in words, not to name a planning ordinal or narrate a change.',
    },
    schema: [],
    messages: {
      commentContent: '{{detail}}',
    },
  },

  create(context) {
    return {
      'Program:exit'() {
        const { analyzed, locOf } = analysisFor(context);
        for (const item of analyzed) {
          if (item.suppressed) continue;
          for (const finding of item.findings) {
            if (finding.rule !== CONTENT_RULE) continue;
            context.report({ loc: locOf(item.block), messageId: 'commentContent', data: { detail: finding.message } });
          }
        }
      },
    };
  },
};

export default rule;
