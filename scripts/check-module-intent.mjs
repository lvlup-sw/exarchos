#!/usr/bin/env node
/**
 * check-module-intent — module-intent CI gate (DR-7, DR-8, DR-9).
 *
 * A production module under a scanned source root with ZERO production importers
 * is a debloat candidate. Rather than delete blindly, DR-7 requires every such
 * dead-in-prod module to DECLARE ITS INTENT, and the declaration to be honored:
 *
 *   1. a `RESERVED(issue, owner, expires)` header whose `expires` is a CLEAN,
 *      parseable calendar date that is NOT in the past — an expired-and-unadopted
 *      RESERVED stub FAILS (this is the DR-7 "deletion happens at expiry"
 *      enforcement point). A well-formed issue ref (`#<number>`) and a non-empty
 *      owner are also required, OR
 *   2. membership in a declared CLASS ALLOWLIST — see {@link ALLOWLIST_CLASSES}.
 *      A convention class is a predicate that generalizes; a declared class
 *      enumerates its members, and every member carries an OWNER and a
 *      RATIONALE. Members of `declared-dormant-surface` also carry an EXPIRY,
 *      which is enforced exactly like a RESERVED header's.
 *
 * Any dead-in-prod module that declares neither → FAIL (exit 1): add a RESERVED
 * header, place it in a declared class, or delete it.
 *
 * ── WHICH ROOTS ARE SCANNED, AND WHY IT IS BOTH (DR-9) ──────────────────────
 * The default root set is BOTH first-party source trees — `servers/exarchos-mcp/
 * src` and the repo-root `src`. It used to be the MCP package alone, and root
 * `src/` holds `advisory-registry`, `shim-registry`, `projection-containment` and
 * `friction-signal`, none of which any gate examined. `friction-signal.ts` states
 * in its own header that it was placed in root `src/` partly BECAUSE a telemetry
 * module elsewhere "would itself register as dead-in-prod (DR-7)". Relocating out
 * of a gate's reach is not satisfying the gate, so the reach is what moved.
 *
 * ── THE TWO REACHABILITY WIDENINGS, AND WHY NEITHER IS AN ALLOWLIST ─────────
 * Reachability is delegated to the vendored `scripts/audit/refgraph.mjs` detector
 * (the SAME instrument the 005 disposition baseline used). refgraph is
 * deliberately type-BLIND — an `import type` edge still counts — which is the
 * correct posture: a type-only importer still justifies the module's existence.
 * It is also scoped to ONE root and walks only `.ts`-family files, and both of
 * those produce false "dead" verdicts that an allowlist entry would have to
 * absorb as a lie. So they are answered with evidence instead:
 *
 *   - CROSS-ROOT IMPORTERS ({@link collectCrossRootImporters}). `src/runtimes/
 *     embedded.ts` is imported by `servers/exarchos-mcp/src/cli-commands/
 *     install-skills-bridge.js` — a deliberate plain-JS bridge that exists so tsc
 *     never resolves the specifier. refgraph reads neither that file (wrong
 *     extension) nor that tree (wrong root), so it reports a module the shipped
 *     binary statically depends on as dead.
 *   - NPM-SCRIPT ENTRYPOINTS ({@link collectScriptEntrypoints}). `src/hooks-guard.ts`
 *     is run by `npm run hooks:guard` as `node dist/hooks-guard.js`. refgraph's
 *     entry set is a hand-written filename regex that lists its sibling
 *     `skills-guard` and not it, so a live CI entrypoint read as dead.
 *
 * Both sweeps only ever REMOVE a module from the dead set, and only on a
 * concrete edge (a resolved import, a script that runs it).
 *
 * FAIL-CLOSED (DR-8): if the reachability scan crashes / exits non-zero, its
 * output cannot be parsed, or an in-scope module cannot be read, the gate FAILS
 * with a named cause (exit 2) rather than passing on partial evidence. A gate
 * that silently no-ops on a tooling error is a gate that isn't there.
 *
 *   Exit 0 — every dead-in-prod module declares valid intent (clean).
 *   Exit 1 — one or more dead-in-prod modules lack valid intent (undeclared, or
 *            an expired / malformed RESERVED header or class expiry).
 *   Exit 2 — fail-closed: scan crash / unparseable scan output / unreadable
 *            module / usage error.
 *
 * Flags (primarily for testability):
 *   --src-root <path>   Root dir the detector scans. REPEATABLE. Passing it at
 *                       all replaces the default root set.
 *   --refgraph <path>   Reachability detector script. Default
 *                       `scripts/audit/refgraph.mjs`.
 *   --now <YYYY-MM-DD>  "Today" for expiry comparison. Default: system clock.
 *   --help              Show usage.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
/** Both first-party source trees. Repo-relative; resolved against REPO_ROOT. */
const DEFAULT_SRC_ROOTS = ['servers/exarchos-mcp/src', 'src'];
const DEFAULT_REFGRAPH = path.join(REPO_ROOT, 'scripts', 'audit', 'refgraph.mjs');

