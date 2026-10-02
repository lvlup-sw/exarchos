/**
 * mutation-adequacy: the Stryker report schema, the carrier aggregation, and
 * the mutation-adequacy action handler.
 *
 * The internal Zod schema mirrors the Stryker `mutation-testing-report-schema`,
 * a cross-language mutation-report standard. `parseMutationReport` does not
 * throw. A malformed or empty report gives a typed degrade signal, and the
 * handler maps it to a Warning carrier. A skip, a degrade, or a deferred full
 * run gives `success: true` with `data.passed`, not an error envelope. If the
 * gate event of a skip or a degrade does not append, the handler returns that
 * append error.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { runCommandSync } from '../../utils/process.js';
import { z } from 'zod';

import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import {
  resolveVerificationRuntime,
  type ResolvedVerificationRuntime,
} from '../../config/test-runtime-resolver.js';
import {
  detectToolchain,
  resolveMutationDiffScope,
  type MutationDiffScope,
} from '../../config/toolchains.js';
import { defaultGitExec, requireGateEvent, resolveRepoRoot } from './gate-utils.js';
import { orchestrateLogger } from '../../logger.js';

/**
 * The mutant verdicts of the Stryker `MutantStatus`. `Killed` and `Timeout`
 * count as detected. `Survived` is the adequacy gap. `NoCoverage` means that no
 * test ran the mutated code. The other statuses count only toward `total`, so
 * they lower the score but give no survivor action.
 */
export const MUTANT_STATUSES = [
  'Killed',
  'Survived',
  'NoCoverage',
  'Timeout',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
] as const;

export type MutantStatus = (typeof MUTANT_STATUSES)[number];

/** Statuses that count as a detected (killed) mutant for scoring. */
const KILLED_STATUSES: ReadonlySet<MutantStatus> = new Set<MutantStatus>(['Killed', 'Timeout']);

const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});

const MutantLocationSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
});

export const MutantSchema = z
  .object({
    id: z.string(),
    mutatorName: z.string(),
    status: z.enum(MUTANT_STATUSES),
    location: MutantLocationSchema,
  })
  .passthrough();

export type Mutant = z.infer<typeof MutantSchema>;

export const FileResultSchema = z
  .object({
    language: z.string(),
    /** Optional, because some emitters omit it for diff-scoped runs. The aggregator does not read it. */
    source: z.string().optional(),
    mutants: z.array(MutantSchema),
  })
  .passthrough();

/**
 * The subset of the Stryker report that the aggregator and the survivor mapping
 * read. `.passthrough()` keeps unknown fields, so a newer `schemaVersion` with
 * more fields still validates. `schemaVersion` accepts any string, because the
 * spec uses values such as `'1'` and `'1.0'`.
 */
export const MutationReportSchema = z
  .object({
    schemaVersion: z.string(),
    thresholds: z
      .object({ high: z.number(), low: z.number() })
      .passthrough()
      .optional(),
    files: z.record(z.string(), FileResultSchema),
  })
  .passthrough();

export type MutationReport = z.infer<typeof MutationReportSchema>;

/**
 * The fixed adequacy carrier. `mutationScore` is detected / (total −
 * noCoverage), as in Stryker. Uncovered mutants are not in the denominator, so
 * uncovered code does not lower the score of the existing tests. The handler
 * adds `passed` and `report`.
 */
export interface MutationCarrier {
  readonly mutationScore: number;
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly total: number;
}

/** Flatten every file's mutant list into one stream. */
function allMutants(report: MutationReport): readonly Mutant[] {
  return Object.values(report.files).flatMap((f) => f.mutants);
}

/**
 * Folds a validated report into the carrier. A zero denominator, from an empty
 * report or from only uncovered mutants, gives a score of 0, not NaN. A NaN
 * breaks the threshold comparison without a signal.
 */
export function aggregate(report: MutationReport): MutationCarrier {
  const mutants = allMutants(report);
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  for (const m of mutants) {
    if (KILLED_STATUSES.has(m.status)) killed += 1;
    else if (m.status === 'Survived') survived += 1;
    else if (m.status === 'NoCoverage') noCoverage += 1;
  }
  const total = mutants.length;
  const denominator = total - noCoverage;
  const mutationScore = denominator > 0 ? killed / denominator : 0;
  return { mutationScore, killed, survived, noCoverage, total };
}

/**
 * The tagged result of {@link parseMutationReport}. The handler branches on
 * `ok` without try/catch. The `reason` of the failure arm is a degrade message
 * that the handler shows as a Warning.
 */
export type ParseResult =
  | { readonly ok: true; readonly report: MutationReport; readonly carrier: MutationCarrier }
  | { readonly ok: false; readonly reason: string };

/**
 * Parses a Stryker report, as a JSON string or a parsed object, into the
 * carrier. It does not throw. Empty input, input that is not JSON, and a shape
 * that fails the schema give `{ ok: false, reason }`.
 */
export function parseMutationReport(input: unknown): ParseResult {
  let candidate: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return { ok: false, reason: 'mutation report was empty' };
    }
    try {
      candidate = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `mutation report was not valid JSON: ${detail}` };
    }
  }

  const parsed = MutationReportSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || '(root)';
    const reason = `mutation report did not match the Stryker report schema at ${where}: ${
      issue?.message ?? 'unknown validation error'
    }`;
    return { ok: false, reason };
  }

  return { ok: true, report: parsed.data, carrier: aggregate(parsed.data) };
}

