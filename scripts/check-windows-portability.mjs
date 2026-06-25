#!/usr/bin/env node
/**
 * Windows-portability anti-pattern CI gate (#1623, follow-up to #1620).
 *
 * The blocking `windows-latest` job (#1620) catches Windows breakage, but only
 * after an ~8-minute run. This gate fires in seconds and flags the three
 * known, high-signal regressions at PR time:
 *
 *   1. **Shell-shim spawn** — `execFile(Sync)('npm'|'npx'|'pnpm'|'yarn', …)`
 *      with a bare package-manager name. `execFile` spawns without a shell, so
 *      a `.cmd` shim won't launch on Windows. Route through `resolveExecutable`
 *      (src/utils/process.ts).
 *   2. **Non-portable module path** — `new URL(import.meta.url).pathname`, which
 *      yields `/D:/…` on Windows and doubles to `D:\D:\…` under `path.resolve`.
 *      Use `fileURLToPath(import.meta.url)`.
 *   3. **Leaked SQLite handle in test teardown** — a `*.test.ts` that constructs
 *      `new EventStore(` and removes a temp dir with a recursive `rm`/`rmSync`,
 *      but neither imports the Windows-safe `rmrf`/`rmrfAsync` helper nor closes
 *      the store (`.close()`). On NTFS the open `exarchos.db` handle blocks the
 *      unlink (EPERM/EBUSY). Use `rmrf`/`rmrfAsync`, or `eventStore.close()`
 *      before removing.
 *
 *   Exit 0 — clean.  Exit 1 — violations (`path:line  excerpt` on stderr).
 *   Exit 2 — usage / environment error.
 *
 * Flags:
 *   --src-root <path>   Root to walk (default: repo `servers/exarchos-mcp`).
 *   --help              Show usage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_ROOT = path.join(REPO_ROOT, 'servers', 'exarchos-mcp');

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return { help: true };
    if (argv[i] === '--src-root') {
      root = path.resolve(argv[++i] ?? '');
      if (!argv[i]) return { error: '--src-root requires a path' };
    }
  }
  return { root };
}

// Replace comments with same-length blanks (newlines preserved) so a prose
// mention in a docstring cannot trip the gate, while offsets still map to the
// correct source line.
function stripComments(content) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return content
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|mts|mjs)$/.test(e.name)) {
      yield full;
    }
  }
}

const SPAWN_RE = /\bexecFile(?:Sync)?\s*\(\s*['"](?:npm|npx|pnpm|yarn|corepack)['"]/g;
const URL_PATHNAME_RE = /new\s+URL\s*\(\s*import\.meta\.url\s*\)\s*\.pathname/g;
const RECURSIVE_RM_RE = /\b(?:fs\.|fsp\.|fsPromises\.)?rm(?:Sync)?\s*\([^;]{0,160}recursive/g;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: check-windows-portability.mjs [--src-root <path>]\n');
    return 0;
  }
  if (args.error) {
    process.stderr.write(`error: ${args.error}\n`);
    return 2;
  }
  let rootStat;
  try {
    rootStat = statSync(args.root);
  } catch {
    process.stderr.write(`error: root not found: ${args.root}\n`);
    return 2;
  }
  if (!rootStat.isDirectory()) {
    process.stderr.write(`error: root is not a directory: ${args.root}\n`);
    return 2;
  }

  const violations = [];
  const record = (file, content, index, why) => {
    const rel = path.relative(REPO_ROOT, file);
    const line = lineOf(content, index);
    const excerpt = content.split('\n')[line - 1]?.trim().slice(0, 120) ?? '';
    violations.push(`${rel}:${line}  [${why}]  ${excerpt}`);
  };

  for (const file of walk(args.root)) {
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    const isTest = /\.test\.ts$/.test(file);

    // 2 — non-portable module path (anywhere)
    for (const m of src.matchAll(URL_PATHNAME_RE)) {
      record(file, raw, m.index, 'url-pathname: use fileURLToPath(import.meta.url)');
    }

    if (!isTest) {
      // 1 — shell-shim spawn (production only; tests may exercise the raw form)
      for (const m of src.matchAll(SPAWN_RE)) {
        record(file, raw, m.index, 'spawn-shim: route npm/npx via resolveExecutable');
      }
    } else {
      // 3 — leaked SQLite handle in test teardown.
      //
      // `new EventStore(dir)` is lazy — the `exarchos.db` handle only opens on
      // the first append/query/read. So flag only files that BOTH construct AND
      // *exercise* the store (otherwise no handle, no leak). A teardown is
      // considered safe if it uses the Windows-safe helper (`rmrf`/`rmrfAsync`),
      // closes the store (`.close()`), or rides out the lock with retries
      // (`maxRetries`) — any of which the green windows-latest run accepts.
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
