import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('package.json scripts', () => {
  it('PackageJson_TestOutcomeScript_Exists', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = parsed.scripts ?? {};
    expect(scripts['test:outcome']).toBe('vitest run --project outcome');
  });

  /**
   * The `unit` and `process` projects have no `bun:sqlite` alias, and `process`
   * also loads the process preflight. Without a project filter, `vitest bench`
   * collects the EventStore benches in those projects, and the regression gate
   * fails before it compares numbers.
   */
  it('PackageJson_BenchScript_RunsCoreProjectOnly', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(parsed.scripts?.bench).toBe('vitest bench --project core');
  });

  /**
   * `.exarchos.yml` names this script as the integration suite of a high-tier settle. The `process`
   * project tests the installed `exarchos` binary, not the tree of the task, so the script leaves it out.
   * The double quotes hold on `sh` and on `cmd.exe`. The negated name must be a project of the vitest
   * config, or the exclusion matches nothing and the script runs the `process` project too.
   */
  it('PackageJson_IntegrationScript_RunsEveryProjectButProcess', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    const script = parsed.scripts?.['test:integration'];
    expect(script).toBe('vitest run --project "!process"');
    const negated = /--project "!([a-z-]+)"/.exec(script ?? '')?.[1];
    const vitestConfig = fs.readFileSync(path.join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
    expect(vitestConfig).toContain(`name: '${negated ?? '<none>'}'`);
  });
});