/**
 * First-party trees swept for import edges refgraph's per-root `.ts`-only walk
 * cannot see, and the packages whose `package.json` scripts name entrypoints.
 */
const IMPORTER_ROOTS = ['src', 'scripts', 'servers/exarchos-mcp/src', 'servers/exarchos-mcp/scripts'];
const PACKAGE_DIRS = ['', 'servers/exarchos-mcp'];

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILCLOSED = 2;

// ── path helpers (refgraph emits forward-slashed, repo-relative paths) ────────
const segments = (rel) => rel.split('/');
const basename = (rel) => segments(rel).pop() ?? rel;
const toPosix = (p) => p.split(path.sep).join('/');

// ─────────────────────────────────────────────────────────────────────────────
// CLASS ALLOWLIST
//
// A dead-in-prod module is exempt from the RESERVED-header requirement iff it
// belongs to one of these declared classes. Each class is a MEMBERSHIP RULE
// (a predicate over the module's root-relative path) plus a rationale — NOT a
// bare path whitelist. The convention-based classes generalize: any future
// module matching the convention is covered.
//
// Two classes ENUMERATE instead, and every member of both carries an `owner` and
// a `rationale`:
//
//   `declared-gate-machinery`  — test-invoked analysis/census/lint modules that
//        are unambiguous gate infrastructure. Permanent by nature, so no expiry:
//        RESERVED means "dead stub, delete at expiry if unadopted", and a live
//        governance gate is neither. An expiry here would either fire spuriously
//        against correct infrastructure or need renewing forever — the rubber
//        stamp DR-7 exists to prevent.
//   `declared-dormant-surface` — product code with no live consumer. Every member
//        additionally carries an `issue` and an `expires`, enforced by the SAME
//        {@link validateReserved} rules as an in-file RESERVED header. This is a
//        RESERVED marker kept in the register rather than in the file; it is a
//        scheduled deletion, not a permanent class.
//
// ── WHY THE `/-seam\.ts$/` FILENAME RULE IS GONE ────────────────────────────
// A `source-lint-seam` class matched any basename ending `-seam.ts` and granted
// it a permanent, unowned exemption. That is the shape this program keeps
// finding and repairing everywhere else: a NAME standing in for a property.
// Nothing stops a `-seam.ts` that is dead product code, and nothing recorded who
// owned any of the five real members. They are enumerated below instead, each
// with an owner and its own reason. A NEW `-seam.ts` that goes dead now fails
// this gate and has to be declared — which is the point.
// ─────────────────────────────────────────────────────────────────────────────
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
    name: 'declared-gate-machinery',
    rationale:
      'Test-invoked analysis / census / source-lint modules that are unambiguous gate infrastructure. Enumerated — each member carries an owner and its own rationale.',
    // Keys are ROOT-RELATIVE, in one namespace shared by every scanned root, so
    // they must stay unambiguous across them. They are today: no path below is
    // spelled the same way under both `servers/exarchos-mcp/src` and `src`.
    members: {
      'architecture/import-cycles.ts': {
        owner: 'exarchos',
        rationale:
          'Pure Tarjan-SCC runtime import-cycle detector (DR-4, debloat task 009); its co-located test shells dependency-cruiser and feeds the JSON graph here. Gate machinery — the analysis analog of contract-seam. NOTE: added by task 009 AFTER the 005 baseline, so it is the one dead-in-prod module not in 005’s disposition table.',
      },
      'projections/gwt.ts': {
        owner: 'exarchos',
        rationale:
          'Given-When-Then test-harness DSL for projection reducers (T044, DR-10). Pure test infrastructure.',
      },
      'orchestrate/gate-ownership-census.ts': {
        owner: 'exarchos',
        rationale:
          'Evidence-ownership census (P01-05): a static scan proving gate-runner.ts is the sole durable evidence emitter, plus a behavioural durability witness. Its co-located test runs it against the live tree. Gate machinery — the census analog of contract-seam, and the enforcement point for P01-05’s exit proof.',
      },
      'architecture/effect-ledger.ts': {
        owner: 'exarchos',
        rationale:
          'Effect-ownership census (P04-01): statically classifies every filesystem/process/network occurrence in shipped source against EFFECT_OWNERSHIP and fails on an indeterminate owner. Test-invoked structural gate; the ledger itself is the declared authority, not a production import target.',
      },
      'architecture/vcs-ownership.ts': {
        owner: 'exarchos',
        rationale:
          'VCS mutation bypass census (P04-05): fails when git/worktree mutation occurs outside the declared owner surface. Test-invoked structural gate, same class as effect-ledger.',
      },
      'quality/skill-example-validator.ts': {
        owner: 'exarchos',
        rationale:
          'Documentation-vs-schema drift gate (P02-07): extracts tool-invocation examples from skills-src/ and commands/ and validates them against the live TOOL_REGISTRY projection. Test-invoked gate machinery — deliberately not a production import target so shipped code never depends on doc parsing.',
      },
      'contract/compiler/generate.ts': {
        owner: 'exarchos',
        rationale:
          'Contract-artifact generator entry point (P03-03): regenerates the checked-in proof-fixture baseline and is invoked by its co-located drift guard. Build/gate machinery — the shipped server consumes the generated baseline, never the generator.',
      },
      'workflow/admission/remediation-purity.ts': {
        owner: 'exarchos',
        rationale:
          'Remediation no-mutation census (P06-06): a source-import audit proving remediation.ts imports no event-store, atomic-appender, or filesystem API — i.e. that remediation is pure data and can never patch pass-state. Test-invoked structural gate, same class as effect-ledger.',
      },
      'architecture/delivery-safety.ts': {
        owner: 'exarchos',
        rationale:
          'Silent-swallow static check for required delivery paths (P04-01): its co-located test runs auditDeliverySafety against the live channel modules and fails on any empty catch / empty .catch() around a required delivery. Test-invoked structural gate, same class as effect-ledger.',
      },
      'architecture/output-schema-census.ts': {
        owner: 'exarchos',
        rationale:
          'outputSchema vacuity census (DR-4): enumerates every TOOL_REGISTRY action declaration and partitions each declared outputSchema into vacuous (data accepts every value) vs substantive, failing closed on an empty subject. Its co-located test runs it against the live registry. Test-invoked structural gate, same class as effect-ledger — deliberately not a production import target so the shipped server never depends on the census.',
      },
      'architecture/audit-delivery-closure.ts': {
        owner: 'exarchos',
        rationale:
          'Audit-delivery closure audit (DR-4/DR-24, task 069): holds every obligation in audit-delivery-closure.data.ts to BOTH halves — the producing action’s live outputSchema must declare the delivered field and its enumerator as required typed properties, and a declared reader document must carry the whole instruction inside one section. It exists because check_invariant_conformance computed an `auditPrompt` nothing was directed to read, delivered through a vacuityWaiver schema. Its only consumers are its co-located test and that test’s kill fixtures, both test-invoked gate machinery, so it never gains a production importer. NOTE the DATA file is production-imported (the handler renders its report directive from the same record) and so is not dead — only the mechanism is.',
      },
      'architecture/authority-census.ts': {
        owner: 'exarchos',
        rationale:
          'The G5 closure verdict over the authority topology (DR-6, task 025): evaluates every boundary row along the authority / binding / enforcement hops and fails on an unbound representation, more than one authority, or a stale `already-enforced` claim — per row, from the wave that remediates it. Its only consumers are its co-located test and task 026’s kill fixtures, both test-invoked gate machinery, so it never gains a production importer. Deliberately not a production import target so the shipped server never depends on the governance verdict.',
      },
      'architecture/authority-topology.ts': {
        owner: 'exarchos',
        rationale:
          'Authority topology as data (DR-6, gate G5): the eight contract-boundary rows — one authority each (or an explicit contested/none), their bound and unbound representations, and the wave from which each is enforced — plus the rows’ own totality check. Its consumer is the task-025 closure census, which is ITSELF test-invoked gate machinery, so it never gains a production importer. Deliberately not a production import target so the shipped server never depends on the governance model.',
      },

      // ── the five former `/-seam\.ts$/` members, now named ─────────────────
      'architecture/contract-seam.ts': {
        owner: 'exarchos',
        rationale:
          'Source-lint seam for the contract layer: exports the lint functions its own co-located test runs against production SOURCE. The archetype of the class — gate machinery, never a production import target.',
      },
      'architecture/layer-boundaries-seam.ts': {
        owner: 'exarchos',
        rationale:
          'Layer-boundary census: proves no module reaches across a declared architectural layer, deriving its population from `git ls-files` as a second authority. Test-invoked structural gate.',
      },
      'architecture/adapter-ownership-seam.ts': {
        owner: 'exarchos',
        rationale:
          'Adapter-ownership census (DR-26): proves each adapter surface has exactly one owning module. Test-invoked structural gate, same class as effect-ledger.',
      },
      'architecture/effect-port-seam.ts': {
        owner: 'exarchos',
        rationale:
          'Effect-port census: proves every declared effect port is reached through its owning port module rather than by a direct import. Test-invoked structural gate, same class as effect-ledger.',
      },
      'core/dispatch.economy-seam.ts': {
        owner: 'exarchos',
        rationale:
          'Dispatch token-economy seam: exports the source-lint the composite dispatch layer is measured against, run by its own co-located test. Gate machinery, not a production import target.',
      },
    },
    matches(rel) {
      return Object.prototype.hasOwnProperty.call(this.members, rel);
    },
  },
  {
    name: 'declared-dormant-surface',
    rationale:
      'Product code with no live consumer, held to a DEADLINE. Each member carries an owner, an issue and an `expires` enforced by the same rules as an in-file RESERVED header — a RESERVED marker recorded in the register instead of the file.',
    members: {
      // The pre-binary interactive installer. `wizard/wizard.ts` is the root of
      // the subtree; `manifest/loader.ts`, `wizard/prompts.ts`, `wizard/display.ts`
      // and `wizard/prerequisites.ts` are alive ONLY because it imports them, so
      // its disposition decides theirs. The shipped install path is the
      // single-file binary + `install-skills.ts`; nothing reaches this flow.
      'wizard/wizard.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Interactive installer wizard flow, root of the `wizard/` + `manifest/loader` subtree. Superseded by the single-file binary install path; retained while `exarchos init` remains a roadmap surface that would re-adopt the prompt flow rather than re-author it. Delete the subtree at expiry if unadopted.',
      },
      'operations/copy.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          '`smartCopyDirectory` for the wizard installer. `build-skills.ts` names it in a comment to explain why IT does not use it (dotfile handling differs), which is the only mention left in the tree. Delete with the wizard subtree at expiry.',
      },
      'operations/settings.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era `settings.json` merge/rollback operations. The live settings path is the MCP onboard handler (`orchestrate/onboard/hooks.ts`). Delete with the wizard subtree at expiry.',
      },
      'operations/mcp.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era MCP-server registration into a host config. Superseded by the plugin packaging + `exarchos mcp` subcommand. Delete with the wizard subtree at expiry.',
      },
      'operations/migration.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era installed-layout migration. Distinct from the live event-store and workflow-state migrations, which are MCP-side and fully wired. Delete with the wizard subtree at expiry.',
      },
      'operations/version-check.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era installed-version comparison. The live version surface is `cli-commands/version.ts` in the MCP package. Delete with the wizard subtree at expiry.',
      },
      'operations/bundle.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era bundle-path resolution (50 lines). Delete with the wizard subtree at expiry.',
      },

      // Root-`src/` gate machinery. Held to an expiry rather than placed in
      // `declared-gate-machinery` because each is a RATCHET whose subject is a
      // shipped projection: if the projection goes away the ratchet should go
      // with it, and only a deadline forces that question to be asked.
      'shim-registry.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Thin-shim inventory + ratchet (P03-07): structurally discovers per-runtime capability shims and fails when one outlives the capability gap that justified it. Its co-located test runs it against the live tree. Gate machinery, but ratchet-shaped — the expiry forces a re-read once the runtime capability matrix settles.',
      },
      'projection-containment.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Projection-containment proof (P05-03): every generated projection must be PRESENT and SELECTED in the shipped/installed artifact. Test-invoked structural gate over the packaging surface; the expiry forces a re-read whenever the shipped `files` set changes.',
      },
      'advisory-kill-probes.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Executable kill fixtures for the governed advisories in ADVISORY_REGISTRY (P07-07): a seeded violation plus a seeded clean control per advisory. Run by `advisory-registry`’s own tests. Test-invoked gate machinery whose subject is the advisory set, so it expires with it.',
      },
    },
    matches(rel) {
      return Object.prototype.hasOwnProperty.call(this.members, rel);
    },
  },
];

