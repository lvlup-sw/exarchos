#!/usr/bin/env node
/**
 * check-module-intent — module-intent CI gate (DR-7, DR-8).
 *
 * A production module under `src` with ZERO production
 * importers is a debloat candidate. Rather than delete blindly, DR-7 requires
 * every such dead-in-prod module to DECLARE ITS INTENT, and the declaration to
 * be honored:
 *
 *   1. a `RESERVED(issue, owner, expires)` header whose `expires` is a CLEAN,
 *      parseable calendar date that is NOT in the past — an expired-and-unadopted
 *      RESERVED stub FAILS (this is the DR-7 "deletion happens at expiry"
 *      enforcement point). A well-formed issue ref (`#<number>`) and a non-empty
 *      owner are also required, OR
 *   2. membership in a declared CLASS ALLOWLIST — test-infra / build-shim /
 *      type-test entrypoint — whose members are legitimately imported only by
 *      tests (or not at all, for `*.type-test.ts` entrypoints) and are not
 *      production import targets.
 *
 * Any dead-in-prod module that declares neither → FAIL (exit 1): add a RESERVED
 * header, place it in a declared class, or delete it.
 *
 * Reachability is delegated to the vendored `tools/audit/refgraph.mjs`
 * detector (the SAME instrument the 005 disposition baseline used). refgraph is
 * deliberately type-BLIND — a `import type` edge still counts as an importer —
 * which is the correct posture here: a type-only importer still justifies the
 * module's existence.
 *
 * FAIL-CLOSED (DR-8): if the reachability scan crashes / exits non-zero, its
 * output cannot be parsed, or an in-scope module cannot be read, the gate FAILS
 * with a named cause (exit 2) rather than passing on partial evidence. A gate
 * that silently no-ops on a tooling error is a gate that isn't there.
 *
 *   Exit 0 — every dead-in-prod module declares valid intent (clean).
 *   Exit 1 — one or more dead-in-prod modules lack valid intent (undeclared, or
 *            an expired / malformed RESERVED header).
 *   Exit 2 — fail-closed: scan crash / unparseable scan output / unreadable
 *            module / usage error.
 *
 * Flags (primarily for testability):
 *   --src-root <path>   Root dir the detector scans. Default
 *                       `src` (repo-relative).
 *   --refgraph <path>   Reachability detector script. Default
 *                       `tools/audit/refgraph.mjs`.
 *   --now <YYYY-MM-DD>  "Today" for expiry comparison. Default: system clock.
 *   --help              Show usage.
 */
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_SRC_ROOT = path.join(REPO_ROOT, 'src');
const DEFAULT_REFGRAPH = path.join(REPO_ROOT, 'tools', 'audit', 'refgraph.mjs');

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILCLOSED = 2;

// ── path helpers (refgraph emits forward-slashed, repo-relative paths) ────────
const segments = (rel) => rel.split('/');
const basename = (rel) => segments(rel).pop() ?? rel;

// ─────────────────────────────────────────────────────────────────────────────
// CLASS ALLOWLIST
//
// A dead-in-prod module is exempt from the RESERVED-header requirement iff it
// belongs to one of these declared classes. Each class is a MEMBERSHIP RULE
// (a predicate over the module's repo-relative path) plus a rationale — NOT a
// bare path whitelist. The convention-based classes generalize (any future
// module matching the convention is covered); the one `declared-test-infra`
// class enumerates the two modules that are unambiguous test/gate infra but
// lack a filename convention, each with its own per-member rationale.
//
// These cover the 10 CLASS-ALLOWLIST modules from the 005 disposition table
// plus `architecture/import-cycles.ts` (a task-009 sibling of contract-seam,
// added after the 005 baseline — see its member note).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Subtrees of the scan root that this census has no jurisdiction over, because
 * they are not entered through the engine's import graph. See the note at the
 * classification loop; membership is asserted non-vacuous by
 * `ModuleIntent_OutOfSubjectPrefixes_AllExist`.
 */
