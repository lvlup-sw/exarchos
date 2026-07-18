#!/usr/bin/env node
/**
 * Windows-portability anti-pattern CI gate (#1623, follow-up to #1620).
 *
 * The blocking `windows-latest` job (#1620) catches Windows breakage, but only
 * after an ~8-minute run. This gate fires in seconds and flags the four
 * known, high-signal regressions at PR time:
 *
 *   1. **Shell-shim spawn** — `execFile(Sync)('npm'|'npx'|'pnpm'|'yarn', …)`
 *      with a bare package-manager name. `execFile` spawns without a shell, so
 *      a `.cmd` shim won't launch on Windows. Route through `runCommandSync`
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
 *   4. **Dynamic-bin spawn** — `execFile(Sync)`/`spawn(Sync)` with a RESOLVED
 *      command *variable* (not a string literal). A literal `'git'` is a real
 *      `.exe`; a variable bin can resolve to a `npm`/`npx` `.cmd` shim that raw
 *      execFile/spawn can't launch on Windows (CVE-2024-27980). Route through
 *      `runCommandSync`/`spawnCommandSync`. The literal-name rule (1) can't see
 *      a variable bin — this is the hole that shipped the test-adequacy
 *      false-red kill probe. Production files only; the spawn helper is exempt.
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
  // Block comments first.
  const noBlock = content.replace(/\/\*[\s\S]*?\*\//g, blank);
  // Line comments, string-aware: a `//` inside a '', "", or `` literal is not a
  // comment, so it must not blank the rest of the line (CodeRabbit #1624).
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
// 4 — dynamic-bin spawn: execFile/spawn whose first arg is a RESOLVED command
// variable (an identifier, not a string literal). A literal `'git'` is a real
// `.exe` and launches fine; but a variable bin can resolve to a `npm`/`npx`/…
// `.cmd` shim that raw execFile/spawn can't launch on Windows since
// CVE-2024-27980 — it must route through runCommandSync/spawnCommandSync. The
// literal-name SPAWN_RE above cannot see a variable bin: that blind spot is
// what shipped the test-adequacy false-red kill probe (#1623).
const DYNAMIC_SPAWN_RE = /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*[A-Za-z_$][\w$.]*/g;
// The shell-aware spawn helpers legitimately call raw execFile/spawn with a
// variable bin — that is their whole job. Exempt only this file.
const SPAWN_HELPER_RE = /utils[/\\]process\.ts$/;
// CI/build tooling under a `scripts/` dir is NOT shipped runtime — it runs
// only on the ubuntu CI host, and the audit gates that shell out a tool
// (knip-diff / cycle-gate → `node_modules/.bin/*`) DEGRADE-TO-FAIL-CLOSED on a
// spawn error (incl. win32, where Node can't exec a `.cmd`/`.ps1` shim
// directly): a spawn failure returns `found:false` → the gate fails closed
// rather than mis-running. So the dynamic-bin rule (rule 4), whose own scope
// is "Production files only", does not apply to these. Rule 2 (url-pathname)
// is a genuine cross-platform path bug and STILL applies to tooling.
// Scoped to the KNOWN CI-tooling roots ONLY — repo-root `scripts/` and
// `servers/<name>/scripts/` (e.g. the DR-7 stryker-adapter, CI-only/Linux-only
// per DR-7). A blanket "`scripts/` at any depth" match would also exempt a
// SHIPPED runtime path such as `src/scripts/` or
// `servers/*/src/scripts/`, letting a production dynamic-bin spawn bypass rule
// 4 on directory name alone. Paths here are `path.relative(REPO_ROOT, file)`;
// out-of-repo self-test fixtures carry a `../` prefix, so the `servers/…`
// alternative uses a `(?:^|[/\\])` boundary rather than a hard `^` anchor.
const CI_TOOLING_RE = /^scripts[/\\]|(?:^|[/\\])servers[/\\][^/\\]+[/\\]scripts[/\\]/;

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
    // Benchmarks are dev-only tooling, never the shipped runtime path; like
    // tests they may spawn a bin (the running `node` via process.execPath) the
    // shipped code wouldn't, so they're exempt from the dynamic-spawn rule.
    const isBench = /\.bench\.ts$/.test(file);
    // CI/build tooling under scripts/ is exempt from the dynamic-spawn rule for
    // the same reason as benches (dev/CI-only, fail-closed on spawn error).
    const isCiTooling = CI_TOOLING_RE.test(path.relative(REPO_ROOT, file));

    // 2 — non-portable module path (anywhere)
    for (const m of src.matchAll(URL_PATHNAME_RE)) {
      record(file, raw, m.index, 'url-pathname: use fileURLToPath(import.meta.url)');
    }

    if (!isTest) {
      // 1 — shell-shim spawn (production only; tests may exercise the raw form)
      for (const m of src.matchAll(SPAWN_RE)) {
        record(file, raw, m.index, 'spawn-shim: route npm/npx via runCommandSync');
      }
      // 4 — dynamic-bin spawn (production only; the spawn helper + benches +
      // fail-closed CI tooling under scripts/ exempt)
      if (!SPAWN_HELPER_RE.test(file) && !isBench && !isCiTooling) {
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
