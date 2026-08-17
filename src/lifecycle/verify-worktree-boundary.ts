/**
 * `exarchos verify-worktree-boundary` — PreToolUse boundary guard (#1301).
 *
 * The structural fix for the worktree-isolation write leak. A `task-isolated`
 * agent (implementer/fixer/scaffolder) runs in an isolated git worktree, but
 * an `Edit`/`Write` to an *absolute* path resolves literally and ignores the
 * agent's worktree cwd — so an absolute parent-repo path silently writes into
 * the orchestrator's MAIN worktree (the byte-identical "mirroring" leak).
 *
 * Wired as a `PreToolUse` hook (matcher `Write|Edit|MultiEdit|NotebookEdit`)
 * via the `pre-write` validationRule→hook adapter, this guard reads the hook
 * JSON on stdin, resolves the target path against the agent's worktree, and
 * **denies (exit 2) any write whose resolved path escapes the worktree root**.
 * The leak becomes unrepresentable by construction (INV-11) rather than
 * detected after the fact by the merge-time backstop.
 *
 * Exit contract:
 *   - target inside the worktree            → exit 0 (allow)
 *   - target escapes the worktree root      → exit 2 (deny; reason on stderr,
 *                                              which Claude Code surfaces)
 *   - no write-target field / non-file tool → exit 0 (nothing to guard)
 *   - unparseable hook input                → exit 0, reason on stderr. A
 *     format mismatch must not brick every agent write; the skip is visible,
 *     never silent (DIM-2).
 *
 * The worktree root is `git -C <cwd> rev-parse --show-toplevel` (a linked
 * worktree reports its OWN toplevel, so the parent main repo is correctly
 * out of bounds), falling back to `cwd` when no toplevel resolves. Path
 * comparison goes through `path.relative` so `..`-escapes, sibling-worktree
 * paths, and absolute parent-repo paths are all rejected cross-platform.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { z } from 'zod';
import { defaultRealpath } from '../verbs/worktree/pure/path-containment.js';

/**
 * Shape of the PreToolUse hook payload we depend on. Validated with `safeParse`
 * so a payload that is valid JSON but wrong-typed (e.g. `{file_path: 123}`) is
 * treated exactly like malformed JSON — allow + stderr — never a thrown
 * `TypeError` from a non-string reaching `path.*`. Unknown keys are ignored.
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
  /** Canonicalize a path (resolve symlinks). Defaults to a realpath that
   *  tolerates not-yet-existing files (a Write creating a new file). */
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

// The realpath seam is the SHARED, `.native`-hardened {@link defaultRealpath}
// from `pure/path-containment.ts` — the single canonicalizer (#1620). A private
// copy here previously used the plain `fs.realpathSync`, which does NOT expand
// Windows 8.3 SHORT names: on win32 CI `git rev-parse --show-toplevel` emits the
// LONG form (`…/runneradmin/…`) while the write target realpath'd through the
// un-hardened copy kept the 8.3 form (`…/RUNNER~1/…`), so the username segments
// diverged, `path.relative` climbed out, and legitimate in-worktree writes were
// wrongly DENIED. Routing through the one shared resolver removes that whole
// class of drift (`.native` expands both sides to the long form; no-op on POSIX).

/** True when `target` is the root itself or lives strictly within it. */
function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Decide whether the PreToolUse write may proceed. Pure over its deps + the
 * raw stdin string; returns the process exit code (0 allow / 2 deny).
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
    // Can't make a boundary decision on unparseable input — allow, but surface.
    stderr('exarchos verify-worktree-boundary: unparseable hook input; skipping boundary check');
    return ALLOW;
  }
  const result = preToolUsePayloadSchema.safeParse(parsedJson);
  if (!result.success) {
    // Valid JSON but the wrong shape (e.g. a non-string path) — same policy as
    // malformed JSON: never throw, never brick a write; skip visibly.
    stderr('exarchos verify-worktree-boundary: unexpected hook payload shape; skipping boundary check');
    return ALLOW;
  }
  const payload = result.data;

  const cwd = payload.cwd ?? process.cwd();
  const targetField = payload.tool_input?.file_path ?? payload.tool_input?.notebook_path;
  if (!targetField) {
    // Not a file-write tool call (or no path) — nothing to guard.
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
