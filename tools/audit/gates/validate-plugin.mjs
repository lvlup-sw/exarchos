#!/usr/bin/env node
/**
 * validate-plugin — plugin-packaging gate (task 064, DR-24).
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * The previous implementation (a bash + jq script) hard-coded its expectations
 * in shell. Those expectations went stale and nobody noticed, because the gate
 * they belonged to was step 1 of an `&&` chain no workflow ran. Measured on the
 * integration tip on 2026-08-07 it failed 5 of its 9 checks — and all five were
 * the GATE being wrong, not the package:
 *
 *   - it demanded `.mcp.json`, deleted on purpose in 2b62e1bf3;
 *   - it demanded a `hooks` field in plugin.json, removed on purpose in e334a392b;
 *   - it demanded a `SessionEnd` hook, dropped on purpose by DR-7 / task 016;
 *   - it forbade `SessionStart`, which the plugin ships on purpose per #1485.
 *
 * Each of the four contradicts an assertion in the green `src/plugin-validation.
 * test.ts` / `src/install/hooks-validation.test.ts` suites. Two statements of one policy,
 * no channel between them, so drift was invisible until something forced them
 * into the same room.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * The policy is DATA — `.claude-plugin/packaging-policy.json` — and this module
 * is only its interpreter. The test suites read the same file, so they cannot
 * disagree with the gate about the contract. Every check this gate reports is
 * generated from a policy entry; there is no expectation written here that the
 * policy does not name.
 *
 * ── Non-empty denominator ───────────────────────────────────────────────────
 * A policy that yields ZERO checks FAILS. A gate that finds nothing to assert
 * is indistinguishable from a gate that passed, and this task exists precisely
 * because that confusion cost the repo sixteen months of unexecuted gates. The
 * same tooth rejects a policy whose `expected` and `retired` hook sets overlap:
 * the run would then be self-contradictory rather than merely empty.
 *
 * ── Strict schema (task 085) ────────────────────────────────────────────────
 * The interpreter reads every family through `policy.<key> ?? []`, so an
 * unrecognised key is not a name it fails on — it is a family it never looks
 * for. A single mistyped `requiredFiles` -> `requiredfiles` silently drops every
 * check in that family, and the non-empty tooth above cannot see it: it fires
 * only when ALL families vanish at once. Measured on this tree, three declared
 * families were dropped and the gate still exited 0 with a clean report.
 *
 * So the policy is validated against a CLOSED key set before it is interpreted,
 * at every level including array entries, and anything outside it is a
 * `[policy-unknown-key]` violation. The schema below is the only place a key is
 * named; adding a family means adding it there and in the interpreter, which is
 * the coupling that makes the drop impossible rather than merely unlikely.
 *
 * Usage: validate-plugin.mjs [--repo-root <path>] [--policy <path>] [--json]
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks fail (including an empty or self-contradictory policy)
 *   2 = usage error / unreadable policy — fail closed, never no-op
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
export const DEFAULT_POLICY_PATH = '.claude-plugin/packaging-policy.json';

/**
 * @typedef {object} CheckResult
 * @property {string} id            Stable identifier, e.g. `manifest.field.name`.
 * @property {string} description   Human-readable statement of what was asserted.
 * @property {boolean} passed
 * @property {string} [detail]      Why it failed, and the recorded reason it matters.
 */

/**
 * The filesystem surface this evaluator needs. Injected so the self-tests can
 * drive seeded trees without touching disk layout conventions.
 *
 * @typedef {object} TreeReader
 * @property {(rel: string) => boolean} fileExists
 * @property {(rel: string) => boolean} dirExists
 * @property {(rel: string) => string} readText
 */

/**
 * A real on-disk tree rooted at `root`.
 *
 * @param {string} root
 * @returns {TreeReader}
 */
export function diskTree(root) {
  // `resolve`, not `join`: an ABSOLUTE path handed to `--policy` must address
  // the file it names. `join` would concatenate it onto the root and report
  // "policy could not be read", which reads as a broken tree rather than a
  // mis-typed flag.
  const at = (rel) => path.resolve(root, rel);
  const kind = (rel) => {
    try {
      return statSync(at(rel));
    } catch {
      return undefined;
    }
  };
  return {
    fileExists: (rel) => kind(rel)?.isFile() === true,
    dirExists: (rel) => kind(rel)?.isDirectory() === true,
    readText: (rel) => readFileSync(at(rel), 'utf8'),
  };
}

