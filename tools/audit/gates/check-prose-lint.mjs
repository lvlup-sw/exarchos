#!/usr/bin/env node
/**
 * CI gate: keeps the prose of the rehydration template free of the AI-writing
 * patterns of the `humanize` skill. Agents that hydrate from the template copy its style.
 *
 * The pattern catalog and scanner are in `src/projections/rehydration/prose-lint.ts`.
 * This wrapper runs the co-located `prose-lint-cli.ts` with `tsx`, so the gate needs
 * no prior build. `--template-source <path>` lints that file instead of the template.
 *
 * Exit 0 when clean, 1 on violations (rows on stderr), and 2 on a usage or environment error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const CLI_ENTRY = path.join(
  REPO_ROOT,
  'src',
  'projections',
  'rehydration',
  'prose-lint-cli.ts',
);

/**
 * Returns `{ command, args }` for `spawnSync`. It runs `tsx/dist/cli.mjs` with
 * `process.execPath` when that file exists, because Windows cannot launch the
 * `node_modules/.bin/tsx` shell shim without `shell: true`. Else it runs `tsx` from PATH.
 */
function resolveTsx() {
  const candidates = [
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(
      REPO_ROOT,
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return { command: 'tsx', args: [] };
}

/**
 * Returns `{ templateSource }`, or exits on a usage error or `--help`. The wrapper
 * checks the flags itself, so a usage error fails before the `tsx` spawn.
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
      'Usage: node tools/audit/gates/check-prose-lint.mjs [--template-source <path>]',
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

/**
 * Runs the TS CLI and forwards its stderr, which holds the violation rows, and its stdout.
 * Statuses 0, 1, and 2 come from the TS CLI. Any other status is an environment error.
 */
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

  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);

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