/**
 * Return `{ cls, member }` for a dead module's declared class, or null.
 *
 * `member` is the enumerated entry for a declared class (`{ owner, rationale }`,
 * plus `issue`/`expires` for `declared-dormant-surface`) and `undefined` for a
 * convention class, which has no per-module record to carry.
 */
function classifyAllowed(rel) {
  for (const cls of ALLOWLIST_CLASSES) {
    if (!cls.matches(rel)) continue;
    return { cls, member: cls.members?.[rel] };
  }
  return null;
}

/**
 * Problems with an enumerated class member. Empty ⇒ valid.
 *
 * Every member owes an owner and a rationale; a `declared-dormant-surface`
 * member additionally owes the same `issue` + `expires` a RESERVED header owes,
 * validated by the same function — an expiry recorded in the register must not
 * be weaker than one recorded in the file, or the register becomes the softer
 * place to put a debt.
 */
function validateClassMember(className, member, now) {
  const problems = [];
  if (!member || typeof member !== 'object') return ['declared class member is not a record'];
  if (!member.owner || !/\S/.test(String(member.owner))) problems.push('owner is required and must be non-empty');
  if (!member.rationale || !/\S/.test(String(member.rationale))) {
    problems.push('rationale is required and must be non-empty');
  }
  if (className === 'declared-dormant-surface') {
    problems.push(...validateReserved({ issue: member.issue, owner: member.owner, expires: member.expires }, now));
  }
  return problems;
}