/** The soft default adequacy threshold, from the observed score distribution. */
export const DEFAULT_MUTATION_THRESHOLD = 0.4;

/**
 * The default NoCoverage budget for a diff-scoped run: zero uncovered changed
 * mutants. An uncovered changed line is the defect that the gate exists to
 * find. NoCoverage does not depend on the runner budget, so it is a safe axis
 * to block on. A project sets
 * `review.gates['mutation-adequacy'].params.maxNoCoverage` to change it.
 */
export const DEFAULT_MAX_NO_COVERAGE = 0;

/** The gate name that this action stamps on its gate events. */
export const MUTATION_GATE_NAME = 'mutation-adequacy';
const MUTATION_GATE_LAYER = 'review';

/**
 * The result of the injected mutation runner. `ok: true` carries the Stryker
 * report for {@link parseMutationReport}. `ok: false` is a run-level degrade, a
 * run with no report, which the handler shows as a Warning.
 */
export type MutationRunResult =
  | { readonly ok: true; readonly report: unknown }
  | { readonly ok: false; readonly reason: string };

/** The arguments of the injected runner. `command` already carries the diff scope. */
export interface MutationRunArgs {
  readonly command: string;
  readonly repoRoot: string;
  readonly base: string;
  /**
   * The directory that the command runs in. It comes from the location of the
   * mutation config, so it differs from `repoRoot` when the config is in a
   * sub-package.
   */
  readonly cwd: string;
}

/**
 * The handler arguments. `base` keeps the existing `string` field contract,
 * because a registration-schema field collision throws. For the same reason,
 * `scope` is a plain string at the registration boundary. The handler validates
 * it to `'diff'` or `'full'`, and `'diff'` is the default.
 */
export interface MutationAdequacyArgs {
  readonly featureId: string;
  /** The review/PR base ref the mutation run is diff-scoped against. */
  readonly base: string;
  /** The repository to run in. `'auto'` resolves to the worktree of the calling delegation. */
  readonly repoRoot?: string;
  /** The explicit worktree for `repoRoot:'auto'`. It takes precedence over the event lookup. */
  readonly worktreePath?: string;
  /**
   * The task whose `worktree.created` event resolves `repoRoot:'auto'` when
   * `worktreePath` is absent. When both are absent, `'auto'` gives INVALID_INPUT.
   */
  readonly taskId?: string;
  /** The idempotency key for the gate events. The liveness events use it as `instanceId`. */
  readonly operationId?: string;
  /** The adequacy threshold override. It falls back to config, then to the soft default. */
  readonly threshold?: number;
  /**
   * The NoCoverage budget for a diff-scoped run, a second blocking axis. A
   * diff-scoped pass needs `mutationScore >= threshold` and
   * `noCoverage <= maxNoCoverage`. The definition of `mutationScore` does not
   * change. It falls back to config, then to {@link DEFAULT_MAX_NO_COVERAGE}.
   * A full-scope run ignores it.
   */
  readonly maxNoCoverage?: number;
  /**
   * `'diff'`, the default, runs scoped. `'full'` runs the whole tree only with
   * `offline`. Without it, `'full'` gives a deferred advisory, because the long
   * run belongs to an offline lane, not to an inline `/review`.
   */
  readonly scope?: string;
  /**
   * The opt-in for a full-tree run. An offline caller, such as a nightly job,
   * sets it. Without it, `scope:'full'` stays deferred. A diff-scoped run
   * ignores it.
   */
  readonly offline?: boolean;
  /** The resolved project config from the dispatch adapter. The handler reads its gate params. */
  readonly projectConfig?: ResolvedProjectConfig;

  /** Verification-runtime resolver. Defaults to {@link resolveVerificationRuntime}. */
  readonly resolve?: (repoRoot: string) => ResolvedVerificationRuntime;
  /** Toolchain-id resolver for the diff-scope table. Defaults to {@link detectToolchain}. */
  readonly detectToolchainId?: (repoRoot: string) => string | null;
  /** Mutation runner. Defaults to a real shell-out capturing stdout as the report. */
  readonly runMutation?: (args: MutationRunArgs) => MutationRunResult | Promise<MutationRunResult>;
  /**
   * The diff seam for the per-runner diff scope: PIT `<changed>` classes and
   * mutmut changed paths. The default is {@link defaultRunDiff}. Tests inject
   * it, so no real git runs.
   */
  readonly runDiff?: RunDiff;
}

/** Resolves the repo-relative paths changed since `base`. It fills the `<changed>` placeholder of PIT and mutmut. */
export type RunDiff = (base: string, repoRoot: string) => readonly string[];

/**
 * The default diff seam: `git diff --name-only <base>...HEAD`, the merge-base
 * form. A git failure gives `[]`, so a scope computation does not throw.
 */
