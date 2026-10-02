// @ts-check
/**
 * @fileoverview Loader for the comment policy, the one place that declares the comment rules.
 *
 * Every consumer reads this file. No consumer restates a pattern, a threshold or an exemption.
 * The loader fails closed: a missing file, malformed JSON or an invalid entry throws. A guard
 * that runs with an empty rule set reports a clean tree, and nobody can tell that from success.
 */

import fs from 'node:fs';
import path from 'node:path';
import { globsMatch } from './lint-scope.mjs';
import { PLACEMENT_CHECKS, PLACEMENT_RULE } from './comment-placement.mjs';
import { BUDGET_CHECKS, PROSE_RULE, STE_CHECKS } from './comment-ste.mjs';

/** Where the datum lives, relative to the repository root. */
export const DEFAULT_POLICY_PATH = '.exarchos/comment-policy.json';

/** Raised for any condition that must stop the caller. */
export class PolicyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * @typedef {object} PatternEntry
 * @property {string} id
 * @property {string} pattern Regular-expression source.
 * @property {string} [flags]
 * @property {boolean} enabled
 * @property {string} [remedy] What to write instead.
 * @property {string} [disabledReason]
 */

/**
 * @typedef {object} ExemptPath
 * @property {string} glob
 * @property {string} reason
 * @property {readonly string[]} rules The roster rules that this path is exempt from.
 */

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown>}
 */