// ── RESERVED header parsing / validation ─────────────────────────────────────

/**
 * Extract the first `RESERVED(...)` field block from a module's source. Fields
 * are `key: value` pairs separated by commas; the trailing ` — reason` (after
 * the close paren) is not consumed. Returns `{ present: false }` when no marker
 * exists.
 */
const RESERVED_FIELD_NAMES = ['issue', 'owner', 'expires'];

function parseReserved(source) {
  // Every `RESERVED(…)` occurrence is considered, and the first one carrying at
  // least one declared FIELD is the marker. Matching the first occurrence
  // outright made the parser answer a question about prose: `shim-registry.ts`
  // and `advisory-registry.ts` both DISCUSS the mechanism ("the same enforcement
  // philosophy as the `RESERVED(...)` module-intent gate"), and that sentence
  // read as a header with three missing fields — three violations reported
  // against two modules that never claimed to be reserved. A mention is not a
  // declaration; requiring a field is what tells them apart.
  for (const m of source.matchAll(/RESERVED\(([^)]*)\)/g)) {
    const fields = {};
    for (const part of m[1].split(',')) {
      const kv = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(part);
      if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
    if (!RESERVED_FIELD_NAMES.some((name) => name in fields)) continue;
    return { present: true, fields, raw: m[1].trim() };
  }
  return { present: false };
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

// ── reachability widenings (edges refgraph's per-root `.ts` walk cannot see) ──

/** Source extensions swept for import edges — `.js` included, unlike refgraph's walk. */
const IMPORTER_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
/** refgraph's own test/eval exclusion, mirrored so both sides count the same importers. */
const IMPORTER_TEST_RE =
  /(\.(test|spec|bench)\.[cm]?[jt]sx?$)|([\\/](__tests__|__fixtures__|test-fixtures|evals)[\\/])/;
/** Static `import`/`export … from`, dynamic `import(…)`, and `require(…)` specifiers. */
const IMPORT_SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function walkFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walkFiles(full, out);
    } else if (entry.isFile() && IMPORTER_EXTENSIONS.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve a relative specifier to an existing file, mirroring refgraph's candidate order. */
function resolveRelativeImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  const stripped = abs.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const bases = stripped === abs ? [abs] : [abs, stripped];
  for (const base of bases) {
    for (const ext of ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']) {
      const candidate = base + ext;
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {
        /* unreadable candidate is simply not a resolution */
      }
    }
    const indexed = path.join(base, 'index.ts');
    try {
      if (existsSync(indexed) && statSync(indexed).isFile()) return path.resolve(indexed);
    } catch {
      /* same */
    }
  }
  return null;
}