export const defaultRunDiff: RunDiff = (base, repoRoot) => {
  const result = defaultGitExec(repoRoot, ['diff', '--name-only', `${base}...HEAD`]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

/**
 * Source extensions that a mutation runner can make mutants from. This is a
 * property of the file, not a list of directories, because a directory list
 * goes stale when the tree moves.
 */
const MUTATABLE_EXTENSIONS: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.py', '.rs', '.cs', '.go', '.kt',
];

/** Path segments whose contents no runner mutates (tests are the oracle, not the subject). */
const NON_MUTATABLE_MARKERS: readonly string[] = [
  '.test.', '.spec.', '/__tests__/', '/__mocks__/', '/__fixtures__/', '/fixtures/', '/node_modules/', '/dist/',
];

/**
 * The changed files that a mutation runner can make mutants from. With it, the
 * handler tells "no mutatable source changed" apart from "the run did not
 * reach the change" when a run gives zero mutants.
 */
export function mutatableChangedFiles(changed: readonly string[]): readonly string[] {
  return changed.filter((file) => {
    const normalized = `/${file.replace(/\\/g, '/')}`;
    if (NON_MUTATABLE_MARKERS.some((marker) => normalized.includes(marker))) return false;
    return MUTATABLE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
  });
}

/** Context the diff-scope applier needs to resolve a `<changed>` placeholder. */
export interface ScopeContext {
  readonly base: string;
  readonly repoRoot: string;
  readonly runDiff: RunDiff;
}

/**
 * Maps changed `.java` paths to class names for PIT `-DtargetClasses`. The name
 * is the path below `src/main/java/`, `src/test/java/`, or `java/`, with `/`
 * changed to `.` and no extension. A path with no source root uses its full
 * dotted form. Other files are ignored. The result has no duplicates and keeps
 * the order.
 */
function changedJavaClasses(files: readonly string[]): string[] {
  const classes = new Set<string>();
  for (const file of files) {
    const posix = file.replace(/\\/g, '/');
    if (!posix.endsWith('.java')) continue;
    const noExt = posix.slice(0, -'.java'.length);
    const rooted = noExt.match(/(?:^|\/)(?:src\/(?:main|test)\/java|java)\/(.+)$/);
    const rel = (rooted ? rooted[1] : noExt) ?? noExt;
    classes.add(rel.replace(/\//g, '.'));
  }
  return [...classes];
}

/**
 * The changed `.py` paths for the mutmut `--paths-to-mutate` flag, in POSIX
 * form, with no duplicates, in order. Mutmut also has a line-level scope with
 * `--use-patch-file`, but that needs a patch file on disk.
 */
function changedPythonPaths(files: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const posix = file.replace(/\\/g, '/');
    if (posix.endsWith('.py')) paths.add(posix);
  }
  return [...paths];
}

/**
 * Adds the per-runner diff scope from the toolchains registry to a mutation
 * command, so the handler does not know runners.
 *   - `append-flag`: appends the flag. When the flag has `<changed>` (PIT), the
 *     changed Java classes replace it. A literal `<changed>` must not reach the runner.
 *   - `path-restricted` (mutmut): the changed `.py` paths replace `<changed>`.
 *   - `already-native` (cargo-mutants): no change, and no diff read.
 *   - `unscoped-warning`: no change, with the warning.
 * With no changed file for the runner, the command runs unscoped with a warning.
 */
export function composeScopedCommand(
  command: string,
  scope: MutationDiffScope,
  ctx: ScopeContext,
): { readonly command: string; readonly warning?: string } {
  switch (scope.kind) {
    case 'append-flag': {
      if (scope.flag.includes('<changed>')) {
        const classes = changedJavaClasses(ctx.runDiff(ctx.base, ctx.repoRoot));
        if (classes.length === 0) {
          return {
            command,
            warning:
              `mutation diff-scope resolved no changed classes for flag ` +
              `'${scope.flag}' (the diff touched no Java sources); the mutation ` +
              `run is unscoped (full-tree) for now`,
          };
        }
        const flag = scope.flag.replace('<changed>', classes.join(','));
        return { command: `${command} ${flag}` };
      }
      return { command: `${command} ${scope.flag}` };
    }
    case 'already-native':
      return { command };
    case 'path-restricted': {
      const paths = changedPythonPaths(ctx.runDiff(ctx.base, ctx.repoRoot));
      if (paths.length === 0) {
        return {
          command,
          warning:
            `path-restricted mutation diff-scope resolved no changed paths ` +
            `(the diff touched no Python sources); the mutation run is unscoped ` +
            `(full-tree) for now`,
        };
      }
      const flag = scope.flag.replace('<changed>', paths.join(','));
      return { command: `${command} ${flag}` };
    }
    case 'unscoped-warning':
      return { command, warning: scope.warning };
  }
}

/** A directory entry reduced to what discovery needs (injectable fs seam). */
export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/** Directory listing seam. Returns `[]` for an unreadable directory. */
export type ReadDirSync = (dir: string) => readonly DirEntry[];

/** A bounded read of the head of a file. It gives `''` for an unreadable file. */
export type ReadFileHead = (file: string) => string;

/**
 * Filenames that identify the config of a mutation runner, in this order:
 * StrykerJS, Stryker.NET, Infection (PHP), mutant (Ruby), and cargo-mutants.
 * The directory of the match is the package that owns the config.
 */
export const MUTATION_CONFIG_FILE_PATTERNS: readonly RegExp[] = [
  /^\.?stryker\.conf(ig)?\.(mjs|cjs|js|json|jsonc)$/i,
  /^stryker-config\.(json|ya?ml)$/i,
  /^infection\.json5?(\.dist)?$/i,
  /^\.?mutant\.ya?ml$/i,
  /^\.?(cargo-)?mutants\.toml$/i,
];

/**
 * Configs inside a file that the project has for other reasons. The basename
 * alone proves nothing, so the file must also contain the section of the
 * runner. That is `[tool.mutmut]` or `[mutmut]` for mutmut, and `pitest` for
 * PIT in Maven or Gradle files.
 */
export const MUTATION_CONFIG_SECTION_MARKERS: ReadonlyArray<{
  readonly basename: string;
  readonly marker: RegExp;
}> = [
  { basename: 'pyproject.toml', marker: /^\s*\[tool\.mutmut\]/m },
  { basename: 'setup.cfg', marker: /^\s*\[mutmut\]/m },
  { basename: 'pom.xml', marker: /pitest/i },
  { basename: 'build.gradle', marker: /pitest/i },
  { basename: 'build.gradle.kts', marker: /pitest/i },
];

/**
 * Directory names that never hold the config of a project: dependency trees
 * and build output. They are kinds of directory, not named subtrees, so the
 * scan root stays the whole repository.
 */
const NON_SCANNABLE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'reports', 'target', 'vendor', 'tmp',
]);

