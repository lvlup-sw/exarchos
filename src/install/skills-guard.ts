/**
 * The CI `skills:guard` check. It finds drift between the `content/` sources and the committed generated trees under `rendered/`.
 * It runs the generators again, then runs `git diff --exit-code` on each tree.
 * A diff means that a source changed without a rebuild, or that someone edited a generated file by hand.
 * The failure message names the command that regenerates the tree.
 * `runSkillsGuard()` takes the project root, so tests can give it a temporary root.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllSkills } from './build-skills.js';
import { emitCommandAliases } from './build-command-aliases.js';
import { emitAuthoredArtifacts } from './build-authored-artifacts.js';
import { resolveMainDeps, type MainDeps } from './cli-helpers.js';

/**
 * Outcome of a guard run. `ok` is false when a build failed or a `git diff` found drift.
 * `message` is safe for CI logs. A failure message holds the remediation command and, when available, the diff.
 */
export interface SkillsGuardResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

/**
 * Guard options. Tests inject `regenerateAgents`, because the agents generator `src/runtime/agents/generate-agents.ts` is outside the `rootDir` of this package.
 * Production runs that entry point under tsx in a child process, as `npm run generate:agents` does.
 * A test writer is synchronous, so the sandbox does not load the full adapter registry.
 */
export interface SkillsGuardOptions {
  cwd: string;
  regenerateAgents?: (cwd: string) => void;
}

/** Remediation for the skills tree. Tests assert that the returned message holds this command. */
const REMEDIATION =
  "Generated skills are stale. Run 'npm run build:skills' and commit the result.";

/** Remediation for the agents trees. The agents generator is separate from the skills renderer, so the remediation is a separate command. */
const REMEDIATION_AGENTS =
  "Generated agents are stale. Run 'npm run generate:agents' and commit the result.";

/**
 * Remediation for the `command-aliases/` tree. `npm run build:skills` also emits the alias tree, so the fix is the same as for skills.
 * Only the text differs, so the failure names the alias tree.
 */
const REMEDIATION_ALIASES =
  "Generated command aliases are stale. Run 'npm run build:skills' and commit the result.";

/**
 * Remediation for the flat `commands/` and `rules/` trees. Their sources are under `content/<domain>/`.
 * The next build discards a direct edit to a flat tree, and the guard makes that discard a failure.
 */
const REMEDIATION_AUTHORED =
  "Generated commands/ or rules/ are stale, or were edited directly instead of " +
  "under content/<domain>/. Run 'npm run build:skills' and commit the result.";

/**
 * Locate the JS entry point of the `tsx` CLI under `cwd`.
 * `npx` is a `.cmd` shim and `node_modules/.bin/tsx` is a shebang script. Since CVE-2024-27980, `execFile` launches neither on Windows without a shell.
 * Thus the caller runs the `.mjs` under `process.execPath`, as `tools/audit/gates/check-prose-lint.mjs` does.
 */
