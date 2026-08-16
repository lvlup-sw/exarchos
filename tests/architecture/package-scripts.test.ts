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

  it('PackageJson_BenchScript_RunsCoreProjectOnly', () => {
    // Other projects do not carry the bun:sqlite alias (or they load the
    // process preflight). `vitest bench` without a project filter collects
    // EventStore benches in those projects and fails the regression gate
    // before any numbers are compared.
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    expect(parsed.scripts?.bench).toBe('vitest bench --project core');
  });
});
