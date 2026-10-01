#!/usr/bin/env node
/**
 * PR-body marker check for load-bearing golden fixtures.
 *
 * A change to a file under `tests/core/fixtures/load-bearing/` needs a PR-body
 * line that starts with `GOLDEN-FIXTURE-UPDATE: <reason>`. The marker shows the
 * change to reviewers and blocks a silent edit that breaks the rehydrate golden test.
 *
 * `checkGoldenFixtureNote` is the pure check. The CLI reads the body from
 * `--body` or `--body-file`, or else from the `GITHUB_EVENT_PATH` event JSON. It
 * reads the changed paths from `--changed-files-file`. It exits 0 on pass, 1 on
 * fail, and 2 on a usage error.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const LOAD_BEARING_PREFIX =
  'tests/core/fixtures/load-bearing/';
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
 * Returns pass or fail, and does not throw or log. The caller decides how to
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
  const normalised = path.replace(/\\/g, '/');
  return normalised.startsWith(LOAD_BEARING_PREFIX);
}

/**
 * True when a line starts with the marker and a non-empty reason. Leading
 * whitespace is ignored, so an indented body matches. The colon in the marker
 * rejects `GOLDEN-FIXTURE-UPDATED`. A bare marker fails, because the reason is
 * the context for the reviewer.
 *
 * @param {string} body
 */
function hasMarker(body) {
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

/**
 * True when Node runs this file directly, not when a test imports it. It uses
 * `fileURLToPath`, because `new URL(import.meta.url).pathname` gives `/D:/…` on
 * Windows, which never equals `process.argv[1]`.
 */
const invokedDirectly = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = fileURLToPath(import.meta.url);
    return argv1 === self || /[/\\]check-golden-fixture-note\.mjs$/.test(argv1);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const exitCode = runCli(process.argv.slice(2));
  process.exit(exitCode);
}

/**
 * Parses the flags, runs the check, and returns the exit code. A missing
 * `--body` value, or a known flag in its place, is a usage error. Other values
 * that start with `-` pass, because body text can start with `-`. An unreadable
 * file exits 2. Without a body flag, the body comes from the `GITHUB_EVENT_PATH`
 * event JSON.
 *
 * @param {string[]} argv
 * @returns {number} exit code
 */
function runCli(argv) {
  /** @type {string | undefined} */
  let body;
  /** @type {string[] | undefined} */
  let changedFiles;

  const KNOWN_FLAGS = new Set([
    '--body',
    '--body-file',
    '--changed-files-file',
    '-h',
    '--help',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--body':
        if (value === undefined || KNOWN_FLAGS.has(value)) {
          return usage('--body requires a string value');
        }
        body = value;
        i++;
        break;
      case '--body-file':
        if (!value) return usage('--body-file requires a path');
        try {
          body = readFileSync(value, 'utf8');
        } catch (err) {
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

  if (body === undefined && process.env.GITHUB_EVENT_PATH) {
    try {
      const raw = readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8');
      const evt = JSON.parse(raw);
      if (evt && evt.pull_request && typeof evt.pull_request.body === 'string') {
        body = evt.pull_request.body;
      }
    } catch {
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
      'Usage: node tools/audit/gates/check-golden-fixture-note.mjs \\',
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
