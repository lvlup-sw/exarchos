/**
 * Quote-aware command tokenizer for the handlers that pass resolver commands to
 * `execFileSync`. A command from `.exarchos.yml` or a CLI override can hold quoted
 * arguments, such as `pytest -k "slow api"`, that a whitespace split breaks.
 *
 * It is not a POSIX shell parser: it does no variable expansion, command
 * substitution, redirects, pipes, or globs. `SAFE_COMMAND_PATTERN` in the resolver
 * rejects shell metacharacters before a command gets here.
 */

/**
 * Splits a command string into argv-style tokens. It honors single quotes, double
 * quotes, and backslash escapes. A backslash outside single quotes escapes the next
 * character. Whitespace outside quotes separates tokens. A run of whitespace gives
 * no empty token, but a quoted empty string is an empty token.
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
    const ch = input[i] ?? '';

    if (ch === '\\' && !inSingle) {
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