/** Depth bound on the discovery walk, counted in directories below the root. */
export const MUTATION_CONFIG_SCAN_MAX_DEPTH = 5;

/** True for a directory that the walk enters. Dot-directories, such as `.git`, hold tool state, so the walk skips them. */
function isScannableDir(name: string): boolean {
  return !name.startsWith('.') && !NON_SCANNABLE_DIRS.has(name);
}

/** Lists `dir` for discovery. `isDirectory()` is false for a symlink, so the walk does not enter a symlinked directory and cannot loop. */
const defaultReadDir: ReadDirSync = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
    }));
  } catch {
    return [];
  }
};

/** Reads the first 64 KiB of a file. A failed read gives `''`. */
const defaultReadFileHead: ReadFileHead = (file) => {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, read).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
};

function isMutationConfigFile(name: string, fullPath: string, readHead: ReadFileHead): boolean {
  if (MUTATION_CONFIG_FILE_PATTERNS.some((re) => re.test(name))) return true;
  const lower = name.toLowerCase();
  const sectioned = MUTATION_CONFIG_SECTION_MARKERS.find((m) => m.basename === lower);
  return sectioned !== undefined && sectioned.marker.test(readHead(fullPath));
}

/** Tagged discovery result — an absent config is a typed signal, never a throw. */
export type MutationConfigDiscovery =
  | { readonly ok: true; readonly configPath: string; readonly packageDir: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Finds the config of the mutation runner under `repoRoot`, breadth-first. The
 * shallowest match wins, and a lexical sort breaks ties, so the listing order
 * does not change the answer. The walk visits the root plus
 * {@link MUTATION_CONFIG_SCAN_MAX_DEPTH} levels, and the failure reason says so.
 */
export function discoverMutationConfig(
  repoRoot: string,
  seams: { readonly readDir?: ReadDirSync; readonly readFileHead?: ReadFileHead } = {},
): MutationConfigDiscovery {
  const readDir = seams.readDir ?? defaultReadDir;
  const readHead = seams.readFileHead ?? defaultReadFileHead;

  let frontier: string[] = [repoRoot];
  for (let depth = 0; depth <= MUTATION_CONFIG_SCAN_MAX_DEPTH && frontier.length > 0; depth++) {
    const hits: string[] = [];
    const next: string[] = [];
    for (const dir of frontier) {
      for (const entry of readDir(dir)) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory) {
          if (isScannableDir(entry.name)) next.push(full);
        } else if (isMutationConfigFile(entry.name, full, readHead)) {
          hits.push(full);
        }
      }
    }
    if (hits.length > 0) {
      const configPath = [...hits].sort()[0]!;
      return { ok: true, configPath, packageDir: path.dirname(configPath) };
    }
    frontier = next.sort();
  }

  return {
    ok: false,
    reason:
      `no mutation-runner configuration was found under ${repoRoot} (searched the ` +
      `root plus ${MUTATION_CONFIG_SCAN_MAX_DEPTH} directory levels, skipping dot-directories and ` +
      `${[...NON_SCANNABLE_DIRS].join('/')})`,
  };
}

/**
 * The reason for the runner cwd, which the carrier reports. `declared-command`
 * means that discovery found no config, but the repository declared the command.
 */
export type MutationCwdRationale =
  | 'declared-runner-dir'
  | 'config-at-repo-root'
  | 'config-owner'
  | 'repo-root-anchored-command'
  | 'declared-command';

/** Tagged run-root resolution: a root the gate cannot justify is a degrade. */
export type MutationCwdResult =
  | {
      readonly ok: true;
      readonly cwd: string;
      readonly configPath: string | null;
      readonly rationale: MutationCwdRationale;
    }
  | { readonly ok: false; readonly reason: string };

