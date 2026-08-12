// @ts-check
/**
 * @fileoverview Reports comments that name a planning ordinal or narrate a
 * change, at edit time.
 *
 * The CI gate and this rule are deliberately redundant in reach and identical
 * in judgement. The gate is total and diff-scoped but only speaks after a push;
 * the rule is local and immediate, which is the only feedback an authoring
 * agent can still act on. What makes running both defensible rather than
 * duplicative is that neither owns the rules: both derive from the policy
 * datum, and a conformance test runs one corpus through both.
 *
 * This file contains NO pattern of its own. A literal here that the datum also
 * declares is a second authority, and the authority guard fails on exactly
 * that.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, DEFAULT_POLICY_PATH } from '../scripts/lib/comment-policy.mjs';
import { stripMarkers } from '../scripts/lib/comment-prose.mjs';
import { classifyText } from '../scripts/lib/comment-classifier.mjs';

/**
 * Resolve the datum from the working directory first, falling back to a
 * module-relative path.
 *
 * ESLint runs with the repository root as its working directory, but the rule
 * is also loaded directly by its own tests, where that is not guaranteed.
 * Preferring cwd keeps the rule reading the same datum the gate reads.
 *
 * @returns {string}
 */
function resolvePolicyPath() {
  const fromCwd = path.resolve(process.cwd(), DEFAULT_POLICY_PATH);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = path.resolve(here, '..', DEFAULT_POLICY_PATH);
  return process.env.EXARCHOS_COMMENT_POLICY ?? (fs.existsSync(fromCwd) ? fromCwd : fromModule);
}

/**
 * Directive comments are machine-readable instructions to other tools, not
 * prose. Their content is fixed by whoever consumes them, so an author cannot
 * rewrite one to satisfy this rule.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isDirective(value) {
  return /^\s*(?:eslint\b|eslint-disable|eslint-enable|eslint-env|globals?\b|exported\b|prettier-ignore|@ts-(?:ignore|expect-error|nocheck|check)|istanbul\s|c8\s|v8\s|jshint\b|jslint\b|biome-ignore|deno-lint-ignore|@vite-ignore|webpackChunkName|#!)/.test(
    value,
  );
}

/**
 * Rebuild the raw comment so normalization matches the gate's byte for byte.
 *
 * ESLint hands back the value with markers already removed; the gate strips
 * them itself. Feeding both through one `stripMarkers` is what keeps the two
 * consumers from disagreeing on whitespace and wrapped lines.
 *
 * @param {{ type: string, value: string }} comment
 * @returns {string}
 */
function rawFor(comment) {
  return comment.type === 'Line' ? `//${comment.value}` : `/*${comment.value}*/`;
}

/** @type {ReturnType<typeof loadPolicy> | undefined} */
let cached;

/** @returns {ReturnType<typeof loadPolicy>} */
function policy() {
  cached ??= loadPolicy(resolvePolicyPath());
  return cached;
}

/** Exposed so tests can force a reload after pointing at a different datum. */
export function resetPolicyCache() {
  cached = undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require comments to state their constraint in words rather than naming a planning ordinal or narrating a change.',
    },
    schema: [],
    messages: {
      // The remedy travels in the message because the fix is a rewrite the
      // author has to judge; a bare "forbidden" verdict does not tell them how.
      commentContent: '{{detail}}',
    },
  },

  create(context) {
    return {
      'Program:exit'() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const active = policy();

        for (const comment of sourceCode.getAllComments()) {
          if (isDirective(comment.value)) continue;
          const text = stripMarkers(rawFor(comment));
          if (text.length === 0) continue;

          for (const finding of classifyText(text, active)) {
            context.report({
              // Comments are not nodes, so the location is reported directly.
              loc: comment.loc,
              messageId: 'commentContent',
              data: { detail: finding.message },
            });
          }
        }
      },
    };
  },
};

export default rule;