/** Read `rel` as JSON, or return `{ error }` — never throw at a call site. */
function readJson(tree, rel) {
  let raw;
  try {
    raw = tree.readText(rel);
  } catch (error) {
    return { error: `unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { value: JSON.parse(raw), raw };
  } catch (error) {
    return { error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** `because`/`decidedIn` rendered as the trailing half of a failure detail. */
function provenance(entry) {
  const parts = [];
  if (typeof entry?.because === 'string') parts.push(entry.because);
  if (typeof entry?.decidedIn === 'string') parts.push(`Decided in: ${entry.decidedIn}`);
  return parts.join(' ');
}

/**
 * The CLOSED key set of the packaging policy, at every level.
 *
 * `object` maps a key to a nested shape; `entries` describes the objects inside
 * an array-valued key. Every key the interpreter below reads appears here, and
 * nothing else is admitted — see the header's "Strict schema" note for why a
 * silently-ignored key is the failure mode this closes.
 *
 * `$comment` is admitted at the root only: it is the file's own prose channel
 * and carries no policy.
 */
const POLICY_SCHEMA = {
  keys: {
    $comment: { type: 'array' },
    manifest: {
      type: 'object',
      keys: {
        path: { type: 'string' },
        requiredFields: { type: 'array', entryKeys: ['field', 'because', 'decidedIn'], requires: 'field' },
        forbiddenFields: { type: 'array', entryKeys: ['field', 'because', 'decidedIn'], requires: 'field' },
        mcpServers: {
          type: 'object',
          keys: {
            field: { type: 'string' },
            expected: { type: 'array', entryKeys: ['name', 'because', 'decidedIn'], requires: 'name' },
            exact: { type: 'boolean' },
            exactBecause: { type: 'string' },
          },
        },
      },
    },
    requiredDirs: { type: 'array', entryKeys: ['path', 'because', 'decidedIn'], requires: 'path' },
    requiredFiles: { type: 'array', entryKeys: ['path', 'because', 'decidedIn'], requires: 'path' },
    forbiddenFiles: { type: 'array', entryKeys: ['path', 'because', 'decidedIn'], requires: 'path' },
    hooks: {
      type: 'object',
      keys: {
        path: { type: 'string' },
        expected: { type: 'array', entryKeys: ['type', 'because', 'decidedIn'], requires: 'type' },
        retired: { type: 'array', entryKeys: ['type', 'because', 'decidedIn'], requires: 'type' },
        forbiddenTokens: { type: 'array', entryKeys: ['token', 'because', 'decidedIn'], requires: 'token' },
        exact: { type: 'boolean' },
        exactBecause: { type: 'string' },
      },
    },
  },
};

/** The JSON type name of `value`, using `array` and `null` rather than `object`. */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The entries of a family, or none.
 *
 * `for (const entry of policy.requiredFiles ?? [])` throws a TypeError on a
 * family declared as an object — an unhandled crash where the schema has already
 * recorded a `[policy-type]` violation. The interpreter yields nothing for a
 * malformed family and lets the violation carry the verdict, so the report stays
 * complete instead of stopping at the first bad key.
 */
function entriesOf(value) {
  if (!Array.isArray(value)) return [];
  // Drop entries that are not objects. `validatePolicyShape` has already
  // recorded a `[policy-type]` violation for each of them, so the run fails
  // either way — but it must fail with that violation rather than with a
  // TypeError from `entry.path` three functions later. Accumulating every
  // violation is the whole discipline here; crashing reports exactly one.
  return value.filter((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry));
}

/**
 * Check `node` against `shape`, pushing a violation for every key the schema
 * does not admit and every value whose type it does not expect.
 *
 * Recursive over nested objects and array entries so a typo cannot hide one
 * level down — `hooks.retried` drops the retired-hook family exactly as
 * completely as a root-level typo drops `requiredFiles`.
 *
 * @param {unknown} node
 * @param {object} shape
 * @param {string} where  Dotted path for the message, e.g. `manifest.mcpServers`.
 * @param {string[]} violations
 */
function validatePolicyShape(node, shape, where, violations) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(
      `[policy-type]  \`${where}\` must be an object, found ${jsonTypeOf(node)}`,
    );
    return;
  }

  const known = Object.keys(shape.keys);
  for (const [key, value] of Object.entries(node)) {
    const at = where === '' ? key : `${where}.${key}`;
    const spec = shape.keys[key];
    if (spec === undefined) {
      violations.push(
        `[policy-unknown-key]  \`${at}\` is not a key this gate interprets. Every family is ` +
          `read as \`policy.<key> ?? []\`, so an unrecognised key is not a name the gate fails ` +
          `on — it is a family the gate never looks for, and its checks vanish silently. ` +
          `Known here: ${known.join(', ')}.`,
      );
      continue;
    }

    const actual = jsonTypeOf(value);
    if (actual !== spec.type) {
      violations.push(
        `[policy-type]  \`${at}\` must be ${spec.type}, found ${actual}. A family of the wrong ` +
          'type contributes no checks, which reads identical to a family that passed.',
      );
      continue;
    }

    if (spec.type === 'object') {
      validatePolicyShape(value, spec, at, violations);
    } else if (spec.type === 'array' && spec.entryKeys !== undefined) {
      value.forEach((entry, index) => {
        const entryAt = `${at}[${index}]`;
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          violations.push(
            `[policy-type]  \`${entryAt}\` must be an object, found ${jsonTypeOf(entry)}`,
          );
          return;
        }
        for (const [entryKey, entryValue] of Object.entries(entry)) {
          if (!spec.entryKeys.includes(entryKey)) {
            violations.push(
              `[policy-unknown-key]  \`${entryAt}.${entryKey}\` is not a key this gate ` +
                `interprets. Known here: ${spec.entryKeys.join(', ')}.`,
            );
            continue;
          }
          // Membership alone is not shape. Every entry key this gate defines is
          // string-valued, and `because` / `decidedIn` carry the provenance the
          // failure message prints — a number there renders as "1" and reads
          // like a citation nobody can follow.
          if (typeof entryValue !== 'string') {
            violations.push(
              `[policy-type]  \`${entryAt}.${entryKey}\` must be string, found ` +
                `${jsonTypeOf(entryValue)}.`,
            );
          }
        }
        if (typeof entry[spec.requires] !== 'string') {
          violations.push(
            `[policy-incomplete]  \`${entryAt}\` does not declare \`${spec.requires}\`, so the ` +
              'entry names no subject and its check would assert about nothing.',
          );
        }
      });
    }
  }
}