/** Tokens that can name a file: flags never do, and a bare word is too ambiguous. */
function commandPathTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith('-'))
    .filter((t) => t.includes('/') || t.includes('\\') || /\.[cm]?[jt]sx?$|\.(sh|py|rb|php)$/i.test(t));
}

/**
 * True when the command names a path that exists from the repo root but not
 * from the config package. Such a command re-roots itself. In the config
 * package it cannot find its own file, or it runs on a missing tree and gives
 * an empty valid report. An absolute path resolves the same from any cwd, so
 * it does not count.
 */
function commandIsRepoRootAnchored(
  command: string,
  repoRoot: string,
  packageDir: string,
  pathExists: (p: string) => boolean,
): boolean {
  for (const token of commandPathTokens(command)) {
    if (path.isAbsolute(token)) continue;
    if (pathExists(path.resolve(repoRoot, token)) && !pathExists(path.resolve(packageDir, token))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves the directory that the mutation command runs in. A runner reads its
 * config and its local binary from that directory, so the config location
 * decides it.
 *   - A declared `runnerDir` wins. It must resolve inside the repository, with
 *     a separator check so `<repoRoot>-other` fails, and it must exist.
 *   - With no config found, a project-declared command runs at the repo root,
 *     because many runners have no config file. An inferred command degrades.
 *   - A config at the root, or a command anchored at the root, runs at the root.
 *     Else the command runs in the config package.
 */
export function resolveMutationRunnerCwd(input: {
  readonly command: string;
  readonly repoRoot: string;
  readonly declaredRunnerDir?: string | undefined;
  /**
   * True when the repository declared the mutation command itself rather than
   * the resolver inferring it. Absent reads as false — the conservative side,
   * so an injected runtime that never states provenance still gets the refusal.
   */
  readonly projectDeclaredCommand?: boolean | undefined;
  readonly discover?: (repoRoot: string) => MutationConfigDiscovery;
  readonly pathExists?: (p: string) => boolean;
}): MutationCwdResult {
  const pathExists = input.pathExists ?? existsSync;
  const repoRoot = path.resolve(input.repoRoot);

  if (input.declaredRunnerDir !== undefined) {
    const declared = path.resolve(repoRoot, input.declaredRunnerDir);
    const withinRepo =
      declared === repoRoot || declared.startsWith(`${repoRoot}${path.sep}`);
    if (!withinRepo) {
      return {
        ok: false,
        reason:
          `mutation-adequacy: the declared mutation runner directory ` +
          `'${input.declaredRunnerDir}' resolves to ${declared}, which is outside ` +
          `${repoRoot}. runnerDir is repo-root-relative; a directory outside the ` +
          `repository would be scored in place of the one under review`,
      };
    }
    if (!pathExists(declared)) {
      return {
        ok: false,
        reason:
          `mutation-adequacy: the declared mutation runner directory ` +
          `'${input.declaredRunnerDir}' does not exist under ${repoRoot} — the gate will ` +
          `not run the command in a directory it cannot resolve`,
      };
    }
    return { ok: true, cwd: declared, configPath: null, rationale: 'declared-runner-dir' };
  }

  const discovered = (input.discover ?? discoverMutationConfig)(repoRoot);
  if (!discovered.ok) {
    if (input.projectDeclaredCommand === true) {
      return {
        ok: true,
        cwd: repoRoot,
        configPath: null,
        rationale: 'declared-command',
      };
    }
    return {
      ok: false,
      reason:
        `mutation-adequacy: ${discovered.reason}. The gate cannot name the package the ` +
        `runner would read its configuration from, so it did NOT run the command — a ` +
        `mutation verdict from an unjustified run root is not evidence of adequacy. ` +
        `Declare it with review.gates['mutation-adequacy'].params.runnerDir.`,
    };
  }

  const packageDir = path.resolve(discovered.packageDir);
  if (packageDir === repoRoot) {
    return { ok: true, cwd: repoRoot, configPath: discovered.configPath, rationale: 'config-at-repo-root' };
  }
  if (commandIsRepoRootAnchored(input.command, repoRoot, packageDir, pathExists)) {
    return {
      ok: true,
      cwd: repoRoot,
      configPath: discovered.configPath,
      rationale: 'repo-root-anchored-command',
    };
  }
  return { ok: true, cwd: packageDir, configPath: discovered.configPath, rationale: 'config-owner' };
}

/** Repo-relative rendering of a path for the carrier (`.` for the root itself). */
function relativeToRepo(repoRoot: string, target: string): string {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(target)).replace(/\\/g, '/');
  return rel.length === 0 ? '.' : rel;
}

/**
 * Keeps the last `maxChars` characters of captured output, with a truncation
 * marker when it cuts. A runner failure is usually at the end of its output.
 * The bound keeps a full runner transcript out of a degrade reason.
 */
function boundedTail(text: string, maxChars = 1500): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)…${trimmed.slice(-maxChars)}`;
}

/**
 * The default runner. It runs the command in `args.cwd` and uses stdout as the
 * Stryker report. It uses `runCommandSync`, because `execFile` does not start
 * the `.cmd` shim of a package manager on Windows (CVE-2024-27980). A non-zero
 * exit with stdout is still a report, because runners exit non-zero below their
 * own threshold. With no stdout, the reason carries a bounded tail of stderr.
 */
function defaultRunMutation(args: MutationRunArgs): MutationRunResult {
  const tokens = args.command.split(/\s+/).filter((t) => t.length > 0);
  const [bin, ...rest] = tokens;
  if (!bin) return { ok: false, reason: 'no resolvable mutation command' };
  try {
    const stdout = runCommandSync(bin, rest, {
      cwd: args.cwd,
      timeout: 600_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    return { ok: true, report: stdout };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const out = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '';
    if (out.trim().length > 0) return { ok: true, report: out };
    const errOut = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '';
    const tail = boundedTail(errOut.length > 0 ? errOut : out);
    return {
      ok: false,
      reason:
        `mutation run produced no report (exit ${e.status ?? 'unknown'})` +
        (tail.length > 0 ? `; runner stderr (tail): ${tail}` : ''),
    };
  }
}

/** Maps surviving and NoCoverage mutants to "write a test that kills file:line" next actions. */
function survivorAffordances(report: MutationReport): string[] {
  const actions: string[] = [];
  for (const [file, result] of Object.entries(report.files)) {
    for (const m of result.mutants) {
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        actions.push(`write a test that kills ${file}:${m.location.start.line}`);
      }
    }
  }
  return actions;
}

/** Lists each NoCoverage mutant as `file:line`, in order, for the failure message of the NoCoverage axis. */
function noCoverageMutants(report: MutationReport): Array<{ file: string; line: number }> {
  const out: Array<{ file: string; line: number }> = [];
  for (const [file, result] of Object.entries(report.files)) {
    for (const m of result.mutants) {
      if (m.status === 'NoCoverage') out.push({ file, line: m.location.start.line });
    }
  }
  return out;
}

/**
 * The mutation-adequacy action handler. An unknown `scope` gives INVALID_INPUT,
 * not a silent `'diff'`. A full scope without `offline` gives a deferred
 * advisory and runs nothing. With no mutation runner, it records a skip-pass,
 * so the required review dimension is present.
 *
 * It resolves the run root before the liveness pair, so a refusal leaves no
 * unpaired start. The terminal liveness event lands on each exit path after the
 * start. An empty mutant surface is a trivial pass only when the diff changed no
 * mutatable file, and a degrade otherwise. The NoCoverage axis applies only to
 * diff scope. The dispatch adapter applies severity after the handler returns.
 */
export async function handleMutationAdequacy(
  args: MutationAdequacyArgs,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!eventStore) {
    return {
      success: false,
      error: { code: 'MISWIRED_CONTEXT', message: 'handleMutationAdequacy: eventStore is required' },
    };
  }
  if (!args.featureId) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'featureId is required' } };
  }
  if (!args.base) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'base is required' } };
  }

  let scope: 'diff' | 'full';
  if (args.scope === undefined) {
    scope = 'diff';
  } else if (args.scope === 'diff' || args.scope === 'full') {
    scope = args.scope;
  } else {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: `scope must be 'diff' or 'full' when provided (got '${args.scope}')`,
      },
    };
  }

  if (scope === 'full' && !args.offline) {
    return {
      success: true,
      data: {
        passed: true,
        deferred: true,
        scope: 'full',
        mutationScore: 0,
        killed: 0,
        survived: 0,
        noCoverage: 0,
        total: 0,
        reason:
          'full-tree mutation is the long-running op deferred to R10/v2.12 ' +
          '(nightly/offline via the Task lifecycle verbs); only diff-scoped runs ' +
          'execute inline this slice',
      },
    };
  }

  const resolved = await resolveRepoRoot(
    {
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      featureId: args.featureId,
      taskId: args.taskId,
    },
    eventStore,
  );
  if (!resolved.ok) {
    return { success: false, error: { code: 'INVALID_INPUT', message: resolved.error } };
  }
  const repoRoot = resolved.repoRoot;

  const resolve = args.resolve ?? resolveVerificationRuntime;
  let runtime: ResolvedVerificationRuntime;
  try {
    runtime = resolve(repoRoot);
  } catch (err) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (!runtime.mutation) {
    const reason =
      runtime.remediation ??
      'no mutation runner resolved for this repository — install one (e.g. stryker, ' +
        'cargo-mutants, mutmut) or set `mutation:` in .exarchos.yml';
    const gateCarrier: ToolResult = {
      success: true,
      data: {
        passed: true,
        skipped: true,
        reason,
        mutationScore: 0,
        killed: 0,
        survived: 0,
        noCoverage: 0,
        total: 0,
      },
    };
    const unrecorded = await requireGateEvent(
      eventStore,
      args.featureId,
      MUTATION_GATE_NAME,
      MUTATION_GATE_LAYER,
      true,
      gateCarrier,
      { skipped: true, reason, mutationScore: 0 },
      mutationGateKey(args.operationId, 'skip-no-toolchain'),
    );
    if (unrecorded !== undefined) return unrecorded;
    return gateCarrier;
  }

  const runDiff = args.runDiff ?? defaultRunDiff;
  const scoped: { readonly command: string; readonly warning?: string } =
    scope === 'full'
      ? { command: runtime.mutation }
      : (() => {
          const detect =
            args.detectToolchainId ?? ((root: string) => detectToolchain(root)?.id ?? null);
          const toolchainId = detect(repoRoot) ?? '';
          const diffScope = resolveMutationDiffScope(toolchainId, args.base);
          return composeScopedCommand(runtime.mutation, diffScope, {
            base: args.base,
            repoRoot,
            runDiff,
          });
        })();

  const runnerCwd = resolveMutationRunnerCwd({
    command: scoped.command,
    repoRoot,
    declaredRunnerDir: resolveDeclaredRunnerDir(args),
    projectDeclaredCommand: runtime.mutationProjectDeclared,
  });
  if (!runnerCwd.ok) {
    return emitAdvisoryGate(eventStore, args, runnerCwd.reason, scoped.warning);
  }
  const cwd = runnerCwd.cwd;

  const runMutation = args.runMutation ?? defaultRunMutation;
  const instanceId = args.operationId ?? randomUUID();
  await emitLiveness(eventStore, args.featureId, 'mutation.executing_started', {
    command: scoped.command,
    repoRoot,
    cwd,
    instanceId,
  });
  let runResult: MutationRunResult;
  try {
    runResult = await runMutation({ command: scoped.command, repoRoot, cwd, base: args.base });
  } catch (err) {
    await emitLiveness(eventStore, args.featureId, 'mutation.executed', {
      command: scoped.command,
      repoRoot,
      cwd,
      passed: false,
      exitCode: 1,
      instanceId,
    });
    return {
      success: false,
      error: { code: 'SCRIPT_ERROR', message: err instanceof Error ? err.message : String(err) },
    };
  }
  await emitLiveness(eventStore, args.featureId, 'mutation.executed', {
    command: scoped.command,
    repoRoot,
    cwd,
    passed: runResult.ok,
    exitCode: runResult.ok ? 0 : 1,
    instanceId,
  });

  if (!runResult.ok) {
    return emitAdvisoryGate(eventStore, args, runResult.reason, scoped.warning);
  }

  const parsed = parseMutationReport(runResult.report);
  if (!parsed.ok) {
    return emitAdvisoryGate(eventStore, args, parsed.reason, scoped.warning);
  }

  const carrier = parsed.carrier;
  const threshold = resolveThreshold(args);
  const maxNoCoverage = resolveMaxNoCoverage(args);

  const changedMutatable = mutatableChangedFiles(runDiff(args.base, repoRoot));
  const emptyMutantSurface = carrier.total === 0;
  const trivialPass = emptyMutantSurface && changedMutatable.length === 0;

  if (emptyMutantSurface && !trivialPass) {
    const reason =
      `mutation-adequacy: the runner produced ZERO mutants while the diff changed ` +
      `${changedMutatable.length} mutatable file(s) (e.g. ${changedMutatable
        .slice(0, 3)
        .join(', ')}) — the run did not cover the change, so this is NOT evidence ` +
      `of adequacy. The command \`${scoped.command}\` ran in ` +
      `'${relativeToRepo(repoRoot, cwd)}' (${runnerCwd.rationale}) against the ` +
      `mutation config ` +
      `'${runnerCwd.configPath === null ? '<declared runner dir>' : relativeToRepo(repoRoot, runnerCwd.configPath)}'.`;
    return emitAdvisoryGate(eventStore, args, reason, scoped.warning);
  }

  const noCoverageBlocks =
    scope === 'diff' && !trivialPass && carrier.noCoverage > maxNoCoverage;
  const noCoverageReason = noCoverageBlocks
    ? `mutation-adequacy: ${carrier.noCoverage} uncovered (NoCoverage) mutant(s) ` +
      `exceed the diff-scoped budget of ${maxNoCoverage} — ` +
      `${noCoverageMutants(parsed.report)
        .map((u) => `${u.file}:${u.line}`)
        .join(', ')}`
    : undefined;

  const passed = trivialPass || (carrier.mutationScore >= threshold && !noCoverageBlocks);
  const nextActions = survivorAffordances(parsed.report);

  const resultCarrier: ToolResult = {
    success: true,
    ...(scoped.warning ? { warnings: [scoped.warning] } : {}),
    data: {
      passed,
      mutationScore: carrier.mutationScore,
      killed: carrier.killed,
      survived: carrier.survived,
      noCoverage: carrier.noCoverage,
      total: carrier.total,
      threshold,
      maxNoCoverage,
      runnerCwd: relativeToRepo(repoRoot, cwd),
      runnerCwdRationale: runnerCwd.rationale,
      mutationConfigPath:
        runnerCwd.configPath === null ? null : relativeToRepo(repoRoot, runnerCwd.configPath),
      ...(trivialPass ? { trivialPass: true } : {}),
      ...(noCoverageReason ? { noCoverageReason } : {}),
      report: parsed.report,
      next_actions: nextActions,
    },
  };

  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    MUTATION_GATE_NAME,
    MUTATION_GATE_LAYER,
    passed,
    resultCarrier,
    {
      mutationScore: carrier.mutationScore,
      killed: carrier.killed,
      survived: carrier.survived,
      noCoverage: carrier.noCoverage,
      total: carrier.total,
      threshold,
    },
    mutationGateKey(args.operationId, 'scored'),
  );
  if (unrecorded !== undefined) return unrecorded;

  return resultCarrier;
}