const OUT_OF_SUBJECT = ['install'];

const ALLOWLIST_CLASSES = [
  {
    name: 'test-helper',
    rationale:
      'Co-located test helper under a `test-helpers/` directory — imported only by tests by design (e.g. test-helpers/temp-dir, workflow/test-helpers/canonical-envelope).',
    matches: (rel) => segments(rel).includes('test-helpers'),
  },
  {
    name: 'test-fixtures',
    rationale:
      'Co-located test fixtures/data — a `__fixtures__/` directory or a `*-fixtures.ts` / `*.fixtures.ts` filename (e.g. event-store/decide-fixtures). Test-only by convention.',
    matches: (rel) =>
      segments(rel).includes('__fixtures__') || /(^|[.-])fixtures?\.ts$/.test(basename(rel)),
  },
  {
    name: 'build-shim',
    rationale:
      'Runtime/build shim under a `__shims__/` directory that swaps an implementation under test (e.g. storage/__shims__/bun-sqlite-node) — never production-imported.',
    matches: (rel) => segments(rel).includes('__shims__'),
  },
  {
    name: 'type-test-entrypoint',
    rationale:
      'A `*.type-test.ts` compile-time assertion entrypoint, deliberately named to dodge the tsconfig `*.test.ts` exclude so `tsc` gates on it (DR-4). No runtime importer by design.',
    matches: (rel) => /\.type-test\.ts$/.test(basename(rel)),
  },
  {
    name: 'benchmark-harness',
    rationale:
      'Benchmark test-data factory/generator under a `benchmarks/` directory, exercised only by benchmark tests (e.g. benchmarks/event-factories, telemetry/benchmarks/cold-start). A `*-schema.ts` is a contract surface (escalated separately) and is excluded.',
    matches: (rel) => segments(rel).includes('benchmarks') && !/-schema\.ts$/.test(basename(rel)),
  },
  {
    name: 'source-lint-seam',
    rationale:
      'A `*-seam.ts` test-invoked source-lint gate: exports lint functions run by its own co-located test against production SOURCE (e.g. core/dispatch.economy-seam, architecture/contract-seam). Gate machinery, not a production import target.',
    matches: (rel) => /-seam\.ts$/.test(basename(rel)),
  },
  {
    name: 'declared-test-infra',
    rationale:
      'Test-invoked analysis / harness modules that are unambiguous gate/test infrastructure but lack a filename convention. Enumerated, each with its own rationale.',
    members: {
      'architecture/import-cycles.ts':
        'Pure Tarjan-SCC runtime import-cycle detector (DR-4, debloat task 009); its co-located test shells dependency-cruiser and feeds the JSON graph here. Gate machinery — the analysis analog of contract-seam. NOTE: added by task 009 AFTER the 005 baseline, so it is the one dead-in-prod module not in 005’s disposition table.',
      'projections/gwt.ts':
        'Given-When-Then test-harness DSL for projection reducers (T044, DR-10). Pure test infrastructure.',
      'verbs/gates/gate-ownership-census.ts':
        'Evidence-ownership census (P01-05): a static scan proving gate-runner.ts is the sole durable evidence emitter, plus a behavioural durability witness. Its co-located test runs it against the live tree. Gate machinery — the census analog of contract-seam, and the enforcement point for P01-05’s exit proof.',
      'architecture/effect-ledger.ts':
        'Effect-ownership census (P04-01): statically classifies every filesystem/process/network occurrence in shipped source against EFFECT_OWNERSHIP and fails on an indeterminate owner. Test-invoked structural gate; the ledger itself is the declared authority, not a production import target.',
      'architecture/vcs-ownership.ts':
        'VCS mutation bypass census (P04-05): fails when git/worktree mutation occurs outside the declared owner surface. Test-invoked structural gate, same class as effect-ledger.',
      'projections/quality/skill-example-validator.ts':
        'Documentation-vs-schema drift gate (P02-07): extracts tool-invocation examples from content/ and commands/ and validates them against the live TOOL_REGISTRY projection. Test-invoked gate machinery — deliberately not a production import target so shipped code never depends on doc parsing.',
      'contract/compiler/generate.ts':
        'Contract-artifact generator entry point (P03-03): regenerates the checked-in proof-fixture baseline and is invoked by its co-located drift guard. Build/gate machinery — the shipped server consumes the generated baseline, never the generator.',
      'workflow/admission/remediation-purity.ts':
        'Remediation no-mutation census (P06-06): a source-import audit proving remediation.ts imports no event-store, atomic-appender, or filesystem API — i.e. that remediation is pure data and can never patch pass-state. Test-invoked structural gate, same class as effect-ledger.',
      'architecture/delivery-safety.ts':
        'Silent-swallow static check for required delivery paths (P04-01): its co-located test runs auditDeliverySafety against the live channel modules and fails on any empty catch / empty .catch() around a required delivery. Test-invoked structural gate, same class as effect-ledger.',
      'architecture/output-schema-census.ts':
        'outputSchema vacuity census (DR-4): enumerates every TOOL_REGISTRY action declaration and partitions each declared outputSchema into vacuous (data accepts every value) vs substantive, failing closed on an empty subject. Its co-located test runs it against the live registry. Test-invoked structural gate, same class as effect-ledger — deliberately not a production import target so the shipped server never depends on the census.',
      'architecture/audit-delivery-closure.ts':
        'Audit-delivery closure audit (DR-4/DR-24, task 069): holds every obligation in audit-delivery-closure.data.ts to BOTH halves — the producing action’s live outputSchema must declare the delivered field and its enumerator as required typed properties, and a declared reader document must carry the whole instruction inside one section. It exists because check_invariant_conformance computed an `auditPrompt` nothing was directed to read, delivered through a vacuityWaiver schema. Its only consumers are its co-located test and that test’s kill fixtures, both test-invoked gate machinery, so it never gains a production importer. Classed here rather than given a RESERVED header for the same reason as output-schema-census.ts and authority-topology.ts: RESERVED means “dead stub, delete at expiry if unadopted”, and a live governance gate is neither. NOTE the DATA file is production-imported (the handler renders its report directive from the same record) and so is not dead — only the mechanism is.',
      'architecture/authority-census.ts':
        'The G5 closure verdict over the authority topology (DR-6, task 025): evaluates every boundary row along the authority / binding / enforcement hops and fails on an unbound representation, more than one authority, or a stale `already-enforced` claim — per row, from the wave that remediates it. Same class as authority-topology.ts and output-schema-census.ts, and classed here for the same reason: RESERVED means “dead stub, delete at expiry if unadopted”, and this is neither a stub nor temporarily dead. Its only consumers are its co-located test and task 026’s kill fixtures, both test-invoked gate machinery, so it never gains a production importer and a RESERVED expiry would either fire spuriously against correct infrastructure or need renewing forever. Deliberately not a production import target so the shipped server never depends on the governance verdict.',
      'architecture/authority-topology.ts':
        'Authority topology as data (DR-6, gate G5): the eight contract-boundary rows — one authority each (or an explicit contested/none), their bound and unbound representations, and the wave from which each is enforced — plus the rows’ own totality check. Classed here rather than given a RESERVED header ON PURPOSE: RESERVED means “dead stub, delete at expiry if unadopted”, and this module is neither a stub nor temporarily dead. Its consumer is the task-025 closure census, which is ITSELF test-invoked gate machinery (same class as output-schema-census), so it never gains a production importer and a RESERVED expiry would either fire spuriously against correct infrastructure or need renewing forever — the rubber stamp DR-7 exists to prevent. Deliberately not a production import target so the shipped server never depends on the governance model.',
    },
    matches(rel) {
      return Object.prototype.hasOwnProperty.call(this.members, rel);
    },
  },
];

