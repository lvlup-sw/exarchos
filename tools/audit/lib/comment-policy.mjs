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
 * @property {string} [remedy] What the author should write instead.
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
 * Validate a pattern entry and prove its source actually compiles.
 *
 * Compiling here rather than at first use means a malformed pattern fails the
 * load, not the first file that happens to reach it.
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
    // Omitted rather than set to `undefined`: under `exactOptionalPropertyTypes`
    // an optional property and one explicitly holding `undefined` are different
    // types, and only the first is what "absent" means here.
    ...(typeof entry.remedy === 'string' ? { remedy: entry.remedy } : {}),
    ...(typeof entry.disabledReason === 'string'
      ? { disabledReason: entry.disabledReason }
      : {}),
  };
}

/**
 * Compile a pattern entry to a fresh regular expression.
 *
 * Fresh each call on purpose: a `g`-flagged expression carries `lastIndex`
 * between uses, so a shared instance silently skips matches in whichever file
 * happens to be scanned second.
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

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    rule: typeof doc.rule === 'string' ? doc.rule : '',
    rules,
    forbiddenOrdinals,
    allowedReferences,
    changelogPatterns,
    notForbidden: Array.isArray(doc.notForbidden) ? doc.notForbidden : [],
    precisionFloor: requireObject(doc.precisionFloor ?? {}, 'precisionFloor'),
    exemptPaths,
  };
}