function resolveTsxCli(cwd: string): string | undefined {
  const candidate = join(cwd, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Default regenerator. It runs `src/runtime/agents/generate-agents.ts` under tsx with `cwd` as the output root, as `npm run generate:agents` does.
 * It throws on a subprocess failure. It also throws when tsx is missing, because a fallback to bare `npx` breaks on Windows.
 * The guard wraps the error into a `SkillsGuardResult`.
 */
function defaultRegenerateAgents(cwd: string): void {
  const scriptPath = join(cwd, 'src', 'runtime', 'agents', 'generate-agents.ts');
  const tsxCli = resolveTsxCli(cwd);
  if (tsxCli === undefined) {
    throw new Error(
      `skills-guard: could not find the tsx CLI under ${cwd}. ` +
        "Run 'npm install' so 'node_modules/tsx/dist/cli.mjs' is present.",
    );
  }
  execFileSync(process.execPath, [tsxCli, scriptPath, cwd], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Regenerate each tree under `rendered/` and diff it against HEAD. An old tree always matches HEAD, so each tree regenerates before its diff.
 * The guard collects all failures. It skips the diff of a tree when the build of that tree failed. It does not call `process.exit`.
 * The authored `commands/` tree regenerates before the aliases, because the alias emitter reads it.
 *
 * The skills diff excludes `rendered/skills/standard/` from the residual check, so a drift in the standard tree reports once.
 * The agent pathspecs follow the `agentFilePath()` prefix of each adapter. Add the directory of a new adapter here.
 * The builds must be deterministic. The `SkillsGuard_AfterCallMacroRender_NoDrift` test locks the CALL-macro render.
 *
 * @param opts.cwd - Absolute path to the project root, with `content/`, `content/harness/runtimes/`, and a git repo.
 */
export function runSkillsGuard(opts: SkillsGuardOptions): SkillsGuardResult {
  const { cwd } = opts;
  const regenerateAgents = opts.regenerateAgents ?? defaultRegenerateAgents;

  const failures: string[] = [];

  let skillsBuildFailed = false;
  try {
    buildAllSkills({
      srcDir: join(cwd, 'content'),
      outDir: join(cwd, 'rendered', 'skills'),
      runtimesDir: join(cwd, 'content/harness/runtimes'),
    });
  } catch (err) {
    skillsBuildFailed = true;
    const detail = err instanceof Error ? err.message : String(err);
    failures.push(`[skills:guard] build failed: ${detail}\n${REMEDIATION}`);
  }

  if (!skillsBuildFailed) {
    const standardDiff = checkGitDiff(
      cwd,
      'rendered/skills/standard/',
      REMEDIATION,
      'rendered/skills/standard',
    );
    if (standardDiff !== null) failures.push(standardDiff);

    const residualDiff = checkGitDiff(
      cwd,
      ['rendered/skills/', ':(exclude)rendered/skills/standard/'],
      REMEDIATION,
      'skills (orchestration residual)',
    );
    if (residualDiff !== null) failures.push(residualDiff);
  }

  let authoredBuildFailed = false;
  try {
    emitAuthoredArtifacts({
      contentDir: join(cwd, 'content'),
      outRoot: join(cwd, 'rendered'),
    });
  } catch (err) {
    authoredBuildFailed = true;
    const detail = err instanceof Error ? err.message : String(err);
    failures.push(
      `[skills:guard] authored-artifact emission failed: ${detail}\n${REMEDIATION_AUTHORED}`,
    );
  }

  if (!authoredBuildFailed) {
    for (const tree of ['rendered/commands', 'rendered/rules']) {
      const diff = checkGitDiff(cwd, `${tree}/`, REMEDIATION_AUTHORED, tree);
      if (diff !== null) failures.push(diff);
    }
  }

  let aliasesBuildFailed = false;
  try {
    emitCommandAliases({
      runtimesDir: join(cwd, 'content/harness/runtimes'),
      commandsDir: join(cwd, 'rendered', 'commands'),
      outDir: join(cwd, 'rendered', 'command-aliases'),
    });
  } catch (err) {
    aliasesBuildFailed = true;
    const detail = err instanceof Error ? err.message : String(err);
    failures.push(
      `[skills:guard] command-alias emission failed: ${detail}\n${REMEDIATION_ALIASES}`,
    );
  }

  if (!aliasesBuildFailed) {
    const aliasesDiff = checkGitDiff(
      cwd,
      'rendered/command-aliases/',
      REMEDIATION_ALIASES,
      'command-aliases',
    );
    if (aliasesDiff !== null) failures.push(aliasesDiff);
  }

  let agentsBuildFailed = false;
  try {
    regenerateAgents(cwd);
  } catch (err) {
    agentsBuildFailed = true;
    const detail =
      getExecErrorStderr(err) ||
      (err instanceof Error ? err.message : String(err));
    failures.push(
      `[skills:guard] generate-agents failed: ${detail}\n${REMEDIATION_AGENTS}`,
    );
  }

  if (!agentsBuildFailed) {
    const agentsDiff = checkGitDiff(
      cwd,
      [
        'rendered/agents/',
        '.codex/agents/',
        '.cursor/agents/',
        '.opencode/agents/',
        '.github/agents/',
      ],
      REMEDIATION_AGENTS,
      'agents',
    );
    if (agentsDiff !== null) failures.push(agentsDiff);
  }

  if (failures.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      message: failures.join('\n\n'),
    };
  }

  return {
    ok: true,
    exitCode: 0,
    message:
      '[skills:guard] skills/, command-aliases/ and agents/ are in sync with sources',
  };
}

/**
 * Run `git diff --exit-code -- <pathspec>` in `cwd`. Return `null` for exit 0, and a drift message for exit 1.
 * Any other exit, such as 128 outside a git repo, gives an environment-error message with all the output.
 * `label` names the tree in the failure header.
 */
function checkGitDiff(
  cwd: string,
  pathspec: string | readonly string[],
  remediation: string,
  label: string,
): string | null {
  const pathspecs = typeof pathspec === 'string' ? [pathspec] : [...pathspec];
  try {
    execFileSync('git', ['diff', '--exit-code', '--', ...pathspecs], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    const status = getExecErrorStatus(err);
    const stdout = getExecErrorStdout(err);
    const stderr = getExecErrorStderr(err);

    if (status === 1) {
      return [
        `[skills:guard] generated ${label} tree is stale (drift detected).`,
        remediation,
        '',
        'Diff:',
        stdout.length > 0 ? stdout : '(no diff output captured)',
      ].join('\n');
    }

    return [
      `[skills:guard] git diff failed for ${label}/ (exit ${status ?? 'unknown'})`,
      stderr || stdout || String(err),
      remediation,
    ].join('\n');
  }
}

/** Get the numeric exit `status` from the `unknown` error of a failed `execFileSync` call, or null. */
function getExecErrorStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

/** Same narrowing pattern for `stdout`. */
function getExecErrorStdout(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stdout' in err) {
    const out = (err as { stdout: unknown }).stdout;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

/** Same narrowing pattern for `stderr`. */
function getExecErrorStderr(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'stderr' in err) {
    const out = (err as { stderr: unknown }).stderr;
    if (Buffer.isBuffer(out)) return out.toString('utf8');
    if (typeof out === 'string') return out;
  }
  return '';
}

export type { MainDeps } from './cli-helpers.js';

/**
 * `npm run skills:guard` entry point. It runs `runSkillsGuard` against `deps.cwd()`, prints the message, and exits with the returned code.
 * Success prints to stdout, and failure to stderr. The module calls `main()` only when it runs directly, so a test import does not run the guard.
 */
export function main(_argv: string[], deps: MainDeps = {}): void {
  const { cwd, exit, log, errLog } = resolveMainDeps(deps);

  const result = runSkillsGuard({ cwd: cwd() });

  if (result.ok) {
    log(result.message);
  } else {
    errLog(result.message);
  }
  exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