/** Return the class a dead module belongs to, or null. */
function classifyAllowed(rel) {
  for (const cls of ALLOWLIST_CLASSES) {
    if (cls.matches(rel)) return cls;
  }
  return null;
}

// ── RESERVED header parsing / validation ─────────────────────────────────────

/**
 * Extract the first `RESERVED(...)` field block from a module's source. Fields
 * are `key: value` pairs separated by commas; the trailing ` — reason` (after
 * the close paren) is not consumed. Returns `{ present: false }` when no marker
 * exists.
 */
function parseReserved(source) {
  const m = /RESERVED\(([^)]*)\)/.exec(source);
  if (!m) return { present: false };
  const fields = {};
  for (const part of m[1].split(',')) {
    const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(part);
    if (kv) fields[kv[1].toLowerCase()] = kv[2];
  }
  return { present: true, fields, raw: m[1].trim() };
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Validate a parsed RESERVED field block. Returns a list of problem strings
 * (empty ⇒ valid). Requires a well-formed issue ref, a non-empty owner, and a
 * CLEAN `YYYY-MM-DD` expiry that is a real calendar date and not in the past.
 */
function validateReserved(fields, now) {
  const problems = [];

  const issue = fields.issue;
  if (!issue || !/^#\d+$/.test(issue)) {
    problems.push(`issue ref must be "#<number>" (got ${JSON.stringify(issue ?? null)})`);
  }

  const owner = fields.owner;
  if (!owner || !/\S/.test(owner)) {
    problems.push('owner is required and must be non-empty');
  }

  const expires = fields.expires;
  if (!expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    // A polluted expires (e.g. "2027-01-31; see also #1609") lands here: the
    // field must be EXACTLY a date, nothing trailing.
    problems.push(`expires must be a clean YYYY-MM-DD date (got ${JSON.stringify(expires ?? null)})`);
  } else {
    const parsed = new Date(`${expires}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== expires) {
      problems.push(`expires is not a real calendar date (got ${JSON.stringify(expires)})`);
    } else if (parsed.getTime() < startOfUtcDay(now)) {
      problems.push(`RESERVED expired on ${expires} — deletion is due at expiry (DR-7)`);
    }
  }

  return problems;
}

// ── reachability (delegated to the vendored refgraph detector) ───────────────

/** Strip ANSI color codes so parsing is TTY-independent. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Run the reachability detector and return the list of repo-relative,
 * forward-slashed dead-in-prod module paths. Throws a `ScanError` on any
 * fail-closed condition (spawn failure, non-zero exit, unparseable output).
 */
class ScanError extends Error {}

function detectDeadInProd(refgraphPath, srcRoot) {
  let result;
  try {
    result = spawnSync('node', [refgraphPath, srcRoot], { encoding: 'utf8' });
  } catch (err) {
    throw new ScanError(`reachability detector could not be spawned: ${err.message}`);
  }
  if (result.error) {
    throw new ScanError(`reachability detector could not be spawned: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-5).join('\n');
    throw new ScanError(
      `reachability detector (${path.relative(REPO_ROOT, refgraphPath)}) exited ${result.status}` +
        (detail ? `:\n${detail}` : ''),
    );
  }

  const out = stripAnsi(result.stdout || '');
  const lines = out.split('\n');
  const markerIdx = lines.findIndex((l) => l.includes('ALL DEAD-IN-PROD'));
  if (markerIdx === -1) {
    throw new ScanError(
      'could not locate the "ALL DEAD-IN-PROD" section in reachability output — detector contract changed?',
    );
  }

  const dead = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') break; // section is terminated by a blank line
    if (line.startsWith('--') || line.startsWith('====')) break;
    dead.push(line);
  }
  return dead;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printUsage() {
  process.stderr.write(
    'Usage: check-module-intent.mjs [--src-root <path>] [--refgraph <path>] [--now <YYYY-MM-DD>]\n',
  );
}

