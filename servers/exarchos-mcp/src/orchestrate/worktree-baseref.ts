// ─── Worktree baseRef Resolution (#1509 / #1501) ─────────────────────────────
//
// Claude Code native `isolation: worktree` branches a subagent's worktree from
// the repository's default branch (`origin/HEAD` → main) UNLESS the consumer's
// settings set `worktree.baseRef: "head"`, which bases worktrees on local HEAD
// (= the integration tip at dispatch time). Without it, every stacked-branch
// delegation lands on a stale base missing all in-branch prerequisites.
//
// Exarchos ships as a binary + plugin and does not own a consumer's
// `.claude/settings.json`, so it cannot set the value transparently. Instead,
// `prepare_delegation` reads the effective value and BLOCKS dispatch (fail-loud)
// when native isolation is requested without the pin in place.
//
// The reader is injectable so the resolution logic stays pure and unit-testable;
// the default reader is the only impurity. Consumer files are resolved from
// `process.cwd()` — never `import.meta.url` (plugin-mode module-relative
// resolution silently fails). See docs/rca/2026-05-31-implementer-worktree-base.md.
// ────────────────────────────────────────────────────────────────────────────

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
 * Resolve the effective `worktree.baseRef` across the Claude Code settings
 * cascade in precedence order:
 *   1. `<cwd>/.claude/settings.local.json`  (personal project overrides)
 *   2. `<cwd>/.claude/settings.json`        (shared project settings)
 *   3. `<home>/.claude/settings.json`       (user settings)
 *
 * Enterprise-managed and CLI-argument overrides are not reachable from here;
 * the version-independent ancestry assert (Layer 3) covers that residual.
 * The first file to declare a valid `baseRef` wins.
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
 * Assert that worktrees are pinned to local HEAD (`baseRef: "head"`). When they
 * are not — unset, `"fresh"`, or unparseable — return a blocking result with the
 * exact remediation so `prepare_delegation` can fail loud instead of silently
 * dispatching a native-isolation subagent onto `origin/HEAD` (main).
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
