/**
 * Shared helpers for the `scripts/check-*.test.ts` CI-gate test suites.
 *
 * Every gate test spawns its `.mjs` script as a child process and, for the
 * clean/violation cases, builds a throwaway fixture source tree. These two
 * helpers were duplicated verbatim across each gate test — only the tmpdir
 * prefix differed — so they live here as the single source of truth (CodeRabbit
 * #1563). Each test keeps a 3-line local wrapper that binds its own `SCRIPT` /
 * `REPO_ROOT` / prefix, so call sites stay unchanged.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface RunScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn a gate `.mjs` script under Node from `repoRoot` and capture its exit
 * status plus stdout/stderr.
 */
export function runScriptCheck(
  scriptPath: string,
  repoRoot: string,
  extraArgs: string[] = [],
): RunScriptResult {
  const result = spawnSync('node', [scriptPath, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export interface FixtureSrc {
  srcRoot: string;
  cleanup: () => void;
}

/**
 * Build a throwaway fixture src tree under a uniquely-named temp dir. `prefix`
 * namespaces the temp dir per gate; the caller invokes the returned `cleanup`.
 */
export function makeFixtureSrc(prefix: string, files: Record<string, string>): FixtureSrc {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }
  return { srcRoot: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
