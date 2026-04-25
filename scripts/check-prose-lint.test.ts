/**
 * Tests for the prose-lint CI gate (task T049, DR-13).
 *
 * Phase progression:
 *   - RED: `scripts/check-prose-lint.mjs` does not yet exist; these tests
 *     fail because spawning the script yields ENOENT and because the root
 *     `package.json` `validate` chain has not been extended to invoke it.
 *   - GREEN: the `.mjs` wrapper shells out to `tsx` against a co-located
 *     TS entrypoint (`servers/exarchos-mcp/src/projections/rehydration/
 *     prose-lint-cli.ts`) which calls `lintTemplate()` (default) or, when
 *     given `--template-source <path>`, runs `lintProse()` over the
 *     contents of that file. Exit 0 on no violations, 1 on violations,
 *     2 on usage / env errors. The validate chain is extended to invoke
 *     the wrapper after the prefix-fingerprint check.
 *
 * Rationale: DR-13 requires the rehydration document template's prose
 * surface to stay free of the AI-writing patterns cataloged by the
 * `humanize` skill (see T048 for the implementation). Without a CI gate,
 * an editor could silently re-introduce slop into the template prose and
 * the agents that hydrate from it would learn to mirror those tells back.
 * This test exercises the CLI contract only — the pattern set is covered
 * by `prose-lint.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-prose-lint.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

/**
 * Spawn the check script and capture status / stdout / stderr. The script
 * defaults to running `lintTemplate()` over the live template module; an
 * optional `--template-source <path>` flag lets tests substitute a file
 * containing seeded AI-writing patterns so the divergence path can be
 * exercised without mutating the real template.
 */
function runCheck(extraArgs: string[] = []): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('node', [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // The script shells out to `tsx`; inherit PATH + node-path env.
    env: { ...process.env },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-prose-lint CLI (T049, DR-13)', () => {
  it('Script_Exists', () => {
    // The GREEN step creates this file. In RED it must not exist, so this
    // assertion fails in RED and passes in GREEN.
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('Validate_CleanTemplate_ExitsZero', () => {
    // With no args, the script lints the live rehydration template via
    // `lintTemplate()`. T048 left the template clean, so a non-zero exit
    // here means either the template has drifted or the wrapper is wired
    // incorrectly. Surface stderr in the failure message so CI logs are
    // actionable.
    const { status, stdout, stderr } = runCheck();
    expect(status, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
  });

  it('Validate_AiWritingInTemplate_ExitsNonZero', () => {
    // Seed a file with multiple high-signal AI tells and feed it via the
    // `--template-source` flag. The script must exit non-zero (1) and
    // print the offending pattern names + line numbers to stderr so a
    // reviewer can locate the slop without re-running the lint manually.
    //
    // The seed string matches at least the ai-vocabulary, conjunction-
    // overuse, and cliche categories — a single-pattern seed would be a
    // weaker assertion (the wrapper could silently drop categories and
    // still pass).
    const dir = mkdtempSync(path.join(tmpdir(), 'prose-lint-'));
    try {
      const seededFile = path.join(dir, 'seeded-template.md');
      writeFileSync(
        seededFile,
        'Moreover, this delves into the rich tapestry.\n' +
          'We must leverage the intricate landscape of synergies.\n',
        'utf8',
      );

      const { status, stderr } = runCheck([
        '--template-source',
        seededFile,
      ]);

      expect(status).toBe(1);
      // Diagnostic surface must name the offending patterns so a reviewer
      // can map the failure back to the humanize catalog without rerunning
      // the lint locally.
      expect(stderr).toMatch(/delve/i);
      expect(stderr).toMatch(/tapestry/i);
      expect(stderr).toMatch(/moreover/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Validate_ChainedIntoNpmValidate', () => {
    // The whole point of T049 is wiring the lint into `npm run validate`.
    // Parse the root package.json directly and assert the chain references
    // the wrapper. This is intentionally a string-level check rather than
    // executing `npm run validate` (which is covered by the integration
    // run in the verification step) — failing here gives the clearest
    // diagnostic when someone removes the chain entry.
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const validate = pkg.scripts?.validate ?? '';
    expect(validate).toContain('check-prose-lint.mjs');
  });
});
