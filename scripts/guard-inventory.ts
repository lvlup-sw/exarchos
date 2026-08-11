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
//     - The guard POPULATION, from four independent channels (see below). A
//       guard has to hide from all four to escape.
//     - Every VERDICT: hosting job, path-filter keys, blocking-vs-observing,
//       and production reachability. All parsed out of `.github/workflows/*.yml`,
//       the two `package.json` script tables, the two `vitest.config.ts` include
//       globs, and TypeScript import specifiers. Never asserted.
//     - Whether a guard's ENTRYPOINT PREDICATE is coupled to its own filename
//       ({@link classifyEntrypointPredicate}, DR-4). Every column above answers
//       "is this guard reached?"; that one answers "and does it still run once
//       reached?", which the others cannot see — a renamed guard keeps a direct,
//       unfiltered, blocking row while enforcing nothing.
//
//   HAND-MAINTAINED (small, reviewable, and EXPIRING by construction)
//     - {@link GUARD_EXEMPTIONS}: the record of a guard that is deliberately not
//       reachable from CI. Each entry carries an owner, a blocking reason, and an
//       ISO expiry. An expired entry FAILS. An entry whose guard turns out to be
//       reachable FAILS (a stale exemption is a wiring lie). An entry naming a
//       guard outside the inventory FAILS.
//     - {@link SPEC_ARTIFACT_WAIVERS}: the record of a Wave-1 `**Files:**` entry
//       that never landed under the name the spec gave it. Same four teeth, same
//       expiry discipline — see {@link GuardInventory.unresolvedSpecArtifacts}.
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
// THE FOUR DISCOVERY CHANNELS
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
//   3. GATES UNDER `servers/exarchos-mcp/scripts/`. A module is a guard iff it
//      has a SELF-TEST ({@link selfTestCandidates}). That is DR-24's own
//      definition of a guard — "each guard's self-test runs in the same CI job
//      as the guard" — so it is the criterion this program already committed to,
//      not one invented here. A module with NO self-test is reported rather than
//      silently dropped: with a statement-level `process.exit(…)` entrypoint (a
//      real parse, never a name match) it lands in
//      {@link GuardInventory.runnableWithoutSelfTest}; without one it has no
//      executable verdict at all and lands in
//      {@link GuardInventory.compileTimeOnlyArtifacts}.
//
//   4. CENSUS / SEAM MODULES UNDER `servers/exarchos-mcp/src/architecture/`.
//      Same self-test criterion, applied to the directory that exists to hold
//      architectural guards. These are LIBRARY guards: they carry no entrypoint,
//      so their co-located vitest IS the enforcement path (see
//      {@link isEnforcingHost}) — which is exactly why they are invisible to
//      channels 1 and 3, and why only the ones a Wave-1 task happened to NAME
//      were reachable through channel 2. `adapter-ownership-seam.ts`,
//      `effect-port-seam.ts`, `audit-delivery-closure.ts`, `delivery-safety.ts`
//      and `import-cycles.ts` were absent from the inventory entirely, so
//      `Wave1Exit_NoGuardIsUnreachable` — asserted over the FULL inventory
//      precisely so a wave cannot wire its headline guards while leaving others
//      dark — did not range over them (DR-9).
//
//      The membership rule is STRUCTURAL, not a `*-census|*-seam` filename
//      match: three of those five carry neither suffix, and this program has
//      twice been bitten by an instrument that measured a name. It errs toward
//      INCLUSION — a support module in this directory earns a row it does not
//      need, which costs a table line; a guard missing a row is the failure DR-9
//      names. Modules here with no self-test are reported in
//      {@link GuardInventory.architectureModulesWithoutSelfTest}.
//
// The union is deduplicated by repo-relative path.
//
// ─────────────────────────────────────────────────────────────────────────────
// INDIRECT HOSTING: A GUARD RUN BY A SHELL SCRIPT THAT A RUN-STEP RUNS (task 070)
//
// Task 063's resolver matched a guard's path as TEXT inside a run-step's command.
// That model cannot see one level of indirection, and the tree is full of it:
// `ci.yml` runs `bash scripts/validate-no-legacy.sh`, and THAT script runs
// `knip-diff.ts`. The guard's path never appears in the workflow at all, so it
// read as `[unwired-guard]` while running on every PR. Same shape for
// `validate-plugin.sh`, which is now a thin `exec node …/validate-plugin.mjs`.
//
// Two properties of that chain decide how it must be measured, and both defeat
// the obvious implementation:
//
//   1. THE PATH IS NEVER WRITTEN AS A LITERAL AT THE CALL SITE. The script says
//      `KNIP_DIFF="$SCRIPT_DIR/audit/knip-diff.ts"` and then `"$TSX_BIN"
//      "$KNIP_DIFF"`. Resolving it means resolving shell VARIABLES, plus the two
//      directory anchors this repo's scripts use (`$(cd "$(dirname
//      "${BASH_SOURCE[0]}")" && pwd)` and `$(cd "$X/.." && pwd)`).
//   2. THE LITERAL PATH *DOES* APPEAR — IN TWO COMMENTS. `validate-no-legacy.sh`
//      names `scripts/audit/knip-diff.ts` in prose on two lines and nowhere else.
//      So a substring scan of the raw text answers "reachable" for a reason that
//      is not an invocation, and a substring scan of the COMMENT-STRIPPED text
//      answers "unreachable" even though the guard runs. Text-matching and real
//      invocation disagree here in BOTH directions, in-tree, today. That is why
//      this is a parse: words are split quote-aware, comments are removed, and
//      variables are resolved against the assignments in force at that line.
//
// What is deliberately NOT counted as an invocation:
//   - a path in a comment (removed before anything else looks at the text);
//   - a path merely ASSIGNED to a variable and never used in a command line —
//     assignment is not execution, and a wrapper that names a guard without
//     running it must still read as unwired;
//   - a word that is not in command position and not an argument of an
//     INTERPRETER ({@link SHELL_INTERPRETERS}). `[[ -x "$TSX_BIN" ]]` names a
//     real file in a test, not an execution.
//
// BOUND — stated rather than left to inference. The walk is bounded by LANGUAGE,
// not by depth: it follows `.sh` wrappers transitively (terminating on a `seen`
// set, exactly as {@link expandNpmScripts} does for npm chains), but it does not
// enter a NON-shell wrapper. Concretely it misses:
//   - a guard spawned by a `.mjs`/`.ts` runner. `scripts/run-validate.mjs` is the
//     live example: it reads its step table from `scripts/validate-manifest.json`
//     and `spawnSync`s each entry. Following it is not merely unimplemented, it
//     would be WRONG TODAY — `ci.yml` invokes it as `--list`, which prints the
//     table and executes nothing, so treating the manifest's entries as executed
//     would manufacture reachability CI does not provide.
//   - a path computed at run time from command-substitution output other than the
//     two `cd`/`dirname` anchors above, or assembled by `find -exec`/`xargs`.
// Both directions of that bound fail toward "unreachable" — the direction that
// REPORTS a wiring hole rather than hiding one.
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
// Implements: DR-24, DR-9.

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
/** Channel 4's scan root — the directory that exists to hold architectural guards. */
export const MCP_ARCHITECTURE_DIR = 'servers/exarchos-mcp/src/architecture';
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

