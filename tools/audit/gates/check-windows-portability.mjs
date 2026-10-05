#!/usr/bin/env node
/**
 * Windows-portability anti-pattern CI gate. The `windows-latest` job takes about
 * 8 minutes. This gate runs in seconds and flags four known regressions:
 *
 *   1. Shell-shim spawn: a raw `execFile` or `spawn` call with a bare shim name as a literal.
 *   2. Non-portable module path: `new URL(import.meta.url).pathname`, which gives `/D:/…` on Windows.
 *      Use `fileURLToPath`.
 *   3. Leaked SQLite handle: a test that uses an `EventStore` and a recursive `rm` with no safe teardown.
 *   4. Dynamic-bin spawn: a raw `execFile` or `spawn` call with a variable command.
 *
 * To correct a rule 1 or rule 4 hit, use `runCommandSync` or `spawnCommandSync` in `src/utils/process.ts`.
 * The default scan root is the repo root.
 *
 * Exit 0: clean. Exit 1: violations, as `path:line  excerpt` on stderr. Exit 2: usage or environment error.
 * Flags: `--src-root <path>` (repeatable, replaces the default), `--spawn-helper <path>`
 * (self-test only), `--help`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_ROOTS = [REPO_ROOT];

/**
 * Parses the flags. An unknown token is an error, because a fallback to
 * `DEFAULT_ROOTS` reports on a tree that the caller did not ask about.
 */
function parseArgs(argv) {
  const roots = [];
  let spawnHelper = DEFAULT_SPAWN_HELPER;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    if (argv[i] === '--src-root') {
      const value = argv[++i];
      if (!value) return { error: '--src-root requires a path' };
      roots.push(path.resolve(value));
    } else if (argv[i] === '--spawn-helper') {
      const value = argv[++i];
      if (!value) return { error: '--spawn-helper requires a path' };
      spawnHelper = path.resolve(value);
    } else {
      return {
        error:
          `unrecognised argument '${argv[i]}'. Known: --src-root <path>, ` +
          '--spawn-helper <path>, --help.',
      };
    }
  }
  return { roots: roots.length > 0 ? roots : DEFAULT_ROOTS, spawnHelper };
}

/**
 * The spawn helper that owns `WINDOWS_CMD_SHIMS`, the command names that ship as
 * `.cmd` shims on Windows. The helper is TypeScript and this gate is a
 * zero-dependency `.mjs`, so the gate reads the names from the source text.
 * An unreadable or empty set exits 2.
 */
const DEFAULT_SPAWN_HELPER = path.join(REPO_ROOT, 'src', 'utils', 'process.ts');

/** Reads the names in the `WINDOWS_CMD_SHIMS` set of `helperPath`. A comment inside the set gives no name. */
function readShimNames(helperPath) {
  let source;
  try {
    source = readFileSync(helperPath, 'utf8');
  } catch {
    return { error: `cannot read the spawn helper: ${helperPath}` };
  }
  const block = /const\s+WINDOWS_CMD_SHIMS\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
  if (!block) {
    return {
      error:
        `WINDOWS_CMD_SHIMS not found in ${helperPath}; ` +
        'the shim vocabulary must be derived from the helper that owns it.',
    };
  }
  const body = stripComments(block[1]);
  const names = [...body.matchAll(/['"]([A-Za-z0-9_.-]+)['"]/g)].map((m) => m[1]);
  if (names.length === 0) {
    return { error: 'WINDOWS_CMD_SHIMS is empty; refusing to police an empty vocabulary.' };
  }
  return { names };
}

/**
 * Replaces comments with blanks of the same length. A prose mention then cannot
 * trip the gate, and offsets still map to the right line. Block comments go first.
 * A `//` inside a quoted literal is not a comment.
 */
function stripComments(content) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//g, blank);
  return noBlock
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') {
          quote = c;
        } else if (c === '/' && line[i + 1] === '/') {
          return line.slice(0, i) + ' '.repeat(line.length - i);
        }
      }
      return line;
    })
    .join('\n');
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Yields each `.ts`, `.mts` and `.mjs` file under `dir`. It skips `node_modules`, `dist` and
 * each name that starts with a dot. It never skips a source subtree by its name.
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|mts|mjs)$/.test(e.name)) {
      yield full;
    }
  }
}

/**
 * Walks each scan root and tags each file with its root, which `ciToolingRel` needs.
 * Each file yields one time, so nested or repeated roots cannot double-report.
 */
