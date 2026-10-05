/**
 * Shared helpers for the gate tests in `tests/scripts/`. A gate test spawns its
 * `.mjs` script as a child process and can build a temporary fixture source tree.
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

/** Runs a gate `.mjs` script with Node from `repoRoot` and returns its exit status, stdout, and stderr. */
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

/** Writes `files` into a new temporary directory that starts with `prefix`. The caller must call `cleanup`. */
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
 * Returns each command line in `tools/audit/gates/validate-manifest.json`, one per line.
 * A gate test uses one `toContain` to check that it is a step of `npm run validate`.
 * The `validate` script only starts the runner, so it cannot show which gates run.
 *
 * @throws When the manifest declares no steps. An empty result lets a `not.toContain`
 * check pass for every gate.
 */
export function validateManifestCommands(repoRoot: string): string {
  const manifestPath = path.join(repoRoot, 'tools', 'audit', 'gates', 'validate-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    steps?: { command?: string; args?: string[] }[];
  };
  const steps = manifest.steps ?? [];
  if (steps.length === 0) {
    throw new Error(
      'tools/audit/gates/validate-manifest.json declares 0 steps — refusing to answer ' +
        '"is this gate wired into validate?" from an empty denominator (task 064, DR-24)',
    );
  }
  return steps.map((s) => [s.command ?? '', ...(s.args ?? [])].join(' ')).join('\n');
}
