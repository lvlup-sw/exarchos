/**
 * The CLI entrypoint for the rehydration prose lint. `tools/audit/gates/check-prose-lint.mjs` runs it
 * under `tsx`, because that wrapper cannot import TypeScript. The pattern catalog stays in `prose-lint.ts`.
 *
 * With no flag, it lints the live template with `lintTemplate()`. With `--template-source <path>`, it runs
 * `lintProse()` over that file, so the wrapper tests can seed patterns and not change the real template.
 *
 * On clean input it prints nothing and exits 0. On violations it writes a tab-separated table to stderr
 * and exits 1. On a usage or read error it exits 2.
 */
import { readFileSync } from 'node:fs';
import { lintProse, lintTemplate, type Violation } from './prose-lint.js';

interface ParsedArgs {
  readonly templateSource: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let templateSource: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--template-source':
        if (!value) {
          process.stderr.write(
            'prose-lint-cli: --template-source requires a path\n',
          );
          process.exit(2);
        }
        templateSource = value;
        i++;
        break;
      case '-h':
      case '--help':
        process.stderr.write(
          'Usage: tsx prose-lint-cli.ts [--template-source <path>]\n',
        );
        process.exit(0);
        break;
      default:
        process.stderr.write(`prose-lint-cli: unknown flag: ${flag}\n`);
        process.exit(2);
    }
  }
  return { templateSource };
}

/** Formats a header line, then one tab-separated line for each violation. */
function formatViolations(violations: readonly Violation[]): string {
  const header = 'pattern\tline\texcerpt';
  const rows = violations.map(
    (v) => `${v.pattern}\t${v.line}\t${v.excerpt}`,
  );
  return [header, ...rows].join('\n');
}

function main(): void {
  const { templateSource } = parseArgs(process.argv.slice(2));

  let violations: Violation[];
  if (templateSource === null) {
    violations = lintTemplate();
  } else {
    let text: string;
    try {
      text = readFileSync(templateSource, 'utf8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `prose-lint-cli: cannot read template source ${templateSource}: ${message}\n`,
      );
      process.exit(2);
    }
    violations = lintProse(text);
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  process.stderr.write(`${formatViolations(violations)}\n`);
  process.stderr.write(
    `prose-lint-cli: ${violations.length} violation(s) found\n`,
  );
  process.exit(1);
}

main();
