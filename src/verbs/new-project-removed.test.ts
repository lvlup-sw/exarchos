import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFullRegistry } from '../registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── DR-3 (task 017): retire `new-project` + delete `applyLanguageCustomizations`
//
// The greenfield path is now `onboard --new` (task 016). The obsolete
// `new-project` handler — whose `applyLanguageCustomizations` did an INV-6-
// violating `npm run …`→dotnet string-rewrite — must be deleted entirely, and
// its `new_project` orchestrate action unregistered. Task 016 already
// reproduced the one salvageable `.gitignore` seed in `onboard/new.ts`, so
// nothing is orphaned.
//
// This test is the regression shield: it fails loud if the module/action
// resurrects, or if any `applyLanguageCustomizations`-style npm→dotnet rewrite
// re-enters the LIVE onboarding/scaffold path (closes #1508).

// The live onboarding/scaffold source surface (source files only — exclude
// tests, including this one, which legitimately *name* the forbidden symbols).
// Comments in these files that document the *absence* of the rewrite (e.g.
// "the applyLanguageCustomizations npm-rewrite is gone") are fine; the
// assertions below match executable shapes (a definition / a call / a
// find-and-replace), not bare prose mentions.
const LIVE_PATH_FILES: readonly string[] = [
  // onboard/* (greenfield + reconcile + install + hooks)
  ...readdirSync(join(__dirname, 'onboard'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(__dirname, 'onboard', f)),
  // shared reconcile engine
  join(__dirname, '../dispatch/core/onboarding/reconcile.ts'),
];

describe('new-project removed (DR-3, task 017)', () => {
  it('NewProject_HandlerRemoved_NoNpmRewriteRemains', async () => {
    // 1. The `new-project.ts` module must no longer exist on disk.
    expect(
      existsSync(join(__dirname, 'new-project.ts')),
      'new-project.ts must be deleted',
    ).toBe(false);

    // 2. Importing the deleted module must fail (no dangling handler). The
    //    specifier is the SIBLING checked above — after task 015 a `../orchestrate/`
    //    path would reject merely because that directory is gone, which would pass
    //    even if the module resurrected here.
    await expect(import('./new-project.js')).rejects.toBeDefined();

    // 3. The `new_project` orchestrate action must be unregistered.
    const registry = getFullRegistry();
    const orchestrate = registry.find((t) => t.name === 'exarchos_orchestrate');
    expect(orchestrate, 'exarchos_orchestrate tool must exist').toBeDefined();
    const actionNames = orchestrate!.actions.map((a) => a.name);
    expect(actionNames).not.toContain('new_project');
    // And it must not linger in the slim action listing surfaced to agents.
    expect(orchestrate!.slimDescription ?? '').not.toContain('new_project');

    // 4. Grep-style check over the LIVE path: no `applyLanguageCustomizations`
    //    as CODE (a definition or a call — bare mentions in comments that
    //    *document its absence* are fine) and no `npm run …`→toolchain
    //    string-rewrite. The regexes target executable shapes, not prose, so a
    //    comment like "the applyLanguageCustomizations npm-rewrite is gone"
    //    legitimately survives while a real reintroduction fails loud.
    const definesApplyLangCustom = /\bfunction\s+applyLanguageCustomizations\b/;
    const callsApplyLangCustom = /\bapplyLanguageCustomizations\s*\(/;
    // The headline INV-6 violation: rewriting canonical `npm run …` tokens into
    // a target toolchain's commands via find-and-replace.
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
