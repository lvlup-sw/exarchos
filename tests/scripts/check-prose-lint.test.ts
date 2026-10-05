/**
 * Tests for the CLI contract of the prose-lint gate.
 *
 * The gate keeps the prose of the rehydration template free of the AI-writing
 * patterns that the `humanize` skill catalogs. Agents that hydrate from the
 * template copy its style.
 * `tests/unit/projections/rehydration/prose-lint.test.ts` covers the pattern set.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifestCommands } from '../../tools/audit/gates/test-utils.js';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'audit', 'gates', 'check-prose-lint.mjs');
const ROOT_PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

/**
 * Spawns the check script. With no arguments the script lints the live template.
 * `--template-source <path>` lints that file, so a test can seed patterns and
 * leave the real template unchanged.
 * The script runs `tsx`, so the child inherits the full environment.
 */
async function runCheck(extraArgs: string[] = []): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  const result = await spawnAsync('node', [SCRIPT, ...extraArgs], {
    cwd: REPO_ROOT,
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
    expect(existsSync(SCRIPT)).toBe(true);
  });

  /** A non-zero exit means that the template drifted, or that the wrapper is wired incorrectly. */
  it('Validate_CleanTemplate_ExitsZero', async () => {
    const { status, stdout, stderr } = await runCheck();
    expect(status, `stderr: ${stderr}\nstdout: ${stdout}`).toBe(0);
  });

  /**
   * The seed holds patterns from the `ai-vocabulary`, `conjunction-overuse` and
   * `cliche` categories, because one pattern cannot show a dropped category.
   * stderr must show the matched patterns, so a reviewer can find them without a local run.
   */
  it('Validate_AiWritingInTemplate_ExitsNonZero', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prose-lint-'));
    try {
      const seededFile = path.join(dir, 'seeded-template.md');
      writeFileSync(
        seededFile,
        'Moreover, this delves into the rich tapestry.\n' +
          'We must leverage the intricate landscape of synergies.\n',
        'utf8',
      );

      const { status, stderr } = await runCheck([
        '--template-source',
        seededFile,
      ]);

      expect(status).toBe(1);
      expect(stderr).toMatch(/delve/i);
      expect(stderr).toMatch(/tapestry/i);
      expect(stderr).toMatch(/moreover/i);
    } finally {
      rmrf(dir);
    }
  });

  /**
   * The `validate` script runs `run-validate.mjs`, which reads its steps from
   * `tools/audit/gates/validate-manifest.json`. The test reads that data and does
   * not run `npm run validate`, so a dropped step gives a clear diagnostic.
   */
  it('Validate_ChainedIntoNpmValidate', () => {
    const pkg = JSON.parse(readFileSync(ROOT_PACKAGE_JSON, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.validate ?? '').toContain('run-validate.mjs');
    expect(validateManifestCommands(REPO_ROOT)).toContain('check-prose-lint.mjs');
  });
});
