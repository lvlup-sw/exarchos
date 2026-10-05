#!/usr/bin/env node
/**
 * check-module-intent: the module-intent CI gate. A production module under a scanned root
 * with zero production importers must declare its intent in one of two ways:
 *
 *   1. A `RESERVED(issue, owner, expires)` header with an `#<number>` issue, a non-empty owner,
 *      and a clean `YYYY-MM-DD` expiry that is not in the past. An expired stub fails.
 *   2. Membership in a class of {@link ALLOWLIST_CLASSES}.
 *
 * Reachability comes from `tools/audit/refgraph.mjs`, which counts `import type` edges.
 * Two sweeps remove a false dead verdict on a concrete edge: a cross-root importer, or an npm
 * script that runs the module.
 *
 * Exit 0: clean. Exit 1: a module lacks valid intent. Exit 2: fail closed on a scan crash,
 * unparseable scan output, an unreadable module, or a usage error.
 * Flags: `--src-root <path>` (repeatable, default `src`), `--refgraph <path>`, `--now <YYYY-MM-DD>`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
/** The default scanned roots, relative to `REPO_ROOT`. */
const DEFAULT_SRC_ROOTS = ['src'];
const DEFAULT_REFGRAPH = path.join(REPO_ROOT, 'tools', 'audit', 'refgraph.mjs');

/**
 * First-party trees swept for import edges refgraph's per-root `.ts`-only walk
 * cannot see, and the packages whose `package.json` scripts name entrypoints.
 */
const IMPORTER_ROOTS = ['src', 'tools'];
const PACKAGE_DIRS = [''];

const EXIT_CLEAN = 0;
const EXIT_VIOLATION = 1;
const EXIT_FAILCLOSED = 2;

/** Splits a forward-slashed path, the form that refgraph prints. */
const segments = (rel) => rel.split('/');
const basename = (rel) => segments(rel).pop() ?? rel;
const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Subtrees outside the engine's import graph. The census reads "no production importer" as
 * dead, which is sound only for code that the engine calls. `install` installs and packages
 * the engine. The self-test `ModuleIntent_OutOfSubjectPrefixes_AllExist` checks each prefix.
 */
const OUT_OF_SUBJECT = ['install'];

/**
 * Classes that exempt a dead module from the RESERVED header. A convention class is a predicate
 * over the root-relative path, so a new module that matches is covered. A declared class
 * enumerates its members, and each member has an `owner` and a `rationale`.
 *
 * `declared-gate-machinery` holds permanent gate infrastructure, so it has no expiry.
 * `declared-dormant-surface` holds product code with no live consumer. Each of its members
 * also has an `issue` and an `expires`, which {@link validateReserved} checks.
 * No class matches the `-seam.ts` suffix, so each `-seam.ts` module is a named member, and a
 * new dead `-seam.ts` module fails until someone declares it.
 */
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
    /** Keys are root-relative in one namespace for every scanned root, so they must stay unambiguous. */
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
      'verbs/gates/gate-ownership-census.ts': {
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
      'projections/quality/skill-example-validator.ts': {
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

      'events/emitter-closure-audit.ts': {
        owner: 'exarchos',
        rationale:
          'Emission-closure audit: compares the measured append-site census against BOTH declaration surfaces (an action\u2019s autoEmits and MODULE_EMISSIONS), reporting an undeclared append site in one direction and a phantom module emission in the other. The undeclared direction is the one a declaration table can never find on its own. Its only consumers are its co-located test and that test\u2019s kill fixtures, both test-invoked gate machinery, so it never gains a production importer.',
      },
      'events/provider-area-audit.ts': {
        owner: 'exarchos',
        rationale:
          'Provider-area consistency audit: checks a registration\u2019s `provider` claim against the area the event is actually appended from, separating a contradiction (the append sits inside a DIFFERENT provider\u2019s area, so exactly one claim is false) from an ungoverned area (no provider owns it, so the vocabulary has no right answer yet). Test-invoked structural gate, same class as emitter-closure-audit \u2014 deliberately not a production import target so the shipped server never depends on the audit.',
      },
      'events/consumer-closure-audit.ts': {
        owner: 'exarchos',
        rationale:
          'Consumer-closure audit: reconciles every capability/harness `consumedBy` against an injected live consumer population (reducer ids + view names), closing the open `ConsumerId` reference that lets a registration outlive its deleted consumer. The population is injected because enumerating it from the events layer is the layering inversion event-registration.ts refuses; the co-located test assembles it from the projections, where those imports are legal. Test-invoked structural gate, same class as emitter-closure-audit \u2014 deliberately not a production import target so the shipped server never depends on the audit.',
      },

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
      'dispatch/core/dispatch.economy-seam.ts': {
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
      /**
       * Root of the interactive installer subtree. The `install/operations` members live only
       * because it imports them. The shipped install path is the single-file binary and
       * `install-skills.ts`. `OUT_OF_SUBJECT` skips `install/`, but each entry keeps an expiry.
       */
      'install/wizard/wizard.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Interactive installer wizard flow, root of the `wizard/` + `manifest/loader` subtree. Superseded by the single-file binary install path; retained while `exarchos init` remains a roadmap surface that would re-adopt the prompt flow rather than re-author it. Delete the subtree at expiry if unadopted.',
      },
      'install/operations/copy.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          '`smartCopyDirectory` for the wizard installer. `build-skills.ts` names it in a comment to explain why IT does not use it (dotfile handling differs), which is the only mention left in the tree. Delete with the wizard subtree at expiry.',
      },
      'install/operations/settings.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era `settings.json` merge/rollback operations. The live settings path is the onboard handler (`verbs/onboard/hooks.ts`). Delete with the wizard subtree at expiry.',
      },
      'install/operations/mcp.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era MCP-server registration into a host config. Superseded by the plugin packaging + `exarchos mcp` subcommand. Delete with the wizard subtree at expiry.',
      },
      'install/operations/migration.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era installed-layout migration. Distinct from the live event-store and workflow-state migrations, which are fully wired. Delete with the wizard subtree at expiry.',
      },
      'install/operations/version-check.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era installed-version comparison. The live version surface is `verbs/version.ts`. Delete with the wizard subtree at expiry.',
      },
      'install/operations/bundle.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Wizard-era bundle-path resolution (50 lines). Delete with the wizard subtree at expiry.',
      },

      /**
       * An install-tree ratchet. Its subject is a shipped projection, so it has an expiry and is
       * not in `declared-gate-machinery`. The deadline forces a check that the subject still exists.
       */
      'install/shim-registry.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Thin-shim inventory + ratchet (P03-07): structurally discovers per-runtime capability shims and fails when one outlives the capability gap that justified it. Its co-located test runs it against the live tree. Gate machinery, but ratchet-shaped — the expiry forces a re-read once the runtime capability matrix settles.',
      },
      'install/projection-containment.ts': {
        owner: 'exarchos',
        issue: '#1764',
        expires: '2027-02-28',
        rationale:
          'Projection-containment proof (P05-03): every generated projection must be PRESENT and SELECTED in the shipped/installed artifact. Test-invoked structural gate over the packaging surface; the expiry forces a re-read whenever the shipped `files` set changes.',
      },
      'install/advisory-kill-probes.ts': {
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
 * Returns the problems of an enumerated class member. An empty list means valid. Each member
 * needs an owner and a rationale. A `declared-dormant-surface` member also needs the `issue` and
 * `expires` of a RESERVED header, and the same function checks them. An expiry in the register
 * must not be weaker than one in the file.
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

/** The fields of a RESERVED marker. A match that holds none of them is prose, not a marker. */
const RESERVED_FIELD_NAMES = ['issue', 'owner', 'expires'];

/**
 * Returns the fields of the first RESERVED occurrence that holds a declared field, or
 * `{ present: false }`. Fields are comma-separated `key: value` pairs. The text after the
 * close paren is not read. A mention in prose holds no field, so it is not a header.
 */
function parseReserved(source) {
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
 * Returns the problems of a parsed RESERVED field block. An empty list means valid. It needs an
 * `#<number>` issue and a non-empty owner. The expiry must be exactly a real `YYYY-MM-DD` date,
 * with nothing after it, and not in the past.
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

/** Strip ANSI color codes so parsing is TTY-independent. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** A fail-closed scan condition: a spawn failure, a non-zero exit, or unparseable output. */
class ScanError extends Error {}

/**
 * Runs the reachability detector and returns the dead-in-prod paths, forward-slashed and
 * relative to `srcRoot`. The list ends at a blank line or at the next section. Throws `ScanError`.
 */
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
    if (line === '') break;
    if (line.startsWith('--') || line.startsWith('====')) break;
    dead.push(line);
  }
  return dead;
}

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

