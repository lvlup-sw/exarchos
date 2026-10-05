// @ts-check
/**
 * @fileoverview The one place that runs every comment rule over a file's blocks.
 *
 * The ESLint rules, the gate and the baseline tools all call `analyzeFile`. So they agree on
 * which blocks break which rule, which blocks the baseline suppresses, and which entries are stale.
 */

import { isExempt } from './comment-policy.mjs';
import { classifyText } from './comment-classifier.mjs';
import { withOccurrences, isSuppressed } from './comment-baseline.mjs';

/** The roster name of the content rule. */
export const CONTENT_RULE = 'comment-content';

/**
 * One rule violation in one block.
 *
 * @typedef {object} BlockFinding
 * @property {string} rule A roster rule name.
 * @property {string} checkId The pattern or check that matched.
 * @property {string} message The text an author reads, with its remedy.
 */

/**
 * One block with its analysis.
 *
 * @typedef {object} AnalyzedBlock
 * @property {import('./comment-baseline.mjs').CommentBlock} block
 * @property {string} hash
 * @property {number} occurrence Index among the file's blocks with the same hash.
 * @property {BlockFinding[]} findings Every finding from every non-exempt rule.
 * @property {boolean} suppressed True when the baseline covers this block. The baseline count
 *   covers the first violating blocks of a hash, in file order.
 */

/**
 * A baseline entry that lists more blocks than still break a rule.
 *
 * @typedef {object} StaleEntry
 * @property {string} hash
 * @property {number} count The count in the baseline.
 * @property {number} live The blocks with this hash that still have findings.
 */

/**
 * The findings of the content rule for one block.
 *
 * @param {import('./comment-baseline.mjs').CommentBlock} block
 * @param {ReturnType<typeof import('./comment-policy.mjs').loadPolicy>} policy
 * @returns {BlockFinding[]}
 */
function contentFindings(block, policy) {
  return classifyText(block.text, policy).map((finding) => ({
    rule: CONTENT_RULE,
    checkId: finding.patternId,
    message: finding.message,
  }));
}

/**
 * Analyze one file's blocks against every rule and the file's baseline entries.
 *
 * @param {object} input
 * @param {string} input.relPath POSIX, repository-relative.
 * @param {readonly import('./comment-baseline.mjs').CommentBlock[]} input.blocks
 * @param {ReturnType<typeof import('./comment-policy.mjs').loadPolicy>} input.policy
 * @param {ReadonlyMap<string, number> | undefined} input.entries The file's baseline entries.
 * @returns {{ analyzed: AnalyzedBlock[], stale: StaleEntry[] }}
 */
export function analyzeFile({ relPath, blocks, policy, entries }) {
  const contentApplies = !isExempt(policy, relPath, CONTENT_RULE);
  /** @type {Map<string, number>} */
  const live = new Map();
  const analyzed = withOccurrences(blocks).map(({ block, hash, occurrence }) => {
    const findings = contentApplies ? contentFindings(block, policy) : [];
    const violating = live.get(hash) ?? 0;
    if (findings.length > 0) live.set(hash, violating + 1);
    return {
      block,
      hash,
      occurrence,
      findings,
      suppressed: findings.length > 0 && isSuppressed(entries, hash, violating),
    };
  });
  /** @type {StaleEntry[]} */
  const stale = [];
  for (const [hash, count] of entries ?? new Map()) {
    const remaining = live.get(hash) ?? 0;
    if (count > remaining) stale.push({ hash, count, live: remaining });
  }
  return { analyzed, stale };
}

/**
 * The baseline entries that exactly cover a file's current findings.
 *
 * @param {readonly AnalyzedBlock[]} analyzed
 * @returns {Map<string, number>}
 */
export function liveEntries(analyzed) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of analyzed) {
    if (item.findings.length > 0) counts.set(item.hash, (counts.get(item.hash) ?? 0) + 1);
  }
  return counts;
}
