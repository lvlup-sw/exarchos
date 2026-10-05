/**
 * Recursive deletes in test code go through the temp-dir helpers (#2027).
 *
 * `rmrf` and `rmrfAsync` check for leaked SQLite handles. They also leave a
 * delete that the operating system refuses inside the run root for the
 * end-of-run sweep. A direct recursive `rm`, `rmSync`, `rmdir` or `rmdirSync`
 * skips both, so on Windows its verdict depends on processes that the test
 * does not control.
 *
 * The guard parses every source file under `tests/`, every file that a vitest
 * project collects, and every other test-named file under `tools/` and `src/`.
 * It gets the collected files from the resolved vitest projects, so a new
 * include glob widens the scope with no edit here. It fails on a direct
 * recursive delete. Only `tools/test-helpers/` deletes a tree directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The directories that the guard walks. Every vitest include glob must start inside one. */
const SCANNED_ROOTS: readonly string[] = ['tests', 'tools', 'src'];

/** The `node:fs` functions that can delete a directory tree. */
const DELETE_FUNCTIONS: ReadonlySet<string> = new Set(['rm', 'rmSync', 'rmdir', 'rmdirSync']);

/** The modules whose named imports can rename a delete function. */
const FS_MODULES: ReadonlySet<string> = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/** The source files that the guard parses. */
const SOURCE_FILE = /\.[cm]?[jt]s$/;

/** A test file by its name, whichever runner runs it. */
const TEST_FILE_NAME = /\.test\.[cm]?[jt]s$/;

/**
 * Directories that the walk skips: installed dependencies, and captured eval
 * runs, which are verbatim records of agent output rather than test code.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', 'runs']);

/** The scan reads at least this many files. The scope held 1,309 when this was written. */
const MIN_FILES_SCANNED = 1250;

/** The scan reads at least this many files outside `tests/`. The scope held 66 when this was written. */
const MIN_FILES_OUTSIDE_TESTS = 60;

/** The vitest projects collect at least this many files. They collected 1,239 when this was written. */
const MIN_FILES_COLLECTED = 1200;

/** The vitest projects declare at least this many include globs. They declared 23 when this was written. */
const MIN_INCLUDE_GLOBS = 20;

/**
 * The scan sees at least this many delete calls. The scope held 26 when this
 * was written, and each one deleted one entry. A matcher that sees no delete
 * call also sees no violation.
 */
const MIN_DELETE_CALLS_SEEN = 20;

/** A call to a delete function, with the guard's verdict on it. */
interface DeleteCall {
  /** The 1-based line of the call. */
  readonly line: number;
  /** The called name as written. */
  readonly callee: string;
  /** `recursive`: deletes a tree. `unreadable`: options the guard cannot read. `single`: one entry. */
  readonly verdict: 'recursive' | 'unreadable' | 'single';
}

/** A vitest project as the runner resolved it. */
interface ResolvedProject {
  /** The project name. */
  readonly name: string;
  /** The include globs, relative to the repository root. */
  readonly include: readonly string[];
  /** The files that the project collects, as repository-relative paths. */
  readonly collected: readonly string[];
}

/** What one pass of the guard found in a set of files. */
interface TreeScan {
  /** The files that the guard parsed. */
  readonly scanned: readonly string[];
  /** The delete calls in the parsed files, recursive or not. */
  readonly deleteCalls: number;
  /** The calls that the guard rejects, as `file:line callee (verdict)`. */
  readonly violations: readonly string[];
}

/** The local names that a file's `fs` imports bind to a delete function. */
function renamedDeleteFunctions(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!FS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (DELETE_FUNCTIONS.has((element.propertyName ?? element.name).text)) names.add(element.name.text);
    }
  }
  return names;
}

/** The verdict on a delete call, from its options argument. */
function verdictFor(call: ts.CallExpression): DeleteCall['verdict'] {
  const options = call.arguments[1];
  if (options === undefined || ts.isArrowFunction(options) || ts.isFunctionExpression(options)) return 'single';
  if (!ts.isObjectLiteralExpression(options)) return 'unreadable';
  for (const property of options.properties) {
    if (ts.isSpreadAssignment(property)) return 'unreadable';
    if (property.name === undefined || !ts.isIdentifier(property.name) || property.name.text !== 'recursive') continue;
    if (ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword) return 'single';
    return 'recursive';
  }
  return 'single';
}