// ─── Shell-wrapper indirection (task 070) ────────────────────────────────────

/**
 * Interpreters that take the program they run as a path ARGUMENT rather than in
 * command position, so `bash x.sh` / `node x.mjs` / `tsx x.ts` all execute `x`.
 *
 * A hand-written set, and the only one in this module — justified by which way it
 * fails. An interpreter MISSING here makes a real invocation read as unreachable,
 * i.e. the inventory reports a wiring hole that is not there. The opposite error
 * (silently blessing an execution that never happens) is the one that would let a
 * dead guard pass, and no omission here can cause it.
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
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'exec',
  'command',
  'env',
  'time',
  'nohup',
  'sudo',
  'builtin',
]);

/** Repo root as a path segment. Kept as `.` so an anchor can prefix a relative path. */
const ROOT_ANCHOR = '.';

/**
 * `#` comments removed, quote-aware.
 *
 * Removing them is the FIRST thing that happens to a wrapper script, because
 * `validate-no-legacy.sh` names `scripts/audit/knip-diff.ts` in two comments and
 * never as a literal in a command. Any scan that runs before this one answers a
 * question about prose.
 *
 * A `#` opens a comment only at the start of a word — so `${x#y}` and `$#` stay
 * intact — and never inside quotes.
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
 *
 * Not cosmetic. `validate-no-legacy.test.sh` writes
 * `AGENTS_BUNDLED_HITS=$(grep -inE "…" \` / `  "$REPO_ROOT/AGENTS.md" …)`, and
 * reading the second physical line on its own puts `AGENTS.md` in COMMAND
 * position — so the resolver reports the repo's agent guide as an executed
 * program. Continuations are joined before anything is classified.
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
      // Consume a doubled operator (`&&`, `||`) as one separator.
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
 * Quotes are removed but `$NAME` is preserved, because expansion happens after
 * splitting — `"$KNIP_DIFF"` must survive as the single word `$KNIP_DIFF`, not as
 * a literal to be matched.
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
function expandShellVars(text: string, table: ReadonlyMap<string, string>, depth = 0): string | null {
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
function normalizeRepoPath(value: string): string | null {
  if (value === '' || value.startsWith('/')) return null;
  const normalized = posix.normalize(value);
  if (normalized === '.' || normalized === './') return '';
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** `NAME=VALUE` split for a word already stripped of quotes. */
function assignmentWord(word: string): { name: string; value: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
  const name = match?.[1];
  if (match === null || name === undefined) return null;
  return { name, value: match[2] ?? '' };
}

/**
 * Resolve an assignment whose value is a whole command substitution, for the two
 * directory anchors this repo's scripts actually use. Anything else is `null` —
 * an unmodelled `$(…)` must not become a guessed path.
 */