/**
 * The idempotency key for a mutation `gate.executed` event, with the outcome as
 * a suffix. Events with the same key collapse to one row. The suffix lets a
 * scored row follow a skip or degrade row of the same run, and a retry of the
 * same outcome still collapses. It is `undefined` when no `operationId` is given.
 */
function mutationGateKey(
  operationId: string | undefined,
  outcome: 'scored' | 'degraded' | 'skip-no-toolchain',
): string | undefined {
  return operationId === undefined ? undefined : `${operationId}:${outcome}`;
}

/**
 * The declared run root, `review.gates['mutation-adequacy'].params.runnerDir`,
 * relative to the repo root. It is for a runner with no config file to find,
 * such as cargo-mutants at its defaults.
 */
function resolveDeclaredRunnerDir(args: MutationAdequacyArgs): string | undefined {
  const raw = args.projectConfig?.review.gates[MUTATION_GATE_NAME]?.params?.runnerDir;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Resolve the effective threshold: arg override > config > soft default. */
function resolveThreshold(args: MutationAdequacyArgs): number {
  if (typeof args.threshold === 'number') return args.threshold;
  const configured = args.projectConfig?.review.gates[MUTATION_GATE_NAME]?.params?.threshold;
  if (typeof configured === 'number') return configured;
  return DEFAULT_MUTATION_THRESHOLD;
}

/**
 * Resolves the NoCoverage budget: the argument, then the config, then the
 * default. The budget is a count, so only a non-negative integer is valid at
 * each layer. An invalid value falls through to the next layer. This rule
 * rejects a NaN budget, which disarms the axis, and a negative budget, which
 * blocks each run that is not a trivial pass.
 */
function resolveMaxNoCoverage(args: MutationAdequacyArgs): number {
  if (
    typeof args.maxNoCoverage === 'number' &&
    Number.isInteger(args.maxNoCoverage) &&
    args.maxNoCoverage >= 0
  ) {
    return args.maxNoCoverage;
  }
  const configured = args.projectConfig?.review.gates[MUTATION_GATE_NAME]?.params?.maxNoCoverage;
  if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
    return configured;
  }
  return DEFAULT_MAX_NO_COVERAGE;
}

