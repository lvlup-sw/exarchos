/**
 * The modules of `src/workflow/decide/` import no legacy guard module, no state store and no dispatch module.
 *
 * The test reads the direct relative imports of each module only, `import type` included. It does not walk
 * the import graph. Two planned imports reach a forbidden module through other modules, so a transitive walk
 * fails on them. The cycle gate `tools/audit/cycle-gate.ts` guards the transitive cycle risk.
 *
 * @oracle-sources: live-src-workflow-decide-directory-listing, the forbidden modules written by hand in this file
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** The root of the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The directory of the decide modules. */
const DECIDE_DIR = resolve(REPO_ROOT, 'src/workflow/decide');

/** The modules that no decide module imports directly. */
const FORBIDDEN_MODULES: readonly string[] = [
  'src/workflow/guards.ts',
  'src/workflow/hsm-definitions.ts',
  'src/workflow/hsm-transition-guard.ts',
  'src/workflow/state-machine.ts',
  'src/config/guards.ts',
  'src/config/register.ts',
  'src/workflow/state-store.ts',
];

/** The directory that no decide module imports from directly. */
const FORBIDDEN_DIRECTORY = 'src/dispatch/';

/** Returns each import specifier of a source text, `import type` and re-exports included. */
function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from|import)\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

/** Returns the repository path of the `.ts` module that a relative specifier names. */
function targetOf(fromFile: string, specifier: string): string {
  const absolute = resolve(dirname(fromFile), specifier).replace(/\.js$/, '.ts');
  return relative(REPO_ROOT, absolute).split('\\').join('/');
}

/**
 * Returns one line for each forbidden direct import of each decide module. A directory with no module gives
 * one line, so an empty scan cannot pass.
 */
function forbiddenImports(): readonly string[] {
  const modules = readdirSync(DECIDE_DIR).filter((name) => name.endsWith('.ts'));
  if (modules.length === 0) return ['no decide module was scanned'];
  const found: string[] = [];
  for (const name of modules) {
    const file = resolve(DECIDE_DIR, name);
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = targetOf(file, specifier);
      if (FORBIDDEN_MODULES.includes(target) || target.startsWith(FORBIDDEN_DIRECTORY)) {
        found.push(`${name} imports ${target}`);
      }
    }
  }
  return found;
}

describe('the imports of the decide modules', () => {
  it('DecideModules_ImportNoLegacyGuardModuleNoStateStoreAndNoDispatch', () => {
    expect(forbiddenImports()).toEqual([]);
  });
});
