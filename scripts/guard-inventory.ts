// scripts/guard-inventory.ts
//
// DR-24 / task 063 — the Wave-1 guard inventory and its CI-reachability proof.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// R-11 — "the mechanism ships and nothing calls it" — is this program's declared
// dominant risk, and Wave 1 accumulated instances of it faster than anything
// noticed. Each was reported by the task that shipped it, against its own work:
// `resolveDispatchShape` has no production caller; the `auditVacuity*` family is
// driven only by co-located vitest; `cli-derivation-guard` is complete but
// deliberately unwired; the authority census runs only inside a PATH-FILTERED
// job, so G5 is unenforced on every PR that does not touch MCP paths.
//
// Task 054 proved the class is live rather than theoretical: registering its gate
// surfaced that `npm run validate` is invoked by NO workflow, so a validate-only
// wiring would itself have been R-11. `scripts/enforcer-wiring-manifest.json`
// names that trap class `unreachable-npm`.
//
// This module answers, per guard: WHICH CI JOB runs it, whether that job is
// PATH-FILTERED, and whether it BLOCKS or merely OBSERVES.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DERIVED AND WHAT IS NOT — READ THIS BEFORE EDITING
//
// This program has been bitten repeatedly by instruments measuring a text proxy
// instead of a structural fact, and twice by hand-maintained lists that silently
// omitted a member. A guard absent from this inventory is the one place an
// unwired guard can hide from the instrument built to find it. So the split is
// stated explicitly rather than left to inference:
//
//   DERIVED (no hand-maintenance anywhere in the chain)
//     - The guard POPULATION, from three independent channels (see below). A
//       guard has to hide from all three to escape.
//     - Every VERDICT: hosting job, path-filter keys, blocking-vs-observing,
//       and production reachability. All parsed out of `.github/workflows/*.yml`,
//       the two `package.json` script tables, the two `vitest.config.ts` include
//       globs, and TypeScript import specifiers. Never asserted.
//
//   HAND-MAINTAINED (small, reviewable, and EXPIRING by construction)
//     - {@link GUARD_EXEMPTIONS}: the record of a guard that is deliberately not
//       reachable from CI. Each entry carries an owner, a blocking reason, and an
//       ISO expiry. An expired entry FAILS. An entry whose guard turns out to be
//       reachable FAILS (a stale exemption is a wiring lie). An entry naming a
//       guard outside the inventory FAILS.
//
//   NOT DERIVABLE AT ALL — stated so it cannot be mistaken for coverage
//     - A guard's SCAN SURFACE (the files it reads). `docs/guides/ci-gate-hosting.md`'s
//       two-surface subset rule needs both the scan surface and the implementation
//       surface. Only the implementation surface is a structural fact about the
//       guard's own path, so {@link auditGuardInventory} enforces THAT half and
//       reports the other half as unproven. Concretely: `dispatch-shape.ts`'s
//       prose-binding test reads `skills-src/**`, which is outside its host job's
//       `mcp` filter — a real two-surface violation this instrument cannot see.
//     - Whether a job is a REQUIRED branch-protection check. That is repo
//       settings, out-of-repo, and not YAML-assertable (ci.yml says so itself in
//       two places). For `ci.yml` the `ci-gate` aggregator stands in for it; for
//       every other workflow, "blocking" means only "runs on pull_request and its
//       exit code is not swallowed".
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE DISCOVERY CHANNELS
//
//   1. ENFORCER-MANIFEST PRIMARIES. Every non-`retired` entry in
//      `scripts/enforcer-wiring-manifest.json`. This channel guarantees the
//      inventory's denominator is never SMALLER than the manifest's, so a new
//      `scripts/check-*|lint-*` gate enters this inventory automatically — its
//      author cannot forget. Note the manifest's own enumerator
//      (`enumeratePrimaryFiles`) globs `scripts/(check|lint)-*.{mjs,sh}` at the
//      ROOT scripts dir only: not `.ts`, not `scripts/audit/`, not
//      `servers/exarchos-mcp/scripts/`. Channel 3 exists because of that hole.
//
//   2. WAVE-1 SPEC ARTIFACTS. The `**Files:**` line of every Wave-1 task in
//      `docs/specs/2026-08-06-internal-mechanics-overhaul.md`. Wave membership is
//      parsed from the `**Wave N…**` headers, and `[ANCHOR]` tasks (the Wave 2–5
//      placeholders that trail the Wave-1 block with no intervening header) are
//      excluded by their own heading tag — never by a task-number range.
//
//   3. RUNNABLE GATES UNDER `servers/exarchos-mcp/scripts/`. A module is a guard
//      executable iff it has a STATEMENT-LEVEL `process.exit(…)` entrypoint (a
//      real parse, not a name match or a text scan) AND a co-located self-test.
//      The self-test half is DR-24's own definition of a guard — "each guard's
//      self-test runs in the same CI job as the guard" — so it is the criterion
//      this program already committed to, not one invented here. A runnable
//      module with no co-located self-test is REPORTED
//      ({@link GuardInventory.runnableWithoutSelfTest}) rather than silently
//      dropped, so the exclusion stays reviewable.
//
// The union is deduplicated by repo-relative path.
//
// ─────────────────────────────────────────────────────────────────────────────
// KNOWN BLIND SPOT, REPORTED RATHER THAN CLOSED
//
// `scripts/audit/` is scanned by neither the enforcer manifest nor channel 3, and
// two runnable gates there (`check-base-substrate.ts`, `check-protected.mjs`) are
// referenced by no workflow and no npm script. They belong to the wave-S / wave-3b
// enforcement substrate, not to Wave 1, so closing them is out of this task's
// scope — but the hole is real and is recorded here so it is not rediscovered.
//
// Implements: DR-24.

import { readdirSync, readFileSync, existsSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root — `<repo>/scripts` → `<repo>`. */
export const REPO_ROOT = resolve(HERE, '..');

/** The spec whose Wave-1 task set is channel 2's denominator. */
export const SPEC_PATH = 'docs/specs/2026-08-06-internal-mechanics-overhaul.md';
/** The enforcer-wiring manifest — channel 1's denominator. */
export const MANIFEST_PATH = 'scripts/enforcer-wiring-manifest.json';
/** Channel 3's scan root. */
export const MCP_SCRIPTS_DIR = 'servers/exarchos-mcp/scripts';
/** The aggregator that decides which `ci.yml` job can fail a PR. */
export const AGGREGATOR_JOB = 'ci-gate';
/** The workflow that hosts the aggregator. */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

// ─── Workflow model ──────────────────────────────────────────────────────────

export interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly 'working-directory'?: string;
  readonly 'continue-on-error'?: boolean | string;
}

export interface WorkflowJob {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly steps?: readonly WorkflowStep[];
  readonly defaults?: { readonly run?: { readonly 'working-directory'?: string } };
  readonly 'continue-on-error'?: boolean | string;
}

export interface Workflow {
  readonly on?: unknown;
  readonly jobs?: Record<string, WorkflowJob>;
}

/** A workflow file plus its repo-relative path. */
export interface LoadedWorkflow {
  readonly path: string;
  readonly doc: Workflow;
}

