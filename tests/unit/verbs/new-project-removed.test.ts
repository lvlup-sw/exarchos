import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullRegistry } from '../../../src/registry.js';

const __dirname = fileURLToPath(new URL('../../../src/verbs/', import.meta.url));

/**
 * The source files of the live onboarding and scaffold path, without tests.
 * The checks match code shapes (a definition, a call, a find-and-replace), so a comment that names the removed function still passes.
 */
const LIVE_PATH_FILES: readonly string[] = [
  /** The source files in the `onboard` directory. */
  ...readdirSync(join(__dirname, 'onboard'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(__dirname, 'onboard', f)),
  /** The shared reconcile engine. */
  join(__dirname, '../dispatch/core/onboarding/reconcile.ts'),
];

/**
 * Regression guard: the `new-project` handler and its `new_project` orchestrate action must stay removed. The greenfield path is `onboard --new`.
 * The removed `applyLanguageCustomizations` rewrote `npm run` commands into the commands of another toolchain by string replacement.
 * That rewrite must not come back into the live onboarding path.
 */
describe('new-project removed (DR-3, task 017)', () => {
  /** The dynamic import uses the sibling path that the test checks on disk. A path into a removed directory rejects for the wrong reason, so it hides a restored module. */
  it('NewProject_HandlerRemoved_NoNpmRewriteRemains', async () => {
    expect(
      existsSync(join(__dirname, 'new-project.ts')),
      'new-project.ts must be deleted',
    ).toBe(false);

    await expect(import('../../../src/verbs/new-project.js')).rejects.toBeDefined();

    const registry = getFullRegistry();
    const orchestrate = registry.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate, 'exarchos_orchestrate tool must exist').toBeDefined();
    const actionNames = orchestrate!.actions.map((a) => a.name);
    expect(actionNames).not.toContain('new_project');
    expect(orchestrate!.slimDescription ?? '').not.toContain('new_project');

    const definesApplyLangCustom = /\bfunction\s+applyLanguageCustomizations\b/;
    const callsApplyLangCustom = /\bapplyLanguageCustomizations\s*\(/;
    const npmRunRewrite = /\.replace\(\s*\/npm run/;
    for (const file of LIVE_PATH_FILES) {
      expect(existsSync(file), `expected live-path file to exist: ${file}`).toBe(true);
      const src = readFileSync(file, 'utf-8');
      expect(
        definesApplyLangCustom.test(src),
        `applyLanguageCustomizations definition must not remain in ${file}`,
      ).toBe(false);
      expect(
        callsApplyLangCustom.test(src),
        `applyLanguageCustomizations call must not remain in ${file}`,
      ).toBe(false);
      expect(
        npmRunRewrite.test(src),
        `npm run …→toolchain string-rewrite must not remain in ${file}`,
      ).toBe(false);
    }
  });
});