/** Every call to a delete function in a source file, with a verdict. */
function scanDeleteCalls(source: string, fileName: string): DeleteCall[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const renamed = renamedDeleteFunctions(sf);
  const calls: DeleteCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name !== undefined && (DELETE_FUNCTIONS.has(name) || renamed.has(name))) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        calls.push({ line, callee: callee.getText(sf), verdict: verdictFor(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/** The calls that the guard rejects, as `file:line callee (verdict)`. */
function rejectedCalls(calls: readonly DeleteCall[], fileName: string): string[] {
  return calls
    .filter((call) => call.verdict !== 'single')
    .map((call) => `${fileName}:${call.line} ${call.callee} (${call.verdict})`);
}

/** The calls in one source that the guard rejects. */
function violationsIn(source: string, fileName: string): string[] {
  return rejectedCalls(scanDeleteCalls(source, fileName), fileName);
}

/** True when the guard parses `file`: test-tree source, a test-named file, or a file that vitest collects. */
function inScope(file: string, collects: (file: string) => boolean): boolean {
  if (!SOURCE_FILE.test(file) || file.split('/').some((segment) => SKIPPED_DIRS.has(segment))) return false;
  return file.startsWith('tests/') || TEST_FILE_NAME.test(file) || collects(file);
}

/** Runs the guard over the in-scope members of `files`, reading each one with `read`. */
function scanTree(
  files: readonly string[],
  read: (file: string) => string,
  collects: (file: string) => boolean,
): TreeScan {
  const scanned = files.filter((file) => inScope(file, collects));
  const violations: string[] = [];
  let deleteCalls = 0;
  for (const file of scanned) {
    const calls = scanDeleteCalls(read(file), file);
    deleteCalls += calls.length;
    violations.push(...rejectedCalls(calls, file));
  }
  return { scanned, deleteCalls, violations };
}

/** A path as the guard names it: relative to the repository root, with `/` separators. */
function repoRelative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

/** Every source file under `dir`, as repository-relative paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...sourceFiles(full));
    } else if (SOURCE_FILE.test(entry.name)) {
      out.push(repoRelative(full));
    }
  }
  return out;
}

/** A seeded source with one violation of each shape, on known lines. */
const SEEDED_VIOLATIONS = [
  "import fs from 'node:fs';",
  "import { rmSync as wipe } from 'node:fs';",
  "fs.rmSync(dir, { recursive: true, force: true });",
  'await fs.promises.rm(',
  '  dir,',
  '  { force: true, recursive: true },',
  ');',
  "wipe(dir, { recursive: true });",
  "fs.rmdirSync(dir, { recursive: true });",
  'fs.rmSync(dir, options);',
  'fs.rmSync(dir, { ...options });',
].join('\n');

/** The guard's report on {@link SEEDED_VIOLATIONS}, without the file name. */
const SEEDED_VERDICTS: readonly string[] = [
  '3 fs.rmSync (recursive)',
  '4 fs.promises.rm (recursive)',
  '8 wipe (recursive)',
  '9 fs.rmdirSync (recursive)',
  '10 fs.rmSync (unreadable)',
  '11 fs.rmSync (unreadable)',
];

/** The clean twin: the helpers, single-entry deletes, and the same text in a string and a comment. */
const CLEAN_TWIN = [
  "import fs from 'node:fs';",
  "import { rmrf, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';",
  'rmrf(dir);',
  'await rmrfAsync(dir);',
  "fs.rmSync(file, { force: true });",
  'fs.rmSync(file);',
  "await fs.promises.rm(dir, { recursive: false });",
  'fs.rm(file, (err) => { void err; });',
  "const text = 'fs.rmSync(dir, { recursive: true })';",
  '/* fs.rmSync(dir, { recursive: true }) */',
].join('\n');

/**
 * A seeded tree under `tools/`. One file is in scope by its name, one only
 * because a project collects it. The others are out of scope or clean.
 */
const SEEDED_TOOLS_TREE: Readonly<Record<string, string>> = {
  'tools/evals/evals/seeded.test.ts': SEEDED_VIOLATIONS,
  'tools/evals/bench/seeded.bench.ts': SEEDED_VIOLATIONS,
  'tools/release/seeded.ts': SEEDED_VIOLATIONS,
  'tools/evals/evals/runs/r1/seeded.test.ts': SEEDED_VIOLATIONS,
  'tools/evals/evals/clean.test.ts': CLEAN_TWIN,
};

let projects: ResolvedProject[] = [];

beforeAll(async () => {
  const vitest = await createVitest('test', { watch: false, root: REPO_ROOT });
  try {
    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles();
      projects.push({
        name: project.name,
        include: [...(project.config.include ?? [])],
        collected: testFiles.map(repoRelative),
      });
    }
  } finally {
    await vitest.close();
  }
}, 120_000);

afterAll(() => {
  projects = [];
});

describe('test-code temp-dir removal guard (#2027)', () => {
  it('TestCode_RecursiveDeletes_GoThroughTheTempDirHelpers', () => {
    const collected = new Set(projects.flatMap((project) => project.collected));
    const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(path.join(REPO_ROOT, root)));
    const result = scanTree(
      files,
      (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
      (file) => collected.has(file),
    );
    const scanned = new Set(result.scanned);

    expect(collected.size, 'the vitest projects collected fewer files than the config holds').toBeGreaterThanOrEqual(
      MIN_FILES_COLLECTED,
    );
    expect(
      [...collected].filter((file) => !scanned.has(file)),
      'files that a vitest project collects but the guard did not parse',
    ).toEqual([]);
    expect(result.scanned.length, 'the scan read fewer files than the scope holds').toBeGreaterThanOrEqual(
      MIN_FILES_SCANNED,
    );
    expect(
      result.scanned.filter((file) => !file.startsWith('tests/')).length,
      'the scan read fewer files outside tests/ than the scope holds',
    ).toBeGreaterThanOrEqual(MIN_FILES_OUTSIDE_TESTS);
    expect(result.deleteCalls, 'the scan saw fewer delete calls than the scope holds').toBeGreaterThanOrEqual(
      MIN_DELETE_CALLS_SEEN,
    );
    expect(
      result.violations,
      'Delete a temp tree with rmrf/rmrfAsync from tools/test-helpers/temp-dir.ts, not with a recursive fs call',
    ).toEqual([]);
  });

  it('VitestIncludeGlobs_EachStartInsideAScannedRoot', () => {
    const globs = projects.flatMap((project) => project.include.map((glob) => `${project.name}: ${glob}`));
    const outside = projects.flatMap((project) =>
      project.include
        .filter((glob) => !SCANNED_ROOTS.some((root) => glob.startsWith(`${root}/`)))
        .map((glob) => `${project.name}: ${glob}`),
    );

    expect(globs.length, 'the vitest projects declared fewer include globs than the config holds').toBeGreaterThanOrEqual(
      MIN_INCLUDE_GLOBS,
    );
    expect(outside, 'include globs that collect files outside the directories the guard walks').toEqual([]);
  });

  it('RecursiveDeleteGuard_SeededViolations_AreEachNamed', () => {
    expect(violationsIn(SEEDED_VIOLATIONS, 'seeded.ts')).toEqual(
      SEEDED_VERDICTS.map((verdict) => `seeded.ts:${verdict}`),
    );
  });

  it('RecursiveDeleteGuard_CleanTwin_IsIgnored', () => {
    const calls = scanDeleteCalls(CLEAN_TWIN, 'clean.ts');
    expect(calls.map((call) => call.callee)).toEqual(['fs.rmSync', 'fs.rmSync', 'fs.promises.rm', 'fs.rm']);
    expect(violationsIn(CLEAN_TWIN, 'clean.ts')).toEqual([]);
  });

  it('RecursiveDeleteGuard_SeededToolsTree_IsScannedByNameAndByCollection', () => {
    const result = scanTree(
      Object.keys(SEEDED_TOOLS_TREE),
      (file) => SEEDED_TOOLS_TREE[file] ?? '',
      (file) => file === 'tools/evals/bench/seeded.bench.ts',
    );

    expect(result.scanned).toEqual([
      'tools/evals/evals/seeded.test.ts',
      'tools/evals/bench/seeded.bench.ts',
      'tools/evals/evals/clean.test.ts',
    ]);
    expect(result.violations).toEqual([
      ...SEEDED_VERDICTS.map((verdict) => `tools/evals/evals/seeded.test.ts:${verdict}`),
      ...SEEDED_VERDICTS.map((verdict) => `tools/evals/bench/seeded.bench.ts:${verdict}`),
    ]);
  });
});