/**
 * Records a passing advisory `gate.executed` for a degrade: a runner is present,
 * but the gate has no score to trust. The causes are an unjustified run root, a
 * failed run, a report that does not parse, and zero mutants for a diff with
 * mutatable files. The skip-pass keeps the required review dimension present,
 * so `review → synthesize` does not block.
 *
 * The marker `{ skipped: true, degraded: true }` differs from the no-toolchain
 * skip-pass. With `review.mutationEnforcement: 'block'`, `degraded` makes the
 * score check fail closed, because a broken runner gave no score. When the
 * append fails, the call returns the append error, not the Warning carrier.
 */
async function emitAdvisoryGate(
  eventStore: EventStore,
  args: MutationAdequacyArgs,
  reason: string,
  scopeWarning?: string,
): Promise<ToolResult> {
  const carrier = warningCarrier(reason, scopeWarning);
  const unrecorded = await requireGateEvent(
    eventStore,
    args.featureId,
    MUTATION_GATE_NAME,
    MUTATION_GATE_LAYER,
    true,
    carrier,
    { skipped: true, degraded: true, reason, mutationScore: 0 },
    mutationGateKey(args.operationId, 'degraded'),
  );
  return unrecorded ?? carrier;
}

/** Builds a degraded Warning carrier. */
function warningCarrier(reason: string, scopeWarning?: string): ToolResult {
  const warnings = scopeWarning ? [scopeWarning, reason] : [reason];
  return {
    success: true,
    warnings,
    data: {
      passed: true,
      warning: reason,
      mutationScore: 0,
      killed: 0,
      survived: 0,
      noCoverage: 0,
      total: 0,
    },
  };
}