/**
 * Absolute paths imported by at least one NON-TEST first-party file, swept across
 * every tree in {@link IMPORTER_ROOTS} regardless of extension.
 *
 * refgraph is scoped to one root and walks `.ts` only, so a cross-package edge —
 * or any edge from a `.js` file — is invisible to it. `install-skills-bridge.js`
 * is both at once, and it is the static import that puts `src/runtimes/embedded.ts`
 * inside the shipped binary.
 */
function collectCrossRootImporters(repoRoot) {
  const imported = new Set();
  for (const root of IMPORTER_ROOTS) {
    for (const file of walkFiles(path.join(repoRoot, root), [])) {
      const rel = toPosix(path.relative(repoRoot, file));
      if (IMPORTER_TEST_RE.test(`/${rel}`)) continue;
      let source;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
        const spec = match[1] || match[2] || match[3];
        if (!spec) continue;
        const target = resolveRelativeImport(file, spec);
        if (target && target !== path.resolve(file)) imported.add(target);
      }
    }
  }
  return imported;
}

/**
 * Absolute paths of source modules an npm script RUNS, directly or through the
 * package's own build output.
 *
 * refgraph's entry set is a hand-written filename regex; it lists `skills-guard`
 * and `build-skills` and not `hooks-guard`, so `npm run hooks:guard`'s subject
 * read as dead code. Derived here from the script tables plus each package's own
 * `outDir`/`rootDir`, so the next `node dist/<x>.js` script needs no edit.
 */
