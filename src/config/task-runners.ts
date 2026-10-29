/**
 * Task-runner tier of the toolchain resolver. It works for any language.
 * If a repo commits a task runner with a conventional target, the resolver returns the command for that target.
 * Detection needs the runner file and the target in it:
 *
 *   Taskfile.yml   -> `task <target>`
 *   justfile       -> `just <target>`
 *   mise.toml      -> `mise run <target>`
 *   Makefile       -> `make <target>`
 *
 * This tier is above the built-in ecosystem table and below the user declarations.
 * The precedence is in `test-runtime-resolver.ts`.
 * Each runner is also a seed row of the kill probe: the file form and the red exit codes of its `test` target.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '../logger.js';
import type { VerificationProfile } from '../workflow/verification/profile.js';

const log = logger.child({ subsystem: 'task-runners' });

export type TaskKind = 'test' | 'typecheck' | 'install' | 'build' | 'mutation' | 'lint';

/** Conventional target names to look for, per kind. First match wins. */
const TARGET_CANDIDATES: Readonly<Record<TaskKind, readonly string[]>> = {
  test: ['test'],
  typecheck: ['typecheck', 'check'],
  install: ['install', 'deps'],
  build: ['build'],
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

/** The form in which a probe command takes its test files. */
type ProbeFileForm = VerificationProfile['tests']['probe']['files'];

interface RunnerDef {
  readonly id: TaskRunnerResolution['runner'];
  readonly files: readonly string[];
  readonly hasTarget: (content: string, target: string) => boolean;
  readonly command: (target: string) => string;
  /**
   * The form in which a target of the runner takes the test files.
   * The resolver does not read the definition of a target, so it cannot know that the target reads the files.
   */
  readonly probeFiles: ProbeFileForm;
  /** The exit codes of a `test` target whose test fails. */
  readonly testFailureExitCodes: readonly number[];
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

/**
 * mise.toml: a `[tasks.<target>]` table, or `<target> = …` under a `[tasks]` table.
 * The `[tasks]` body runs from its header to the next `[section]` or the end of the file.
 */
function miseHasTarget(content: string, target: string): boolean {
  const t = escapeRegExp(target);
  if (new RegExp(`^\\[tasks\\.${t}\\]`, 'm').test(content)) return true;
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

/**
 * Runners in priority order. The cross-platform runners come first.
 * Makefile is last, because its targets have no standard and Windows has no native `make`.
 */
const RUNNERS: readonly RunnerDef[] = [
  {
    id: 'task',
    files: ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'],
    hasTarget: taskfileHasTarget,
    command: (t) => `task ${t}`,
    probeFiles: 'none',
    testFailureExitCodes: [1],
  },
  {
    id: 'just',
    files: ['justfile', 'Justfile', '.justfile'],
    hasTarget: justHasTarget,
    command: (t) => `just ${t}`,
    probeFiles: 'none',
    testFailureExitCodes: [1],
  },
  {
    id: 'mise',
    files: ['mise.toml', '.mise.toml', 'mise/config.toml', '.config/mise/config.toml'],
    hasTarget: miseHasTarget,
    command: (t) => `mise run ${t}`,
    probeFiles: 'none',
    testFailureExitCodes: [1],
  },
  {
    id: 'make',
    files: ['Makefile', 'makefile', 'GNUmakefile'],
    hasTarget: makeHasTarget,
    command: (t) => `make ${t}`,
    probeFiles: 'none',
    /** `make` exits 2 when a recipe fails. */
    testFailureExitCodes: [2],
  },
];

/**
 * Returns the task-runner command for `kind` at `repoRoot`, or `undefined` when no runner file has a matching target.
 * It reads files and runs nothing. `path.join` converts the forward slashes in the runner file names for each platform.
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

/** The probe row of a task runner: the file form and the red exit codes of a test target that the runner runs. */
export interface TaskRunnerProbeRow {
  readonly runner: TaskRunnerResolution['runner'];
  readonly files: ProbeFileForm;
  readonly testFailureExitCodes: readonly number[];
}

/**
 * Returns the probe row of the task runner whose program is `program`, or `undefined` when no runner has that program.
 * The program of a runner is its id, such as `make` of `make test`.
 */
export function taskRunnerProbeRow(program: string): TaskRunnerProbeRow | undefined {
  const runner = RUNNERS.find((r) => r.id === program);
  if (runner === undefined) return undefined;
  return { runner: runner.id, files: runner.probeFiles, testFailureExitCodes: runner.testFailureExitCodes };
}