export function parseWorkflow(path: string, raw: string): LoadedWorkflow {
  const loaded: unknown = yaml.load(raw);
  if (loaded === null || typeof loaded !== 'object') {
    throw new Error(`${path}: workflow did not parse to an object`);
  }
  const doc: Workflow = loaded;
  if (doc.jobs === undefined || typeof doc.jobs !== 'object') {
    throw new Error(`${path}: parsed workflow has no top-level "jobs" map`);
  }
  return { path, doc };
}

/** Loads every `.yml`/`.yaml` under `.github/workflows`. Fails closed on an unreadable dir. */
export function loadWorkflows(repoRoot: string = REPO_ROOT): LoadedWorkflow[] {
  const dir = join(repoRoot, '.github', 'workflows');
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: LoadedWorkflow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const rel = `.github/workflows/${entry.name}`;
    out.push(parseWorkflow(rel, readFileSync(join(dir, entry.name), 'utf8')));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function needsList(job: WorkflowJob | undefined): string[] {
  const needs = job?.needs;
  if (needs === undefined) return [];
  // Discriminated on `typeof`, not `Array.isArray`: the latter does not narrow a
  // `readonly string[]` out of the union, and widening it back with an assertion
  // would spend cast budget to work around a check that already holds.
  return typeof needs === 'string' ? [needs] : [...needs];
}

/**
 * The `changes.outputs.<key>` set a job's `if:` gates on, parsed out of the raw
 * `if:` text. Never a hardcoded job→key table — the same derivation
 * `scripts/ci-topology.test.ts` uses, for the same reason.
 */
export function pathFilterKeys(job: WorkflowJob | undefined): string[] {
  const ifText = job?.if ?? '';
  const pattern = /needs\.changes\.outputs\.([A-Za-z0-9_-]+)/g;
  const keys = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(ifText)) !== null) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

/** Recovers the `dorny/paths-filter` glob lists from the `changes` job. */
export function pathFilterGlobs(workflow: Workflow): Record<string, string[]> {
  const job = workflow.jobs?.['changes'];
  const filterStep = (job?.steps ?? []).find(
    (s) => typeof s.uses === 'string' && s.uses.startsWith('dorny/paths-filter'),
  );
  const raw = filterStep?.with?.['filters'];
  if (typeof raw !== 'string') return {};
  const parsed: unknown = yaml.load(raw);
  if (parsed === null || typeof parsed !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      out[key] = value.filter((v): v is string => typeof v === 'string');
    }
  }
  return out;
}

// ─── npm-script expansion ────────────────────────────────────────────────────

export interface PackageScripts {
  /** Repo-relative directory the package lives in (`''` for the root package). */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
}

export function readPackageScripts(repoRoot: string, dir: string): PackageScripts {
  const file = join(repoRoot, dir, 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const scripts =
    parsed !== null && typeof parsed === 'object' && 'scripts' in parsed
      ? (parsed as { scripts?: unknown }).scripts
      : undefined;
  const table: Record<string, string> = {};
  if (scripts !== null && typeof scripts === 'object') {
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body === 'string') table[name] = body;
    }
  }
  return { dir, scripts: table };
}

/**
 * Expand `npm run <name>` (and `npm run <name> --`) transitively against a
 * package's script table, so a step that runs `npm run skills:guard` is seen to
 * execute `node scripts/lint-test-first-drift.mjs` — the class-2 `unreachable-npm`
 * trap a name-grep cannot see. Cycles terminate via the `seen` set.
 */
export function expandNpmScripts(command: string, pkg: PackageScripts, seen = new Set<string>()): string {
  let out = command;
  const re = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const name = m[1];
    if (name !== undefined) names.push(name);
  }
  for (const name of names) {
    if (seen.has(name)) continue;
    const body = pkg.scripts[name];
    if (body === undefined) continue;
    seen.add(name);
    out += `\n${expandNpmScripts(body, pkg, seen)}`;
  }
  return out;
}

// ─── Guard population ────────────────────────────────────────────────────────

export type GuardChannel = 'enforcer-manifest' | 'wave1-spec' | 'mcp-scripts-gate';

/**
 * How a CI job reaches a guard.
 *
 * `'direct'`    — a step executes the guard's own entrypoint (npm chains expanded).
 * `'self-test'` — a step runs the guard's co-located test, either as a vitest
 *                 suite member or as a named `.test.sh` re-assert.
 *
 * The distinction is load-bearing and was learned the hard way on this very
 * inventory. `cli-derivation-guard`'s co-located test runs on every MCP-touching
 * PR — and asserts the CURRENT literal count (11), not the POLICY (zero). Its
 * self-test is hosted; its gate is not. Treating "the self-test runs" as "the
 * guard is wired" would have reported the single guard this task exists to find
 * as green. See {@link isEnforcingHost}.
 */
export type HostingVia = 'direct' | 'self-test';

export type Enforcement = 'blocks' | 'observes' | 'unreachable';

export interface GuardHost {
  /** Repo-relative workflow path. */
  readonly workflow: string;
  readonly job: string;
  readonly via: HostingVia;
  /** `changes.outputs.*` keys gating the job; empty means unfiltered. */
  readonly pathFilterKeys: readonly string[];
  /** True when the step (or job) swallows the exit code. */
  readonly exitSwallowed: boolean;
  /**
   * True when the host workflow declares a `pull_request` trigger. A host that
   * only fires on a tag push (`release.yml` runs the whole root suite) is a real
   * execution site but is NOT pre-merge coverage, so it must not stand in for one.
   */
  readonly onPullRequest: boolean;
  /** True when a failure of this job can fail the PR, as far as YAML can say. */
  readonly blocking: boolean;
}

/**
 * Which hosts actually enforce a guard's POLICY, as opposed to merely running
 * its unit tests.
 *
 * A RUNNABLE guard (one with its own `process.exit` entrypoint, or a shell
 * script) states its verdict by exiting non-zero, so only a step that EXECUTES
 * it enforces anything. A non-runnable source module has no entrypoint — its
 * co-located vitest IS the enforcement path, which is exactly how the
 * `auditVacuity*` family and the authority census are enforced today.
 */
export function isEnforcingHost(host: GuardHost, runnable: boolean): boolean {
  return runnable ? host.via === 'direct' : true;
}

export interface GuardRecord {
  /** Repo-relative, forward-slashed path of the guard artifact. */
  readonly artifact: string;
  /** Every channel that discovered it — more than one is normal and good. */
  readonly channels: readonly GuardChannel[];
  /** Wave-1 task ids that name this artifact, when channel 2 saw it. */
  readonly wave1Tasks: readonly string[];
  readonly hosts: readonly GuardHost[];
  /** True when the guard states its verdict by exiting — see {@link isEnforcingHost}. */
  readonly runnable: boolean;
  readonly enforcement: Enforcement;
  /**
   * True when every ENFORCING host is path-filtered. #1711's skipped-as-passed
   * failure is the reason this field exists: a gate in a path-filtered job is
   * skipped-as-passed on exactly the PRs it polices.
   */
  readonly pathFilteredOnly: boolean;
  /**
   * True when some NON-test module imports a named binding from this artifact.
   * `false` is the R-11 signal — "the mechanism ships and nothing calls it" —
   * and is orthogonal to CI reachability: a guard can be executed by CI (through
   * its co-located vitest) while having no production caller at all.
   * `null` when the artifact is not a TypeScript module, so the question does
   * not apply and cannot be silently answered "yes".
   */
  readonly productionImported: boolean | null;
}