function requireObject(value, where) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyError(`${where} must be an object.`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {unknown[]}
 */
function requireArray(value, where) {
  if (!Array.isArray(value)) throw new PolicyError(`${where} must be an array.`);
  return value;
}

/**
 * @param {Record<string, unknown>} entry
 * @param {string} key
 * @param {string} where
 * @returns {string}
 */
function requireString(entry, key, where) {
  const value = entry[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PolicyError(`${where} requires a non-empty string \`${key}\`.`);
  }
  return value;
}

/**
 * Validates a pattern entry and compiles its source.
 *
 * A malformed pattern thus fails the load, not the first file that reaches it.
 * An absent optional field stays absent, not `undefined`, because
 * `exactOptionalPropertyTypes` treats the two as different types.
 *
 * @param {unknown} raw
 * @param {string} where
 * @returns {PatternEntry}
 */
function readPatternEntry(raw, where) {
  const entry = requireObject(raw, where);
  const id = requireString(entry, 'id', where);
  const pattern = requireString(entry, 'pattern', `${where}.${id}`);
  const flags = entry.flags === undefined ? 'g' : String(entry.flags);
  try {
    new RegExp(pattern, flags);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(`${where}.${id} has an invalid pattern: ${detail}`);
  }
  if (typeof entry.enabled !== 'boolean') {
    throw new PolicyError(
      `${where}.${id} requires an explicit boolean \`enabled\`. A pattern that ships without ` +
        `stating whether it blocks is the ambiguity the precision floor exists to settle.`,
    );
  }
  return {
    id,
    pattern,
    flags,
    enabled: entry.enabled,
    ...(typeof entry.remedy === 'string' ? { remedy: entry.remedy } : {}),
    ...(typeof entry.disabledReason === 'string'
      ? { disabledReason: entry.disabledReason }
      : {}),
  };
}

/**
 * Compiles a pattern entry to a fresh regular expression.
 *
 * A `g`-flagged expression keeps `lastIndex` between uses. A shared instance
 * thus silently skips matches in the second file that it scans.
 *
 * @param {PatternEntry} entry
 * @returns {RegExp}
 */
export function compilePattern(entry) {
  return new RegExp(entry.pattern, entry.flags ?? 'g');
}

/**
 * Whether a repository-relative path is exempt from one roster rule.
 *
 * Exemptions are permanent. They cover files that must contain the forbidden text to do their job.
 *
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {string} relPath POSIX-normalized, repository-relative.
 * @param {string} rule A name from the policy's `rules` roster.
 * @returns {boolean}
 */
export function isExempt(policy, relPath, rule) {
  if (!policy.rules.includes(rule)) {
    throw new PolicyError(`isExempt was asked about "${rule}", which is not in the policy's rules roster.`);
  }
  const normalized = relPath.split(path.sep).join('/');
  return policy.exemptPaths.some(
    (entry) => entry.rules.includes(rule) && globsMatch([entry.glob], normalized),
  );
}

/**
 * The placement section: the test callees, and one enabled flag and message per check.
 *
 * @typedef {object} PlacementPolicy
 * @property {readonly string[]} testCallees
 * @property {ReadonlyMap<string, { enabled: boolean, message: string }>} checks
 */

/**
 * Validate the placement section. It must declare every placement check, and no other.
 *
 * @param {unknown} raw
 * @returns {PlacementPolicy}
 */
function readPlacement(raw) {
  const section = requireObject(raw, 'placement');
  const testCallees = requireArray(section.testCallees, 'placement.testCallees').map((name, index) => {
    if (typeof name !== 'string' || name.length === 0) throw new PolicyError(`placement.testCallees[${index}] must be a name.`);
    return name;
  });
  /** @type {Map<string, { enabled: boolean, message: string }>} */
  const checks = new Map();
  for (const rawCheck of requireArray(section.checks, 'placement.checks')) {
    const check = requireObject(rawCheck, 'placement.checks');
    const id = requireString(check, 'id', 'placement.checks');
    if (!PLACEMENT_CHECKS.includes(id)) throw new PolicyError(`placement.checks.${id} is not a placement check.`);
    if (checks.has(id)) throw new PolicyError(`placement.checks.${id} appears twice.`);
    if (typeof check.enabled !== 'boolean') throw new PolicyError(`placement.checks.${id} requires an explicit boolean \`enabled\`.`);
    checks.set(id, { enabled: check.enabled, message: requireString(check, 'message', `placement.checks.${id}`) });
  }
  const missing = PLACEMENT_CHECKS.filter((id) => !checks.has(id));
  if (missing.length > 0) throw new PolicyError(`placement.checks does not declare: ${missing.join(', ')}.`);
  return { testCallees: Object.freeze(testCallees), checks };
}

/**
 * Compile a regular expression from a policy entry, or throw a policy error that names the entry.
 *
 * @param {Record<string, unknown>} entry
 * @param {string} where
 * @returns {RegExp}
 */
function compileEntry(entry, where) {
  const source = requireString(entry, 'pattern', where);
  try {
    return new RegExp(source, entry.flags === undefined ? 'g' : String(entry.flags));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(`${where} has an invalid pattern: ${detail}`);
  }
}

/**
 * Validate one STE check. A check cites a rule or a table of the skill. It has a limit, a pattern
 * or a list of terms.
 *
 * @param {unknown} raw
 * @returns {import('./comment-ste.mjs').SteCheck & { disabledReason?: string, steRule?: string }}
 */
function readSteCheck(raw) {
  const check = requireObject(raw, 'prose.steChecks');
  const id = requireString(check, 'id', 'prose.steChecks');
  const where = `prose.steChecks.${id}`;
  if (!STE_CHECKS.includes(id)) throw new PolicyError(`${where} is not an STE check.`);
  const steRule = typeof check.steRule === 'string' && check.steRule.length > 0 ? check.steRule : undefined;
  const source = typeof check.source === 'string' && check.source.length > 0 ? check.source : undefined;
  if ((steRule === undefined) === (source === undefined)) throw new PolicyError(`${where} needs exactly one of \`steRule\` and \`source\`.`);
  if (typeof check.enabled !== 'boolean') throw new PolicyError(`${where} requires an explicit boolean \`enabled\`.`);
  const disabledReason = typeof check.disabledReason === 'string' ? check.disabledReason : undefined;
  if (!check.enabled && disabledReason === undefined) throw new PolicyError(`${where} is disabled without a \`disabledReason\`.`);
  const base = {
    id,
    cite: steRule === undefined ? String(source) : `STE ${steRule}`,
    enabled: check.enabled,
    remedy: requireString(check, 'remedy', where),
    ...(steRule === undefined ? {} : { steRule }),
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
  if (id === 'sentence-length' || id === 'paragraph-length') {
    if (!Number.isInteger(check.limit) || Number(check.limit) < 1) throw new PolicyError(`${where} requires a positive integer \`limit\`.`);
    return { ...base, limit: Number(check.limit) };
  }
  if (id === 'filler') {
    const terms = requireArray(check.terms, `${where}.terms`).map((rawTerm, index) => {
      const term = requireObject(rawTerm, `${where}.terms[${index}]`);
      const name = requireString(term, 'term', `${where}.terms[${index}]`);
      return { term: name, pattern: compileEntry(term, `${where}.terms.${name}`), use: requireString(term, 'use', `${where}.terms.${name}`) };
    });
    if (terms.length === 0) throw new PolicyError(`${where}.terms is empty.`);
    return { ...base, terms: Object.freeze(terms) };
  }
  return { ...base, pattern: compileEntry(check, where) };
}

/**
 * The prose section: the vendored skill, the STE checks and the line budgets.
 *
 * @typedef {object} ProsePolicy
 * @property {{ canonical: string, mirror: string, version: string }} skill
 * @property {readonly ReturnType<typeof readSteCheck>[]} steChecks
 * @property {ReadonlyMap<string, { lines: number, enabled: boolean, remedy: string }>} budgets
 */

/**
 * Validate the prose section. It must declare every STE check and every budget, and no other.
 *
 * @param {unknown} raw
 * @returns {ProsePolicy}
 */
function readProse(raw) {
  const section = requireObject(raw, 'prose');
  const skillEntry = requireObject(section.skill, 'prose.skill');
  const skill = {
    canonical: requireString(skillEntry, 'canonical', 'prose.skill'),
    mirror: requireString(skillEntry, 'mirror', 'prose.skill'),
    version: requireString(skillEntry, 'version', 'prose.skill'),
  };
  const steChecks = requireArray(section.steChecks, 'prose.steChecks').map(readSteCheck);
  const ids = steChecks.map((check) => check.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new PolicyError(`prose.steChecks.${duplicate} appears twice.`);
  const missing = STE_CHECKS.filter((id) => !ids.includes(id));
  if (missing.length > 0) throw new PolicyError(`prose.steChecks does not declare: ${missing.join(', ')}.`);
  /** @type {Map<string, { lines: number, enabled: boolean, remedy: string }>} */
  const budgets = new Map();
  for (const rawBudget of requireArray(section.budgets, 'prose.budgets')) {
    const budget = requireObject(rawBudget, 'prose.budgets');
    const id = requireString(budget, 'id', 'prose.budgets');
    if (!BUDGET_CHECKS.includes(id)) throw new PolicyError(`prose.budgets.${id} is not a line budget.`);
    if (budgets.has(id)) throw new PolicyError(`prose.budgets.${id} appears twice.`);
    if (!Number.isInteger(budget.lines) || Number(budget.lines) < 1) throw new PolicyError(`prose.budgets.${id} requires a positive integer \`lines\`.`);
    if (typeof budget.enabled !== 'boolean') throw new PolicyError(`prose.budgets.${id} requires an explicit boolean \`enabled\`.`);
    budgets.set(id, { lines: Number(budget.lines), enabled: budget.enabled, remedy: requireString(budget, 'remedy', `prose.budgets.${id}`) });
  }
  const missingBudgets = BUDGET_CHECKS.filter((id) => !budgets.has(id));
  if (missingBudgets.length > 0) throw new PolicyError(`prose.budgets does not declare: ${missingBudgets.join(', ')}.`);
  return { skill, steChecks: Object.freeze(steChecks), budgets };
}

/**
 * Read, validate and return the policy.
 *
 * @param {string} [policyPath]
 */
export function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(
      `comment policy not found at ${policyPath} (${detail}). Refusing to run with defaults: ` +
        `a guard with no rules cannot fail, and cannot be told apart from a clean tree.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PolicyError(`comment policy at ${policyPath} is not valid JSON: ${detail}`);
  }

  const doc = requireObject(parsed, 'comment policy');

  const forbiddenOrdinals = requireArray(doc.forbiddenOrdinals, 'forbiddenOrdinals').map((entry) =>
    readPatternEntry(entry, 'forbiddenOrdinals'),
  );
  const changelogPatterns = requireArray(doc.changelogPatterns, 'changelogPatterns').map((entry) =>
    readPatternEntry(entry, 'changelogPatterns'),
  );

  const allowedReferences = requireArray(doc.allowedReferences, 'allowedReferences').map((raw2) => {
    const entry = requireObject(raw2, 'allowedReferences');
    const id = requireString(entry, 'id', 'allowedReferences');
    const pattern = requireString(entry, 'pattern', `allowedReferences.${id}`);
    const flags = entry.flags === undefined ? 'g' : String(entry.flags);
    try {
      new RegExp(pattern, flags);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new PolicyError(`allowedReferences.${id} has an invalid pattern: ${detail}`);
    }
    return { id, pattern, flags, enabled: true, reason: String(entry.reason ?? '') };
  });

  if (forbiddenOrdinals.length === 0) {
    throw new PolicyError('forbiddenOrdinals is empty; a policy that forbids nothing is not a policy.');
  }

  const rules = requireArray(doc.rules, 'rules').map((name, index) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new PolicyError(`rules[${index}] must be a non-empty rule name.`);
    }
    return name;
  });
  if (rules.length === 0) throw new PolicyError('rules is empty. A policy that no rule reads is not a policy.');

  const exemptPaths = requireArray(doc.exemptPaths, 'exemptPaths').map((raw2) => {
    const entry = requireObject(raw2, 'exemptPaths');
    const glob = requireString(entry, 'glob', 'exemptPaths');
    if ('expires' in entry) {
      throw new PolicyError(
        `exemptPaths.${glob} carries an \`expires\`. Exemptions are permanent: they cover files that ` +
          `must contain the forbidden text to do their job.`,
      );
    }
    const scoped = requireArray(entry.rules, `exemptPaths.${glob}.rules`);
    if (scoped.length === 0) {
      throw new PolicyError(`exemptPaths.${glob}.rules is empty. Name each rule that the path is exempt from.`);
    }
    for (const name of scoped) {
      if (typeof name !== 'string' || !rules.includes(name)) {
        throw new PolicyError(`exemptPaths.${glob}.rules names "${String(name)}", which is not in the rules roster.`);
      }
    }
    return {
      glob,
      reason: requireString(entry, 'reason', `exemptPaths.${glob}`),
      rules: Object.freeze(/** @type {string[]} */ ([...scoped])),
    };
  });

  const placement = rules.includes(PLACEMENT_RULE) ? readPlacement(doc.placement) : undefined;
  if (rules.includes(PROSE_RULE) && placement === undefined) {
    throw new PolicyError(`${PROSE_RULE} reads the placement of each block, so the roster must also name ${PLACEMENT_RULE}.`);
  }
  const prose = rules.includes(PROSE_RULE) ? readProse(doc.prose) : undefined;

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    rule: typeof doc.rule === 'string' ? doc.rule : '',
    rules,
    placement,
    prose,
    forbiddenOrdinals,
    allowedReferences,
    changelogPatterns,
    notForbidden: Array.isArray(doc.notForbidden) ? doc.notForbidden : [],
    precisionFloor: requireObject(doc.precisionFloor ?? {}, 'precisionFloor'),
    exemptPaths,
  };
}