/**
 * Appends a liveness event and does not throw, because an emission failure must
 * not fail a mutation run that succeeded. It logs a failure.
 *   - A lost `mutation.executing_started` heals itself. With no start, no
 *     instance is in flight.
 *   - A lost `mutation.executed` does not. `computeInFlightInstances` has no age
 *     eviction, so the start shows as in flight to `ps` and
 *     `wait --operation mutation` until a registry terminal for its
 *     `instanceId` is appended. The log names that instance.
 */
async function emitLiveness(
  store: EventStore,
  stream: string,
  type: 'mutation.executing_started' | 'mutation.executed',
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await store.append(stream, { type, data });
  } catch (err) {
    const terminal = type === 'mutation.executed';
    orchestrateLogger.warn(
      {
        stream,
        type,
        instanceId: data.instanceId,
        err: err instanceof Error ? err.message : String(err),
        ...(terminal ? { consequence: 'unpaired-start-reports-in-flight' } : {}),
      },
      terminal
        ? 'mutation-adequacy: failed to emit terminal mutation.executed — `ps`/`wait --operation mutation` will report this instance in-flight until a registry terminal is appended for it (S-6 recovery)'
        : 'mutation-adequacy: failed to emit mutation.executing_started — run proceeds untracked',
    );
  }
}
