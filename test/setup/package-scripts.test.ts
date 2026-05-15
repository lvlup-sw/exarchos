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
});
