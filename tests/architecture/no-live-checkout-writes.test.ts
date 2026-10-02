// Test code must not write into the checkout it runs from (#2030). Parallel
// test files read the same tree, so a file one test creates or rewrites for a
// moment is seen by another. A test that must change a tree uses the sandbox
// in `tools/test-helpers/repo-sandbox.ts`.
//
// The guard parses every test file under `tests/` and `tools/`, the setup
// files, and the `tests/` and `tools/test-helpers/` modules they import. It
// names each fs write whose target starts at `__dirname`, `import.meta`,
// `process.cwd()` or a relative path, also through variables and helpers.
// It cannot see writes made by a child process (a build, `git`, `npm`, a
// shell), and it does not enter product code under `src/`. It proves its
// population and that its matcher names seeded writes and passes their twins.

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import vitestConfig from '../../vitest.config.js';
import {
  diskModuleReader,
  scanLiveCheckoutWrites,
  type LiveCheckoutWrite,
  type ModuleReader,
} from '../../tools/test-helpers/live-checkout-writes.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

/** Test-support code the scan enters when a test passes it a path. */
const HELPER_ROOTS = [path.join(REPO_ROOT, 'tests'), path.join(REPO_ROOT, 'tools', 'test-helpers')];

const TEST_FILE = /\.(?:test|type-test|bench)\.[cm]?[jt]s$/;
const SOURCE_FILE = /\.[cm]?[jt]s$/;

/** `runs/` holds captured eval artifacts, which vitest excludes and nothing runs. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'runs', '.git']);

/** A write the guard permits, with the reason. Each one must still match a write. */
interface Allowance {
  readonly file: RegExp;
  readonly matches: (write: LiveCheckoutWrite) => boolean;
  readonly why: string;
}

const ALLOWED_WRITES: readonly Allowance[] = [
  {
    file: /^tests\/integration\/tools-list-golden\.test\.ts$/,
    matches: (write) => write.gate === 'UPDATE_TOOLS_LIST_GOLDEN',
    why: 'Regenerates the committed golden only when a developer sets UPDATE_TOOLS_LIST_GOLDEN=1.',
  },
  {
    file: /^tests\/core\/process\/packaged-proof\.test\.ts$/,
    matches: (write) => write.gate === 'EXARCHOS_WRITE_PACKAGED_BASELINE',
    why: 'Regenerates the committed baseline only when a developer sets EXARCHOS_WRITE_PACKAGED_BASELINE=1.',
  },
  {
    file: /^tests\/core\/process\/[^/]+\.test\.ts$/,
    matches: (write) => write.text.startsWith('ensureBinaryBuilt('),
    why:
      'The compiled-binary tests share one build in the git-ignored dist/bin. A lock serializes the build ' +
      'and an atomic rename publishes it. Moving that cache changes which suites see a binary, so it is a separate decision.',
  },
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_FILE.test(entry.name)) out.push(full);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every setup file a vitest project lists, as an absolute path. */
function setupFiles(): string[] {
  const test: unknown = Reflect.get(vitestConfig, 'test');
  const projects: unknown = isRecord(test) ? test['projects'] : undefined;
  const files = new Set<string>();
  for (const project of Array.isArray(projects) ? projects : []) {
    const block: unknown = isRecord(project) ? project['test'] : undefined;
    const listed: unknown = isRecord(block) ? block['setupFiles'] : undefined;
    for (const file of Array.isArray(listed) ? listed : []) {
      if (typeof file === 'string') files.add(path.resolve(REPO_ROOT, file));
    }
  }
  return [...files];
}

function isHelperPath(file: string): boolean {
  return HELPER_ROOTS.some((root) => file.startsWith(root + path.sep));
}

interface Population {
  readonly testFiles: readonly string[];
  readonly setupFiles: readonly string[];
  readonly modules: readonly string[];
}

