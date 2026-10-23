/**
 * Every `*.type-test.ts` file must be in a `tsc` program that `npm run typecheck` runs.
 *
 * A type test holds compile-time proofs. Vitest strips types, so a type test that no program
 * reads passes while its proofs are false. This guard reads the program list from the
 * `typecheck` script and asks `tsc` itself which files each program holds.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { execFileAsync } from '../../tools/test-helpers/spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../');

/** The directories that hold type tests today. A new home for type tests must join this list. */
const TYPE_TEST_ROOTS = ['src', 'tests', 'tools'] as const;

/** The number of type tests that exist today. A smaller count means the file walk broke. */
const MIN_TYPE_TESTS = 7;

/** Three `tsc` programs read the tree: the root, the conformance tool and the tests. */
const MIN_PROGRAMS = 3;

/** The time for three `tsc --listFilesOnly` runs. The `unit` default of 5 s is too short. */
const LIST_TIMEOUT_MS = 120_000;

/**
 * Returns the project argument of each `tsc` command in a `typecheck` script.
 * A `tsc` command with no `-p` reads the root `tsconfig.json`, so its project is `.`.
 */
function typecheckPrograms(script: string): string[] {
  const programs: string[] = [];
  for (const command of script.split('&&').map((part) => part.trim())) {
    const words = command.split(/\s+/);
    if (words[0] !== 'tsc') continue;
    const flag = words.findIndex((word) => word === '-p' || word === '--project');
    const project = flag >= 0 ? words[flag + 1] : undefined;
    programs.push(project ?? '.');
  }
  return programs;
}

/** Returns the type tests that no listed program holds. Both inputs are absolute paths. */
function unlistedTypeTests(typeTests: readonly string[], listed: ReadonlySet<string>): string[] {
  return typeTests.filter((file) => !listed.has(file));
}

/** Returns every `*.type-test.ts` file under a directory, as absolute paths. */
function findTypeTests(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTypeTests(path));
    else if (entry.name.endsWith('.type-test.ts')) found.push(path);
  }
  return found;
}

/** Returns the absolute paths of the files that one `tsc` program reads. */
async function listProgramFiles(project: string): Promise<string[]> {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const stdout = await execFileAsync(process.execPath, [tsc, '--listFilesOnly', '-p', project], {
    cwd: REPO_ROOT,
    timeout: LIST_TIMEOUT_MS,
  });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => resolve(REPO_ROOT, line));
}

describe('type-test coverage', () => {
  /** The live check: the programs of the `typecheck` script hold every type test in the tree. */
  it(
    'TypeTestFiles_EveryFile_InATypecheckProgram',
    async () => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      const programs = typecheckPrograms(pkg.scripts['typecheck'] ?? '');
      expect(programs.length, 'the typecheck script names too few tsc programs').toBeGreaterThanOrEqual(
        MIN_PROGRAMS,
      );

      const typeTests = TYPE_TEST_ROOTS.flatMap((root) => findTypeTests(join(REPO_ROOT, root)));
      expect(typeTests.length, 'the walk found too few type tests').toBeGreaterThanOrEqual(MIN_TYPE_TESTS);

      const listed = new Set((await Promise.all(programs.map(listProgramFiles))).flat());
      expect(unlistedTypeTests(typeTests, listed)).toEqual([]);
    },
    LIST_TIMEOUT_MS,
  );

  /** A type test that no program lists is reported, so the live check can fail. */
  it('TypeTestFiles_SeededUnlistedPath_Fails', () => {
    const listed = new Set(['/repo/tests/core/a.type-test.ts']);
    const seeded = '/repo/tests/unit/b.type-test.ts';
    expect(unlistedTypeTests(['/repo/tests/core/a.type-test.ts', seeded], listed)).toEqual([seeded]);
  });

  /** The parser reads `-p` and `--project`, and a bare `tsc` reads the root config. */
  it('TypecheckPrograms_ScriptWithThreeCommands_ReturnsEachProject', () => {
    expect(
      typecheckPrograms('tsc --noEmit && tsc --noEmit -p tools/conformance && tsc --project tests --noEmit'),
    ).toEqual(['.', 'tools/conformance', 'tests']);
  });
});
