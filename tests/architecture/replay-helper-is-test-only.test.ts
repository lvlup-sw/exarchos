/**
 * No module under `src/` or `tools/` imports the test-only replay helper.
 *
 * The helper appends the reserved ledger kinds through the store appender. A product import of it opens a write route
 * that the reserved list closes. The guard parses each module that holds the word `replay`, and it reads each import specifier.
 * It resolves a relative specifier against the directory of the module with POSIX rules, because a specifier uses `/` on each platform.
 * It reports each module as a POSIX path relative to the repository root.
 * The walk holds each tracked module, and the guard finds an import that the test plants in a copy of a real module.
 *
 * @oracle-sources: ../../tools/test-helpers/module-specifier-parser.ts, the import lines that the test plants by hand
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseModuleSpecifiers } from '../../tools/test-helpers/module-specifier-parser.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The roots that hold product code and repository automation. */
const SCANNED_ROOTS: readonly string[] = ['src', 'tools'];

/** The extensions of a module that can hold an import. */
const MODULE_EXTENSIONS: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** The directory of the replay helper, relative to the repository root. */
const HELPER_DIRECTORY = 'tests/helpers/replay';

/** The walk parses each module of the live tree, so the case sets its own timeout. */
const SCAN_TIMEOUT_MS = 30_000;

/** One import of the helper: the module, relative to the repository root, and its specifier. */
interface HelperImport {
  readonly module: string;
  readonly specifier: string;
}

/** Whether a directory entry is out of the walk. The tracked population leaves out the same segments. */
function isSkipped(name: string): boolean {
  return name === 'node_modules' || name === 'dist' || name.startsWith('.');
}

/** Each module under a root, as a POSIX path relative to the repository root, built from the entry names. */
function modulesUnder(relative: string): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(path.join(REPO_ROOT, ...relative.split('/')), { withFileTypes: true })) {
    if (isSkipped(entry.name)) continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) modules.push(...modulesUnder(child));
    else if (MODULE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) modules.push(child);
  }
  return modules;
}

/** Whether a specifier of a module names the helper directory or a file under it. */
function namesHelper(module: string, specifier: string): boolean {
  if (specifier.startsWith('.')) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(module), specifier));
    return resolved === HELPER_DIRECTORY || resolved.startsWith(`${HELPER_DIRECTORY}/`);
  }
  return specifier === HELPER_DIRECTORY || specifier.includes(`${HELPER_DIRECTORY}/`) || specifier.endsWith(`/${HELPER_DIRECTORY}`);
}

/** The imports of the helper in one module. A specifier names the directory, so a module without the word imports nothing of it. */
function helperImportsOf(module: string, source: string): HelperImport[] {
  if (!source.includes('replay')) return [];
  return parseModuleSpecifiers(source, path.posix.basename(module))
    .filter(({ specifier }) => namesHelper(module, specifier))
    .map(({ specifier }) => ({ module, specifier }));
}

describe('the replay helper is test-only', () => {
  /** The walk holds each tracked module first, so a broken walk cannot pass the last assertion for nothing. */
  it('ReplayHelper_NoModuleUnderSrcOrTools_ImportsIt', async () => {
    const modules = SCANNED_ROOTS.flatMap(modulesUnder);
    const walked = new Set(modules);
    const tracked = await listTrackedFiles(REPO_ROOT, {
      extensions: MODULE_EXTENSIONS,
      exclude: (relative) => !SCANNED_ROOTS.some((root) => relative.startsWith(`${root}/`)),
    });
    expect(tracked.filter((module) => !walked.has(module))).toEqual([]);
    expect(modules).toContain('src/events/store.ts');

    const sources = modules.map((module) => ({ module, source: readFileSync(path.join(REPO_ROOT, ...module.split('/')), 'utf8') }));
    expect(sources.filter(({ source }) => source.includes('replay')).length).toBeGreaterThan(0);
    expect(sources.flatMap(({ module, source }) => helperImportsOf(module, source))).toEqual([]);
  }, SCAN_TIMEOUT_MS);

  /**
   * Each planted import in a copy of a real module is found with its specifier. A specifier in a comment or a string is no import.
   * A relative specifier that resolves outside the helper directory is no import of the helper.
   */
  it('ReplayHelper_APlantedImport_IsFound', () => {
    const module = 'src/events/store.ts';
    const source = readFileSync(path.join(REPO_ROOT, 'src', 'events', 'store.ts'), 'utf8');
    expect(helperImportsOf(module, source)).toEqual([]);

    const helper = '../../tests/helpers/replay/workflow-replay.js';
    const planted = [
      `import { copyWorkflowStream } from '${helper}';`,
      `export { copyWorkflowStream as copy } from '${helper}';`,
      `export const late = (): Promise<unknown> => import('${helper}');`,
    ];
    for (const line of planted) {
      expect(helperImportsOf(module, `${source}\n${line}\n`), line).toEqual([{ module, specifier: helper }]);
    }

    const described = `${source}\n/** The old copy imported '${helper}'. */\nexport const note = '${helper}';\n`;
    expect(helperImportsOf(module, described)).toEqual([]);
    const elsewhere = `${source}\nimport { copy } from '../tests/helpers/replay/workflow-replay.js';\n`;
    expect(helperImportsOf(module, elsewhere)).toEqual([]);
    const fromTools = `import { walkSettledFeature } from '../../../tests/helpers/replay/settled-feature-walk.js';\n`;
    expect(helperImportsOf('tools/audit/core/replay-user.ts', fromTools)).toEqual([
      { module: 'tools/audit/core/replay-user.ts', specifier: '../../../tests/helpers/replay/settled-feature-walk.js' },
    ]);
  });
});
