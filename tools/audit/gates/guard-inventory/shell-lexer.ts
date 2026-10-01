import { posix } from 'node:path';

/**
 * Interpreters that take the program as a path argument, so `bash x.sh`, `node x.mjs` and
 * `tsx x.ts` all run `x`. The list is hand-written. A missing interpreter makes a real call
 * look unreachable, so the inventory reports a false wiring hole. It never hides a dead guard.
 */
export const SHELL_INTERPRETERS: readonly string[] = Object.freeze([
  'bash',
  'sh',
  'zsh',
  'dash',
  'node',
  'npx',
  'tsx',
  'bun',
  'deno',
  'python',
  'python3',
]);

/** Words that delegate to the command following them, so the real head is later. */
export const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'exec',
  'command',
  'env',
  'time',
  'nohup',
  'sudo',
  'builtin',
]);

/** Repo root as a path segment. Kept as `.` so an anchor can prefix a relative path. */
export const ROOT_ANCHOR = '.';

/**
 * `#` comments removed, quote-aware.
 * The walk strips the comments of a wrapper script first, because a script can name a path in a comment and never run it.
 * A `#` opens a comment only at the start of a word, so `${x#y}` and `$#` stay intact. A `#` inside quotes is not a comment.
 */
export function stripShellComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  let escaped = false;
  let inComment = false;
  let prev = '\n';
  for (const ch of source) {
    if (inComment) {
      if (ch === '\n') {
        inComment = false;
        out += ch;
        prev = '\n';
      }
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      prev = ch;
      continue;
    }
    if (quote === null && ch === '\\') {
      out += ch;
      escaped = true;
      prev = ch;
      continue;
    }
    if (quote !== null) {
      out += ch;
      if (ch === quote) quote = null;
      prev = ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      prev = ch;
      continue;
    }
    if (ch === '#' && /[\s;(&|]/.test(prev)) {
      inComment = true;
      continue;
    }
    out += ch;
    prev = ch;
  }
  return out;
}

/**
 * Join backslash line-continuations into one logical line.
 * Without this step, the second physical line of a continued command reads as a new command, and an argument lands in command position.
 */
export function joinShellContinuations(source: string): string {
  return source.replace(/\\\n/g, ' ');
}

/**
 * Split a logical line into command segments on unquoted `;`, `&&`, `||`, `|`, `&`.
 *
 * Each segment has its own command head, which is what decides whether a path
 * argument is executed. Without this, `grep -q x file | node gate.mjs` presents a
 * single head (`grep`) and the pipeline's real invocation disappears.
 * A doubled operator (`&&`, `||`) counts as one separator.
 */
export function shellCommandSegments(line: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === null && ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&') {
      segments.push(current);
      current = '';
      if (line[i + 1] === ch) i += 1;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== '');
}

/**
 * Split one shell line into words, quote-aware, dropping operators.
 *
 * The function removes quotes but keeps `$NAME`, because expansion happens after
 * the split. `"$KNIP_DIFF"` becomes the single word `$KNIP_DIFF`.
 */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;
  let escaped = false;
  const push = (): void => {
    if (started) {
      words.push(current);
      current = '';
      started = false;
    }
  };
  for (const ch of line) {
    if (escaped) {
      current += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (quote === null && ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        started = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch) || /[;&|()<>]/.test(ch)) {
      push();
      continue;
    }
    current += ch;
    started = true;
  }
  push();
  return words;
}

/**
 * Substitute `$NAME` / `${NAME}` from `table`.
 *
 * Returns `null` when any reference cannot be resolved — an unresolvable word is
 * NOT treated as a literal, because `"$UNKNOWN/knip-diff.ts"` is not evidence that
 * `knip-diff.ts` ran. Bounded recursion terminates on values that expand to
 * further `$` text (including shapes this resolver does not model, like
 * `${BASH_SOURCE[0]}`).
 */
export function expandShellVars(text: string, table: ReadonlyMap<string, string>, depth = 0): string | null {
  if (depth > 8) return null;
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = '';
  let last = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1] ?? match[2];
    if (name === undefined) continue;
    const value = table.get(name);
    if (value === undefined) return null;
    out += text.slice(last, match.index) + value;
    last = match.index + match[0].length;
    matched = true;
  }
  out += text.slice(last);
  if (!matched) return text.includes('$') ? null : text;
  return out.includes('$') ? expandShellVars(out, table, depth + 1) : out;
}

/**
 * Normalize an expanded word to a repo-relative path, or `null` when it does not
 * denote one (absolute, or escaping the repo root).
 */
export function normalizeRepoPath(value: string): string | null {
  if (value === '' || value.startsWith('/')) return null;
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === './') return '';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** `NAME=VALUE` split for a word already stripped of quotes. */
export function assignmentWord(word: string): { name: string; value: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
  const name = match?.[1];
  if (match === null || name === undefined) return null;
  return { name, value: match[2] ?? '' };
}

/**
 * Resolve an assignment whose value is a whole command substitution, for the two
 * directory anchors this repo's scripts actually use. Anything else is `null` —
 * an unmodelled `$(…)` must not become a guessed path.
 * `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)` resolves to the script directory, and `$(cd <dir> && pwd)` resolves to that directory.
 */
export function resolveCommandSubstitution(
  raw: string,
  table: ReadonlyMap<string, string>,
  scriptDir: string,
): string | null {
  const match = /^"?\$\((.*)\)"?$/s.exec(raw.trim());
  const inner = match?.[1];
  if (inner === undefined) return null;
  if (/\bdirname\b/.test(inner) && /BASH_SOURCE|\$0/.test(inner)) return scriptDir;
  const cd = /^cd\s+(.+?)\s*&&\s*pwd$/.exec(inner.trim());
  const target = cd?.[1];
  if (target === undefined) return null;
  const expanded = expandShellVars(target.replace(/^["']|["']$/g, ''), table);
  if (expanded === null) return null;
  const normalized = normalizeRepoPath(expanded);
  return normalized === null ? null : normalized === '' ? ROOT_ANCHOR : normalized;
}
