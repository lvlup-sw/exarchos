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
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
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
 * Evaluate a packaging policy against a tree.
 *
 * Pure: every filesystem touch goes through `tree`. Returns the full check list
 * even when an early check fails — the aggregation discipline this task exists
 * to install applies inside the gate as much as across the chain.
 *
 * @param {unknown} policy
 * @param {TreeReader} tree
 * @returns {{ checks: CheckResult[], violations: string[] }}
 *   `violations` holds structural problems with the POLICY itself (empty,
 *   self-contradictory), which are distinct from a failing check.
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

    for (const entry of manifestSpec.requiredFields ?? []) {
      const field = entry.field;
      const present = manifest !== undefined && manifest !== null && manifest[field] !== undefined;
      add(
        `manifest.field.${field}`,
        `${manifestPath} declares \`${field}\``,
        present,
        present ? undefined : `field absent. ${provenance(entry)}`,
      );
    }

    for (const entry of manifestSpec.forbiddenFields ?? []) {
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
      for (const entry of serversSpec.expected ?? []) {
        const present = names?.includes(entry.name) === true;
        add(
          `manifest.mcp-server.${entry.name}`,
          `${manifestPath} \`${field}\` registers \`${entry.name}\``,
          present,
          present ? undefined : `server absent. ${provenance(entry)}`,
        );
      }
      if (serversSpec.exact === true) {
        const expected = (serversSpec.expected ?? []).map((e) => e.name).sort();
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
  for (const entry of policy.requiredDirs ?? []) {
    const ok = tree.dirExists(entry.path);
    add(
      `dir.${entry.path}`,
      `${entry.path}/ exists`,
      ok,
      ok ? undefined : `directory absent. ${provenance(entry)}`,
    );
  }

  for (const entry of policy.requiredFiles ?? []) {
    const ok = tree.fileExists(entry.path);
    add(
      `file.${entry.path}`,
      `${entry.path} exists`,
      ok,
      ok ? undefined : `file absent. ${provenance(entry)}`,
    );
  }

  for (const entry of policy.forbiddenFiles ?? []) {
    const present = tree.fileExists(entry.path);
    add(
      `forbidden-file.${entry.path}`,
      `${entry.path} is absent`,
      !present,
      present ? `file present. ${provenance(entry)}` : undefined,
    );
  }

  // ── hooks/hooks.json ──────────────────────────────────────────────────────
  const hooksSpec = policy.hooks;
  if (hooksSpec !== undefined) {
    const hooksPath = hooksSpec.path;
    const expectedTypes = (hooksSpec.expected ?? []).map((e) => e.type);
    const retiredTypes = (hooksSpec.retired ?? []).map((e) => e.type);
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

    for (const entry of hooksSpec.expected ?? []) {
      const present = declared?.includes(entry.type) === true;
      add(
        `hooks.expected.${entry.type}`,
        `${hooksPath} declares \`${entry.type}\``,
        present,
        present ? undefined : `hook absent. ${provenance(entry)}`,
      );
    }

    for (const entry of hooksSpec.retired ?? []) {
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

    for (const entry of hooksSpec.forbiddenTokens ?? []) {
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
