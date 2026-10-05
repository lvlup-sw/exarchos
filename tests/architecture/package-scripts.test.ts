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
});
