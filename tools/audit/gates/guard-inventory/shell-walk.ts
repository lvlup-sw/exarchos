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
 *
 * Cycles terminate on `seen`. A script that cannot be read contributes nothing
 * rather than throwing: an entry point naming a file outside the repo (or a
 * generated one) is normal, and the non-empty-denominator check in
 * {@link auditGuardInventory} is what catches a walk that finds nothing at all.
 */
export function resolveShellExecutions(entryScript: string, read: (path: string) => string | null): ShellWalk {
  /** target → chain + whether every invocation of it swallowed the exit code. */
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
      // The one GitHub-defined anchor the workflows use: `$GITHUB_WORKSPACE` is
      // the checkout root, which in this model is the repo root.
      ['GITHUB_WORKSPACE', ROOT_ANCHOR],
    ]);
    /** Targets invoked BY THIS script — the only ones whose chain is `chain`. */
    const invokedHere = new Set<string>();

    const toRepoPath = (word: string): string | null => {
      const expanded = expandShellVars(word, table);
      if (expanded === null) {
        if (word.includes('$')) unresolved.add(`${script}: ${word}`);
        return null;
      }
      const normalized = normalizeRepoPath(expanded);
      if (normalized === null || normalized === '') return null;
      // A readable regular FILE. `read` returns null for a directory, which is
      // what keeps `scripts/audit` (named as a bare argument by a portability
      // test) out of a list of executed programs.
      return read(normalized) === null ? null : normalized;
    };

    /** Classify one command segment and record whatever it executes. */
    const scanSegment = (segment: string, swallowed: boolean): void => {
      let words = shellWords(segment);
      // Peel leading `NAME=VALUE` env prefixes. `FOO=1 bash x.sh` both assigns and
      // invokes, so this cannot simply classify the segment as an assignment.
      while (words.length > 0) {
        const first = words[0];
        if (first === undefined) break;
        const assignment = assignmentWord(first);
        if (assignment === null) break;
        const expanded = expandShellVars(assignment.value, table);
        if (expanded !== null) table.set(assignment.name, expanded);
        words = words.slice(1);
      }
      // Assignment ONLY: nothing was executed. `KNIP_DIFF="$SCRIPT_DIR/…"` names a
      // guard without running it, and must not read as an invocation.
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

      // Command position: `./scripts/x.sh` or `"$SCRIPT_DIR/x.sh"`.
      invoke(head);

      // Interpreter arguments: `bash x.sh`, `node x.mjs`, `"$TSX_BIN" "$KNIP_DIFF"`.
      //
      // Only the PROGRAM argument counts — the first non-flag word — and then the
      // scan stops. Everything after it belongs to that program, not to the shell.
      // Taking every argument instead reports `npx eslint --print-config
      // composite.ts` as EXECUTING `composite.ts`, which is a source file eslint
      // reads. Interpreters chain (`npx … tsx x.ts`), so an argument that is
      // itself an interpreter name advances the search rather than ending it.
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

      // An assignment whose value is a whole command substitution must be read
      // before word-splitting, because `$( … )` contains the very characters the
      // splitter treats as operators.
      const wholeLine =
        /^(?:export\s+|readonly\s+|local\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=("?\$\(.*\)"?)$/.exec(line);
      const wholeName = wholeLine?.[1];
      const wholeValue = wholeLine?.[2];
      if (wholeName !== undefined && wholeValue !== undefined) {
        const resolved = resolveCommandSubstitution(wholeValue, table, scriptDir);
        if (resolved !== null) {
          // One of the two directory anchors: a value, not an invocation.
          table.set(wholeName, resolved);
          continue;
        }
        // Any other `$(…)` IS a command and may invoke a guard (`OUT=$(node
        // gate.mjs)`), so its interior is scanned — but it yields no variable
        // value, because this resolver cannot know what the command printed.
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

// ─── Guard population ────────────────────────────────────────────────────────
