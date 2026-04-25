#!/usr/bin/env node
/**
 * Golden-fixture PR-body marker check (task T053, DR-15).
 *
 * DR-15 ("Load-bearing golden fixtures") requires that any change to a file
 * under `servers/exarchos-mcp/tests/fixtures/load-bearing/**` be explicitly
 * acknowledged in the PR body with the marker
 *
 *     GOLDEN-FIXTURE-UPDATE: <free-form reason>
 *
 * on a line by itself (or as a leading token on a line). The marker makes
 * changes to load-bearing fixtures visible to reviewers and blocks silent
 * edits that would invalidate the rehydrate golden test.
 *
 * This module exports a single pure function, `checkGoldenFixtureNote`,
 * which is unit-tested. A thin CLI main is provided for CI wiring: run the
 * script directly with Node 20+ and it reads:
 *
 *   - `--body-file <path>` or `--body <string>`   → PR body text
 *   - `--changed-files-file <path>`               → newline-separated paths
 *   - `GITHUB_EVENT_PATH` env var                 → pull_request event JSON
 *     (used as a fallback body source when `--body*` flags are absent)
 *
 * The script exits 0 on pass, 1 on fail, 2 on usage error. Only Node
 * built-ins are used (`node:fs`, `node:process`).
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

const LOAD_BEARING_PREFIX =
  'servers/exarchos-mcp/tests/fixtures/load-bearing/';
const MARKER = 'GOLDEN-FIXTURE-UPDATE:';

/**
 * @typedef {Object} CheckInput
 * @property {string[]} changedFiles - Paths relative to repo root.
 * @property {string}   prBody       - Full PR body text.
 *
 * @typedef {Object} CheckResult
 * @property {boolean} passed
 * @property {string=} reason
 */

/**
 * Pure, side-effect-free check: returns pass/fail without throwing or
 * logging. Callers (tests, CLI main, future GitHub Action) decide how to
 * report.
 *
 * @param {CheckInput} input
 * @returns {CheckResult}
 */
export function checkGoldenFixtureNote({ changedFiles, prBody }) {
  const touched = (changedFiles ?? []).filter((p) =>
    isLoadBearingFixture(p),
  );
  if (touched.length === 0) {
    return { passed: true };
  }
  if (hasMarker(prBody ?? '')) {
    return { passed: true };
  }
  return {
    passed: false,
    reason:
      `Changes to load-bearing golden fixtures require an explicit` +
      ` \`${MARKER}\` note in the PR body.\n` +
      `Touched fixtures:\n` +
      touched.map((p) => `  - ${p}`).join('\n') +
      `\n\nAdd a line to the PR body such as:\n` +
      `  ${MARKER} <one-line reason for regenerating the fixture>`,
  };
}

/** @param {string} path */
function isLoadBearingFixture(path) {
  // Normalise Windows-style separators defensively; the rule lives in a
  // POSIX path namespace.
  const normalised = path.replace(/\\/g, '/');
  return normalised.startsWith(LOAD_BEARING_PREFIX);
}

/** @param {string} body */
function hasMarker(body) {
  // Accept the marker as a leading token on any line (ignoring leading
  // whitespace) so that quoted/indented bodies still match. The colon is
  // part of the marker to avoid accidental prefix matches like
  // `GOLDEN-FIXTURE-UPDATED`. The marker MUST be followed by a non-empty
  // reason — DR-15's whole point is to force reviewer context, so a bare
  // `GOLDEN-FIXTURE-UPDATE:` line must NOT satisfy the gate.
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.replace(/^\s+/, '');
    if (
      trimmed.startsWith(MARKER) &&
      trimmed.slice(MARKER.length).trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

// ─── CLI main ────────────────────────────────────────────────────────────
// Only runs when invoked directly (not when imported by the test file).

const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = new URL(import.meta.url).pathname;
    return argv1 === self || argv1.endsWith('/check-golden-fixture-note.mjs');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function runCli(argv) {
  /** @type {string | undefined} */
  let body;
  /** @type {string[] | undefined} */
  let changedFiles;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--body':
        body = value;
        i++;
        break;
      case '--body-file':
        if (!value) return usage('--body-file requires a path');
        try {
          body = readFileSync(value, 'utf8');
        } catch (err) {
          // Route through usage() so the failure surface (missing path,
          // permission error, unreadable file) maps to the same exit
          // code path as malformed flags rather than crashing with an
          // unhandled exception. Preserve the underlying error message
          // so debugging stays cheap.
          const msg = err instanceof Error ? err.message : String(err);
          return usage(`--body-file ${value}: ${msg}`);
        }
        i++;
        break;
      case '--changed-files-file':
        if (!value) return usage('--changed-files-file requires a path');
        try {
          changedFiles = readFileSync(value, 'utf8')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return usage(`--changed-files-file ${value}: ${msg}`);
        }
        i++;
        break;
      case '-h':
      case '--help':
        printHelp();
        return 0;
      default:
        return usage(`unknown flag: ${flag}`);
    }
  }

  // Fallback: PR body from GitHub event payload.
  if (body === undefined && process.env.GITHUB_EVENT_PATH) {
    try {
      const raw = readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8');
      const evt = JSON.parse(raw);
      if (evt && evt.pull_request && typeof evt.pull_request.body === 'string') {
        body = evt.pull_request.body;
      }
    } catch {
      // Fall through — treated as missing body below.
    }
  }

  if (body === undefined) {
    return usage('PR body not provided (use --body, --body-file, or GITHUB_EVENT_PATH)');
  }
  if (changedFiles === undefined) {
    return usage('changed files list not provided (use --changed-files-file)');
  }

  const result = checkGoldenFixtureNote({ changedFiles, prBody: body });
  if (result.passed) {
    process.stdout.write('check-golden-fixture-note: passed\n');
    return 0;
  }
  process.stderr.write(`check-golden-fixture-note: FAILED\n${result.reason}\n`);
  return 1;
}

/** @param {string} msg */
function usage(msg) {
  process.stderr.write(`check-golden-fixture-note: ${msg}\n`);
  printHelp();
  return 2;
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: node scripts/check-golden-fixture-note.mjs \\',
      '         --body-file <path> \\',
      '         --changed-files-file <path>',
      '',
      'Flags:',
      '  --body <string>              PR body as a raw string',
      '  --body-file <path>           File containing PR body',
      '  --changed-files-file <path>  File with one changed path per line',
      '',
      'Env fallback:',
      '  GITHUB_EVENT_PATH            GitHub Actions pull_request event JSON',
      '',
      'Exit codes: 0 pass, 1 fail, 2 usage error.',
      '',
    ].join('\n'),
  );
}