/** The test files, the setup files, and every test-support module they import. */
function testCodePopulation(): Population {
  const all: string[] = [];
  walk(path.join(REPO_ROOT, 'tests'), all);
  walk(path.join(REPO_ROOT, 'tools'), all);
  const testFiles = all.filter((file) => TEST_FILE.test(file));
  const setup = setupFiles();
  const seen = new Set<string>([...testFiles, ...setup]);
  const queue = [...seen];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
      const read = diskModuleReader(file, imported.fileName);
      if (read === undefined || seen.has(read.fileName) || !isHelperPath(read.fileName)) continue;
      seen.add(read.fileName);
      queue.push(read.fileName);
    }
  }
  return { testFiles, setupFiles: setup, modules: [...seen].sort() };
}

interface GuardScan {
  readonly population: Population;
  readonly sinkCallCount: number;
  readonly writes: readonly LiveCheckoutWrite[];
}

/**
 * Parsing about 1,300 modules takes seconds, more than the `unit` tier's
 * per-test budget, so the scan runs once in `beforeAll` with its own bound.
 */
const SCAN_TIMEOUT_MS = 120_000;

let cachedScan: GuardScan | undefined;

function scanTestCode(): GuardScan {
  if (cachedScan !== undefined) return cachedScan;
  const population = testCodePopulation();
  let sinkCallCount = 0;
  const writes: LiveCheckoutWrite[] = [];
  for (const file of population.modules) {
    const scan = scanLiveCheckoutWrites(file, readFileSync(file, 'utf8'), { reader: diskModuleReader, helperRoots: HELPER_ROOTS });
    sinkCallCount += scan.sinkCallCount;
    for (const write of scan.writes) writes.push({ ...write, file: path.relative(REPO_ROOT, write.file).split(path.sep).join('/') });
  }
  cachedScan = { population, sinkCallCount, writes };
  return cachedScan;
}

function isAllowed(write: LiveCheckoutWrite): boolean {
  return ALLOWED_WRITES.some((allowance) => allowance.file.test(write.file) && allowance.matches(write));
}

/** Scans inline sources; `files` maps virtual paths to source for relative imports. */
function scanInline(source: readonly string[], files: Readonly<Record<string, string>> = {}): string[] {
  const reader: ModuleReader = (fromFile, specifier) => {
    const fileName = path.posix.join(path.posix.dirname(fromFile), specifier).replace(/\.js$/, '.ts');
    const text = files[fileName];
    return text === undefined ? undefined : { fileName, source: text };
  };
  return scanLiveCheckoutWrites('/virtual/seeded.test.ts', source.join('\n'), { reader }).writes.map(
    (write) => `${write.line}:${write.sink}${write.gate === undefined ? '' : ` [${write.gate}]`}`,
  );
}

const PREAMBLE = [
  "import fs, { writeFileSync, mkdirSync, copyFileSync, mkdtempSync } from 'node:fs';",
  "import os from 'node:os';",
  "import path, { join } from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');",
  "const tmp = mkdtempSync(join(os.tmpdir(), 'seeded-'));",
];

