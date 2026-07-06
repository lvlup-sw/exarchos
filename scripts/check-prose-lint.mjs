#!/usr/bin/env node
/**
 * Prose-lint CI gate (task T049, DR-13).
 *
 * Invoked from the root `npm run validate` chain. The purpose of this
 * gate is to keep the rehydration document's prose surface (the
 * `behavioralGuidance` template strings + surrounding doc comments) free
 * of the AI-writing patterns cataloged by the `humanize` skill. Without
 * the gate, an editor could silently re-introduce slop into the template
 * and the agents that hydrate from it would learn to mirror those tells
 * back into their own output.
 *
 *   Exit 0 — no violations (clean prose).
 *   Exit 1 — one or more violations (printed to stderr as
 *            `pattern  line  excerpt` rows).
 *   Exit 2 — usage / environment error (tsx not found, file unreadable).
 *
 * How we reach the lint:
 *   - The canonical pattern catalog + scanner live in
 *     `servers/exarchos-mcp/src/projections/rehydration/prose-lint.ts`.
 *   - A tiny TS entrypoint (`prose-lint-cli.ts`, co-located with the
 *     module) calls either `lintTemplate()` or `lintProse(readFileSync(
 *     <path>))` and prints violations to stderr.
 *   - This `.mjs` shells out to `tsx` (devDep at the repo root) to
 *     execute that entrypoint. We deliberately avoid importing a
 *     compiled dist so the validate chain does not depend on a prior
 *     build step.
 *
 * Flags (primarily for testability):
 *   --template-source <path>  Read the file at <path> and lint its
 *                             contents instead of the live template.
 *                             Used by the wrapper's test suite to seed
 *                             AI-writing patterns without mutating the
 *                             real template.
 *   --help                    Show usage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CLI_ENTRY = path.join(
  REPO_ROOT,
  'servers',
  'exarchos-mcp',
  'src',
  'projections',
  'rehydration',
  'prose-lint-cli.ts',
);

/**
 * Resolve the tsx binary. Search order: root `node_modules/.bin/tsx`
 * (the devDep that is guaranteed installed by `npm install`), then the
 * MCP server's local `node_modules/.bin/tsx`, then `tsx` on PATH. We
 * prefer explicit paths over PATH so the check is reproducible across
 * shells.
 *
 * @returns {string} absolute path to a tsx binary, or the literal `tsx`
 *   for PATH fallback.
 */
/**
 * Resolve how to invoke `tsx`, returning `{ command, args }` for
 * `spawnSync`. Prefers the actual JS CLI entrypoint
 * (`tsx/dist/cli.mjs`) run via `process.execPath` over the
 * `node_modules/.bin/tsx` shim — the shim is a POSIX shebang script with
 * no `.exe`/`.cmd` extension, so Win32's executable resolution can't
 * launch it directly (no `shell: true` here). Invoking the `.mjs` CLI
 * with `node` sidesteps shim resolution entirely and works identically
 * on every platform.
 */
function resolveTsx() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(
      REPO_ROOT,
      'servers',
      'exarchos-mcp',
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  // PATH fallback — let spawnSync resolve the `tsx` shim itself.
  return { command: 'tsx', args: [] };
}

/**
 * Parse argv. Returns `{ templateSource }` or exits on usage error /
 * help. The wrapper intentionally validates flags here (rather than
 * delegating to the TS CLI) so usage errors fail fast without paying
 * the tsx spawn cost.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let templateSource = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--template-source':
        if (!value) usageExit('--template-source requires a path');
        templateSource = path.resolve(value);
        i++;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        usageExit(`unknown flag: ${flag}`);
    }
  }
  return { templateSource };
}

/** @param {string} msg */
function usageExit(msg) {
  process.stderr.write(`check-prose-lint: ${msg}\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: node scripts/check-prose-lint.mjs [--template-source <path>]',
      '',
      'Flags:',
      '  --template-source <path>  Lint the file at <path> instead of the',
      '                            live rehydration template. Used by tests.',
      '  --help                    Show this help message.',
      '',
      'Exit codes: 0 clean, 1 violations, 2 usage/env error.',
      '',
    ].join('\n'),
  );
}

function main() {
  const { templateSource } = parseArgs(process.argv.slice(2));

  const { command, args } = resolveTsx();
  const tsxArgs = [...args, CLI_ENTRY];
  if (templateSource !== null) {
    tsxArgs.push('--template-source', templateSource);
  }

  const result = spawnSync(command, tsxArgs, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (result.error) {
    process.stderr.write(
      `check-prose-lint: failed to spawn tsx (${command}): ${result.error.message}\n`,
    );
    process.exit(2);
  }

  // Forward the TS CLI's stderr (which contains the violation rows) so
  // CI logs name the offending patterns + line numbers without a second
  // tool invocation. stdout is reserved for clean-run summaries.
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);

  // Statuses 0/1/2 come straight from the TS CLI (clean / violations /
  // usage-or-env error). Any other status is treated as an env failure.
  switch (result.status) {
    case 0:
      process.stdout.write('check-prose-lint: OK (no violations)\n');
      process.exit(0);
      break;
    case 1:
      process.stderr.write(
        '\ncheck-prose-lint: FAIL — AI-writing patterns detected (DR-13).\n' +
          'Rewrite the offending lines using natural technical prose, or\n' +
          'see ~/.claude/skills/humanize/references/ai-writing-patterns.md\n' +
          'for guidance on each pattern category.\n',
      );
      process.exit(1);
      break;
    case 2:
      process.exit(2);
      break;
    default:
      process.stderr.write(
        `check-prose-lint: unexpected exit status ${result.status} from tsx (${tsx})\n`,
      );
      process.exit(2);
  }
}

main();