function resolveCommandSubstitution(
  raw: string,
  table: ReadonlyMap<string, string>,
  scriptDir: string,
): string | null {
  const match = /^"?\$\((.*)\)"?$/s.exec(raw.trim());
  const inner = match?.[1];
  if (inner === undefined) return null;
  // `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)` — the script's own directory.
  if (/\bdirname\b/.test(inner) && /BASH_SOURCE|\$0/.test(inner)) return scriptDir;
  // `$(cd <dir> && pwd)` — that directory, normalized.
  const cd = /^cd\s+(.+?)\s*&&\s*pwd$/.exec(inner.trim());
  const target = cd?.[1];
  if (target === undefined) return null;
  const expanded = expandShellVars(target.replace(/^["']|["']$/g, ''), table);
  if (expanded === null) return null;
  const normalized = normalizeRepoPath(expanded);
  return normalized === null ? null : normalized === '' ? ROOT_ANCHOR : normalized;
}

/** One file a CI run-step reaches through one or more shell wrappers. */
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

export type GuardChannel =
  | 'enforcer-manifest'
  | 'wave1-spec'
  | 'mcp-scripts-gate'
  | 'mcp-architecture-module';

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
  /**
   * The wrapper-script chain between the run-step and the guard, outermost first.
   * Empty for a step that names the guard itself.
   *
   * Carrying the chain rather than a boolean is the difference between a verdict
   * that says "reachable" and one that says HOW: `knip-diff.ts` is reachable
   * because `validate-no-legacy` runs `scripts/validate-no-legacy.sh`, and that
   * sentence is the reviewable claim. A bare "reachable" cannot be checked.
   */
  readonly through: readonly string[];
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
   * Runnable modules under {@link MCP_SCRIPTS_DIR} with NO self-test.
   * Excluded from the guard population by DR-24's own definition ("each guard's
   * self-test runs in the same CI job as the guard"), and listed so that
   * exclusion is reviewable rather than silent.
   */
  readonly runnableWithoutSelfTest: readonly string[];
  /**
   * Modules under {@link MCP_ARCHITECTURE_DIR} with no self-test — the channel-4
   * analogue of {@link runnableWithoutSelfTest}. A census that LOSES its
   * co-located test lands here rather than disappearing from the denominator,
   * which is the drop DR-9 exists to make visible.
   */
  readonly architectureModulesWithoutSelfTest: readonly string[];
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
   *
   * Wave 1 is CLOSED, so "the task has not landed yet" is no longer available as
   * an explanation: an entry here is an artifact the spec PROMISED and the tree
   * does not have. {@link auditGuardInventory} raises `[unresolved-spec-artifact]`
   * for each one that is not covered by an expiring {@link SPEC_ARTIFACT_WAIVERS}
   * entry — previously this list was computed and then never judged, so a task
   * whose declared artifact never landed passed the DR-24 proof unremarked.
   *
   * A bare basename (`report-coupling-census.ts` — spec shorthand for a path
   * given in full elsewhere) is resolved against the source roots when exactly
   * one file carries that name, so shorthand is not reported as drift. Two
   * matches, or none, stay here.
   */
  readonly unresolvedSpecArtifacts: readonly string[];
  /**
   * Guards whose self-execution is decided by their own FILENAME (DR-4).
   *
   * A rename plus the matching `run:` edit turns such a guard into a step that
   * runs and enforces nothing, and every other column in this inventory keeps
   * reporting it as direct, unfiltered and blocking. {@link auditGuardInventory}
   * raises `[filename-coupled-entrypoint]` for each entry not covered by an
   * expiring {@link GUARD_EXEMPTIONS} record.
   */
  readonly filenameCoupledEntrypoints: readonly FilenameCoupledEntrypoint[];
  /**
   * How many artifacts the entrypoint-predicate classifier actually parsed.
   *
   * The non-empty-denominator rule applied to the check itself: a classifier
   * that examined nothing reports zero coupled entrypoints and is
   * indistinguishable from a clean tree.
   */
  readonly entrypointPredicatesScanned: number;
  /**
   * What the wrapper-script walk actually examined. Present so the indirection
   * resolver is subject to the same non-empty-denominator rule as the inventory:
   * a resolver that walked zero run-steps or zero wrappers would silently report
   * every indirectly-hosted guard as unwired, which is the failure task 070 was
   * dispatched to fix — reintroduced quietly.
   */
  readonly indirection: ShellIndirectionIndex;
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

/**
 * Every file under the source roots, keyed by BASENAME.
 *
 * Exists for one shape the spec actually uses: a `**Files:**` line that gives a
 * path in full and then names a sibling by basename alone (task 077 writes
 * ``…/output-schema-census.ts`, `report-coupling-census.ts``). Without this the
 * shorthand reads as a promised artifact that never landed, which would put a
 * permanent false entry in {@link SPEC_ARTIFACT_WAIVERS} — a register whose
 * whole value is that every row is a real debt.
 */
export function indexSourceBasenames(repoRoot: string = REPO_ROOT): ReadonlyMap<string, readonly string[]> {
  const byName = new Map<string, string[]>();
  const walk = (dir: string): void => {
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
        walk(rel);
      } else if (entry.isFile()) {
        byName.set(entry.name, [...(byName.get(entry.name) ?? []), rel]);
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  for (const paths of byName.values()) paths.sort();
  return byName;
}

/**
 * Resolve one `**Files:**` entry to a repo-relative path, or `null` when the
 * artifact the spec promised is not in the tree.
 *
 * A path that exists resolves to itself. A BARE BASENAME resolves only when
 * exactly one file in the source roots carries that name — two candidates is an
 * ambiguity this resolver must not guess through, and zero is real drift. Both
 * of those fail toward `null`, i.e. toward reporting.
 */
export function resolveSpecArtifact(
  file: string,
  exists: (path: string) => boolean,
  basenames: ReadonlyMap<string, readonly string[]>,
): string | null {
  if (exists(file)) return file;
  if (file.includes('/')) return null;
  const hits = basenames.get(file) ?? [];
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

// ─── Channel 3: runnable gates with a co-located self-test ───────────────────

/**
 * True iff the module has a STATEMENT-LEVEL exit entrypoint — `process.exit(…)`
 * or `process.exitCode = …`, either one not nested inside a function body, so
 * it executes on load and can fail a build.
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
  /** `process.exit` / `process.exitCode`, as a property access off `process`. */
  const isProcessMember = (node: ts.Node, member: string): boolean =>
    ts.isPropertyAccessExpression(node) &&
    node.name.text === member &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process';

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      isProcessMember(node.expression, 'exit') &&
      !insideFunction(node)
    ) {
      found = true;
      return;
    }
    // `process.exitCode = runGuard()` is the same entrypoint with the flush
    // hazard removed, so it has to classify the same way. Detecting only the
    // call form would quietly demote a guard to "not a gate" the moment it
    // stopped truncating its own diagnostics — the inventory would report the
    // safer spelling as an absence.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isProcessMember(node.left, 'exitCode') &&
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

// ─── The entrypoint predicate (DR-4 / task 074) ──────────────────────────────
//
// A guard that decides "am I the process entrypoint?" with
// `process.argv[1].endsWith('<its own name>')` couples WHETHER IT RUNS to WHAT
// IT IS CALLED. Rename it, update the `run:` step to match, and CI keeps a step
// that exists, runs, resolves and enforces nothing — measured on
// `output-schema-ratchet-guard.ts` as 0 bytes of output and exit 0.
//
// This inventory could not see that, and said so: the step is still there, still
// direct, still unfiltered, so the guard's row is unchanged. That blindness is
// what makes it this file's problem rather than each guard's. Four sites in the
// tree carried the coupling when the check was added — one more than the spec
// had enumerated by hand, which is the argument for detecting the CLASS instead
// of fixing the instances.

/** A guard whose self-execution is decided by its own filename. */
export interface FilenameCoupledEntrypoint {
  readonly artifact: string;
  /** The filename literals the predicate tests, in source order. */
  readonly literals: readonly string[];
}

interface EntrypointPredicate {
  /** Filename literals `argv[1]` is tested against with no identity check alongside. */
  readonly coupledLiterals: readonly string[];
}

/**
 * Classify a module's entrypoint predicate.
 *
 * A filename test is only a FINDING when nothing in the same statement also
 * compares `argv[1]` against `import.meta.url`. That distinction is load-bearing
 * and in-tree: `check-type-debt.mjs`, `check-enforcer-wiring.mjs` and
 * `stryker-adapter.mjs` all read
 *
 *     path.resolve(entry) === fileURLToPath(import.meta.url) || entry.endsWith('/check-type-debt.mjs')
 *
 * where the filename arm WIDENS an identity check rather than replacing it — a
 * rename still self-executes through the first disjunct. Reporting those three
 * would be a false positive demanding a waiver for correct code. Scoping to the
 * nearest enclosing STATEMENT is what separates them from
 *
 *     const isDirectRun = process.argv[1].endsWith('cli-vocab-guard.ts');
 *
 * where the same statement contains no identity check at all.
 *
 * Both operands are followed through single-assignment aliases (`const entry =
 * process.argv[1]`, `const self = fileURLToPath(import.meta.url)`), because
 * three of the five real predicates in the tree are written that way.
 *
 * Fails CLOSED on a source the parser had to recover from — a `[]` there would
 * read as "no coupling found".
 */
export function classifyEntrypointPredicate(source: string, fileName: string): EntrypointPredicate {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (Array.isArray(diagnostics) && diagnostics.length > 0) {
    throw new Error(`${fileName}: ${diagnostics.length} parse error(s) — refusing to classify`);
  }

  const subtreeHas = (node: ts.Node, pred: (n: ts.Node) => boolean): boolean => {
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (pred(n)) {
        found = true;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const isArgv1 = (n: ts.Node): boolean =>
    ts.isElementAccessExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'argv' &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'process' &&
    ts.isNumericLiteral(n.argumentExpression) &&
    n.argumentExpression.text === '1';

  const isImportMeta = (n: ts.Node): boolean => n.kind === ts.SyntaxKind.MetaProperty;

  const argvAliases = new Set<string>();
  const metaAliases = new Set<string>();
  const collectAliases = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
      if (subtreeHas(n.initializer, isArgv1)) argvAliases.add(n.name.text);
      if (subtreeHas(n.initializer, isImportMeta)) metaAliases.add(n.name.text);
    }
    ts.forEachChild(n, collectAliases);
  };
  ts.forEachChild(sourceFile, collectAliases);

  const mentionsArgv = (n: ts.Node): boolean =>
    subtreeHas(n, (x) => isArgv1(x) || (ts.isIdentifier(x) && argvAliases.has(x.text)));
  const mentionsMeta = (n: ts.Node): boolean =>
    subtreeHas(n, (x) => isImportMeta(x) || (ts.isIdentifier(x) && metaAliases.has(x.text)));

  /** The nearest enclosing statement — the scope a predicate is written in. */
  const enclosingStatement = (node: ts.Node): ts.Node => {
    let current: ts.Node = node;
    while (current.parent !== undefined && !ts.isStatement(current)) current = current.parent;
    return current;
  };

  /** `argv[1] === <something mentioning import.meta>`, in either operand order. */
  const isIdentityCheck = (n: ts.Node): boolean => {
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      return (
        (mentionsArgv(n.left) && mentionsMeta(n.right)) ||
        (mentionsArgv(n.right) && mentionsMeta(n.left))
      );
    }
    // `isDirectExecution(import.meta.url, process.argv[1])` — the helper form.
    if (ts.isCallExpression(n)) {
      return n.arguments.some((a) => mentionsArgv(a)) && n.arguments.some((a) => mentionsMeta(a));
    }
    return false;
  };

  const coupledLiterals: string[] = [];
  const isFilenameTest = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    (n.expression.name.text === 'endsWith' || n.expression.name.text === 'includes') &&
    n.arguments.length === 1 &&
    mentionsArgv(n.expression.expression);

  const visit = (n: ts.Node): void => {
    if (isFilenameTest(n)) {
      const literal = n.arguments[0];
      if (
        literal !== undefined &&
        ts.isStringLiteralLike(literal) &&
        !subtreeHas(enclosingStatement(n), isIdentityCheck)
      ) {
        coupledLiterals.push(literal.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { coupledLiterals };
}

/**
 * `<package>/src/**` test files, keyed `<packageDir>::<basename>` — the input
 * that lets {@link selfTestCandidates} see a `scripts/` guard whose self-test
 * was filed under `src/` instead of beside it.
 *
 * Built once and passed in, rather than globbed inside the candidate function,
 * so `selfTestCandidates` stays a pure path computation that a unit test can
 * exercise without a tree.
 */
export interface MirroredSelfTestIndex {
  readonly byPackageAndName: ReadonlyMap<string, readonly string[]>;
}

/** The packages whose `scripts/` modules may file a self-test under `src/`. */
const MIRROR_PACKAGES: readonly string[] = ['', 'servers/exarchos-mcp'];

function mirrorKey(packageDir: string, name: string): string {
  return `${packageDir}::${name}`;
}

/** The `<pkg>` of a `<pkg>/scripts/<file>` artifact, or `null` when it is not one. */
function scriptsPackageOf(artifact: string): string | null {
  if (artifact.startsWith('scripts/')) return '';
  const match = /^(.*)\/scripts\/[^/]+$/.exec(artifact);
  return match?.[1] ?? null;
}

/**
 * Index `<pkg>/src/**` self-tests by basename.
 *
 * Only DIRECT `.test.*` siblings of a source name are indexed; the key drops the
 * `.test.<ext>` suffix so `authority-live-proof.test.ts` is found from
 * `authority-live-proof.ts`.
 */
export function indexMirroredSelfTests(repoRoot: string = REPO_ROOT): MirroredSelfTestIndex {
  const byPackageAndName = new Map<string, string[]>();
  const walk = (packageDir: string, dir: string): void => {
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
        walk(packageDir, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stem = /^(.*)\.test\.[cm]?[jt]s$/.exec(entry.name)?.[1];
      if (stem === undefined) continue;
      const key = mirrorKey(packageDir, stem);
      byPackageAndName.set(key, [...(byPackageAndName.get(key) ?? []), rel]);
    }
  };
  for (const packageDir of MIRROR_PACKAGES) {
    walk(packageDir, packageDir === '' ? 'src' : `${packageDir}/src`);
  }
  for (const paths of byPackageAndName.values()) paths.sort();
  return { byPackageAndName };
}

/**
 * Self-test candidates for an artifact, in resolution order.
 *
 * Co-located siblings first — the ordinary case. When `mirror` is supplied and
 * the artifact is a `<pkg>/scripts/` module, the `<pkg>/src/**` file of the same
 * name is offered too: `servers/exarchos-mcp/scripts/authority-live-proof.ts`
 * (42 KB of live authority measurement) has its self-test at
 * `servers/exarchos-mcp/src/architecture/authority-live-proof.test.ts`, and with
 * only the co-located rule the whole guard read as untested and dropped out of
 * the inventory.
 *
 * An AMBIGUOUS basename (two `src/**` tests of the same name) yields NO mirrored
 * candidate. Guessing which one is the self-test could make an unexamined module
 * read as covered; reporting it as untested is the direction that fails toward a
 * finding.
 */
export function selfTestCandidates(artifact: string, mirror?: MirroredSelfTestIndex): string[] {
  const base = artifact.replace(/\.[cm]?[jt]s$/, '').replace(/\.sh$/, '');
  const colocated = [`${base}.test.ts`, `${base}.test.mts`, `${base}.test.mjs`, `${base}.test.sh`];
  if (mirror === undefined) return colocated;
  const packageDir = scriptsPackageOf(artifact);
  if (packageDir === null) return colocated;
  const name = posix.basename(base);
  const mirrored = mirror.byPackageAndName.get(mirrorKey(packageDir, name)) ?? [];
  if (mirrored.length !== 1) return colocated;
  return colocated.includes(mirrored[0] ?? '') ? colocated : [...colocated, ...mirrored];
}

export interface McpScriptScan {
  /** Modules with a self-test — the channel-3 guard population. */
  readonly gatesWithSelfTest: readonly string[];
  /** Runnable modules with no self-test: an executable verdict nothing re-asserts. */
  readonly runnableWithoutSelfTest: readonly string[];
  /** Non-runnable modules with no self-test: no executable verdict to reach at all. */
  readonly compileTimeOnly: readonly string[];
}

export function scanMcpScriptGates(repoRoot: string = REPO_ROOT, mirror?: MirroredSelfTestIndex): McpScriptScan {
  const dir = join(repoRoot, MCP_SCRIPTS_DIR);
  const gatesWithSelfTest: string[] = [];
  const runnableWithoutSelfTest: string[] = [];
  const compileTimeOnly: string[] = [];
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
    if (selfTestCandidates(rel, mirror).some((c) => existsSync(join(repoRoot, c)))) {
      gatesWithSelfTest.push(rel);
      continue;
    }
    const source = readFileSync(join(dir, entry.name), 'utf8');
    if (hasDirectRunExit(source, rel)) runnableWithoutSelfTest.push(rel);
    else compileTimeOnly.push(rel);
  }
  return {
    gatesWithSelfTest: gatesWithSelfTest.sort(),
    runnableWithoutSelfTest: runnableWithoutSelfTest.sort(),
    compileTimeOnly: compileTimeOnly.sort(),
  };
}

// ─── Channel 4: architecture census / seam modules ───────────────────────────

export interface ArchitectureScan {
  /** Modules with a co-located self-test — the channel-4 guard population. */
  readonly modulesWithSelfTest: readonly string[];
  /** Modules with none, reported so the exclusion stays reviewable. */
  readonly modulesWithoutSelfTest: readonly string[];
}

/**
 * Channel 4 — every non-test module directly under {@link MCP_ARCHITECTURE_DIR}.
 *
 * TOP-LEVEL only: `__tests__/` and `__fixtures__/` under it hold subjects of the
 * guards, not guards. Fails closed on an unreadable root for the same reason as
 * {@link scanMcpScriptGates} — an empty channel reads as "no guards here".
 */
export function scanArchitectureModules(repoRoot: string = REPO_ROOT): ArchitectureScan {
  const dir = join(repoRoot, MCP_ARCHITECTURE_DIR);
  const modulesWithSelfTest: string[] = [];
  const modulesWithoutSelfTest: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `${MCP_ARCHITECTURE_DIR}: cannot enumerate (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.[cm]?ts$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
    const rel = `${MCP_ARCHITECTURE_DIR}/${entry.name}`;
    if (isTestArtifact(rel)) continue;
    const hasSelfTest = selfTestCandidates(rel).some((c) => existsSync(join(repoRoot, c)));
    if (hasSelfTest) modulesWithSelfTest.push(rel);
    else modulesWithoutSelfTest.push(rel);
  }
  return {
    modulesWithSelfTest: modulesWithSelfTest.sort(),
    modulesWithoutSelfTest: modulesWithoutSelfTest.sort(),
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
  /**
   * Source of a repo-relative shell script, or `null` when it is not a readable
   * file. Absent means indirection is NOT followed — which
   * {@link auditGuardInventory} then reports as `[empty-indirection-walk]` rather
   * than letting a resolver that walked nothing pass as clean.
   */
  readonly readScript?: (path: string) => string | null;
  /** Precomputed wrapper-script reach, per run-step. See {@link indexShellIndirection}. */
  readonly shellIndex?: ShellIndirectionIndex;
  /**
   * `<pkg>/src/**` self-tests, so a `scripts/` guard whose test was filed under
   * `src/` still resolves one. Absent means co-located siblings only.
   */
  readonly mirroredSelfTests?: MirroredSelfTestIndex;
}

/**
 * Wrapper-script reach for every `run:` step in the workflow set, computed once.
 *
 * Keyed by the parsed step OBJECT rather than by a synthesized string id, so the
 * index and {@link resolveHosts} cannot disagree about which step they are
 * talking about — they iterate the same parsed documents.
 */
export interface ShellIndirectionIndex {
  readonly byStep: ReadonlyMap<WorkflowStep, readonly ShellExecution[]>;
  /** Every `run:` step examined — zero means the resolver walked nothing. */
  readonly runStepsWalked: number;
  /** Distinct wrapper scripts actually read. */
  readonly wrapperScriptsWalked: readonly string[];
  /** Invocation words whose variables could not be resolved. */
  readonly unresolvedInvocations: readonly string[];
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

/**
 * Walk every `run:` step once and record what it reaches through shell wrappers.
 *
 * Done as ONE pass over the workflow set rather than per-guard, so the
 * non-empty-denominator numbers ({@link ShellIndirectionIndex.runStepsWalked},
 * `wrapperScriptsWalked`) describe the resolver itself and not whichever guard
 * happened to be asked about last.
 */
export function indexShellIndirection(ctx: ResolutionContext): ShellIndirectionIndex {
  const byStep = new Map<WorkflowStep, readonly ShellExecution[]>();
  const wrapperScripts = new Set<string>();
  const unresolved = new Set<string>();
  let runStepsWalked = 0;
  const read = ctx.readScript;

  for (const { doc } of ctx.workflows) {
    for (const job of Object.values(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        runStepsWalked += 1;
        if (read === undefined) continue;
        const workingDir = stepWorkingDirectory(job, step);
        const pkg = workingDir === 'servers/exarchos-mcp' ? ctx.mcpPkg : ctx.rootPkg;
        const expanded = expandNpmScripts(step.run, pkg);
        const executions: ShellExecution[] = [];
        // The step's own text is scanned for the wrapper scripts it launches; the
        // wrappers' contents are what the walk then resolves.
        // `$GITHUB_WORKSPACE` is the checkout root — the one anchor the workflow
        // steps themselves use (`bash "$GITHUB_WORKSPACE/scripts/npm-ci-retry.sh"`).
        const stepVars = new Map<string, string>([['GITHUB_WORKSPACE', ROOT_ANCHOR]]);
        for (const line of expanded.split('\n')) {
          for (const rawWord of shellWords(line)) {
            if (!rawWord.endsWith('.sh')) continue;
            const resolved = rawWord.includes('$') ? expandShellVars(rawWord, stepVars) : rawWord;
            if (resolved === null) continue;
            const word = normalizeRepoPath(resolved);
            if (word === null || word === '') continue;
            const candidates = [word];
            if (workingDir !== '') candidates.push(`${workingDir}/${word}`);
            for (const candidate of candidates) {
              if (read(candidate) === null) continue;
              const walk = resolveShellExecutions(candidate, read);
              for (const script of walk.scriptsWalked) wrapperScripts.add(script);
              for (const item of walk.unresolved) unresolved.add(item);
              for (const execution of walk.executions) executions.push(execution);
            }
          }
        }
        if (executions.length > 0) byStep.set(step, executions);
      }
    }
  }

  return {
    byStep,
    runStepsWalked,
    wrapperScriptsWalked: [...wrapperScripts].sort(),
    unresolvedInvocations: [...unresolved].sort(),
  };
}

/** Resolve every CI host of one guard artifact. */
export function resolveHosts(artifact: string, ctx: ResolutionContext): GuardHost[] {
  const hosts: GuardHost[] = [];
  const selfTests = selfTestCandidates(artifact, ctx.mirroredSelfTests).filter((c) => ctx.exists(c));

  for (const { path: workflowPath, doc } of ctx.workflows) {
    const isCi = workflowPath === CI_WORKFLOW;
    const aggregatorNeeds = new Set(isCi ? needsList(doc.jobs?.[AGGREGATOR_JOB]) : []);
    const onPullRequest = runsOnPullRequest(doc);

    for (const [jobName, job] of Object.entries(doc.jobs ?? {})) {
      if (jobName === AGGREGATOR_JOB) continue;
      const keys = pathFilterKeys(job);

      const record = (via: HostingVia, exitSwallowed: boolean, through: readonly string[] = []): void => {
        const blocking = isCi
          ? aggregatorNeeds.has(jobName) && !exitSwallowed
          : onPullRequest && !exitSwallowed;
        hosts.push({
          workflow: workflowPath,
          job: jobName,
          via,
          through,
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
      // (a2) INDIRECT execution: a step runs a shell wrapper that runs the guard.
      //      Tracked separately from (a) so the chain survives into the verdict.
      const indirect = new Map<string, { through: readonly string[]; swallowed: boolean }>();
      const noteIndirect = (execution: ShellExecution, stepSwallowed: boolean): void => {
        const key = execution.through.join(' → ');
        const swallowed = stepSwallowed || execution.exitSwallowed;
        const prior = indirect.get(key);
        if (prior === undefined) indirect.set(key, { through: execution.through, swallowed });
        else indirect.set(key, { through: prior.through, swallowed: prior.swallowed && swallowed });
      };
      /**
       * A guard run BY ITS OWN `.test.sh` is executing against seeded fixtures, not
       * policing the repo — so that chain stays `self-test` and cannot make an
       * unwired gate read as wired. Collapsing this into `direct` would re-open the
       * exact hole {@link isEnforcingHost} exists to keep shut.
       */
      const viaFor = (through: readonly string[]): HostingVia =>
        through.some((script) => selfTests.includes(script)) ? 'self-test' : 'direct';
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
        for (const execution of ctx.shellIndex?.byStep.get(step) ?? []) {
          if (execution.target === artifact) noteIndirect(execution, swallowed);
          else if (selfTests.includes(execution.target)) {
            selfTestSwallowed =
              selfTestSwallowed === null
                ? swallowed || execution.exitSwallowed
                : selfTestSwallowed && (swallowed || execution.exitSwallowed);
          }
        }
      }
      if (directSwallowed !== null) record('direct', directSwallowed);
      if (selfTestSwallowed !== null) record('self-test', selfTestSwallowed);
      for (const { through, swallowed } of indirect.values()) record(viaFor(through), swallowed, through);

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
export type ExemptedFinding =
  | 'unreachable'
  | 'filtered-implementation-surface'
  | 'filename-coupled-entrypoint';

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
  // NARROWED by task 023, not discharged. This entry named task 023 as its
  // blocker on the reasoning that populating the allowlist would make the gate
  // green. Task 023 landed and the reasoning turned out to be incomplete, so the
  // correction is recorded here rather than the entry being re-dated:
  //
  //   Ten of the eleven literals are now tracked debt with an owner and an
  //   ENFORCED deadline, and the ratchet half is wired blocking and unfiltered
  //   (`cli-derivation-ratchet-guard.ts`, which this inventory reports as
  //   `enforcement: blocks`, `pathFilteredOnly: false`). What remains is ONE
  //   violation — `merge-orchestrate`, the DR-5 kill fixture. It is not
  //   allowlistable: `readPolicy` refuses a policy file that names it, because
  //   an earlier revision exempted it and thereby neutralized the rejection DR-5
  //   requires. DR-5's stated remediation is to DELETE the hand-written
  //   `.command('merge-orchestrate')` call and let the registry declaration be
  //   the single remaining definition — and NO Wave-1 task owns that edit. Task
  //   023's `**Files:**` list does not include the composition root, and
  //   removing a promoted top-level verb is a user-visible surface change that
  //   the `init` / `install-skills` precedent says needs a rename stub, i.e. a
  //   decision rather than a guard task.
  //
  // DISCHARGED by task 076 — entry removed rather than re-dated.
  //
  // The entry above recorded that the derivation entrypoint stayed unwired
  // because ONE violation survived task 023's paydown: `merge-orchestrate` was
  // declared both as a registry action and by hand in the composition root, and
  // as the DR-5 kill fixture it could not be allowlisted around. It named the
  // unblocking edit ("delete the hand-written call") and noted the edit was
  // unowned by any Wave-1 task.
  //
  // Task 076 made that edit, and the resolution was cheaper than the entry
  // assumed. The entry reasoned that deleting a promoted top-level verb is a
  // user-visible surface change needing an `init`-style rename stub — a decision
  // rather than a guard task. That premise was WRONG, and the correction is
  // recorded here rather than lost with the entry: DR-7 had already shipped
  // `CliActionHints.topLevel`, a registry hint whose hoist loop registers a
  // top-level command through `registerActionCommand`. Moving the promotion onto
  // that hint deletes the hand-written literal while keeping `exarchos
  // merge-orchestrate …` byte-identical for operators. No rename stub was owed,
  // because nothing was renamed — only the place the name is DECLARED moved.
  //
  // The derivation entrypoint is now wired direct and blocking on the unfiltered
  // `grep-gates` deps tail (the host class this entry itself specified), so it
  // no longer exhibits `unreachable` and `auditGuardInventory` would flag a
  // surviving entry as `[stale-exemption]`. That tooth is what forced this
  // deletion, and it is the mechanism working as designed.
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

// ─── Spec-artifact waivers (the second hand-maintained input) ────────────────

/**
 * A Wave-1 `**Files:**` entry that never landed under the name the spec gave it.
 *
 * Same construction as {@link GuardExemption} and for the same reason: the entry
 * is a DEBT with an owner and a deadline, not a permanent excuse. The spec is a
 * landed historical record, so the reconciliation is recorded HERE rather than
 * by editing the document — amending the plan to match what shipped would erase
 * the drift signal instead of paying it.
 */
export interface SpecArtifactWaiver {
  /** The unresolved `**Files:**` entry, exactly as the spec spells it. */
  readonly artifact: string;
  /** What actually happened to it. Must name where the work landed, or that it did not. */
  readonly reason: string;
  /** The task or issue that reconciles it. */
  readonly blockedBy: string;
  /** ISO `YYYY-MM-DD`. Past this date the waiver FAILS rather than lapsing quietly. */
  readonly expires: string;
}

/**
 * The four Wave-1 artifacts the spec named and the tree does not have.
 *
 * All four are the same shape — a planned FILE SPLIT that the implementer
 * consolidated — and the consolidation was the better call in each case. What
 * was missing is that nothing said so anywhere a gate could read, which is the
 * whole of DR-9's complaint applied to channel 2's denominator.
 */
export const SPEC_ARTIFACT_WAIVERS: readonly SpecArtifactWaiver[] = Object.freeze([
  Object.freeze({
    artifact: 'servers/exarchos-mcp/src/architecture/authority-topology.data.ts',
    reason:
      'Task 024 planned to split the boundary rows into a `.data.ts` sibling so "policy is data ' +
      'the census reads, never prose inside a test body". The rows landed as the exported ' +
      '`AUTHORITY_TOPOLOGY` inside `authority-topology.ts` itself, which satisfies that rule ' +
      '(the census imports the data; no rule lives in a test predicate) without the extra file. ' +
      'Task 027 named the same path again and inherited the same non-landing.',
    blockedBy: '#1764 (Wave-1 spec reconciliation)',
    expires: '2026-11-05',
  }),
  Object.freeze({
    artifact: 'servers/exarchos-mcp/src/architecture/authority-topology.census.test.ts',
    reason:
      "Task 025's census tests landed in `authority-census.test.ts`, beside the census they " +
      'exercise, rather than in a second test file named after the topology. The co-located ' +
      'placement is what DR-24 asks for; the spec named the file before the module split was ' +
      'settled.',
    blockedBy: '#1764 (Wave-1 spec reconciliation)',
    expires: '2026-11-05',
  }),
  Object.freeze({
    artifact: 'servers/exarchos-mcp/src/architecture/__tests__/authority-topology.kill-fixtures.test.ts',
    reason:
      "Task 026's kill fixtures landed inside `authority-census.test.ts` and " +
      '`authority-live-proof.test.ts` rather than as a separate `__tests__/` file, and none of ' +
      'the three test names the spec listed survived verbatim. The fixtures themselves ARE in ' +
      'the tree — what did not land is the file boundary.',
    blockedBy: '#1764 (Wave-1 spec reconciliation)',
    expires: '2026-11-05',
  }),
  Object.freeze({
    artifact: 'servers/exarchos-mcp/src/architecture/__tests__/output-schema-census.selftest.test.ts',
    reason:
      "Task 018's G2 self-test landed one directory up, at " +
      '`servers/exarchos-mcp/src/architecture/output-schema-census.selftest.test.ts`, so it sits ' +
      'beside the census it guards instead of under `__tests__/`. Same file, same content, ' +
      'different directory.',
    blockedBy: '#1764 (Wave-1 spec reconciliation)',
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

  /** `null` for anything that is not a readable regular file (a directory throws). */
  const readScript = (path: string): string | null => {
    try {
      return readFileSync(join(repoRoot, path), 'utf8');
    } catch {
      return null;
    }
  };

  const mirroredSelfTests = indexMirroredSelfTests(repoRoot);
  const base: ResolutionContext = {
    workflows,
    rootPkg: readPackageScripts(repoRoot, ''),
    mcpPkg: readPackageScripts(repoRoot, 'servers/exarchos-mcp'),
    suites: loadSuiteConfigs(repoRoot),
    exists: (path) => existsSync(join(repoRoot, path)),
    readScript,
    mirroredSelfTests,
  };
  const ctx: ResolutionContext = { ...base, shellIndex: indexShellIndirection(base) };

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

  const basenameIndex = indexSourceBasenames(repoRoot);
  const unresolvedSpecArtifacts: string[] = [];
  const compileTimeOnlyArtifacts: string[] = [];
  for (const task of wave1Tasks(parseSpecTasks(specText))) {
    for (const rawFile of task.files) {
      if (!isPathShaped(rawFile)) continue;
      const file = resolveSpecArtifact(rawFile, ctx.exists, basenameIndex);
      if (file === null) {
        unresolvedSpecArtifacts.push(rawFile);
        continue;
      }
      if (isTestArtifact(file)) continue;
      if (!/\.[cm]?[jt]s$|\.sh$/.test(file)) continue;
      // DR-24's own definition of a guard: it has a self-test that runs in the
      // same CI job. A Wave-1 module with neither a self-test nor an entrypoint
      // carries no executable verdict — its rung is `tsc`, not a CI step — so it
      // is recorded rather than judged against execution reachability.
      const hasSelfTest = selfTestCandidates(file, mirroredSelfTests).some((c) => ctx.exists(c));
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

  const mcpScan = scanMcpScriptGates(repoRoot, mirroredSelfTests);
  for (const gate of mcpScan.gatesWithSelfTest) add(gate, 'mcp-scripts-gate');
  for (const module of mcpScan.compileTimeOnly) compileTimeOnlyArtifacts.push(module);

  const architectureScan = scanArchitectureModules(repoRoot);
  for (const module of architectureScan.modulesWithSelfTest) add(module, 'mcp-architecture-module');

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

  // DR-4: the entrypoint predicate, over the SAME population every other column
  // is computed from. Scoping it to the inventory rather than to a directory is
  // the point — a guard has to escape all four discovery channels to escape this
  // check too, and a new guard enters it without anyone remembering to.
  const filenameCoupledEntrypoints: FilenameCoupledEntrypoint[] = [];
  let entrypointPredicatesScanned = 0;
  for (const guard of guards) {
    if (!/\.[cm]?[jt]s$/.test(guard.artifact)) continue;
    const source = readScript(guard.artifact);
    if (source === null) continue;
    entrypointPredicatesScanned += 1;
    const { coupledLiterals } = classifyEntrypointPredicate(source, guard.artifact);
    if (coupledLiterals.length > 0) {
      filenameCoupledEntrypoints.push({ artifact: guard.artifact, literals: coupledLiterals });
    }
  }

  return {
    guards,
    runnableWithoutSelfTest: mcpScan.runnableWithoutSelfTest,
    architectureModulesWithoutSelfTest: architectureScan.modulesWithoutSelfTest,
    compileTimeOnlyArtifacts: [...new Set(compileTimeOnlyArtifacts)].sort(),
    unresolvedSpecArtifacts: [...new Set(unresolvedSpecArtifacts)].sort(),
    filenameCoupledEntrypoints,
    entrypointPredicatesScanned,
    indirection: ctx.shellIndex ?? { byStep: new Map(), runStepsWalked: 0, wrapperScriptsWalked: [], unresolvedInvocations: [] },
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
 *   `[unresolved-spec-artifact]`   — a Wave-1 `**Files:**` entry with no file behind it
 *                                    and no waiver. Wave 1 is closed, so "not landed
 *                                    yet" has expired as an explanation: an artifact
 *                                    the spec promised and the tree lacks is either a
 *                                    guard that never shipped or a rename nothing
 *                                    recorded, and both used to pass this proof
 *                                    unremarked (DR-9).
 *   `[expired-spec-artifact-waiver]` / `[stale-spec-artifact-waiver]` — the same expiry
 *                                    and staleness teeth GUARD_EXEMPTIONS carries,
 *                                    applied to {@link SPEC_ARTIFACT_WAIVERS}: a waiver
 *                                    whose artifact turns up on disk is removed, not
 *                                    left standing to cover a later disappearance.
 *   `[empty-entrypoint-scan]`      — the entrypoint classifier parsed zero sources, so
 *                                    "no coupled entrypoint" is vacuous.
 *   `[filename-coupled-entrypoint]` — DR-4: the guard self-executes on a match against
 *                                    its own FILENAME, so a rename silently turns it
 *                                    into a no-op while every other column here still
 *                                    reports it as hosted and blocking.
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
    readonly specArtifactWaivers?: readonly SpecArtifactWaiver[];
    readonly manifestJson?: unknown;
    readonly filterGlobs?: Record<string, string[]>;
  } = {},
): InventoryAudit {
  const now = options.now ?? new Date();
  const exemptions = options.exemptions ?? GUARD_EXEMPTIONS;
  const specWaivers = options.specArtifactWaivers ?? SPEC_ARTIFACT_WAIVERS;
  const violations: string[] = [];
  const byArtifact = new Map(inventory.guards.map((g) => [g.artifact, g]));

  if (inventory.guards.length === 0) {
    violations.push(
      '[empty-inventory]  the inventory resolved zero guards — a run that finds nothing ' +
        'fails rather than passing clean (DR-24 non-empty denominator)',
    );
  }

  // The same rule applied to the indirection resolver itself. A walk that
  // examined no run-step, or found no wrapper script, reports every
  // wrapper-hosted guard as unwired while looking exactly like a clean run —
  // task 070's own failure, silently reintroduced.
  if (inventory.indirection.runStepsWalked === 0) {
    violations.push(
      '[empty-indirection-walk]  the wrapper-script resolver walked ZERO `run:` steps — ' +
        'indirect hosting cannot have been resolved, so a clean result proves nothing',
    );
  } else if (inventory.indirection.wrapperScriptsWalked.length === 0) {
    violations.push(
      `[empty-indirection-walk]  the resolver walked ${inventory.indirection.runStepsWalked} ` +
        '`run:` step(s) but read ZERO wrapper scripts — either no CI step invokes a shell ' +
        'script (it does) or the walk is broken; a guard hosted only through a wrapper would ' +
        'read as unwired',
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
    ['filename-coupled-entrypoint', new Set(inventory.filenameCoupledEntrypoints.map((e) => e.artifact))],
  ]);

  // ── Filename-coupled entrypoints (DR-4) ────────────────────────────────────
  // The same non-empty-denominator rule the inventory applies to itself: a
  // classifier that parsed nothing reports no coupling and looks exactly like a
  // clean tree.
  if (inventory.entrypointPredicatesScanned === 0) {
    violations.push(
      '[empty-entrypoint-scan]  the entrypoint-predicate classifier parsed ZERO guard ' +
        'sources — no coupling could have been found, so a clean result proves nothing',
    );
  }
  for (const coupled of inventory.filenameCoupledEntrypoints) {
    if (excusedBy(coupled.artifact, 'filename-coupled-entrypoint') !== undefined) continue;
    violations.push(
      `${coupled.artifact}  [filename-coupled-entrypoint]  self-executes on ` +
        `${coupled.literals.map((l) => `\`argv[1].endsWith('${l}')\``).join(' or ')}, so renaming ` +
        'it leaves a step that runs and enforces nothing while this inventory still reports it ' +
        'as hosted — compare the RESOLVED `argv[1]` against `fileURLToPath(import.meta.url)` ' +
        '(DR-4), or record an expiring GUARD_EXEMPTIONS entry',
    );
  }

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
    const checkable = exemption.excuses !== 'filtered-implementation-surface' || filtersKnown;
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

  // ── Promised-but-absent Wave-1 artifacts (DR-9) ────────────────────────────
  const unresolved = new Set(inventory.unresolvedSpecArtifacts);
  const waivedArtifacts = new Set(specWaivers.map((w) => w.artifact));
  for (const artifact of inventory.unresolvedSpecArtifacts) {
    if (waivedArtifacts.has(artifact)) continue;
    violations.push(
      `${artifact}  [unresolved-spec-artifact]  a Wave-1 \`**Files:**\` entry with no file ` +
        'behind it — land it, or record what it became in SPEC_ARTIFACT_WAIVERS with an owner ' +
        'and an expiry',
    );
  }
  for (const waiver of specWaivers) {
    if (!unresolved.has(waiver.artifact)) {
      violations.push(
        `${waiver.artifact}  [stale-spec-artifact-waiver]  waived as absent but the spec entry ` +
          'now resolves — remove the waiver so a later disappearance cannot pass unnoticed',
      );
    }
    const expiry = Date.parse(`${waiver.expires}T00:00:00Z`);
    if (Number.isNaN(expiry)) {
      violations.push(
        `${waiver.artifact}  [expired-spec-artifact-waiver]  unparseable expiry "${waiver.expires}"`,
      );
    } else if (expiry <= now.getTime()) {
      violations.push(
        `${waiver.artifact}  [expired-spec-artifact-waiver]  expired ${waiver.expires} ` +
          `(blocked on ${waiver.blockedBy}) — reconcile it or re-justify with a new deadline`,
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
 * {@link isEnforcingHost}). An INDIRECT host renders the whole chain
 * (`job → wrapper.sh`), because "reachable" without "how" is a claim a reviewer
 * cannot check — and this inventory reported the opposite verdict for exactly one
 * missing hop until task 070.
 */
export function describeHost(host: GuardHost): string {
  const chain = host.through.length === 0 ? '' : ` → ${host.through.join(' → ')}`;
  return `${host.job}${chain}${host.via === 'self-test' ? ' (via self-test)' : ''}`;
}

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
        : [...new Set(enforcing.map((h) => describeHost(h)))].join(', ');
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
