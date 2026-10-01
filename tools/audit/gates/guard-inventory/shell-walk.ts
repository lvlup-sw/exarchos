import { posix } from 'node:path';
import { COMMAND_PREFIXES, ROOT_ANCHOR, SHELL_INTERPRETERS, assignmentWord, expandShellVars, joinShellContinuations, normalizeRepoPath, resolveCommandSubstitution, shellCommandSegments, shellWords, stripShellComments } from './shell-lexer.js';

export interface ShellExecution {
  /** Repo-relative path of the executed file. */
  readonly target: string;
  /** The wrapper chain from the run-step to `target`, outermost first. */
  readonly through: readonly string[];
  /** True when EVERY invocation line of `target` swallows its exit code. */
  readonly exitSwallowed: boolean;
}

export interface ShellWalk {
  readonly executions: readonly ShellExecution[];
  /** Wrapper scripts actually read during the walk — the non-empty-denominator input. */
  readonly scriptsWalked: readonly string[];
  /** Invocation words naming an unresolvable variable, reported rather than guessed. */
  readonly unresolved: readonly string[];
}

/**
 * Everything `entryScript` executes, transitively through further `.sh` wrappers.
 * Cycles end on `seen`. An unreadable script or a directory contributes nothing,
 * and {@link auditGuardInventory} catches a walk that finds nothing at all.
 *
 * A `NAME=VALUE` prefix sets a variable. A segment of only assignments executes nothing.
 * After an interpreter, the first non-flag word is the program. A further interpreter name continues the search.
 *
 * The walk reads a whole-line `NAME=$(…)` assignment before word splitting, because `$(…)` holds operator characters.
 * When the value resolves to a directory anchor, it sets the variable. Otherwise the walk scans its commands and sets no value.
 */
export function resolveShellExecutions(entryScript: string, read: (path: string) => string | null): ShellWalk {
  const found = new Map<string, { through: string[]; swallowed: boolean }>();
  const scriptsWalked: string[] = [];
  const unresolved = new Set<string>();
  const seen = new Set<string>();

  const record = (target: string, through: string[], swallowed: boolean): void => {
    const prior = found.get(target);
    if (prior === undefined) found.set(target, { through, swallowed });
    else prior.swallowed = prior.swallowed && swallowed;
  };

  const walk = (script: string, chain: string[]): void => {
    if (seen.has(script)) return;
    seen.add(script);
    const source = read(script);
    if (source === null) return;
    scriptsWalked.push(script);

    const scriptDir = posix.dirname(script) === '.' ? ROOT_ANCHOR : posix.dirname(script);
    const table = new Map<string, string>([
      ['GITHUB_WORKSPACE', ROOT_ANCHOR],
    ]);
    const invokedHere = new Set<string>();

    const toRepoPath = (word: string): string | null => {
      const expanded = expandShellVars(word, table);
      if (expanded === null) {
        if (word.includes('$')) unresolved.add(`${script}: ${word}`);
        return null;
      }
      const normalized = normalizeRepoPath(expanded);
      if (normalized === null || normalized === '') return null;
      return read(normalized) === null ? null : normalized;
    };

    const scanSegment = (segment: string, swallowed: boolean): void => {
      let words = shellWords(segment);
      while (words.length > 0) {
        const first = words[0];
        if (first === undefined) break;
        const assignment = assignmentWord(first);
        if (assignment === null) break;
        const expanded = expandShellVars(assignment.value, table);
        if (expanded !== null) table.set(assignment.name, expanded);
        words = words.slice(1);
      }
      if (words.length === 0) return;

      while (words.length > 0) {
        const prefix = words[0];
        if (prefix === undefined || !COMMAND_PREFIXES.has(prefix)) break;
        words = words.slice(1);
      }
      const head = words[0];
      if (head === undefined) return;

      const invoke = (word: string): void => {
        const path = toRepoPath(word);
        if (path === null) return;
        record(path, chain, swallowed);
        invokedHere.add(path);
      };

      invoke(head);

      const basenameOf = (word: string): string => posix.basename(expandShellVars(word, table) ?? word);
      if (SHELL_INTERPRETERS.includes(basenameOf(head))) {
        for (const word of words.slice(1)) {
          if (word.startsWith('-')) continue;
          if (SHELL_INTERPRETERS.includes(basenameOf(word))) continue;
          invoke(word);
          break;
        }
      }
    };

    for (const rawLine of joinShellContinuations(stripShellComments(source)).split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      const swallowed = /\|\|\s*(true|:)\s*$/.test(line) || /\|\|\s*(true|:)\)/.test(line);

      const wholeLine =
        /^(?:export\s+|readonly\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=("?\$\(.*\)"?)$/.exec(line);
      const wholeName = wholeLine?.[1];
      const wholeValue = wholeLine?.[2];
      if (wholeName !== undefined && wholeValue !== undefined) {
        const resolved = resolveCommandSubstitution(wholeValue, table, scriptDir);
        if (resolved !== null) {
          table.set(wholeName, resolved);
          continue;
        }
        const inner = /^"?\$\((.*)\)"?$/s.exec(wholeValue)?.[1];
        if (inner !== undefined) {
          for (const segment of shellCommandSegments(inner)) scanSegment(segment, swallowed);
        }
        continue;
      }

      for (const segment of shellCommandSegments(line)) scanSegment(segment, swallowed);
    }

    for (const target of invokedHere) {
      if (target.endsWith('.sh')) walk(target, [...chain, target]);
    }
  };

  walk(entryScript, [entryScript]);

  return {
    executions: [...found.entries()]
      .map(([target, entry]) => ({ target, through: entry.through, exitSwallowed: entry.swallowed }))
      .sort((a, b) => a.target.localeCompare(b.target)),
    scriptsWalked,
    unresolved: [...unresolved].sort(),
  };
}
