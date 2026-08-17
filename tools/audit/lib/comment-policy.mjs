// @ts-check
/**
 * @fileoverview Loader for the comment policy — the single place the rules are
 * declared.
 *
 * Every consumer derives from this datum. Nothing restates a pattern, an
 * allowed-reference class or a threshold: a convention written down twice is
 * two conventions as soon as one copy is edited, which is the defect this
 * design exists to remove.
 *
 * The loader FAILS CLOSED. A missing file, malformed JSON, an expired waiver or
 * a structurally invalid entry throws rather than falling back to defaults. A
 * guard that quietly runs with an empty rule set reports a clean tree forever,
 * which is indistinguishable from success and strictly worse than an error.
 */

import fs from 'node:fs';
import path from 'node:path';

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
 */

/**
 * @typedef {object} Waiver
 * @property {string} glob
 * @property {string} owner
 * @property {string} expires ISO date; the waiver stops applying after it.
 * @property {string} reason
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
 * Translate a path glob to an anchored regular expression.
 *
 * Hand-rolled rather than taken from a glob library: the gates in this
 * directory run on plain Node with no runtime dependencies, and the shapes in
 * use here are `**`, `*` and literals. `**` crosses separators, `*` does not.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    // `charAt`, not `[i]`: the index is in range by the loop condition, and this
    // says so in the type instead of leaving a `string | undefined` to unwrap.
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` should also match zero directories, so `a/**/b` matches `a/b`.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Whether a repository-relative path is structurally exempt.
 *
 * Structural exemptions are permanent and carry no expiry — they cover files
 * that must contain the forbidden text to do their job. They are a different
 * thing from a waiver, which is a dated concession to existing debt.
 *
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {string} relPath POSIX-normalized, repository-relative.
 * @returns {boolean}
 */
export function isExempt(policy, relPath) {
  const normalized = relPath.split(path.sep).join('/');
  return policy.exemptPaths.some((entry) => globToRegExp(entry.glob).test(normalized));
}

/**
 * Whether a waiver covers this path on the given date.
 *
 * @param {ReturnType<typeof loadPolicy>} policy
 * @param {string} relPath
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isWaived(policy, relPath, now = new Date()) {
  const normalized = relPath.split(path.sep).join('/');
  return policy.waivers.some(
    (entry) => Date.parse(entry.expires) > now.getTime() && globToRegExp(entry.glob).test(normalized),
  );
}

/**
 * Read, validate and return the policy.
 *
 * @param {string} [policyPath]
 * @param {{ now?: Date }} [options]
 */
export function loadPolicy(policyPath = DEFAULT_POLICY_PATH, options = {}) {
  const now = options.now ?? new Date();

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

  const exemptPaths = requireArray(doc.exemptPaths, 'exemptPaths').map((raw2) => {
    const entry = requireObject(raw2, 'exemptPaths');
    const glob = requireString(entry, 'glob', 'exemptPaths');
    if ('expires' in entry) {
      throw new PolicyError(
        `exemptPaths.${glob} carries an \`expires\`. Structural exemptions are permanent: they ` +
          `cover files that must contain the forbidden text to do their job. Use \`waivers\` for a ` +
          `dated concession to existing debt.`,
      );
    }
    return { glob, reason: requireString(entry, 'reason', `exemptPaths.${glob}`) };
  });

  const waivers = requireArray(doc.waivers, 'waivers').map((raw2) => {
    const entry = requireObject(raw2, 'waivers');
    const glob = requireString(entry, 'glob', 'waivers');
    const owner = requireString(entry, 'owner', `waivers.${glob}`);
    const expires = requireString(entry, 'expires', `waivers.${glob}`);
    const parsedExpiry = Date.parse(expires);
    if (Number.isNaN(parsedExpiry)) {
      throw new PolicyError(`waivers.${glob} has an unparseable \`expires\`: ${expires}`);
    }
    if (parsedExpiry <= now.getTime()) {
      throw new PolicyError(
        `waivers.${glob} expired on ${expires} (owner: ${owner}). An expired waiver fails the ` +
          `gate: renew it deliberately or remove it, but it does not lapse into silence.`,
      );
    }
    return { glob, owner, expires, reason: requireString(entry, 'reason', `waivers.${glob}`) };
  });

  return {
    version: typeof doc.version === 'number' ? doc.version : 0,
    rule: typeof doc.rule === 'string' ? doc.rule : '',
    forbiddenOrdinals,
    allowedReferences,
    changelogPatterns,
    notForbidden: Array.isArray(doc.notForbidden) ? doc.notForbidden : [],
    precisionFloor: requireObject(doc.precisionFloor ?? {}, 'precisionFloor'),
    exemptPaths,
    waivers,
    coverage: requireObject(doc.coverage ?? {}, 'coverage'),
  };
}