/**
 * Evaluate a packaging policy against a tree.
 *
 * Pure: every filesystem touch goes through `tree`. Returns the full check list
 * even when an early check fails — the aggregation discipline this task exists
 * to install applies inside the gate as much as across the chain.
 *
 * @param {unknown} policy
 * @param {TreeReader} tree
 * @returns {{ checks: CheckResult[], violations: string[] }}
 *   `violations` holds structural problems with the POLICY itself (unknown key,
 *   wrong type, empty, self-contradictory), which are distinct from a failing
 *   check.
 */
export function evaluatePackaging(policy, tree) {
  /** @type {CheckResult[]} */
  const checks = [];
  /** @type {string[]} */
  const violations = [];
  const add = (id, description, passed, detail) =>
    checks.push(detail === undefined ? { id, description, passed } : { id, description, passed, detail });

  if (policy === null || typeof policy !== 'object') {
    violations.push('[policy-unreadable]  the packaging policy is not a JSON object');
    return { checks, violations };
  }

  // Before interpreting: every key must be one this gate acts on. A key it does
  // not recognise is a family it will never look for.
  validatePolicyShape(policy, POLICY_SCHEMA, '', violations);

  // ── plugin.json ───────────────────────────────────────────────────────────
  const manifestSpec = policy.manifest ?? {};
  const manifestPath = typeof manifestSpec.path === 'string' ? manifestSpec.path : undefined;
  if (manifestPath === undefined) {
    violations.push('[policy-incomplete]  `manifest.path` is not declared');
  } else {
    const parsed = readJson(tree, manifestPath);
    const manifest = parsed.value;
    add(
      'manifest.parses',
      `${manifestPath} exists and is valid JSON`,
      manifest !== undefined && typeof manifest === 'object' && manifest !== null,
      parsed.error,
    );

    for (const entry of entriesOf(manifestSpec.requiredFields)) {
      const field = entry.field;
      const present = manifest !== undefined && manifest !== null && manifest[field] !== undefined;
      add(
        `manifest.field.${field}`,
        `${manifestPath} declares \`${field}\``,
        present,
        present ? undefined : `field absent. ${provenance(entry)}`,
      );
    }

    for (const entry of entriesOf(manifestSpec.forbiddenFields)) {
      const field = entry.field;
      const present = manifest !== undefined && manifest !== null && manifest[field] !== undefined;
      add(
        `manifest.forbidden-field.${field}`,
        `${manifestPath} does NOT declare \`${field}\``,
        !present,
        present ? `field present. ${provenance(entry)}` : undefined,
      );
    }

    const serversSpec = manifestSpec.mcpServers;
    if (serversSpec !== undefined) {
      const field = serversSpec.field ?? 'mcpServers';
      const servers =
        manifest !== null && typeof manifest === 'object' ? manifest?.[field] : undefined;
      const names =
        servers !== null && typeof servers === 'object' ? Object.keys(servers) : undefined;
      for (const entry of entriesOf(serversSpec.expected)) {
        const present = names?.includes(entry.name) === true;
        add(
          `manifest.mcp-server.${entry.name}`,
          `${manifestPath} \`${field}\` registers \`${entry.name}\``,
          present,
          present ? undefined : `server absent. ${provenance(entry)}`,
        );
      }
      if (serversSpec.exact === true) {
        const expected = entriesOf(serversSpec.expected).map((e) => e.name).sort();
        const actual = [...(names ?? [])].sort();
        const same = actual.length === expected.length && actual.every((n, i) => n === expected[i]);
        add(
          `manifest.mcp-servers.exact`,
          `${manifestPath} \`${field}\` registers EXACTLY [${expected.join(', ')}]`,
          same,
          same
            ? undefined
            : `found [${actual.join(', ')}]. ${serversSpec.exactBecause ?? ''}`,
        );
      }
    }
  }

  // ── Referenced directories / files ────────────────────────────────────────
  for (const entry of entriesOf(policy.requiredDirs)) {
    const ok = tree.dirExists(entry.path);
    add(
      `dir.${entry.path}`,
      `${entry.path}/ exists`,
      ok,
      ok ? undefined : `directory absent. ${provenance(entry)}`,
    );
  }

  for (const entry of entriesOf(policy.requiredFiles)) {
    const ok = tree.fileExists(entry.path);
    add(
      `file.${entry.path}`,
      `${entry.path} exists`,
      ok,
      ok ? undefined : `file absent. ${provenance(entry)}`,
    );
  }

  for (const entry of entriesOf(policy.forbiddenFiles)) {
    const present = tree.fileExists(entry.path);
    add(
      `forbidden-file.${entry.path}`,
      `${entry.path} is absent`,
      !present,
      present ? `file present. ${provenance(entry)}` : undefined,
    );
  }

  // ── hooks/hooks.json ──────────────────────────────────────────────────────
  // Same reasoning as `entriesOf`: a `hooks` that is null, an array, or a
  // scalar has already been recorded as a `[policy-type]` violation. Reading
  // `.path` off it here would replace that message with a stack trace.
  const hooksSpec = policy.hooks;
  if (hooksSpec !== null && typeof hooksSpec === 'object' && !Array.isArray(hooksSpec)) {
    const hooksPath = hooksSpec.path;
    const expectedTypes = entriesOf(hooksSpec.expected).map((e) => e.type);
    const retiredTypes = entriesOf(hooksSpec.retired).map((e) => e.type);
    const overlap = expectedTypes.filter((t) => retiredTypes.includes(t));
    if (overlap.length > 0) {
      violations.push(
        `[policy-contradiction]  hook type(s) ${overlap.join(', ')} are declared both ` +
          'expected and retired — the policy cannot be satisfied and every run would ' +
          'report a failure the tree cannot fix',
      );
    }

    const parsed = readJson(tree, hooksPath);
    const config = parsed.value;
    const declared =
      config !== null && typeof config === 'object' && config?.hooks !== null && typeof config?.hooks === 'object'
        ? Object.keys(config.hooks)
        : undefined;

    add(
      'hooks.parses',
      `${hooksPath} exists, is valid JSON, and declares a \`hooks\` object`,
      declared !== undefined,
      parsed.error ?? (declared === undefined ? 'no `hooks` object at the document root' : undefined),
    );

    for (const entry of entriesOf(hooksSpec.expected)) {
      const present = declared?.includes(entry.type) === true;
      add(
        `hooks.expected.${entry.type}`,
        `${hooksPath} declares \`${entry.type}\``,
        present,
        present ? undefined : `hook absent. ${provenance(entry)}`,
      );
    }

    for (const entry of entriesOf(hooksSpec.retired)) {
      const present = declared?.includes(entry.type) === true;
      add(
        `hooks.retired.${entry.type}`,
        `${hooksPath} does NOT declare retired \`${entry.type}\``,
        !present,
        present ? `retired hook present. ${provenance(entry)}` : undefined,
      );
    }

    if (hooksSpec.exact === true) {
      const expected = [...expectedTypes].sort();
      const actual = [...(declared ?? [])].sort();
      const same = actual.length === expected.length && actual.every((t, i) => t === expected[i]);
      add(
        'hooks.exact',
        `${hooksPath} declares EXACTLY [${expected.join(', ')}]`,
        same,
        same ? undefined : `found [${actual.join(', ')}]. ${hooksSpec.exactBecause ?? ''}`,
      );
    }

    for (const entry of entriesOf(hooksSpec.forbiddenTokens)) {
      // Read as TEXT: a placeholder can hide in any string value, and the point
      // is that it never reaches a consumer's machine in ANY position.
      let raw = parsed.raw;
      if (raw === undefined) {
        try {
          raw = tree.readText(hooksPath);
        } catch {
          raw = undefined;
        }
      }
      const present = raw !== undefined && raw.includes(entry.token);
      add(
        `hooks.token.${entry.token}`,
        `${hooksPath} contains no \`${entry.token}\``,
        !present && raw !== undefined,
        raw === undefined
          ? `${hooksPath} unreadable, so the token sweep could not run — fail closed`
          : present
            ? `token present. ${provenance(entry)}`
            : undefined,
      );
    }
  }

  // ── Non-empty denominator ─────────────────────────────────────────────────
  if (checks.length === 0) {
    violations.push(
      '[empty-policy]  the packaging policy produced ZERO checks — a gate that ' +
        'asserts nothing reads identical to a gate that passed, which is the exact ' +
        'confusion task 064 exists to remove (DR-24 non-empty denominator)',
    );
  }

  return { checks, violations };
}

