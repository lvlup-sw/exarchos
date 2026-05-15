// Tests for `scripts/lint-inv6.mjs` — the advisory grep-based lint that
// surfaces candidate INV-6 (workflow-agnosticism) violations.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-inv6.mjs');

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
  readonly rule: string;
  readonly severity?: string;
  readonly message?: string;
}

interface LintOutput {
  readonly findings: ReadonlyArray<Finding>;
  readonly advisory: boolean;
}

function runLint(arg: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [LINT_SCRIPT, arg], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

describe('lint-inv6', () => {
  it('LintINV6_FlagsWorkflowTypeLiterals_NonZeroFindings', () => {
    // Set up a tmpdir with two synthetic skill SKILL.md files:
    //  - flagged: contains `feature/merge-pending` literal and NO
    //    `workflow-type:` frontmatter
    //  - clean:   declares `workflow-type: feature` in frontmatter
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-inv6-'));
    try {
      const flaggedDir = path.join(tmpdir, 'flagged-skill');
      const cleanDir = path.join(tmpdir, 'clean-skill');
      fs.mkdirSync(flaggedDir, { recursive: true });
      fs.mkdirSync(cleanDir, { recursive: true });

      const flaggedBody = [
        '---',
        'name: flagged-skill',
        'description: "Demonstrate INV-6 leak."',
        '---',
        '',
        '# Flagged skill',
        '',
        'When you reach `feature/merge-pending`, do the rebase.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(flaggedDir, 'SKILL.md'), flaggedBody, 'utf8');

      const cleanBody = [
        '---',
        'name: clean-skill',
        'description: "Demonstrate INV-6 declared escape hatch."',
        'metadata:',
        '  workflow-type: feature',
        '---',
        '',
        '# Clean skill',
        '',
        'When you reach `feature/merge-pending`, do the rebase.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(cleanDir, 'SKILL.md'), cleanBody, 'utf8');

      const { stdout, status } = runLint(tmpdir);
      expect(status, 'lint must exit 0 (advisory)').toBe(0);
      const out = JSON.parse(stdout) as LintOutput;
      expect(out.advisory).toBe(true);
      const flagged = out.findings.filter((f) =>
        f.file.includes(path.join('flagged-skill', 'SKILL.md')),
      );
      const clean = out.findings.filter((f) =>
        f.file.includes(path.join('clean-skill', 'SKILL.md')),
      );
      expect(clean.length, 'clean skill must not be flagged (workflow-type declared)').toBe(0);
      expect(flagged.length, 'flagged skill must be reported').toBeGreaterThanOrEqual(1);
      for (const f of flagged) {
        expect(f.rule).toBe('workflow-type-literal-without-declaration');
      }
    } finally {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    }
  });

  it('LintINV6_RunsAdvisoryAgainstRealCatalog_ExitsZero', () => {
    const { stdout, status } = runLint('skills-src/');
    expect(status, 'lint must exit 0 even with findings (advisory)').toBe(0);
    const out = JSON.parse(stdout) as LintOutput;
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.advisory).toBe(true);
  });
});
