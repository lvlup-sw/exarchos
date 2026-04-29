// ─── Quote-aware command tokenizer ───────────────────────────────────────────
//
// Splits a command string into argv-style tokens, honoring single quotes,
// double quotes, and backslash escapes.
//
// Used by the orchestrate handlers that take resolver output and feed it to
// `execFileSync`. With #1199 the resolver can return commands sourced from
// `.exarchos.yml` or CLI overrides — these may contain quoted arguments
// (e.g., `pytest -k "slow api"`) that a naive whitespace split would
// mangle. Detection-sourced commands are simple enough to tokenize either
// way; the cost of using this for both is negligible.
//
// Intentionally NOT a full POSIX shell parser:
//   * No variable expansion ($FOO, ${FOO}).
//   * No command substitution, redirects, or piping.
//   * No globbing.
// The resolver's SAFE_COMMAND_PATTERN already rejects shell metacharacters,
// so commands fed to this tokenizer cannot legitimately contain those
// constructs anyway.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Tokenize a command string into argv-style tokens.
 *
 * Honors single quotes, double quotes, and backslash escapes. Whitespace
 * outside quotes separates tokens. Empty tokens are dropped.
 *
 * Examples:
 *   tokenizeCommand('pytest -k "slow api"')      → ['pytest', '-k', 'slow api']
 *   tokenizeCommand("./bin/runner --flag arg")   → ['./bin/runner', '--flag', 'arg']
 *   tokenizeCommand('npm run test:run')          → ['npm', 'run', 'test:run']
 *
 * @throws on unterminated quote or trailing backslash.
 */
export function tokenizeCommand(input: string): readonly string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === '\\' && !inSingle) {
      // Backslash escapes the next character outside single quotes.
      if (i + 1 >= input.length) {
        throw new Error(`tokenizeCommand: trailing backslash in: ${input}`);
      }
      current += input[i + 1];
      hasContent = true;
      i++;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasContent = true;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasContent = true;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (hasContent) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }

    current += ch;
    hasContent = true;
  }

  if (inSingle || inDouble) {
    throw new Error(`tokenizeCommand: unterminated quote in: ${input}`);
  }
  if (hasContent) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Split a command into `{ cmd, args }`. Returns `cmd: ''` for an empty input
 * so callers can short-circuit.
 */
export function splitCommand(input: string): { cmd: string; args: readonly string[] } {
  const tokens = tokenizeCommand(input);
  const [cmd, ...args] = tokens;
  return { cmd: cmd ?? '', args };
}
