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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Every command line declared by `scripts/validate-manifest.json`, newline
 * joined so a gate's `Validate_ChainedIntoNpmValidate` case can ask "am I a
 * declared step of `npm run validate`?" with one `toContain`.
 *
 * It used to ask that of `pkg.scripts.validate`, which was an inline `&&`
 * chain. Task 064 (DR-24) replaced the chain with an aggregating runner because
 * a red early step made every later gate skipped-as-passed — measured
 * 2026-08-07, 1 of 9 declared steps executed. The steps moved to data, so the
 * question has to be put to the data; a substring check on the npm script now
 * only proves the runner is invoked, not which gates it reaches.
 *
 * THROWS on an empty manifest rather than returning `''`. A gate asking "am I
 * wired?" of a manifest that declares nothing would get a clean `not.toContain`
 * either way, and a silent empty denominator is the exact defect task 064 exists
 * to remove.
 */
export function validateManifestCommands(repoRoot: string): string {
  const manifestPath = path.join(repoRoot, 'scripts', 'validate-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    steps?: { command?: string; args?: string[] }[];
  };
  const steps = manifest.steps ?? [];
  if (steps.length === 0) {
    throw new Error(
      'scripts/validate-manifest.json declares 0 steps — refusing to answer ' +
        '"is this gate wired into validate?" from an empty denominator (task 064, DR-24)',
    );
  }
  return steps.map((s) => [s.command ?? '', ...(s.args ?? [])].join(' ')).join('\n');
}