function collectScriptEntrypoints(repoRoot) {
  const entrypoints = new Set();
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      return null;
    }
  };
  for (const pkgDir of PACKAGE_DIRS) {
    const pkgPath = path.join(repoRoot, pkgDir, 'package.json');
    const pkg = readJson(pkgPath);
    const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const tsconfig = readJson(path.join(repoRoot, pkgDir, 'tsconfig.json'));
    const opts = (tsconfig && tsconfig.compilerOptions) || {};
    const outDir = toPosix(String(opts.outDir ?? './dist')).replace(/^\.\//, '').replace(/\/$/, '');
    const rootDir = toPosix(String(opts.rootDir ?? './src')).replace(/^\.\//, '').replace(/\/$/, '');
    for (const body of Object.values(scripts)) {
      if (typeof body !== 'string') continue;
      for (const token of body.match(/[\w./@-]+\.(?:js|mjs|cjs|ts|mts|cts)\b/g) ?? []) {
        const rel = toPosix(token).replace(/^\.\//, '');
        // A build-output path maps back to the source it was compiled from.
        const sourceRel = rel.startsWith(`${outDir}/`)
          ? `${rootDir}/${rel.slice(outDir.length + 1).replace(/\.js$/, '.ts')}`
          : rel;
        for (const candidate of [path.join(repoRoot, pkgDir, sourceRel), path.join(repoRoot, sourceRel)]) {
          try {
            if (existsSync(candidate) && statSync(candidate).isFile()) entrypoints.add(path.resolve(candidate));
          } catch {
            /* not a resolution */
          }
        }
      }
    }
  }
  return entrypoints;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function printUsage() {
  process.stderr.write(
    'Usage: check-module-intent.mjs [--src-root <path>]... [--refgraph <path>] [--now <YYYY-MM-DD>]\n',
  );
}

function parseArgs(argv) {
  const args = { srcRoots: [], refgraph: DEFAULT_REFGRAPH, now: new Date() };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(EXIT_CLEAN);
    } else if (arg === '--src-root') {
      const value = argv[++i];
      if (!value) fail('--src-root requires a path argument');
      args.srcRoots.push(path.resolve(value));
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
  if (args.srcRoots.length === 0) {
    args.srcRoots = DEFAULT_SRC_ROOTS.map((rel) => path.join(REPO_ROOT, ...rel.split('/')));
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

  for (const srcRoot of args.srcRoots) {
    let stat;
    try {
      stat = statSync(srcRoot);
    } catch (err) {
      if (err.code === 'ENOENT') {
        process.stderr.write(`check-module-intent: src-root does not exist: ${srcRoot}\n`);
        process.exit(EXIT_FAILCLOSED);
      }
      throw err;
    }
    if (!stat.isDirectory()) {
      process.stderr.write(`check-module-intent: src-root is not a directory: ${srcRoot}\n`);
      process.exit(EXIT_FAILCLOSED);
    }
  }

  // The two widenings are computed ONCE against the repo, not per root — they
  // exist precisely to see edges that cross a root boundary.
  const crossRootImporters = collectCrossRootImporters(REPO_ROOT);
  const scriptEntrypoints = collectScriptEntrypoints(REPO_ROOT);

  const violations = [];
  for (const srcRoot of args.srcRoots) {
    // 1. Reachability — fail closed on any scan error (DR-8).
    let dead;
    try {
      dead = detectDeadInProd(args.refgraph, srcRoot);
    } catch (err) {
      if (err instanceof ScanError) {
        process.stderr.write(`check-module-intent: reachability scan failed (fail-closed):\n  ${err.message}\n`);
        process.exit(EXIT_FAILCLOSED);
      }
      throw err;
    }

    // 2. Classify each dead-in-prod module.
    for (const rel of dead) {
      const full = path.join(srcRoot, ...rel.split('/'));
      const resolved = path.resolve(full);

      // Not dead after all: something outside refgraph's per-root `.ts` walk
      // imports it, or an npm script runs it. Both are concrete edges.
      if (crossRootImporters.has(resolved) || scriptEntrypoints.has(resolved)) continue;

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

      // Reported repo-relative when the root is inside the repo, so a message
      // is unambiguous now that two roots are scanned.
      const label = resolved.startsWith(`${REPO_ROOT}${path.sep}`)
        ? toPosix(path.relative(REPO_ROOT, resolved))
        : `${toPosix(srcRoot)}/${rel}`;

      const reserved = parseReserved(source);
      if (reserved.present) {
        // An intent declaration exists: it MUST be valid. A malformed / expired
        // RESERVED header is a violation (the DR-7 enforcement point) — it does
        // NOT fall through to the class allowlist.
        const problems = validateReserved(reserved.fields, args.now);
        if (problems.length === 0) continue; // valid RESERVED → OK
        violations.push({ rel: label, reason: `RESERVED header is invalid — ${problems.join('; ')}` });
        continue;
      }

      const classified = classifyAllowed(rel);
      if (classified === null) {
        violations.push({
          rel: label,
          reason:
            'dead-in-prod (0 production importers) with no RESERVED(issue, owner, expires) header and no allowlist class',
        });
        continue;
      }
      if (classified.member === undefined) continue; // convention class → OK

      // An ENUMERATED member owes an owner and a rationale, and a dormant-surface
      // member owes a live expiry. A declared class that skips those checks is
      // just an unowned whitelist wearing a longer name.
      const problems = validateClassMember(classified.cls.name, classified.member, args.now);
      if (problems.length === 0) continue;
      violations.push({
        rel: label,
        reason: `\`${classified.cls.name}\` member is invalid — ${problems.join('; ')}`,
      });
    }
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