function* walkRoots(roots) {
  const seen = new Set();
  for (const root of roots) {
    for (const file of walk(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      yield { root, file };
    }
  }
}

/**
 * Rule 1: a bare shim name spawned without a shell. `spawn` and `spawnSync` bypass
 * the shell as `execFile` does, so the rule matches all four calls. The match
 * ignores case, because Windows resolves `NPM` to `npm.cmd` too.
 */
function buildSpawnRe(shimNames) {
  const alternatives = shimNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `\\b(?:execFile|execFileSync|spawn|spawnSync)\\s*\\(\\s*['"\`](?:${alternatives})['"\`]`,
    'gi',
  );
}
const URL_PATHNAME_RE = /new\s+URL\s*\(\s*import\.meta\.url\s*\)\s*\.pathname/g;
const RECURSIVE_RM_RE = /\b(?:fs\.|fsp\.|fsPromises\.)?rm(?:Sync)?\s*\([^;]{0,160}recursive/g;
/**
 * Rule 4: a raw `execFile` or `spawn` call whose first argument is an identifier.
 * A variable bin can resolve to an `npm` or `npx` `.cmd` shim, which a raw call
 * cannot launch on Windows since CVE-2024-27980. Rule 1 cannot see a variable bin.
 * `process.execPath` is exempt. It is the absolute path of the running Node
 * executable, so it never resolves to a shim.
 */
const DYNAMIC_SPAWN_RE =
  /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*(?!process\.execPath\b)[A-Za-z_$][\w$.]*/g;
/** The two spawn helpers call a raw `execFile` or `spawn` with a variable bin by design, so only they are exempt. */
const SPAWN_HELPER_RE = /(?:utils[/\\]process|test-helpers[/\\]spawn)\.ts$/;
/**
 * CI tooling roots, which rules 1 and 4 skip. The tooling runs on the CI host, and
 * its gates fail closed on a spawn error. Rule 2 still applies to them. The `^`
 * anchor stops a shipped path from a match by directory name alone. The tested
 * string is `ciToolingRel`.
 */
const CI_TOOLING_RE =
  /^(?:scripts[/\\]|tools[/\\]audit[/\\]|servers[/\\][^/\\]+[/\\]scripts[/\\])/;
/** Harness files under `tests/` are not shipped runtime. They are not `*.test.ts` files, so rule 4 skips them by this path. */
const UNDER_TESTS_RE = /^tests[/\\]/;

/**
 * Runs the rules over each scan root and prints the violations.
 * Rule 2 applies to each file. Rule 1 skips test files and CI tooling. Rule 4 also
 * skips the spawn helper, benches and the `tests/` tree. Rule 3 applies to test files only.
 *
 * `ciToolingRel` is the repo-relative path. A self-test fixture root is outside the repo,
 * so its files use the root-relative path. A file is outside the repo only when the
 * relative path is `..`, starts with a `..` segment, or is absolute. A first segment
 * inside the repo can start with dots, so a bare `startsWith('..')` test is wrong.
 *
 * Rule 3 flags a recursive `rm` in a test that constructs an `EventStore` and calls a
 * store method, because the handle opens lazily. `rmrf`, `.close()` or `maxRetries` is safe.
 */
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: check-windows-portability.mjs [--src-root <path>]... [--spawn-helper <path>]\n',
    );
    return 0;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n`);
    return 2;
  }
  for (const root of args.roots) {
    let rootStat;
    try {
      rootStat = statSync(root);
    } catch {
      process.stderr.write(`error: root not found: ${root}\n`);
      return 2;
    }
    if (!rootStat.isDirectory()) {
      process.stderr.write(`error: root is not a directory: ${root}\n`);
      return 2;
    }
  }
  const shims = readShimNames(args.spawnHelper);
  if (shims.error) {
    process.stderr.write(`error: ${shims.error}\n`);
    return 2;
  }
  const SPAWN_RE = buildSpawnRe(shims.names);

  const violations = [];
  const record = (file, content, index, why) => {
    const rel = path.relative(REPO_ROOT, file);
    const line = lineOf(content, index);
    const excerpt = content.split('\n')[line - 1]?.trim().slice(0, 120) ?? '';
    violations.push(`${rel}:${line}  [${why}]  ${excerpt}`);
  };

  for (const { root, file } of walkRoots(args.roots)) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const isTest = /\.test\.ts$/.test(file);
    const isBench = /\.bench\.ts$/.test(file);
    const repoRootRel = path.relative(REPO_ROOT, file);
    const outsideRepo =
      repoRootRel === '..' ||
      repoRootRel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(repoRootRel);
    const ciToolingRel = outsideRepo ? path.relative(root, file) : repoRootRel;
    const isCiTooling = CI_TOOLING_RE.test(ciToolingRel);
    const isUnderTests = UNDER_TESTS_RE.test(ciToolingRel);

    for (const m of src.matchAll(URL_PATHNAME_RE)) {
      record(file, raw, m.index, 'url-pathname: use fileURLToPath(import.meta.url)');
    }

    if (!isTest) {
      if (!isCiTooling) {
        for (const m of src.matchAll(SPAWN_RE)) {
          record(
            file,
            raw,
            m.index,
            'spawn-shim: route the shim via runCommandSync/spawnCommandSync',
          );
        }
      }
      if (!SPAWN_HELPER_RE.test(file) && !isBench && !isCiTooling && !isUnderTests) {
        for (const m of src.matchAll(DYNAMIC_SPAWN_RE)) {
          record(
            file,
            raw,
            m.index,
            'dynamic-spawn: a resolved command bin must route through runCommandSync/spawnCommandSync',
          );
        }
      }
    } else {
      const exercisesStore =
        /\bnew\s+EventStore\s*\(/.test(src) &&
        /\.(?:append|appendValidated|batchAppend|query|queryByType|getReadBackend|ensureSqliteBackend)\s*\(/.test(
          src,
        );
      const safe =
        /\brmrf(?:Async)?\b/.test(src) ||
        /\.close\s*\(/.test(src) ||
        /\bmaxRetries\b/.test(src);
      if (exercisesStore && !safe) {
        for (const m of src.matchAll(RECURSIVE_RM_RE)) {
          record(
            file,
            raw,
            m.index,
            'handle-leak: close the store or use rmrf/rmrfAsync (or maxRetries) before rm',
          );
        }
      }
    }
  }

  if (violations.length > 0) {
    process.stderr.write(
      `Windows-portability gate: ${violations.length} violation(s):\n` +
        violations.map((v) => `  ${v}`).join('\n') +
        '\n',
    );
    return 1;
  }
  process.stdout.write('Windows-portability gate: clean.\n');
  return 0;
}

process.exit(main());