/** Markdown report, stable enough for a human to diff between runs. */
export function renderReport({ checks, violations }) {
  const lines = ['## Plugin Validation Report', ''];
  for (const check of checks) {
    lines.push(`- **${check.passed ? 'PASS' : 'FAIL'}**: ${check.description}`);
    if (!check.passed && check.detail) lines.push(`  - ${check.detail}`);
  }
  if (violations.length > 0) {
    lines.push('', '### Policy violations', '');
    for (const violation of violations) lines.push(`- ${violation}`);
  }
  const passed = checks.filter((c) => c.passed).length;
  const ok = violations.length === 0 && passed === checks.length && checks.length > 0;
  lines.push('', '---', '', `**Result: ${ok ? 'PASS' : 'FAIL'}** (${passed}/${checks.length} checks passed)`);
  return lines.join('\n');
}

/** The gate's verdict: policy violations count as failures, not as silence. */
export function isClean({ checks, violations }) {
  return violations.length === 0 && checks.length > 0 && checks.every((c) => c.passed);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `Usage: validate-plugin.mjs [--repo-root <path>] [--policy <path>] [--json]

Validates the shipped Exarchos plugin package against
.claude-plugin/packaging-policy.json — the single data statement of the package
shape. Change the package shape by changing that file.

Options:
  --repo-root <path>   Tree to validate (default: the repo this script lives in)
  --policy <path>      Policy document, relative to --repo-root
                       (default: ${DEFAULT_POLICY_PATH})
  --json               Emit the machine-readable report on stdout
  --help               Show this message

Exit codes:
  0  All checks pass
  1  One or more checks fail, or the policy is empty / self-contradictory
  2  Usage error, or the policy could not be read (fail closed)`;

function parseArgs(argv) {
  const options = { repoRoot: REPO_ROOT, policyPath: DEFAULT_POLICY_PATH, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--repo-root' || arg === '--policy') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a path argument`);
      }
      if (arg === '--repo-root') options.repoRoot = value;
      else options.policyPath = value;
      i += 1;
    } else throw new Error(`Unknown argument '${arg}'`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!existsSync(options.repoRoot)) {
    process.stderr.write(`Error: repository root not found: ${options.repoRoot}\n`);
    return 2;
  }

  const tree = diskTree(options.repoRoot);
  const policyRead = readJson(tree, options.policyPath);
  if (policyRead.value === undefined) {
    // Fail CLOSED (exit 2, not 1): an unreadable policy is a broken instrument,
    // and an instrument that no-ops on its own breakage is the class of defect
    // this whole task is about.
    process.stderr.write(
      `Error: packaging policy ${options.policyPath} could not be read — ${policyRead.error}\n`,
    );
    return 2;
  }

  const report = evaluatePackaging(policyRead.value, tree);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: isClean(report), ...report }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }
  return isClean(report) ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
