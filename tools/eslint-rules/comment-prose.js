// @ts-check
/**
 * @fileoverview ESLint rule: a file header or a description is short, in Simplified Technical English.
 *
 * The checks, their STE rule numbers and the line budgets live in `.exarchos/comment-policy.json`.
 * The rule reports once per finding, at the comment block, and skips blocks that the baseline covers.
 */

import { analysisFor } from './comment-context.js';
import { PROSE_RULE } from '../audit/lib/comment-ste.mjs';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require file headers and descriptions to be short and in Simplified Technical English.',
    },
    schema: [],
    messages: {
      commentProse: '{{detail}}',
    },
  },

  create(context) {
    return {
      'Program:exit'() {
        const { analyzed, locOf } = analysisFor(context);
        for (const item of analyzed) {
          if (item.suppressed) continue;
          for (const finding of item.findings) {
            if (finding.rule !== PROSE_RULE) continue;
            context.report({ loc: locOf(item.block), messageId: 'commentProse', data: { detail: finding.message } });
          }
        }
      },
    };
  },
};

export default rule;