function parseArgs(argv) {
  const args = { srcRoot: DEFAULT_SRC_ROOT, refgraph: DEFAULT_REFGRAPH, now: new Date() };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_CLEAN);
    } else if (arg === '--src-root') {
      const value = argv[++i];
      if (!value) fail('--src-root requires a path argument');
      args.srcRoot = path.resolve(value);
    } else if (arg === '--refgraph') {
      const value = argv[++i];
      if (!value) fail('--refgraph requires a path argument');
      args.refgraph = path.resolve(value);
    } else if (arg === '--now') {
      const value = argv[++i];
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('--now requires a YYYY-MM-DD date');
      args.now = new Date(`${value}T00:00:00Z`);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  printUsage();
  process.exit(EXIT_FAILCLOSED);
}

function main() {
  const args = parseArgs(process.argv);

  let stat;
  try {
    stat = statSync(args.srcRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stderr.write(`check-module-intent: src-root does not exist: ${args.srcRoot}\n`);
      process.exit(EXIT_FAILCLOSED);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    process.stderr.write(`check-module-intent: src-root is not a directory: ${args.srcRoot}\n`);
    process.exit(EXIT_FAILCLOSED);
  }

  // 1. Reachability — fail closed on any scan error (DR-8).
  let dead;
  try {
    dead = detectDeadInProd(args.refgraph, args.srcRoot);
  } catch (err) {
    if (err instanceof ScanError) {
      process.stderr.write(`check-module-intent: reachability scan failed (fail-closed):\n  ${err.message}\n`);
      process.exit(EXIT_FAILCLOSED);
    }
    throw err;
  }

  // 2. Classify each dead-in-prod module.
  //
  // Subtrees entered from OUTSIDE the engine's import graph are skipped first.
  // The census reads "no production importer" as "dead", which is only sound
  // for code the engine actually calls. `tools/audit/layer-map.json` — the
  // task-010 authority — declares `install` a non-layer peer that "installs and
  // packages the engine rather than sitting in its call graph", so its
  // CLI-entered modules are unreachable BY DESIGN, not dead. This census
  // scanned `servers/exarchos-mcp/src` until task 019 folded the two trees
  // together and pointed it at `src`, which is how a tree it never governed
  // arrived inside its subject.
  //
  // The installer still deserves a reachability audit; it needs one rooted at
  // ITS entry points, which is a different instrument than this one.
  const violations = [];
  for (const rel of dead) {
    if (OUT_OF_SUBJECT.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    const full = path.join(args.srcRoot, ...rel.split('/'));

    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch (err) {
      // A dead module we cannot read is not a clean module — fail closed.
      process.stderr.write(
        `check-module-intent: failed to read dead-in-prod module ${rel} (fail-closed): ${err.message}\n`,
      );
      process.exit(EXIT_FAILCLOSED);
    }

    const reserved = parseReserved(source);
    if (reserved.present) {
      // An intent declaration exists: it MUST be valid. A malformed / expired
      // RESERVED header is a violation (the DR-7 enforcement point) — it does
      // NOT fall through to the class allowlist.
      const problems = validateReserved(reserved.fields, args.now);
      if (problems.length === 0) continue; // valid RESERVED → OK
      violations.push({
        rel,
        reason: `RESERVED header is invalid — ${problems.join('; ')}`,
      });
      continue;
    }

    const cls = classifyAllowed(rel);
    if (cls) continue; // class-allowlisted → OK

    violations.push({
      rel,
      reason:
        'dead-in-prod (0 production importers) with no RESERVED(issue, owner, expires) header and no allowlist class',
    });
  }

  if (violations.length === 0) {
    process.exit(EXIT_CLEAN);
  }

  process.stderr.write(
    `check-module-intent: ${violations.length} dead-in-prod module(s) lack valid intent (DR-7).\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.rel}\n      ${v.reason}\n`);
  }
  process.stderr.write(
    '\nEvery production module with zero production importers must either carry a\n' +
      'RESERVED(issue, owner, expires) header with a future expiry, belong to a declared\n' +
      'allowlist class (test-infra / build-shim / type-test entrypoint), or be deleted.\n',
  );
  process.exit(EXIT_VIOLATION);
}

main();