export interface GuardInventory {
  readonly guards: readonly GuardRecord[];
  /**
   * Runnable modules under {@link MCP_SCRIPTS_DIR} with NO co-located self-test.
   * Excluded from the guard population by DR-24's own definition ("each guard's
   * self-test runs in the same CI job as the guard"), and listed so that
   * exclusion is reviewable rather than silent.
   */
  readonly runnableWithoutSelfTest: readonly string[];
  /**
   * Wave-1 source artifacts with no co-located self-test and no runnable
   * entrypoint — modules whose enforcement rung is COMPILE TIME (`tsc --noEmit`
   * in the typecheck steps), e.g. `output-schema-declaration.ts` and
   * `sdk/brand.ts`. They carry no executable verdict, so execution-reachability
   * is not a question that can be asked of them. Reported, never silently
   * dropped: a guard that loses its self-test would land here rather than
   * disappearing.
   */
  readonly compileTimeOnlyArtifacts: readonly string[];
  /**
   * Path-shaped `**Files:**` entries of Wave-1 tasks that do not resolve on disk.
   * A drift signal (renamed or not-yet-landed), reported not failed — Wave-1
   * tasks legitimately name files their own task has not landed yet.
   */
  readonly unresolvedSpecArtifacts: readonly string[];
}

// ─── Channel 1: enforcer-manifest primaries ──────────────────────────────────

interface ManifestEntry {
  readonly script?: unknown;
  readonly disposition?: unknown;
}

export function manifestPrimaries(manifestJson: unknown): string[] {
  if (manifestJson === null || typeof manifestJson !== 'object') return [];
  const primaries = (manifestJson as { primaries?: unknown }).primaries;
  if (!Array.isArray(primaries)) return [];
  const out: string[] = [];
  for (const raw of primaries) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry: ManifestEntry = raw;
    if (typeof entry.script !== 'string') continue;
    if (entry.disposition === 'retired') continue;
    out.push(entry.script);
  }
  return out.sort();
}

// ─── Channel 2: Wave-1 spec artifacts ────────────────────────────────────────

export interface SpecTask {
  readonly id: string;
  /** The `**Wave …**` label in force at the heading, or `null` before any header. */
  readonly wave: string | null;
  readonly isAnchor: boolean;
  readonly files: readonly string[];
}

/**
 * Parse the spec's task table. Wave membership comes from the `**Wave N…**`
 * headers; `[ANCHOR]` tasks are tagged from their own heading. Both are
 * structural features of the document, so a re-ordered or renumbered task set
 * stays correctly attributed.
 */
