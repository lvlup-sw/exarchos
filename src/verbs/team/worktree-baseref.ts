/**
 * Resolves the Claude Code `worktree.baseRef` setting for `prepare_delegation`.
 *
 * Native `isolation: worktree` branches a subagent worktree from `origin/HEAD`,
 * unless `worktree.baseRef` is `"head"`. Without that value, a stacked
 * delegation starts on a stale base. Exarchos does not own the consumer
 * `.claude/settings.json`, so `prepare_delegation` blocks dispatch when the
 * value is not `"head"`. Consumer files resolve from `process.cwd()`, not from
 * `import.meta.url`, because module-relative paths fail in plugin mode.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The only values Claude Code accepts for `worktree.baseRef`. */
export type BaseRefValue = 'fresh' | 'head';

const BASE_REF_VALUES: ReadonlySet<string> = new Set<BaseRefValue>(['fresh', 'head']);

/** Reads a file's contents, or returns `null` when absent/unreadable. */
export type SettingsReader = (filePath: string) => string | null;

export interface ResolveWorktreeBaseRefOptions {
  /** Project root the orchestrator is dispatching from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** User home dir for the user-level settings cascade. Defaults to `os.homedir()`. */
  readonly home?: string;
  /** Injectable reader (testing). Defaults to a swallow-on-error `fs` reader. */
  readonly readFile?: SettingsReader;
}

export interface WorktreeBaseRefResult {
  /** Effective `worktree.baseRef` across the settings cascade, or `null` if unset/invalid. */
  readonly effective: BaseRefValue | null;
  /** Settings files inspected, highest-precedence first. */
  readonly checked: readonly string[];
  /** The file that supplied `effective`, when one did. */
  readonly source?: string;
}

export interface WorktreeBaseRefAssertion {
  /** True only when the effective value is `"head"` (worktrees base on local HEAD). */
  readonly pinned: boolean;
  readonly effective: BaseRefValue | null;
  readonly checked: readonly string[];
  /** Set when not pinned — the dispatch-blocking reason. */
  readonly reason?: 'worktree-baseref-unset';
  /** Operator-facing remediation: the exact file + patch to add. */
  readonly remediation?: {
    readonly file: string;
    readonly patch: { readonly worktree: { readonly baseRef: 'head' } };
  };
  /** Short human hint mirrored from `remediation`. */
  readonly hint?: string;
}

const REMEDIATION = {
  file: '.claude/settings.json',
  patch: { worktree: { baseRef: 'head' } },
} as const;

/**
 * Default reader: `fs.readFileSync` with all errors (ENOENT, permission,
 * directory) collapsed to `null`. Absence is a non-signal, not a throw.
 */
const defaultReader: SettingsReader = (filePath: string): string | null => {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
};

/**
 * Parse a settings file's `worktree.baseRef`, returning the enum value or
 * `null` for absent/malformed/non-enum. Never throws.
 */
function readBaseRef(contents: string | null): BaseRefValue | null {
  if (contents === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const worktree = (parsed as { worktree?: unknown }).worktree;
  if (typeof worktree !== 'object' || worktree === null) return null;
  const value = (worktree as { baseRef?: unknown }).baseRef;
  if (typeof value === 'string' && BASE_REF_VALUES.has(value)) {
    return value as BaseRefValue;
  }
  return null;
}

/**
 * Resolves the effective `worktree.baseRef` from the settings files, in this order:
 *   1. `<cwd>/.claude/settings.local.json`
 *   2. `<cwd>/.claude/settings.json`
 *   3. `<home>/.claude/settings.json`
 *
 * The first file with a valid `baseRef` supplies the value. This function
 * cannot read enterprise-managed or command-line overrides.
 */
export function resolveWorktreeBaseRef(
  options: ResolveWorktreeBaseRefOptions = {},
): WorktreeBaseRefResult {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const read = options.readFile ?? defaultReader;

  const checked: string[] = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
  ];

  for (const filePath of checked) {
    const value = readBaseRef(read(filePath));
    if (value !== null) {
      return { effective: value, checked, source: filePath };
    }
  }

  return { effective: null, checked };
}

/**
 * Checks that worktrees base on local HEAD (`baseRef: "head"`). For any other
 * value, or no value, it returns a blocking result with the exact remediation.
 * Then `prepare_delegation` can stop instead of dispatching onto `origin/HEAD`.
 */
export function assertWorktreeBaseRefPinned(
  options: ResolveWorktreeBaseRefOptions = {},
): WorktreeBaseRefAssertion {
  const { effective, checked } = resolveWorktreeBaseRef(options);
  if (effective === 'head') {
    return { pinned: true, effective, checked };
  }
  return {
    pinned: false,
    effective,
    checked,
    reason: 'worktree-baseref-unset',
    remediation: REMEDIATION,
    hint:
      'native isolation:worktree branches subagent worktrees from origin/HEAD (main), ' +
      'not the integration tip — set worktree.baseRef:"head" in .claude/settings.json ' +
      'so worktrees base on the integration branch at dispatch time',
  };
}
