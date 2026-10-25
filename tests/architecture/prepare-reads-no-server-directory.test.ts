/**
 * `prepare` reads the repository that `repoRoot` names, and never the directory or the config of the server.
 *
 * The guard walks each source module under `src/verbs/prepare`, and it names each read of `ctx.cwd`, `process.cwd()` or `ctx.projectConfig`.
 * It reads the code with comments, strings and templates blanked, so a sentence about a read is not a read.
 * It cannot see a read through another name, a destructuring, or a helper outside the directory.
 * The count of scanned modules is pinned, so a broken walk fails. A seeded read in a copy of the real handler is named.
 *
 * @oracle-sources: live-src-verbs-prepare-directory-listing, the three server-directory reads written by hand in this file
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { lexModule } from '../../tools/test-helpers/module-lexer.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** The directory of the prepare verb. */
const PREPARE_ROOT = path.join(REPO_ROOT, 'src', 'verbs', 'prepare');

/** The source modules under the directory today. A new module changes this pin in the same change. */
const SCANNED_MODULE_COUNT = 13;

/** One read of the server directory or its config, by name, with the pattern that finds it in code. */
interface ServerDirectoryRead {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The reads that the guard refuses. Each pattern also finds the optional-chaining form. */
const SERVER_DIRECTORY_READS: readonly ServerDirectoryRead[] = [
  { name: 'ctx.cwd', pattern: /\bctx\s*\??\.\s*cwd\b/ },
  { name: 'process.cwd()', pattern: /\bprocess\s*\??\.\s*cwd\s*\(/ },
  { name: 'ctx.projectConfig', pattern: /\bctx\s*\??\.\s*projectConfig\b/ },
];

/** One read that the scan found: the module, relative to the repository root, and the name of the read. */
interface FoundRead {
  readonly module: string;
  readonly read: string;
}

/** Each source module under a directory, recursively, as an absolute path. A test module is not a source module. */
function sourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceModules(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

/** The reads of one module, in the order of {@link SERVER_DIRECTORY_READS}. */
function readsOf(module: string, source: string): FoundRead[] {
  const code = lexModule(source, path.basename(module)).maskedSource;
  return SERVER_DIRECTORY_READS.filter((read) => read.pattern.test(code)).map((read) => ({ module, read: read.name }));
}

/** The module path relative to the repository root, in POSIX form. */
function relativeOf(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

describe('prepare reads no server directory', () => {
  /**
   * The denominator comes first. A walk that finds no module, or a pattern that matches nothing, passes the last assertion for nothing.
   * The handler is in the walk, because it is the module that read the server directory before the scope was pinned.
   */
  it('PrepareSource_ReadsNoServerDirectory', () => {
    const modules = sourceModules(PREPARE_ROOT);
    expect(modules).toHaveLength(SCANNED_MODULE_COUNT);
    expect(modules.map(relativeOf)).toContain('src/verbs/prepare/handler.ts');
    const found = modules.flatMap((module) => readsOf(relativeOf(module), readFileSync(module, 'utf8')));
    expect(found).toStrictEqual([]);
  });

  /**
   * The real handler holds no read. Each seeded copy holds one read, and the scan names that read and the module.
   * A copy that names a read only in a comment or a string holds no read.
   */
  it('PrepareSource_ASeededServerDirectoryRead_FailsByName', () => {
    const handler = path.join(PREPARE_ROOT, 'handler.ts');
    const source = readFileSync(handler, 'utf8');
    expect(readsOf('src/verbs/prepare/handler.ts', source)).toStrictEqual([]);

    const seeded = [
      { read: 'ctx.cwd', line: 'export const seededRoot = (ctx: { cwd?: string }) => ctx.cwd;' },
      { read: 'process.cwd()', line: 'export const seededRoot = () => process.cwd();' },
      { read: 'ctx.projectConfig', line: 'export const seededPolicy = (ctx: { projectConfig?: unknown }) => ctx?.projectConfig;' },
    ];
    for (const { read, line } of seeded) {
      expect(readsOf('src/verbs/prepare/handler.ts', `${source}\n${line}\n`), read).toStrictEqual([
        { module: 'src/verbs/prepare/handler.ts', read },
      ]);
    }

    const described = `${source}\n/** The old handler read process.cwd() and ctx.cwd. */\nexport const note = 'ctx.projectConfig';\n`;
    expect(readsOf('src/verbs/prepare/handler.ts', described)).toStrictEqual([]);
  });
});
