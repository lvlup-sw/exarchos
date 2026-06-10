// ─── Task-Runner Tier (universal, language-agnostic) ────────────────────────
//
// The truly-universal layer of the toolchain resolver: if a repo commits a
// standard task runner with a conventional `test` (or `build`/`typecheck`/
// `install`) target, run THAT — regardless of language. This covers any
// toolchain a runner supports, with zero per-language code and no enumeration.
//
// Detection is file-presence + target-presence. We confirm the conventional
// target actually exists (so we never hand back a command that fails), then
// emit the runner's invocation for it.
//
//   Taskfile.yml   → `task <target>`
//   justfile       → `just <target>`
//   mise.toml      → `mise run <target>`
//   Makefile       → `make <target>`
//
// Resolves above the built-in ecosystem table but below explicit user
// declaration — see test-runtime-resolver's precedence.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';

const log = logger.child({ subsystem: 'task-runners' });

export type TaskKind = 'test' | 'typecheck' | 'install' | 'build' | 'mutation' | 'lint';

/** Conventional target names to look for, per kind. First match wins. */
const TARGET_CANDIDATES: Readonly<Record<TaskKind, readonly string[]>> = {
  test: ['test'],
  typecheck: ['typecheck', 'check'],
  install: ['install', 'deps'],
  build: ['build'],
  // verification-ladder slice 1 (task 017): a committed task-runner target
  // named `mutation`/`lint` is a deliberate project interface, honored at the
  // task-runner tier just like `test`.
  mutation: ['mutation', 'mutants'],
  lint: ['lint'],
};

export interface TaskRunnerResolution {
  readonly runner: 'task' | 'just' | 'mise' | 'make';
  readonly target: string;
  readonly command: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface RunnerDef {
  readonly id: TaskRunnerResolution['runner'];
  readonly files: readonly string[];
  readonly hasTarget: (content: string, target: string) => boolean;
  readonly command: (target: string) => string;
}

/** Taskfile: YAML with a `tasks:` map keyed by target. */
function taskfileHasTarget(content: string, target: string): boolean {
  try {
    const doc = parseYaml(content) as { tasks?: Record<string, unknown> } | null;
    return Boolean(doc && typeof doc === 'object' && doc.tasks && target in doc.tasks);
  } catch (err) {
    log.warn({ err: (err as Error)?.message ?? String(err) }, 'Taskfile parse failed');
    return false;
  }
}

/**
 * justfile: recipes are `target:` / `target args:` / `target: deps` at line
 * start. A leading `@` marks a quiet recipe (`@target:`), so it is optional.
 * `:(?!=)` excludes `target := value` variable assignments.
 */
function justHasTarget(content: string, target: string): boolean {
  return new RegExp(`^@?${escapeRegExp(target)}(\\s+[^:\\n]*)?:(?!=)`, 'm').test(content);
}

/** mise.toml: `[tasks.<target>]` table, or `<target> = …` under a `[tasks]` table. */
function miseHasTarget(content: string, target: string): boolean {
  const t = escapeRegExp(target);
  if (new RegExp(`^\\[tasks\\.${t}\\]`, 'm').test(content)) return true;
  // Body of the [tasks] table: from its header to the next `[section]` or EOF.
  const headerIdx = content.search(/^\[tasks\][^\n]*$/m);
  if (headerIdx === -1) return false;
  const afterHeader = content.slice(headerIdx).replace(/^\[tasks\][^\n]*\n?/, '');
  const nextSection = afterHeader.search(/^\[/m);
  const section = nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection);
  return new RegExp(`^\\s*("?)${t}\\1\\s*=`, 'm').test(section);
}

/** Makefile: targets are `<target>:` at line start (not a variable assignment). */
function makeHasTarget(content: string, target: string): boolean {
  return new RegExp(`^${escapeRegExp(target)}\\s*:(?!=)`, 'm').test(content);
}

// Priority order: explicit cross-platform runners first, Makefile (lowest common
// denominator, non-standardized targets, not native on Windows) last.
const RUNNERS: readonly RunnerDef[] = [
  {
    id: 'task',
    files: ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'],
    hasTarget: taskfileHasTarget,
    command: (t) => `task ${t}`,
  },
  {
    id: 'just',
    files: ['justfile', 'Justfile', '.justfile'],
    hasTarget: justHasTarget,
    command: (t) => `just ${t}`,
  },
  {
    id: 'mise',
    // path.join normalizes the forward slashes cross-platform.
    files: ['mise.toml', '.mise.toml', 'mise/config.toml', '.config/mise/config.toml'],
    hasTarget: miseHasTarget,
    command: (t) => `mise run ${t}`,
  },
  {
    id: 'make',
    files: ['Makefile', 'makefile', 'GNUmakefile'],
    hasTarget: makeHasTarget,
    command: (t) => `make ${t}`,
  },
];

/**
 * Resolve a task-runner command for `kind` at `repoRoot`, or undefined when no
 * committed runner declares a matching conventional target. Pure: reads files,
 * no execution.
 */
export function resolveTaskRunner(
  repoRoot: string,
  kind: TaskKind,
): TaskRunnerResolution | undefined {
  for (const runner of RUNNERS) {
    const file = runner.files.find((f) => existsSync(path.join(repoRoot, f)));
    if (!file) continue;
    let content: string;
    try {
      content = readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const target of TARGET_CANDIDATES[kind]) {
      if (runner.hasTarget(content, target)) {
        return { runner: runner.id, target, command: runner.command(target) };
      }
    }
  }
  return undefined;
}