export function parseSpecTasks(specText: string): SpecTask[] {
  const tasks: { id: string; wave: string | null; isAnchor: boolean; files: string[] }[] = [];
  let wave: string | null = null;
  let current: { id: string; wave: string | null; isAnchor: boolean; files: string[] } | null = null;
  for (const line of specText.split('\n')) {
    const waveHeader = /^\*\*Wave\s+([^\s—-]+)/.exec(line);
    if (waveHeader !== null) {
      wave = waveHeader[1] ?? null;
      continue;
    }
    const heading = /^###\s+Task\s+(\d{3}):\s*(.*)$/.exec(line);
    if (heading !== null) {
      const id = heading[1];
      const title = heading[2] ?? '';
      if (id !== undefined) {
        current = { id, wave, isAnchor: title.trimStart().startsWith('[ANCHOR]'), files: [] };
        tasks.push(current);
      }
      continue;
    }
    if (current !== null && /^\*\*Files:\*\*/.test(line)) {
      for (const m of line.matchAll(/`([^`]+)`/g)) {
        const value = m[1];
        if (value !== undefined) current.files.push(value);
      }
    }
  }
  return tasks;
}

/** Wave-1 tasks: the wave label starts with `1` and the heading carries no `[ANCHOR]` tag. */
export function wave1Tasks(tasks: readonly SpecTask[]): SpecTask[] {
  return tasks.filter((t) => t.wave !== null && t.wave.startsWith('1') && !t.isAnchor);
}

/**
 * True for a backtick span that is shaped like a repo-relative file path.
 *
 * The `**Files:**` lines also carry directories (`src/`), slash-commands
 * (`/exarchos:invariants`) and bare prose (`as`). Requiring a dotted extension,
 * no whitespace, no colon and no leading slash keeps those out WITHOUT a
 * hand-maintained rejection list — and, crucially, keeps a renamed real path IN
 * (it stays path-shaped, so it surfaces via {@link GuardInventory.unresolvedSpecArtifacts}
 * instead of vanishing).
 */
export function isPathShaped(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith('/') || value.includes(':') || /\s/.test(value)) return false;
  if (value.endsWith('/')) return false;
  return /\.[A-Za-z0-9]+$/.test(value);
}

/** Test-file paths are subjects of the inventory's hosting resolution, never guards themselves. */
export function isTestArtifact(path: string): boolean {
  return /\.(test|type-test|bench|smoke\.test)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)__tests__\//.test(path);
}

// ─── Channel 3: runnable gates with a co-located self-test ───────────────────

/**
 * True iff the module has a STATEMENT-LEVEL `process.exit(…)` — one not nested
 * inside a function body, so it executes on load and can fail a build.
 *
 * A real parse, deliberately: `cli-derivation-guard.ts` records that a naive
 * `/\.command\(/` over the very file it governs reports 15 sites instead of 14
 * because a JSDoc block writes the call in prose. Comments are blanked
 * STRUCTURALLY here for the same reason — the parser classifies them as trivia,
 * so they never become `CallExpression` nodes at all.
 *
 * Fails CLOSED: a source the parser had to recover from throws rather than
 * contributing a `false` that would read as "not a gate".
 */
export function hasDirectRunExit(source: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(`${fileName}: ${diagnostics.length} parse error(s) — refusing to classify`);
  }
  let found = false;
  const insideFunction = (node: ts.Node): boolean => {
    let parent = node.parent;
    while (parent !== undefined) {
      if (
        ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isConstructorDeclaration(parent)
      ) {
        return true;
      }
      parent = parent.parent;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'exit' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      !insideFunction(node)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Co-located self-test candidates for an artifact, in resolution order. */
export function selfTestCandidates(artifact: string): string[] {
  const base = artifact.replace(/\.[cm]?[jt]s$/, '').replace(/\.sh$/, '');
  return [`${base}.test.ts`, `${base}.test.mts`, `${base}.test.mjs`, `${base}.test.sh`];
}

export interface McpScriptScan {
  readonly gatesWithSelfTest: readonly string[];
  readonly runnableWithoutSelfTest: readonly string[];
}

export function scanMcpScriptGates(repoRoot: string = REPO_ROOT): McpScriptScan {
  const dir = join(repoRoot, MCP_SCRIPTS_DIR);
  const gatesWithSelfTest: string[] = [];
  const runnableWithoutSelfTest: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Fail closed: a scan that cannot read its root must not contribute an
    // empty channel that reads as "no guards here".
    throw new Error(`${MCP_SCRIPTS_DIR}: cannot enumerate (${err instanceof Error ? err.message : String(err)})`);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
    const rel = `${MCP_SCRIPTS_DIR}/${entry.name}`;
    if (isTestArtifact(rel)) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    if (!hasDirectRunExit(source, rel)) continue;
    const hasSelfTest = selfTestCandidates(rel).some((c) => existsSync(join(repoRoot, c)));
    if (hasSelfTest) gatesWithSelfTest.push(rel);
    else runnableWithoutSelfTest.push(rel);
  }
  return {
    gatesWithSelfTest: gatesWithSelfTest.sort(),
    runnableWithoutSelfTest: runnableWithoutSelfTest.sort(),
  };
}

// ─── Vitest include globs → suite identity ───────────────────────────────────

export type SuiteId = 'root' | 'mcp';

export interface VitestProject {
  /** The project's declared `name`, or `'default'` for a config with one unnamed suite. */
  readonly name: string;
  readonly includes: readonly string[];
}

/**
 * The vitest PROJECTS a config declares, by PARSE.
 *
 * Two things make the naive version wrong, and both bit this module before the
 * project axis existed:
 *
 *   1. Only the `include` sitting DIRECTLY on a `test:` object is a suite glob.
 *      Both configs also carry `coverage: { include: ['src/**' + '/*.ts'] }` and
 *      `benchmark: { include: [...] }`; folding those in makes every source file
 *      look like a collected test.
 *   2. The project NAME matters, because `npm run test:process` expands to
 *      `vitest run --project process` — which runs the `process` project ONLY.
 *      Without the name, the `e2e-process` and `outcome-tests` jobs read as hosts
 *      of every root-suite test, and a genuinely filtered guard reads as covered
 *      by an unfiltered job that never runs it.
 *
 * A regex would also read the globs out of the long explanatory comments that
 * surround them in both files.
 */
export function parseVitestProjects(source: string, fileName: string): VitestProject[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: VitestProject[] = [];
  const directProperty = (object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      const text = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
      if (text === key) return property.initializer;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'test') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'test')) &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const includeNode = directProperty(node.initializer, 'include');
      if (includeNode !== undefined && ts.isArrayLiteralExpression(includeNode)) {
        const includes: string[] = [];
        for (const element of includeNode.elements) {
          if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
            includes.push(element.text);
          }
        }
        const nameNode = directProperty(node.initializer, 'name');
        const name =
          nameNode !== undefined && (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode))
            ? nameNode.text
            : 'default';
        out.push({ name, includes });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/** `--project X` / `--project=X` selectors on a vitest invocation tail. */
export function vitestProjectSelectors(tail: string): string[] {
  const out: string[] = [];
  const re = /--project(?:=|\s+)([A-Za-z0-9._-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tail)) !== null) {
    const name = match[1];
    if (name !== undefined) out.push(name);
  }
  return out;
}

/**
 * Minimal glob matcher for the shapes the two vitest configs and the
 * `dorny/paths-filter` lists actually use (`dir/**` + `/*.test.ts`, `src/**`,
 * `AGENTS.md`). `**` crosses path separators, `*` does not, and `a/**` + `/b`
 * also matches `a/b` because the middle segment is optional.
 *
 * Tokenising the glob — rather than running a chain of `String.replace` passes
 * over a half-built pattern — is what keeps a metacharacter produced by an
 * EARLIER substitution from being re-consumed by a later one, which is the
 * classic way a hand-rolled glob compiler quietly starts matching the wrong
 * thing.
 */
export function globMatches(glob: string, path: string): boolean {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
    } else {
      const ch = glob[index] ?? '';
      pattern += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch;
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`).test(path);
}

export interface SuiteConfig {
  readonly id: SuiteId;
  /** Repo-relative directory the vitest config lives in (`''` for the root). */
  readonly dir: string;
  readonly projects: readonly VitestProject[];
}

export function loadSuiteConfigs(repoRoot: string = REPO_ROOT): SuiteConfig[] {
  const read = (dir: string): VitestProject[] => {
    const file = join(repoRoot, dir, 'vitest.config.ts');
    const projects = parseVitestProjects(readFileSync(file, 'utf8'), `${dir}/vitest.config.ts`);
    if (projects.length === 0) {
      // Fail closed: a config the parser cannot read must not contribute an
      // empty project set, which would silently unhost every co-located test.
      throw new Error(`${dir || '.'}/vitest.config.ts: parsed zero vitest projects`);
    }
    return projects;
  };
  return [
    { id: 'root', dir: '', projects: read('') },
    { id: 'mcp', dir: 'servers/exarchos-mcp', projects: read('servers/exarchos-mcp') },
  ];
}

/** Which vitest suite + project(s) collect a repo-relative test path. */
export interface SuiteMembership {
  readonly suite: SuiteId;
  readonly projects: readonly string[];
}

export function suiteForTest(testPath: string, suites: readonly SuiteConfig[]): SuiteMembership | null {
  // Longest package dir first, so an MCP test is never claimed by the root suite.
  const ordered = [...suites].sort((a, b) => b.dir.length - a.dir.length);
  for (const suite of ordered) {
    const prefix = suite.dir === '' ? '' : `${suite.dir}/`;
    if (!testPath.startsWith(prefix)) continue;
    const relative = testPath.slice(prefix.length);
    if (suite.dir === '' && relative.startsWith('servers/')) continue;
    const projects = suite.projects
      .filter((project) => project.includes.some((glob) => globMatches(glob, relative)))
      .map((project) => project.name);
    if (projects.length > 0) return { suite: suite.id, projects };
  }
  return null;
}

// ─── Hosting resolution ──────────────────────────────────────────────────────

function stepWorkingDirectory(job: WorkflowJob, step: WorkflowStep): string {
  const stepDir = step['working-directory'];
  if (typeof stepDir === 'string') return stepDir === '.' ? '' : stepDir;
  const jobDir = job.defaults?.run?.['working-directory'];
  if (typeof jobDir === 'string') return jobDir === '.' ? '' : jobDir;
  return '';
}

function isTruthyFlag(value: boolean | string | undefined): boolean {
  return value === true || value === 'true';
}

/** `|| true` / `|| :` around a term, or an explicit `continue-on-error`. */
function stepSwallowsExit(job: WorkflowJob, step: WorkflowStep): boolean {
  if (isTruthyFlag(step['continue-on-error']) || isTruthyFlag(job['continue-on-error'])) return true;
  const run = step.run ?? '';
  return /\|\|\s*(true|:)\b/.test(run);
}

/** True when the workflow declares a `pull_request` trigger. */
export function runsOnPullRequest(workflow: Workflow): boolean {
  const on = workflow.on;
  if (on === 'pull_request') return true;
  if (Array.isArray(on)) return on.includes('pull_request');
  if (on !== null && typeof on === 'object') return 'pull_request' in on;
  return false;
}

export interface ResolutionContext {
  readonly workflows: readonly LoadedWorkflow[];
  readonly rootPkg: PackageScripts;
  readonly mcpPkg: PackageScripts;
  readonly suites: readonly SuiteConfig[];
  /** `true` for every repo-relative path that exists on disk. */
  readonly exists: (path: string) => boolean;
}

/**
 * True when a step's expanded command text executes `artifact`.
 *
 * Matching is on the artifact path, tried both repo-relative and relative to the
 * step's working directory — so `npm run cli:vocab-guard` inside
 * `servers/exarchos-mcp` (which expands to `bun run scripts/cli-vocab-guard.ts`)
 * resolves to `servers/exarchos-mcp/scripts/cli-vocab-guard.ts`.
 */
function commandExecutes(command: string, artifact: string, workingDir: string): boolean {
  const candidates = [artifact];
  if (workingDir !== '' && artifact.startsWith(`${workingDir}/`)) {
    candidates.push(artifact.slice(workingDir.length + 1));
  }
  return candidates.some((candidate) => command.includes(candidate));
}

/**
 * The PATH operands of a `vitest run …` tail.
 *
 * A token counts as a file operand only when it looks like a path (contains `/`
 * or carries a `.ts`/`.mts`/`.mjs` extension). Without that test, `npm run
 * test:unit` — which expands to `vitest run --project unit --project integration`
 * — reads `unit` and `integration` as file filters, and every guard whose only
 * host is the root suite resolves UNREACHABLE. That false negative is the exact
 * failure this inventory exists to prevent, so the narrower rule is deliberate.
 */
export function vitestPathOperands(tail: string): string[] {
  return tail
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('-'))
    .filter((token) => !/^(&&|\|\||;)$/.test(token))
    .filter((token) => token.includes('/') || /\.[cm]?[jt]s$/.test(token));
}

/**
 * True when a job runs the vitest suite that collects `testPath`.
 *
 * Derived from the job's own steps: an `npm run`-expanded command containing a
 * `vitest run` invocation in the package that owns the suite. `vitest bench` is
 * NOT a suite run — it collects `*.bench.ts` only — so the benchmark job must not
 * be reported as a host of every co-located test.
 *
 * A `vitest run <explicit paths>` step counts only when one of those paths is a
 * prefix of the test file; otherwise the single-file re-assert steps
 * (`npx --no-install vitest run scripts/ci-topology.test.ts`) would each read as
 * running the whole suite.
 */
function jobRunsSuiteFor(
  job: WorkflowJob,
  testPath: string,
  membership: SuiteMembership,
  ctx: ResolutionContext,
): { runs: boolean; swallowed: boolean } {
  for (const step of job.steps ?? []) {
    if (typeof step.run !== 'string') continue;
    const workingDir = stepWorkingDirectory(job, step);
    const pkg = workingDir === 'servers/exarchos-mcp' ? ctx.mcpPkg : ctx.rootPkg;
    const stepSuite: SuiteId = workingDir === 'servers/exarchos-mcp' ? 'mcp' : 'root';
    if (stepSuite !== membership.suite) continue;
    const expanded = expandNpmScripts(step.run, pkg);
    for (const line of expanded.split('\n')) {
      const invocation = /(?:^|\s|&&|\|\|)(?:npx\s+(?:--no-install\s+)?)?vitest\s+run\b([^\n]*)/.exec(line);
      if (invocation === null) continue;
      const tail = invocation[1] ?? '';
      const selectors = vitestProjectSelectors(tail);
      // No `--project` means every project; otherwise the test must belong to a
      // SELECTED one, or this step does not collect it.
      if (selectors.length > 0 && !membership.projects.some((project) => selectors.includes(project))) continue;
      const operands = vitestPathOperands(tail);
      if (operands.length === 0) {
        return { runs: true, swallowed: stepSwallowsExit(job, step) };
      }
      const prefix = workingDir === '' ? '' : `${workingDir}/`;
      if (operands.some((op) => testPath === `${prefix}${op}` || testPath.startsWith(`${prefix}${op}`))) {
        return { runs: true, swallowed: stepSwallowsExit(job, step) };
      }
    }
  }
  return { runs: false, swallowed: false };
}

/** Resolve every CI host of one guard artifact. */
export function resolveHosts(artifact: string, ctx: ResolutionContext): GuardHost[] {
  const hosts: GuardHost[] = [];
  const selfTests = selfTestCandidates(artifact).filter((c) => ctx.exists(c));

  for (const { path: workflowPath, doc } of ctx.workflows) {
    const isCi = workflowPath === CI_WORKFLOW;
    const aggregatorNeeds = new Set(isCi ? needsList(doc.jobs?.[AGGREGATOR_JOB]) : []);
    const onPullRequest = runsOnPullRequest(doc);

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (jobName === AGGREGATOR_JOB) continue;
      const keys = pathFilterKeys(job);

      const record = (via: HostingVia, exitSwallowed: boolean): void => {
        const blocking = isCi
          ? aggregatorNeeds.has(jobName) && !exitSwallowed
          : onPullRequest && !exitSwallowed;
        hosts.push({
          workflow: workflowPath,
          job: jobName,
          via,
          pathFilterKeys: keys,
          exitSwallowed,
          onPullRequest,
          blocking,
        });
      };

      // (a) direct execution of the artifact by a step, npm chains expanded.
      //     `directSwallowed` ANDs across matching steps: a guard run twice, once
      //     under `|| true` and once not, is still failable.
      let directSwallowed: boolean | null = null;
      // (b) direct execution of a co-located self-test by a step — the DR-10
      //     `.test.sh` re-asserts that ride the unfiltered grep-gates host so a
      //     scripts-only PR still proves the gate is failable.
      let selfTestSwallowed: boolean | null = null;
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const workingDir = stepWorkingDirectory(job, step);
        const pkg = workingDir === 'servers/exarchos-mcp' ? ctx.mcpPkg : ctx.rootPkg;
        const expanded = expandNpmScripts(step.run, pkg);
        const swallowed = stepSwallowsExit(job, step);
        // Self-test paths are checked FIRST: `…/x.test.sh` contains `…/x.test.`
        // but never `…/x.mjs`, so the two matches cannot alias. Checking the
        // artifact against a step that only names its self-test would, though —
        // hence the explicit `.test.` exclusion below.
        if (selfTests.some((selfTest) => commandExecutes(expanded, selfTest, workingDir))) {
          selfTestSwallowed = selfTestSwallowed === null ? swallowed : selfTestSwallowed && swallowed;
        }
        if (commandExecutes(expanded, artifact, workingDir)) {
          directSwallowed = directSwallowed === null ? swallowed : directSwallowed && swallowed;
        }
      }
      if (directSwallowed !== null) record('direct', directSwallowed);
      if (selfTestSwallowed !== null) record('self-test', selfTestSwallowed);

      // (c) execution through a co-located self-test collected by a vitest suite
      //     the job runs.
      for (const selfTest of selfTests) {
        const suite = suiteForTest(selfTest, ctx.suites);
        if (suite === null) continue;
        const { runs, swallowed } = jobRunsSuiteFor(job, selfTest, suite, ctx);
        if (runs) record('self-test', swallowed);
      }
    }
  }
  return hosts;
}

// ─── Production reachability (the R-11 axis) ─────────────────────────────────

const SOURCE_ROOTS = ['src', 'servers/exarchos-mcp/src', 'scripts', 'servers/exarchos-mcp/scripts'] as const;

function walkSourceFiles(repoRoot: string, dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkSourceFiles(repoRoot, rel, out);
    } else if (entry.isFile() && /\.[cm]?ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(rel);
    }
  }
}

/**
 * Repo-relative paths of every non-test TypeScript module under the source roots.
 * `statSync` keeps the walk honest about symlinked roots.
 */
export function enumerateProductionModules(repoRoot: string = REPO_ROOT): string[] {
  const out: string[] = [];
  for (const root of SOURCE_ROOTS) {
    try {
      if (!statSync(join(repoRoot, root)).isDirectory()) continue;
    } catch {
      continue;
    }
    walkSourceFiles(repoRoot, root, out);
  }
  return out.filter((p) => !isTestArtifact(p)).sort();
}

/**
 * Every module specifier imported (or re-exported) by a source file, PARSED —
 * static declarations AND dynamic `import('…')` calls.
 *
 * Task 061 and task 062 both had to correct scanners that matched specifiers as
 * raw text; a package named only in a comment or a template literal is not an
 * import. `ts.isImportDeclaration` cannot disagree with the compiler about what
 * an import is.
 *
 * The dynamic half is not optional. `servers/exarchos-mcp/src/index.ts` reaches
 * `adapters/mcp.ts` ONLY through `await import('./adapters/mcp.js')` — a
 * deliberate lazy edge that keeps the MCP SDK off the CLI's cold-start path. A
 * static-only scan reports the repo's MCP adapter as having no production caller,
 * which would have put a false R-11 finding in this inventory on day one.
 */
export function collectImportSpecifiers(source: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
        out.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/** Resolve a relative ESM specifier (`./x.js`) from `fromFile` to a repo-relative `.ts` path. */
export function resolveRelativeSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  return joined.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts');
}

/**
 * Artifacts imported by at least one NON-test module.
 *
 * This is the R-11 axis and it is deliberately independent of CI reachability:
 * `resolveDispatchShape` is executed on every MCP-touching PR through its
 * co-located vitest and still has no production caller.
 */
export function productionImportedSet(repoRoot: string = REPO_ROOT): Set<string> {
  const modules = enumerateProductionModules(repoRoot);
  const imported = new Set<string>();
  for (const file of modules) {
    let source: string;
    try {
      source = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const specifier of collectImportSpecifiers(source, file)) {
      const target = resolveRelativeSpecifier(file, specifier);
      if (target !== null && target !== file) imported.add(target);
    }
  }
  return imported;
}

// ─── Exemption register (the one hand-maintained input) ──────────────────────

/** The finding an exemption is allowed to excuse. One entry excuses exactly one. */
export type ExemptedFinding = 'unreachable' | 'filtered-implementation-surface';

export interface GuardExemption {
  /** Repo-relative path of the guard whose hosting is knowingly imperfect. */
  readonly artifact: string;
  /**
   * Which finding this entry excuses. Naming it means an exemption written for a
   * wiring gap cannot silently also cover a two-surface violation that appears
   * later — each imperfection is justified on its own terms.
   */
  readonly excuses: ExemptedFinding;
  /** Why it cannot be fixed yet. Must name the blocking work. */
  readonly reason: string;
  /** The task or issue that unblocks it. */
  readonly blockedBy: string;
  /** ISO `YYYY-MM-DD`. Past this date the exemption FAILS rather than lapsing quietly. */
  readonly expires: string;
}

/**
 * The recorded, EXPIRING reasons a Wave-1 guard is not reachable from CI.
 *
 * DR-24 permits exactly this and nothing looser: "every guard is reachable from a
 * CI job — or carries a recorded, expiring reason why not." An entry here is a
 * debt with an owner and a deadline, never a permanent exemption; see
 * {@link auditGuardInventory} for the four ways an entry can fail.
 */
export const GUARD_EXEMPTIONS: readonly GuardExemption[] = Object.freeze([
  // DISCHARGED by task 064 — entry removed rather than re-dated.
  //
  // `scripts/validate-plugin.sh` now runs as a blocking, unfiltered step in
  // ci.yml's `grep-gates` job (plus a DR-10 `.test.sh` re-assert), so it no
  // longer exhibits `unreachable` and `auditGuardInventory` would flag a
  // surviving entry as `[stale-exemption]`. That tooth is what forced this
  // deletion, and it is the mechanism working as designed.
  //
  // Two numbers this entry carried were WRONG when measured on the landing
  // branch on 2026-08-07, and both came from the spec's Task 064 prose rather
  // than from a derivation — the DR-27 class, in the file that inventories
  // DR-24. Recorded here so the correction is not lost with the entry:
  //   - the `validate` chain was NINE steps, not seventeen;
  //   - `validate-plugin.sh` failed FIVE of nine checks (four passed), and from
  //     FOUR distinct causes, not three: the entry omitted `.claude-plugin/
  //     plugin.json` missing a `hooks` field.
  // All four causes turned out to be the GATE being stale, not the package —
  // each contradicted a green assertion in `src/plugin-validation.test.ts`.
  Object.freeze({
    artifact: 'servers/exarchos-mcp/scripts/cli-derivation-guard.ts',
    excuses: 'unreachable',
    reason:
      'Correct and complete, but exits 1 on the landing branch BY DESIGN: it reports all 11 ' +
      'literal `.command(` sites in the CLI composition root, and the shrink-only allowlist ' +
      'that turns that report into an enforceable budget is not populated yet. Wiring it ' +
      'blocking today would red-line every PR. Note its co-located self-test DOES run on ' +
      'every MCP-touching PR — and asserts the current count (11), not the policy (zero) — so ' +
      '"the self-test is hosted" must not be read as "the gate is wired". Host class when it ' +
      'is wired (docs/guides/ci-gate-hosting.md): the DEPS TAIL of the unfiltered `grep-gates` ' +
      'job — it needs `typescript` resolvable, so it cannot ride the zero-dep prefix.',
    blockedBy: 'task 023 (DR-5) — shrink-only allowlist for the 11 hand-written top-level CLI verbs',
    expires: '2026-11-05',
  }),
  Object.freeze({
    artifact: 'scripts/lint-inv6.mjs',
    excuses: 'filtered-implementation-surface',
    reason:
      'Runs via `npm run skills:guard` in `test-root`, which is filtered on `root` — and the ' +
      '`root` filter deliberately excludes `scripts/**`, so a PR that edits this lint`s own ' +
      'source does not arm the only job that runs it. This is the residual scripts-filter hole ' +
      'docs/guides/ci-gate-hosting.md already records: widening `root` to include `scripts/**` ' +
      'was considered and REJECTED because `changes.outputs.root` also arms `test-windows-root`, ' +
      'a chronically flaky lane never proven green on main (#1699). The expiry forces that ' +
      'trade to be re-made rather than inherited.',
    blockedBy: '#1717 (carries the #1699 Windows-lane constraint)',
    expires: '2026-11-05',
  }),
  Object.freeze({
    artifact: 'scripts/lint-test-first-drift.mjs',
    excuses: 'filtered-implementation-surface',
    reason:
      'Same host and same hole as `scripts/lint-inv6.mjs`: chained with `&&` inside ' +
      '`npm run skills:guard` in the `root`-filtered `test-root` job, with its own source ' +
      'outside that filter. Unlike lint-inv6 its exit code DOES propagate, so the gate is ' +
      'failable — the gap is which PRs arm it, not whether it can fail.',
    blockedBy: '#1717 (carries the #1699 Windows-lane constraint)',
    expires: '2026-11-05',
  }),
]);

// ─── The inventory ───────────────────────────────────────────────────────────

export interface BuildOptions {
  readonly repoRoot?: string;
  readonly specText?: string;
  readonly manifestJson?: unknown;
  readonly workflows?: readonly LoadedWorkflow[];
}

export function buildGuardInventory(options: BuildOptions = {}): GuardInventory {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const specText = options.specText ?? readFileSync(join(repoRoot, SPEC_PATH), 'utf8');
  const manifestJson: unknown =
    options.manifestJson ?? JSON.parse(readFileSync(join(repoRoot, MANIFEST_PATH), 'utf8'));
  const workflows = options.workflows ?? loadWorkflows(repoRoot);

  const ctx: ResolutionContext = {
    workflows,
    rootPkg: readPackageScripts(repoRoot, ''),
    mcpPkg: readPackageScripts(repoRoot, 'servers/exarchos-mcp'),
    suites: loadSuiteConfigs(repoRoot),
    exists: (path) => existsSync(join(repoRoot, path)),
  };

  const channels = new Map<string, Set<GuardChannel>>();
  const tasksByArtifact = new Map<string, Set<string>>();
  const add = (artifact: string, channel: GuardChannel): void => {
    const set = channels.get(artifact) ?? new Set<GuardChannel>();
    set.add(channel);
    channels.set(artifact, set);
  };

  for (const primary of manifestPrimaries(manifestJson)) add(primary, 'enforcer-manifest');

  /** A `.sh` gate has no AST to parse; a shell script IS its own entrypoint. */
  const isRunnable = (artifact: string): boolean => {
    if (artifact.endsWith('.sh')) return true;
    if (!/\.[cm]?[jt]s$/.test(artifact)) return false;
    try {
      return hasDirectRunExit(readFileSync(join(repoRoot, artifact), 'utf8'), artifact);
    } catch {
      // Unreadable or unparseable: fail CLOSED toward "runnable", the stricter
      // reading — it demands DIRECT execution rather than accepting a self-test.
      return true;
    }
  };

  const unresolvedSpecArtifacts: string[] = [];
  const compileTimeOnlyArtifacts: string[] = [];
  for (const task of wave1Tasks(parseSpecTasks(specText))) {
    for (const file of task.files) {
      if (!isPathShaped(file)) continue;
      if (!ctx.exists(file)) {
        unresolvedSpecArtifacts.push(file);
        continue;
      }
      if (isTestArtifact(file)) continue;
      if (!/\.[cm]?[jt]s$|\.sh$/.test(file)) continue;
      // DR-24's own definition of a guard: it has a self-test that runs in the
      // same CI job. A Wave-1 module with neither a self-test nor an entrypoint
      // carries no executable verdict — its rung is `tsc`, not a CI step — so it
      // is recorded rather than judged against execution reachability.
      const hasSelfTest = selfTestCandidates(file).some((c) => ctx.exists(c));
      if (!hasSelfTest && !isRunnable(file)) {
        compileTimeOnlyArtifacts.push(file);
        continue;
      }
      add(file, 'wave1-spec');
      const ids = tasksByArtifact.get(file) ?? new Set<string>();
      ids.add(task.id);
      tasksByArtifact.set(file, ids);
    }
  }

  const mcpScan = scanMcpScriptGates(repoRoot);
  for (const gate of mcpScan.gatesWithSelfTest) add(gate, 'mcp-scripts-gate');

  const imported = productionImportedSet(repoRoot);

  const guards: GuardRecord[] = [...channels.entries()]
    .map(([artifact, channelSet]) => {
      const hosts = resolveHosts(artifact, ctx);
      const runnable = isRunnable(artifact);
      const enforcing = hosts.filter((host) => isEnforcingHost(host, runnable));
      const enforcement: Enforcement =
        enforcing.length === 0 ? 'unreachable' : enforcing.some((h) => h.blocking) ? 'blocks' : 'observes';
      // Path-filtering is a PRE-MERGE property, so a release-lane host (which
      // fires only on a tag push) neither creates nor clears the condition.
      const enforcingOnPr = enforcing.filter((h) => h.onPullRequest);
      return {
        artifact,
        channels: [...channelSet].sort(),
        wave1Tasks: [...(tasksByArtifact.get(artifact) ?? [])].sort(),
        hosts,
        runnable,
        enforcement,
        pathFilteredOnly: enforcingOnPr.length > 0 && enforcingOnPr.every((h) => h.pathFilterKeys.length > 0),
        productionImported: /\.[cm]?ts$/.test(artifact) ? imported.has(artifact) : null,
      };
    })
    .sort((a, b) => a.artifact.localeCompare(b.artifact));

  return {
    guards,
    runnableWithoutSelfTest: mcpScan.runnableWithoutSelfTest,
    compileTimeOnlyArtifacts: [...new Set(compileTimeOnlyArtifacts)].sort(),
    unresolvedSpecArtifacts: [...new Set(unresolvedSpecArtifacts)].sort(),
  };
}

// ─── The audit ───────────────────────────────────────────────────────────────

export interface InventoryAudit {
  readonly ok: boolean;
  readonly violations: readonly string[];
  /** Path-filtered-only guards, surfaced so the hosting is reported, not accepted. */
  readonly pathFilteredOnly: readonly string[];
  /** Guards no production module imports — the R-11 population. */
  readonly noProductionCaller: readonly string[];
}

/**
 * The reachability proof.
 *
 * Failure conditions, in the order DR-24 states them:
 *   `[empty-inventory]`            — a resolution of zero guards FAILS rather than
 *                                    passing clean (the non-empty-denominator rule).
 *   `[unwired-guard]`              — unreachable from every CI job, with no exemption.
 *   `[expired-exemption]`          — a recorded reason whose deadline has passed.
 *   `[stale-exemption]`            — an exemption whose guard IS reachable; keeping it
 *                                    would let a later un-wiring pass unnoticed.
 *   `[orphan-exemption]`           — an exemption naming a guard outside the inventory.
 *   `[manifest-primary-missing]`   — a manifest primary the inventory cannot see, i.e.
 *                                    the denominator shrank below channel 1's.
 *   `[implementation-surface-outside-filter]` — the two-surface subset rule from
 *                                    docs/guides/ci-gate-hosting.md: a guard hosted
 *                                    ONLY in path-filtered jobs whose own source is
 *                                    outside every one of those filters can be
 *                                    weakened by a PR the filter never arms, and the
 *                                    job skips-as-passed on exactly that PR. This is
 *                                    #1711's failure, mechanized.
 */
export function auditGuardInventory(
  inventory: GuardInventory,
  options: {
    readonly now?: Date;
    readonly exemptions?: readonly GuardExemption[];
    readonly manifestJson?: unknown;
    readonly filterGlobs?: Record<string, string[]>;
  } = {},
): InventoryAudit {
  const now = options.now ?? new Date();
  const exemptions = options.exemptions ?? GUARD_EXEMPTIONS;
  const violations: string[] = [];
  const byArtifact = new Map(inventory.guards.map((g) => [g.artifact, g]));

  if (inventory.guards.length === 0) {
    violations.push(
      '[empty-inventory]  the inventory resolved zero guards — a run that finds nothing ' +
        'fails rather than passing clean (DR-24 non-empty denominator)',
    );
  }

  const excusedBy = (artifact: string, finding: ExemptedFinding): GuardExemption | undefined =>
    exemptions.find((e) => e.artifact === artifact && e.excuses === finding);

  for (const guard of inventory.guards) {
    if (guard.enforcement !== 'unreachable') continue;
    if (excusedBy(guard.artifact, 'unreachable') === undefined) {
      violations.push(
        `${guard.artifact}  [unwired-guard]  no CI job executes it and no expiring reason is ` +
          'recorded — wire it, or add a GUARD_EXEMPTIONS entry with an owner and an expiry',
      );
    }
  }

  const filterGlobs = options.filterGlobs ?? {};
  const filtersKnown = Object.keys(filterGlobs).length > 0;
  const pathFilteredOnly: string[] = [];
  /** Artifacts that genuinely exhibit each finding, used to detect stale exemptions. */
  const exhibits = new Map<ExemptedFinding, Set<string>>([
    ['unreachable', new Set(inventory.guards.filter((g) => g.enforcement === 'unreachable').map((g) => g.artifact))],
    ['filtered-implementation-surface', new Set<string>()],
  ]);

  for (const guard of inventory.guards) {
    if (!guard.pathFilteredOnly) continue;
    pathFilteredOnly.push(guard.artifact);
    if (!filtersKnown) continue;
    // The two-surface subset rule ranges over EVERY host, not only the enforcing
    // ones: a DR-10 `.test.sh` re-assert on the unfiltered grep-gates host is
    // precisely how `check-coverage-ratchet` and `check-mutation-gate` close this
    // hole while still being enforced from a filtered job.
    const keys = [...new Set(guard.hosts.flatMap((h) => [...h.pathFilterKeys]))];
    const anyUnfilteredHost = guard.hosts.some((h) => h.pathFilterKeys.length === 0 && h.onPullRequest);
    const covered =
      anyUnfilteredHost ||
      keys.some((key) => (filterGlobs[key] ?? []).some((glob) => globMatches(glob, guard.artifact)));
    if (keys.length === 0 || covered) continue;
    exhibits.get('filtered-implementation-surface')?.add(guard.artifact);
    if (excusedBy(guard.artifact, 'filtered-implementation-surface') !== undefined) continue;
    violations.push(
      `${guard.artifact}  [implementation-surface-outside-filter]  hosted only in job(s) ` +
        `filtered on ${keys.join(', ')}, but its own source is outside every one of those ` +
        'filters and no unfiltered job re-asserts it — a PR that weakens it skips the job ' +
        'that would notice (docs/guides/ci-gate-hosting.md, two-surface subset rule)',
    );
  }

  for (const exemption of exemptions) {
    if (!byArtifact.has(exemption.artifact)) {
      violations.push(
        `${exemption.artifact}  [orphan-exemption]  exempted but absent from the inventory — ` +
          'the guard moved, was renamed, or was deleted',
      );
      continue;
    }
    // A `filtered-implementation-surface` exemption is only checkable when the
    // filter globs were supplied; without them the finding cannot be computed, so
    // the entry is neither confirmed nor declared stale.
    const checkable = exemption.excuses === 'unreachable' || filtersKnown;
    if (checkable && exhibits.get(exemption.excuses)?.has(exemption.artifact) !== true) {
      violations.push(
        `${exemption.artifact}  [stale-exemption]  no longer exhibits "${exemption.excuses}" — ` +
          'remove the exemption so a later regression cannot pass unnoticed',
      );
    }
    const expiry = Date.parse(`${exemption.expires}T00:00:00Z`);
    if (Number.isNaN(expiry)) {
      violations.push(`${exemption.artifact}  [expired-exemption]  unparseable expiry "${exemption.expires}"`);
    } else if (expiry <= now.getTime()) {
      violations.push(
        `${exemption.artifact}  [expired-exemption]  expired ${exemption.expires} ` +
          `(blocked on ${exemption.blockedBy}) — fix it or re-justify with a new deadline`,
      );
    }
  }

  if (options.manifestJson !== undefined) {
    for (const primary of manifestPrimaries(options.manifestJson)) {
      if (!byArtifact.has(primary)) {
        violations.push(
          `${primary}  [manifest-primary-missing]  dispositioned in the enforcer manifest but ` +
            "absent from this inventory — the inventory denominator has fallen below the manifest's",
        );
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    pathFilteredOnly: pathFilteredOnly.sort(),
    noProductionCaller: inventory.guards
      .filter((g) => g.productionImported === false)
      .map((g) => g.artifact)
      .sort(),
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * One markdown row per guard: artifact · CI job(s) · path-filtered? ·
 * blocks-or-observes · production caller.
 *
 * The job column names the ENFORCING hosts; a self-test-only host is suffixed so
 * "its tests run" is never mistaken for "its policy runs" (see
 * {@link isEnforcingHost}).
 */
export function renderInventoryTable(inventory: GuardInventory): string {
  const rows = [
    '| Guard | CI job(s) | Path-filtered? | Blocks / observes | Prod caller? |',
    '|---|---|---|---|---|',
  ];
  for (const guard of inventory.guards) {
    const enforcing = guard.hosts.filter((h) => isEnforcingHost(h, guard.runnable));
    const jobs =
      enforcing.length === 0
        ? guard.hosts.length === 0
          ? '— (none)'
          : `— (self-test only: ${[...new Set(guard.hosts.map((h) => h.job))].join(', ')})`
        : [...new Set(enforcing.map((h) => `${h.job}${h.via === 'self-test' ? ' (via self-test)' : ''}`))].join(', ');
    const filtered =
      enforcing.length === 0
        ? '—'
        : guard.pathFilteredOnly
          ? `YES (${[...new Set(enforcing.flatMap((h) => [...h.pathFilterKeys]))].join('+')})`
          : 'no';
    const prod = guard.productionImported === null ? 'n/a' : guard.productionImported ? 'yes' : 'NO (R-11)';
    rows.push(`| \`${guard.artifact}\` | ${jobs} | ${filtered} | ${guard.enforcement} | ${prod} |`);
  }
  return rows.join('\n');
}