/** Resolves a relative specifier to an existing file in the refgraph candidate order. It skips an unreadable candidate. */
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
      }
    }
    const indexed = path.join(base, 'index.ts');
    try {
      if (existsSync(indexed) && statSync(indexed).isFile()) return path.resolve(indexed);
    } catch {
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
 * Absolute paths of the source modules that an npm script runs, directly or through the build
 * output. refgraph finds entry points with a filename regex, which can miss a script subject.
 * This sweep reads the script tables and maps a path under `outDir` to its source under `rootDir`.
 * A new `node dist/<x>.js` script needs no edit.
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
        const sourceRel = rel.startsWith(`${outDir}/`)
          ? `${rootDir}/${rel.slice(outDir.length + 1).replace(/\.js$/, '.ts')}`
          : rel;
        for (const candidate of [path.join(repoRoot, pkgDir, sourceRel), path.join(repoRoot, sourceRel)]) {
          try {
            if (existsSync(candidate) && statSync(candidate).isFile()) entrypoints.add(path.resolve(candidate));
          } catch {
          }
        }
      }
    }
  }
  return entrypoints;
}

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

/**
 * Computes the two sweeps once for the repo, because they exist to see edges across roots.
 * A scan error or an unreadable dead module fails closed. A present RESERVED header must be
 * valid, and an invalid one does not fall through to the class allowlist. An enumerated member
 * must pass {@link validateClassMember}. A convention-class match is enough.
 */
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

  const crossRootImporters = collectCrossRootImporters(REPO_ROOT);
  const scriptEntrypoints = collectScriptEntrypoints(REPO_ROOT);

  const violations = [];
  for (const srcRoot of args.srcRoots) {
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

    for (const rel of dead) {
      const full = path.join(srcRoot, ...rel.split('/'));
      const resolved = path.resolve(full);

      if (crossRootImporters.has(resolved) || scriptEntrypoints.has(resolved)) continue;

      if (OUT_OF_SUBJECT.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;

      let source;
      try {
        source = readFileSync(full, 'utf8');
      } catch (err) {
        process.stderr.write(
          `check-module-intent: failed to read dead-in-prod module ${rel} (fail-closed): ${err.message}\n`,
        );
        process.exit(EXIT_FAILCLOSED);
      }

      const label = resolved.startsWith(`${REPO_ROOT}${path.sep}`)
        ? toPosix(path.relative(REPO_ROOT, resolved))
        : `${toPosix(srcRoot)}/${rel}`;

      const reserved = parseReserved(source);
      if (reserved.present) {
        const problems = validateReserved(reserved.fields, args.now);
        if (problems.length === 0) continue;
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
      if (classified.member === undefined) continue;

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
