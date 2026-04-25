/**
 * Thin CLI entrypoint that runs the rehydration prose lint and reports
 * violations in a machine-friendly text format.
 *
 * Intended to be invoked under `tsx` by `scripts/check-prose-lint.mjs`
 * (T049, DR-13). The wrapper at the repo root cannot directly import
 * TypeScript, so this stub exposes the canonical `lintTemplate()` /
 * `lintProse()` functions through a child-process boundary. Single
 * source of truth for the pattern catalog stays in `prose-lint.ts`.
 *
 * Modes:
 *   - Default: lint the live rehydration document template via
 *     `lintTemplate()` (which reads `schema.ts` doc comments + every
 *     `compactGuidance` literal in `playbooks.ts`).
 *   - `--template-source <path>`: read the file at <path> as a string
 *     and run `lintProse()` over its contents. Used by the wrapper's
 *     test suite to seed AI-writing patterns without mutating the real
 *     template; also useful as a one-off lint of an arbitrary file.
 *
 * Output:
 *   - On clean input: prints nothing and exits 0.
 *   - On violations: prints one line per violation to stderr in the
 *     `pattern\tline\texcerpt` format, then exits 1. The wrapper
 *     forwards this stderr to the npm-run-validate console.
 *   - On usage / IO errors: prints a diagnostic to stderr and exits 2.
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

function formatViolations(violations: readonly Violation[]): string {
  // One line per violation. Tab-separated so wrappers can pipe the output
  // through `column -t` or `cut` if they want a different layout. The
  // header line keeps the format self-documenting in CI logs.
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
