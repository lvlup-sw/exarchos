/**
 * `exarchos verify-worktree-boundary`: the PreToolUse guard that keeps a `task-isolated` agent
 * inside its worktree. An `Edit` or `Write` to an absolute path ignores the cwd of the agent.
 * Thus an absolute parent-repo path writes into the main worktree of the orchestrator.
 *
 * The `pre-write` hook (matcher `Write|Edit|MultiEdit|NotebookEdit`) sends the hook JSON on
 * stdin. The guard resolves the target against the worktree root and returns an exit code:
 *   - The target is inside the worktree: exit 0.
 *   - The target escapes the worktree root: exit 2, with the reason on stderr.
 *   - The payload has no write target: exit 0.
 *   - The input does not parse: exit 0, with the reason on stderr, so a format mismatch does not
 *     block every agent write.
 *
 * The root is `git rev-parse --show-toplevel`, or `cwd` when no toplevel resolves. A linked
 * worktree reports its own toplevel, so the parent repository is out of bounds.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { defaultRealpath } from '../verbs/worktree/pure/path-containment.js';

/**
 * The fields of the PreToolUse hook payload that the guard reads. The guard uses `safeParse`, so
 * a wrong-typed payload, for example `{file_path: 123}`, gets the same result as malformed JSON.
 */
const preToolUsePayloadSchema = z.object({
  cwd: z.string().optional(),
  tool_input: z
    .object({
      file_path: z.string().optional(),
      notebook_path: z.string().optional(),
    })
    .optional(),
});

/** Allow / deny exit codes per the Claude Code PreToolUse block contract. */
const ALLOW = 0;
const DENY = 2;

/** Injectable seams so the unit tests never touch git or the filesystem. */
export interface VerifyWorktreeBoundaryDeps {
  /** Resolve the worktree root for `cwd`. Returns null when none resolves. */
  gitToplevel?: (cwd: string) => string | null;
  /**
   * Canonicalize a path (resolve symlinks). The default accepts a file that does not exist yet,
   * for a Write that creates a new file.
   */
  realpath?: (p: string) => string;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

function defaultGitToplevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * True when `target` is the root itself or lives strictly within it. `path.relative` rejects
 * `..` escapes, sibling worktrees and absolute parent-repo paths on every platform.
 */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Decides if the PreToolUse write can proceed, and returns the exit code (0 allow, 2 deny).
 *
 * The default realpath is the shared {@link defaultRealpath}, which expands Windows 8.3 short
 * names. Git reports the long form, so a plain `fs.realpathSync` on the target makes the paths
 * differ and denies valid writes.
 */
export function handleVerifyWorktreeBoundary(
  stdin: string,
  deps: VerifyWorktreeBoundaryDeps = {},
): number {
  const gitToplevel = deps.gitToplevel ?? defaultGitToplevel;
  const realpath = deps.realpath ?? defaultRealpath;
  const stderr = deps.stderr ?? ((s) => process.stderr.write(`${s}\n`));

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdin);
  } catch {
    stderr('exarchos verify-worktree-boundary: unparseable hook input; skipping boundary check');
    return ALLOW;
  }
  const result = preToolUsePayloadSchema.safeParse(parsedJson);
  if (!result.success) {
    stderr('exarchos verify-worktree-boundary: unexpected hook payload shape; skipping boundary check');
    return ALLOW;
  }
  const payload = result.data;

  const cwd = payload.cwd ?? process.cwd();
  const targetField = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!targetField) {
    return ALLOW;
  }

  const root = realpath(gitToplevel(cwd) ?? cwd);
  const absTarget = path.isAbsolute(targetField)
    ? targetField
    : path.resolve(cwd, targetField);
  const resolvedTarget = realpath(absTarget);

  if (isWithin(root, resolvedTarget)) {
    return ALLOW;
  }

  stderr(
    `exarchos verify-worktree-boundary: BLOCKED write outside the isolated worktree.\n` +
      `  worktree root: ${root}\n` +
      `  attempted path: ${resolvedTarget}\n` +
      `  Use a path relative to the worktree (your cwd), never an absolute parent-repo path — ` +
      `absolute paths bypass the worktree and leak into the main worktree (#1301).`,
  );
  return DENY;
}