describe('no test writes into the live checkout (#2030)', () => {
  beforeAll(() => {
    scanTestCode();
  }, SCAN_TIMEOUT_MS);

  /** The scan must cover the test tree, or a clean result means nothing. */
  it('NoLiveCheckoutWrites_ScansTheWholeTestPopulation', () => {
    const { population, sinkCallCount } = scanTestCode();
    const sandboxUsers = population.modules.filter((file) =>
      readFileSync(file, 'utf8').includes('test-helpers/repo-sandbox.js'),
    );

    expect(population.testFiles.length).toBeGreaterThanOrEqual(1100);
    expect(population.setupFiles.length).toBeGreaterThanOrEqual(4);
    expect(population.modules.length).toBeGreaterThan(population.testFiles.length);
    expect(sinkCallCount).toBeGreaterThanOrEqual(2500);
    expect(sandboxUsers.length).toBeGreaterThanOrEqual(8);
  });

  /** Every fs write in test code goes to a temp directory or a sandbox, or is a listed allowance. */
  it('NoLiveCheckoutWrites_TestCodeWritesOnlyOutsideTheCheckout', () => {
    const violations = scanTestCode()
      .writes.filter((write) => !isAllowed(write))
      .map((write) => `${write.file}:${write.line} ${write.sink} :: ${write.text}`);

    expect(violations).toEqual([]);
  });

  /** An allowance that no longer matches a write is stale and must be removed. */
  it('NoLiveCheckoutWrites_EveryAllowanceStillMatchesAWrite', () => {
    const { writes } = scanTestCode();
    const stale = ALLOWED_WRITES.filter(
      (allowance) => !writes.some((write) => allowance.file.test(write.file) && allowance.matches(write)),
    ).map((allowance) => allowance.why);

    expect(stale).toEqual([]);
  });

  /** Each seeded line writes into the checkout by one route the scan follows. */
  it('NoLiveCheckoutWrites_Matcher_NamesSeededWrites', () => {
    const seeded = [
      ...PREAMBLE,
      "writeFileSync(path.join(__dirname, 'probe.txt'), 'x');",
      "fs.rmSync(path.join(ROOT, 'src', 'probe.ts'), { force: true });",
      "mkdirSync('dist/bin', { recursive: true });",
      "const targets = ['a.ts'].map((p) => ({ abs: join(ROOT, p) }));",
      "for (const t of targets) writeFileSync(t.abs, '');",
      "function plant(root: string): void { writeFileSync(join(root, 'x'), ''); }",
      'plant(process.cwd());',
      "copyFileSync(join(tmp, 'a'), join(ROOT, 'b'));",
      "if (process.env.UPDATE_SEEDED_GOLDEN === '1') writeFileSync(join(ROOT, 'golden.json'), '');",
      "async function main(): Promise<void> { writeFileSync(join(ROOT, 'report.md'), ''); }",
      'main();',
    ];

    expect(scanInline(seeded)).toEqual([
      '7:writeFileSync',
      '8:rmSync',
      '9:mkdirSync',
      '11:writeFileSync',
      '12:writeFileSync',
      '14:copyFileSync',
      '15:writeFileSync [UPDATE_SEEDED_GOLDEN]',
      '16:writeFileSync',
    ]);
  });

  /** The same shapes over a temp root, a copy out of the checkout, a read, and a guarded script `main`. */
  it('NoLiveCheckoutWrites_Matcher_PassesCleanTwins', () => {
    const clean = [
      ...PREAMBLE,
      "writeFileSync(path.join(os.tmpdir(), 'probe.txt'), 'x');",
      "fs.rmSync(path.join(tmp, 'src', 'probe.ts'), { force: true });",
      "mkdirSync(join(tmp, 'dist/bin'), { recursive: true });",
      "const targets = ['a.ts'].map((p) => ({ abs: join(tmp, p) }));",
      "for (const t of targets) writeFileSync(t.abs, '');",
      "function plant(root: string): void { writeFileSync(join(root, 'x'), ''); }",
      'plant(tmp);',
      "copyFileSync(join(ROOT, 'b'), join(tmp, 'a'));",
      "fs.readFileSync(join(ROOT, 'package.json'), 'utf8');",
      "async function main(): Promise<void> { writeFileSync(join(ROOT, 'report.md'), ''); }",
      "if (process.argv[1] === fileURLToPath(import.meta.url)) main();",
    ];

    expect(scanInline(clean)).toEqual([]);
  });

  /** A write inside an imported test helper is named at the call that hands it a checkout path. */
  it('NoLiveCheckoutWrites_Matcher_FollowsAnImportedHelper', () => {
    const helper = [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "export function plant(root: string): void { writeFileSync(join(root, 'probe.ts'), ''); }",
    ].join('\n');
    const files = { '/virtual/helper.ts': helper };

    expect(scanInline([...PREAMBLE, "import { plant } from './helper.js';", 'plant(ROOT);'], files)).toEqual([
      '8:helper writes: writeFileSync in helper.ts:3',
    ]);
    expect(scanInline([...PREAMBLE, "import { plant } from './helper.js';", 'plant(tmp);'], files)).toEqual([]);
  });
});
