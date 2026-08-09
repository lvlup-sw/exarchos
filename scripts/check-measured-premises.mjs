#!/usr/bin/env node
/**
 * check-measured-premises — DR-27 measured-premise drift gate.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * Every numeric and structural claim in `docs/specs/2026-08-06-internal-
 * mechanics-overhaul.md` is a REPRESENTATION OF A DERIVATION, and none of them
 * were bound to it. That is the program's own defect class — "a declaration
 * exists, is enforced, and cannot fail" — instantiated by the document that
 * defines it. It is not hypothetical:
 *
 *   - rev 1 was refuted 3/3 by an adversarial panel for stale measurements: it
 *     was authored against a worktree 7 commits behind `origin/main` and never
 *     re-measured against the branch it lands on;
 *   - rev 3 reproduced the class in DR-4 — it asserted 109 vacuous of 123 when
 *     the tree said 112 of 122, and called two declarations "typed" that are in
 *     fact vacuous.
 *
 * DR-24 already carries the rule ("re-derive wave premises against the landing
 * branch at plan time") — but as prose a human must remember, which is PDD's
 * *"a fix relies on someone remembering a convention"* row. This gate makes it
 * mechanical: the document may not assert a number that nothing produces.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 * 1. MEASURED CLAIMS. A claim is annotated inline:
 *
 *        <!-- measured: output-schema-vacuous -->112<!-- /measured -->
 *
 *    The name resolves to a DERIVATION in {@link DERIVATIONS} — a census
 *    function, a script, or a counted scan. The literal between the markers is
 *    compared against the re-derived value; disagreement FAILS.
 *
 * 2. NON-EMPTY DENOMINATOR. A run that resolves ZERO annotated claims FAILS
 *    rather than passing clean. Without this tooth, deleting every annotation —
 *    or renaming the document — reads green, which is precisely the failure
 *    mode the gate exists to prevent.
 *
 * 3. PROOF RUNGS. DR-0 failed DIFFERENTLY from a stale count: it asserted a
 *    proof rung its subject could not carry ("a partially-migrated tree must
 *    fail typecheck" — impossible, because TypeScript has no nominal package
 *    identity). A rung is therefore a CLAIM ABOUT THE SUBJECT and is falsifiable
 *    like any other. Each obligation-map row carries a one-line probe:
 *
 *        | 3 — structural<!-- rung-probe: fixture:path/to/x.test.ts --> | ...
 *        | 2 — types<!-- rung-probe: none -->                           | ...
 *
 *    An UNPROBED rung is a reportable GAP, not a pass — "nothing" is a
 *    reportable answer, per the obligation map's own `Failure signal` column.
 *    A row carrying NO annotation at all is a different thing: the map is then
 *    partial, the instrument cannot see the row, and that FAILS (the rung-side
 *    analogue of the non-empty-denominator rule).
 *
 * ── Verdicts and exit codes ─────────────────────────────────────────────────
 *   pass  → exit 0. Every claim agrees; every obligation row is probed.
 *   gaps  → exit 0 (exit 1 under `--fail-on-gap`). No drift, but one or more
 *           rungs are unprobed. Deliberately NOT reported as a pass.
 *   fail  → exit 1. Drift, an empty denominator, an unknown derivation, a
 *           malformed literal, or an obligation row with no probe annotation.
 *   usage → exit 2. Bad flags, unreadable document, derivation subprocess
 *           failure. Fail-closed: a gate that no-ops on a tooling error is a
 *           gate that isn't there.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * `docs/specs/2026-08-06-internal-mechanics-overhaul.md` plus
 * `.exarchos/invariants.md`, and NOTHING else. Generalizing to all of `docs/`
 * is explicitly out of scope per DR-27 and needs its own ADR.
 *
 * ── Why every `scan` derivation PARSES (task 061) ───────────────────────────
 * The `scan` derivations read TypeScript source. Until task 061 they read it as
 * TEXT: `sdkImportFiles` matched `source.includes('@modelcontextprotocol/sdk')`,
 * so a module that merely NAMED the package in a comment or a string counted as
 * an import site. That is the defect class this whole program exists to remove —
 * an instrument that is declared, is enforced, and measures a property other
 * than the one it names — instantiated INSIDE the instrument built to catch it.
 * It was not theoretical: the derivation reported 40 files across 13 directories
 * where the tree holds 23 across 9, a 74% inflation, and every one of the 17
 * extra files names the package only in prose or in a lint fixture string.
 *
 * The comment-blanking half of the old approach — a hand-rolled `blankComments`
 * lexer, since removed — was not a fix either. It preserved string and template
 * literals by design, so a call site written inside a string still counted, and
 * a NESTED template (`` `x${`…`}z` ``) desynced it outright. Both failures are
 * pinned as tests, so `cli-handwritten-literals` and `withcappedshape-count`
 * carried the same class latently even though they agreed with the parse on
 * today's tree. Re-deriving TypeScript's lexical grammar by hand is how the
 * original defect arrived; `typescript` cannot disagree with the compiler about
 * what an import — or a call site — is.
 *
 * `typescript` is a root devDependency and this gate already rides CI's
 * tsx-backed deps tail rather than the zero-dep prefix (see
 * `scripts/enforcer-wiring-manifest.json`), so the dependency costs nothing that
 * was not already installed — the same trade `scripts/audit/consolidate-suite.mjs`
 * and `scripts/tsconfig-strictness/count-casts.ts` already make.
 *
 * Flags:
 *   --document <path>   Scan this document instead of the default scope.
 *                       Repeatable. Paths resolve against the repo root.
 *   --fail-on-gap       Promote unprobed rungs from `gaps` to `fail`.
 *   --json              Emit the machine-readable report on stdout.
 *   --help              Show usage.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
// Task 064's packaging gate, imported so `validate-plugin-checks` derives the
// number a real run reports rather than re-implementing the policy's expansion.
import { evaluatePackaging, diskTree } from './validate-plugin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/** DR-27's declared scope. Two documents. Not `docs/**`. */
export const DEFAULT_DOCUMENTS = Object.freeze([
  'docs/specs/2026-08-06-internal-mechanics-overhaul.md',
  '.exarchos/invariants.md',
]);

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

// ─── Annotation grammar ─────────────────────────────────────────────────────

const MEASURED_RE =
  /<!--\s*measured:\s*([a-z0-9][a-z0-9-]*)\s*-->([\s\S]*?)<!--\s*\/measured\s*-->/g;
const RUNG_PROBE_RE = /<!--\s*rung-probe:\s*([^>]*?)\s*-->/g;

/**
 * @typedef {Object} MeasuredClaim
 * @property {string} name    Derivation name.
 * @property {string} raw     Verbatim text between the markers.
 * @property {number} line    1-based line of the opening marker.
 */

/**
 * Extract every `<!-- measured: name -->literal<!-- /measured -->` span.
 *
 * @param {string} text
 * @returns {MeasuredClaim[]}
 */
export function scanMeasuredClaims(text) {
  /** @type {MeasuredClaim[]} */
  const claims = [];
  MEASURED_RE.lastIndex = 0;
  let m;
  while ((m = MEASURED_RE.exec(text)) !== null) {
    claims.push({
      name: m[1],
      raw: m[2],
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return claims;
}

/**
 * Parse a claim literal. Accepts plain integers and thousands-separated forms
 * (`1,613`) because the document writes both. Anything else is malformed —
 * a literal the checker cannot read is a claim it cannot bind.
 *
 * @param {string} raw
 * @returns {number | undefined}
 */
export function parseClaimLiteral(raw) {
  const trimmed = raw.trim();
  if (!/^[0-9][0-9,]*$/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/,/g, '');
  const value = Number.parseInt(digits, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

// ─── Obligation map (the rung half) ─────────────────────────────────────────

/**
 * @typedef {Object} ObligationRow
 * @property {string} property   First cell — the property being claimed.
 * @property {string} rung       The `Primary proof (rung)` cell, markers stripped.
 * @property {string[]} probes   Raw probe declarations found on the row.
 * @property {number} line       1-based line of the row.
 */

/** Split a markdown table row on UNESCAPED pipes. */
function splitRow(line) {
  const cells = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  // A markdown row is fenced by pipes, so the first and last splits are empty.
  if (cells.length >= 2 && cells[0].trim() === '') cells.shift();
  if (cells.length >= 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

const SEPARATOR_ROW = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Locate the obligation map and read one record per row.
 *
 * The table is identified by its HEADER — a row carrying both a
 * `Primary proof (rung)` column and a `Failure signal` column. Identifying by
 * heading text would break the moment the section is renamed; identifying by
 * the columns the check actually reads cannot.
 *
 * @param {string} text
 * @returns {{ found: boolean, rows: ObligationRow[] }}
 */
export function scanObligationRungs(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!header.includes('|')) continue;
    const cells = splitRow(header);
    const rungIndex = cells.findIndex((c) => /primary proof/i.test(c));
    const hasFailureSignal = cells.some((c) => /failure signal/i.test(c));
    if (rungIndex < 0 || !hasFailureSignal) continue;

    /** @type {ObligationRow[]} */
    const rows = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim().startsWith('|')) break;
      if (SEPARATOR_ROW.test(line)) continue;
      const rowCells = splitRow(line);
      if (rowCells.length === 0) continue;
      const probes = [];
      RUNG_PROBE_RE.lastIndex = 0;
      let pm;
      while ((pm = RUNG_PROBE_RE.exec(line)) !== null) probes.push(pm[1].trim());
      rows.push({
        property: stripAnnotations(rowCells[0] ?? ''),
        rung: stripAnnotations(rowCells[rungIndex] ?? ''),
        probes,
        line: j + 1,
      });
    }
    return { found: true, rows };
  }
  return { found: false, rows: [] };
}

function stripAnnotations(cell) {
  return cell.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Resolve a probe declaration against the working tree.
 *
 * `fixture:<repo-relative path>` — the file must exist. A probe pointing at a
 * file that is not there is worse than no probe: it asserts evidence that
 * cannot be inspected, so it degrades to a GAP with a named reason rather than
 * passing.
 *
 * `command:<npm script>` — the script must be declared in the root
 * `package.json`, so "run this to see the rung is bearable" is checkable.
 *
 * `none` — the honest answer when the subject has no probe yet. Reported as a
 * gap; never a pass.
 *
 * @param {string} probe
 * @param {{ repoRoot?: string }} [opts]
 * @returns {{ status: 'probed' | 'gap' | 'malformed', reason?: string }}
 */
export function resolveRungProbe(probe, opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  if (probe === 'none') {
    return { status: 'gap', reason: 'declared-unprobed' };
  }
  const sep = probe.indexOf(':');
  if (sep < 0) {
    return { status: 'malformed', reason: `expected '<kind>:<target>' or 'none', got ${JSON.stringify(probe)}` };
  }
  const kind = probe.slice(0, sep).trim();
  const target = probe.slice(sep + 1).trim();
  if (target === '') {
    return { status: 'malformed', reason: `probe kind '${kind}' has an empty target` };
  }
  if (kind === 'fixture') {
    const abs = path.resolve(repoRoot, target);
    return existsSync(abs)
      ? { status: 'probed' }
      : { status: 'gap', reason: `probe-target-missing: ${target}` };
  }
  if (kind === 'command') {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts ?? {};
    } catch {
      return { status: 'gap', reason: 'probe-target-missing: root package.json unreadable' };
    }
    return Object.prototype.hasOwnProperty.call(scripts, target)
      ? { status: 'probed' }
      : { status: 'gap', reason: `probe-target-missing: npm script '${target}'` };
  }
  return { status: 'malformed', reason: `unknown probe kind '${kind}'` };
}

// ─── The check itself (pure — no I/O, no process exit) ──────────────────────

/**
 * @typedef {Object} CheckOptions
 * @property {{ path: string, text: string }[]} documents
 * @property {(name: string) => number | undefined} derive       Re-derive a claim.
 * @property {(name: string) => boolean} isKnownDerivation       Is the name bound at all?
 * @property {(probe: string) => { status: string, reason?: string }} [resolveProbe]
 * @property {boolean} [failOnGap]
 */

/**
 * Compare every annotated claim against its derivation and classify every
 * obligation-map rung.
 *
 * @param {CheckOptions} options
 */
export function checkMeasuredPremises(options) {
  const {
    documents,
    derive,
    isKnownDerivation,
    resolveProbe = (probe) => resolveRungProbe(probe),
    failOnGap = false,
  } = options;

  /** @type {{ document: string, line: number, name: string, literal: number | undefined, derived: number | undefined, verdict: string, detail?: string }[]} */
  const claims = [];
  /** @type {{ document: string, line: number, property: string, rung: string, probe: string | undefined, verdict: string, reason?: string }[]} */
  const rungs = [];
  /** @type {string[]} */
  const failures = [];

  let obligationMapFound = false;

  for (const doc of documents) {
    for (const claim of scanMeasuredClaims(doc.text)) {
      const literal = parseClaimLiteral(claim.raw);
      const base = { document: doc.path, line: claim.line, name: claim.name, literal };

      if (!isKnownDerivation(claim.name)) {
        claims.push({ ...base, derived: undefined, verdict: 'unknown-derivation' });
        failures.push(
          `${doc.path}:${claim.line} — claim '${claim.name}' names no derivation. ` +
            `The document may not assert a number nothing produces; register the ` +
            `derivation or remove the annotation.`,
        );
        continue;
      }
      if (literal === undefined) {
        claims.push({ ...base, derived: undefined, verdict: 'malformed-literal' });
        failures.push(
          `${doc.path}:${claim.line} — claim '${claim.name}' has an unreadable literal ` +
            `${JSON.stringify(claim.raw)}; expected an integer.`,
        );
        continue;
      }

      let derived;
      try {
        derived = derive(claim.name);
      } catch (err) {
        derived = undefined;
        claims.push({
          ...base,
          derived: undefined,
          verdict: 'derivation-unavailable',
          detail: err instanceof Error ? err.message : String(err),
        });
        failures.push(
          `${doc.path}:${claim.line} — derivation '${claim.name}' could not run: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (typeof derived !== 'number') {
        claims.push({ ...base, derived: undefined, verdict: 'derivation-unavailable' });
        failures.push(
          `${doc.path}:${claim.line} — derivation '${claim.name}' produced no value.`,
        );
        continue;
      }
      if (derived !== literal) {
        claims.push({ ...base, derived, verdict: 'drifted' });
        failures.push(
          `${doc.path}:${claim.line} — DRIFT in '${claim.name}': document says ` +
            `${literal}, derivation says ${derived}. Re-derive the premise against ` +
            `the landing branch and update the literal (DR-27).`,
        );
        continue;
      }
      claims.push({ ...base, derived, verdict: 'agree' });
    }

    const map = scanObligationRungs(doc.text);
    if (!map.found) continue;
    obligationMapFound = true;
    for (const row of map.rows) {
      const at = { document: doc.path, line: row.line, property: row.property, rung: row.rung };
      if (row.probes.length === 0) {
        rungs.push({ ...at, probe: undefined, verdict: 'unannotated' });
        failures.push(
          `${doc.path}:${row.line} — obligation row ${JSON.stringify(row.property)} ` +
            `declares rung ${JSON.stringify(row.rung)} with no \`rung-probe\` ` +
            `annotation. A rung is a claim about the subject; an unannotated row ` +
            `is invisible to the check, which is the same hole the non-empty ` +
            `denominator rule closes. Annotate it — 'none' is a legitimate answer.`,
        );
        continue;
      }
      if (row.probes.length > 1) {
        rungs.push({ ...at, probe: row.probes.join(' | '), verdict: 'unannotated' });
        failures.push(
          `${doc.path}:${row.line} — obligation row ${JSON.stringify(row.property)} ` +
            `carries ${row.probes.length} \`rung-probe\` annotations; exactly one is required.`,
        );
        continue;
      }
      const probe = row.probes[0];
      const resolved = resolveProbe(probe);
      if (resolved.status === 'malformed') {
        rungs.push({ ...at, probe, verdict: 'unannotated', reason: resolved.reason });
        failures.push(
          `${doc.path}:${row.line} — malformed \`rung-probe\` on ` +
            `${JSON.stringify(row.property)}: ${resolved.reason}`,
        );
        continue;
      }
      rungs.push({
        ...at,
        probe,
        verdict: resolved.status === 'probed' ? 'probed' : 'gap',
        ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
      });
    }
  }

  const claimsResolved = claims.filter((c) => c.verdict === 'agree' || c.verdict === 'drifted').length;
  if (claimsResolved === 0) {
    failures.push(
      'EMPTY_DENOMINATOR — the run resolved ZERO annotated claims. A check over an ' +
        'empty subject proves nothing and MUST fail rather than report clean: a ' +
        'renamed document, a deleted annotation block, or a broken scanner would ' +
        'otherwise read green exactly when the instrument stopped working.',
    );
  }
  if (!obligationMapFound) {
    failures.push(
      'RUNG_MAP_MISSING — no obligation map was found in the scanned documents. The ' +
        'rung half of DR-27 has lost its subject; a run that cannot see the map ' +
        'cannot report its gaps.',
    );
  }

  const gapCount = rungs.filter((r) => r.verdict === 'gap').length;
  const verdict = failures.length > 0 ? 'fail' : gapCount > 0 ? 'gaps' : 'pass';
  const exitCode =
    verdict === 'fail' || (verdict === 'gaps' && failOnGap) ? EXIT_FAIL : EXIT_PASS;

  return {
    verdict,
    exitCode,
    claims,
    rungs,
    failures,
    counts: {
      claimsAnnotated: claims.length,
      claimsResolved,
      drifted: claims.filter((c) => c.verdict === 'drifted').length,
      rungRows: rungs.length,
      rungsProbed: rungs.filter((r) => r.verdict === 'probed').length,
      rungGaps: gapCount,
      rungsUnannotated: rungs.filter((r) => r.verdict === 'unannotated').length,
    },
  };
}

// ─── Derivations ────────────────────────────────────────────────────────────
//
// Each entry binds an annotation name to the artifact that produces its value.
// `ts` derivations are answered by one `tsx` subprocess against
// `scripts/measured-premises-derive.ts`; `scan` derivations are pure Node so
// the common case needs no subprocess at all.

const MCP_SRC = 'servers/exarchos-mcp/src';
const CLI_SOURCE = `${MCP_SRC}/adapters/cli.ts`;
const REGISTRY_SOURCE = `${MCP_SRC}/registry.ts`;

/** Task 064's data files — see the two `validate-*` derivations below. */
const VALIDATE_MANIFEST = 'scripts/validate-manifest.json';
const PACKAGING_POLICY = '.claude-plugin/packaging-policy.json';

/** Task 023's DR-5 policy data — see the `cli-allowlisted-literals` derivation below. */
const CLI_DERIVATION_ALLOWLIST = 'servers/exarchos-mcp/scripts/cli-derivation-allowlist.json';
/** @type {Record<string, { kind: 'ts' | 'scan', describe: string, fn?: (root: string) => number }>} */
export const DERIVATIONS = {
  'output-schema-total': {
    kind: 'ts',
    describe: `censusOutputSchemas().total — every action declaration in TOOL_REGISTRY`,
  },
  'output-schema-vacuous': {
    kind: 'ts',
    describe: `censusOutputSchemas().vacuousCount — success-branch data is z.unknown()/z.any()`,
  },
  'output-schema-substantive': {
    kind: 'ts',
    describe: `censusOutputSchemas().substantiveCount — success-branch data pins a real shape`,
  },
  'event-types-total': {
    kind: 'ts',
    describe: `EventTypes.length in ${MCP_SRC}/event-store/schemas.ts`,
  },
  'report-coupled-events': {
    kind: 'ts',
    describe:
      `censusReportCoupling().reportCoupledCount — registrations whose DR-2 tier + lifecycle ` +
      `derive the emission source 'model' (G3's seed, ${MCP_SRC}/architecture/report-coupling-census.ts)`,
  },
  'event-name-pattern-divergence': {
    kind: 'ts',
    describe:
      `censusEventNameGrammar().divergent.length — registered names on which the shipped ` +
      `EVENT_NAME_PATTERN and the DR-3 grammar disagree (task 015's measurement; task 075 ` +
      `collapses the two authorities, ${MCP_SRC}/architecture/event-grammar-census.ts)`,
  },
  'sdk-import-sites': {
    kind: 'scan',
    describe:
      `files under ${MCP_SRC} whose PARSED import/export specifiers include ` +
      `'@modelcontextprotocol/sdk' (or a subpath), owned seam excluded`,
    fn: (root) => sdkImportFiles(root).length,
  },
  'sdk-import-directories': {
    kind: 'scan',
    describe: `distinct directories holding a file counted by 'sdk-import-sites'`,
    fn: (root) => new Set(sdkImportFiles(root).map((f) => path.dirname(f))).size,
  },
  'sdk-import-production-files': {
    kind: 'scan',
    describe: `non-test files counted by 'sdk-import-sites' — task 053's production migration surface`,
    fn: (root) => sdkImportFiles(root).filter((f) => !isTestFile(f)).length,
  },
  'cli-handwritten-literals': {
    kind: 'scan',
    describe: `parsed \`.command('<literal>')\` call sites in ${CLI_SOURCE}`,
    fn: (root) => countCommandLiterals(readSource(root, CLI_SOURCE), CLI_SOURCE),
  },
  // Task 023 (DR-5). The spec's Task 023 prose named EIGHT verbs and included
  // `merge-orchestrate`; the parse says ELEVEN literals, of which
  // `merge-orchestrate` is the kill fixture and is not allowlistable — so the
  // tracked population is TEN. That is a second unannotated number in the same
  // document that was wrong when re-derived, which is exactly DR-27's class.
  // It derives now. The number is bound to the parse from the other side too:
  // `auditCliAllowlistMembership` fails when a tracked name is not a live
  // literal AND when a live literal is untracked, so this count cannot drift
  // from `cli-handwritten-literals` without the ratchet going red.
  'cli-allowlisted-literals': {
    kind: 'scan',
    describe:
      `tolerated hand-written verbs in ${CLI_DERIVATION_ALLOWLIST} — the DR-5 shrink-only ` +
      'population, which is every literal command site EXCEPT the kill fixture',
    fn: (root) => countCliAllowlistEntries(root),
  },
  'withcappedshape-count': {
    kind: 'scan',
    describe: `parsed \`outputSchema: withCappedShape(...)\` declaration sites in ${REGISTRY_SOURCE}`,
    fn: (root) => countWithCappedShapeDeclarations(readSource(root, REGISTRY_SOURCE), REGISTRY_SOURCE),
  },
  // Task 064 (DR-24). The spec's own account of `npm run validate` carried two
  // unannotated numbers and BOTH were wrong when re-derived on the landing
  // branch — it said a 17-step chain whose step 1 "fails 4 of 9 checks", where
  // the tree held a NINE-step chain whose step 1 failed FIVE of nine. That is
  // exactly DR-27's class: a representation of a derivation with nothing behind
  // it, in the document that defines the class. Both numbers now derive.
  'validate-chain-steps': {
    kind: 'scan',
    describe: `declared steps in ${VALIDATE_MANIFEST} — the denominator \`npm run validate\` reports`,
    fn: (root) => countValidateSteps(root),
  },
  'validate-plugin-checks': {
    kind: 'scan',
    describe:
      `checks the shipped ${PACKAGING_POLICY} produces against the shipped tree — ` +
      'the plugin gate\'s own denominator',
    fn: (root) => countPackagingChecks(root),
  },
};

/**
 * Steps declared by the validate manifest.
 *
 * Non-empty denominator, the same tooth `sdk-import-sites` carries: a manifest
 * resolving zero steps would let the document assert `0` and read green, when
 * "the runner knows of no gates" is the failure task 064 exists to remove.
 *
 * @param {string} root
 * @returns {number}
 */
export function countValidateSteps(root) {
  const absolute = path.join(root, VALIDATE_MANIFEST);
  if (!existsSync(absolute)) {
    throw new Error(`check-measured-premises: validate manifest ${VALIDATE_MANIFEST} does not exist`);
  }
  const steps = JSON.parse(readFileSync(absolute, 'utf8')).steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      `check-measured-premises: ${VALIDATE_MANIFEST} declares 0 steps — refusing to derive ` +
        'a premise from an empty denominator',
    );
  }
  return steps.length;
}

/**
 * Checks the packaging policy produces against the tree at `root`.
 *
 * Re-evaluates the real gate rather than counting policy entries, because the
 * number the spec talks about is the number a RUN reports — clauses expand into
 * more than one check apiece, and a count of entries would drift from the
 * observable output the moment that mapping changed.
 *
 * @param {string} root
 * @returns {number}
 */
export function countPackagingChecks(root) {
  const absolute = path.join(root, PACKAGING_POLICY);
  if (!existsSync(absolute)) {
    throw new Error(`check-measured-premises: packaging policy ${PACKAGING_POLICY} does not exist`);
  }
  const { checks } = evaluatePackaging(JSON.parse(readFileSync(absolute, 'utf8')), diskTree(root));
  if (checks.length === 0) {
    throw new Error(
      `check-measured-premises: ${PACKAGING_POLICY} produced 0 checks — refusing to derive ` +
        'a premise from an empty denominator',
    );
  }
  return checks.length;
}

/**
 * Tolerated hand-written CLI verbs in the DR-5 shrink-only allowlist.
 *
 * Counts the KEYS of the `allowed` map rather than re-deriving the population
 * from the composition root, because the two are already bound to each other by
 * `auditCliAllowlistMembership` in BOTH directions — an untracked literal and a
 * tracked non-literal both fail the ratchet. Re-implementing the exclusion of
 * the kill fixture here would copy DR-5's policy into this file, where it could
 * disagree with the guard.
 *
 * Non-empty denominator, the same tooth the other `scan` derivations carry: a
 * policy file resolving zero entries would let the document assert `0` and read
 * green, when "the allowlist was moved, renamed or emptied" is a broken
 * measurement. The legitimate zero state is DR-19, and it deletes this file.
 *
 * @param {string} root
 * @returns {number}
 */
export function countCliAllowlistEntries(root) {
  const absolute = path.join(root, CLI_DERIVATION_ALLOWLIST);
  if (!existsSync(absolute)) {
    throw new Error(
      `check-measured-premises: CLI derivation allowlist ${CLI_DERIVATION_ALLOWLIST} does not exist`,
    );
  }
  const { allowed } = JSON.parse(readFileSync(absolute, 'utf8'));
  if (typeof allowed !== 'object' || allowed === null || Array.isArray(allowed)) {
    throw new Error(
      `check-measured-premises: ${CLI_DERIVATION_ALLOWLIST} has no "allowed" object — refusing ` +
        'to derive a premise from a policy file whose shape it cannot verify',
    );
  }
  const names = Object.keys(allowed);
  if (names.length === 0) {
    throw new Error(
      `check-measured-premises: ${CLI_DERIVATION_ALLOWLIST} tolerates 0 verbs — refusing to ` +
        'derive a premise from an empty denominator',
    );
  }
  return names.length;
}
function readSource(root, relative) {
  return readFileSync(path.join(root, relative), 'utf8');
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function walkTypeScript(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTypeScript(child, out);
    else if (entry.isFile() && child.endsWith('.ts')) out.push(child);
  }
  return out;
}

/**
 * The owned SDK seam (DR-26, task 052). Nothing under this directory is a
 * DIRECT-import subject: `sdk/seam.ts` is the sanctioned importer and
 * `sdk/brand.ts` is its generation vocabulary. Counting them would make the
 * denominator include the very module that closes it — and would hand task 053
 * a migration target that must not be migrated.
 */
const SDK_SEAM_DIR = `${MCP_SRC}/sdk`;

/** The v1 package root. Every `@modelcontextprotocol/sdk/...` subpath is v1. */
const SDK_V1_PACKAGE = '@modelcontextprotocol/sdk';

// ─── Source parsing ─────────────────────────────────────────────────────────

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * `ts.createSourceFile` never throws: handed broken input it returns a partial
 * tree with nodes silently missing, which under-reports. An under-counting
 * derivation is strictly worse than an over-counting one — it lets the document
 * assert a number smaller than the truth and still reads green — so a recovered
 * parse is fatal here. `parseDiagnostics` is off the public `ts.SourceFile`
 * surface but is the only way to tell a clean parse from a recovered one; this
 * is the same access `scripts/tsconfig-strictness/count-casts.ts` makes for the
 * same reason.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {import('typescript').SourceFile}
 */
export function parseModule(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `check-measured-premises: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to ` +
        `derive a premise from a recovered parse, which would silently ` +
        `under-report and let the document assert a number below the truth.`,
    );
  }
  return sourceFile;
}

/**
 * Every MODULE SPECIFIER the parsed program actually imports or re-exports.
 *
 * Covers every form the tree uses or could use, so the parse cannot under-report
 * where the old text match could not miss anything:
 *
 *   `import x from 'p'` · `import type { T } from 'p'` · `import 'p'` ·
 *   `export { x } from 'p'` · `export * from 'p'` · `await import('p')` ·
 *   `require('p')` · `import p = require('p')`
 *
 * A specifier inside a comment, a string, or a template literal is NOT one of
 * these nodes and is therefore absent by construction rather than by filtering —
 * which is the whole point of parsing instead of matching.
 *
 * @param {string} source
 * @param {string} [fileName]
 * @returns {string[]}
 */
export function collectModuleSpecifiers(source, fileName = 'source.ts') {
  const sourceFile = parseModule(source, fileName);
  /** @type {string[]} */
  const specifiers = [];

  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const first = node.arguments[0];
      if (
        (isDynamicImport || isRequire) &&
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        specifiers.push(first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return specifiers;
}

/**
 * True when `specifier` is exactly `pkg` or one of its subpaths.
 *
 * Deliberately NOT `startsWith(pkg)`: that would swallow a hypothetical future
 * `@modelcontextprotocol/sdk-next`, which is a different package.
 *
 * @param {string} specifier
 * @param {string} pkg
 */
function isPackageOrSubpath(specifier, pkg) {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * How many v1 SDK specifiers one module actually imports. Zero for a module that
 * only NAMES the package — in a comment, a string, or a lint fixture written as
 * a template literal.
 *
 * This is the kill-fixture surface for task 061: the superseded predicate was
 * `source.includes('@modelcontextprotocol/sdk')`, which answers 1 for a
 * comment-only mention where this answers 0.
 *
 * @param {string} source
 * @param {string} [fileName]
 * @returns {number}
 */
export function countSdkImportSpecifiers(source, fileName = 'source.ts') {
  return collectModuleSpecifiers(source, fileName).filter((specifier) =>
    isPackageOrSubpath(specifier, SDK_V1_PACKAGE),
  ).length;
}

/**
 * The DR-26 kill-fixture subject: every file that IMPORTS an SDK package
 * DIRECTLY — that is, outside the owned seam — tests included. Tests are counted
 * deliberately: DR-26's seam rule forbids the direct import everywhere, and a
 * subject list that quietly omits the test tree would under-report the
 * denominator it exists to prove non-empty.
 *
 * NON-EMPTY DENOMINATOR (the count-casts rule, one boundary over): a scan that
 * resolves ZERO TypeScript files throws instead of returning an empty list. A
 * relocated `src/`, a typo in {@link MCP_SRC} or a renamed package directory all
 * present the same way — as a clean run over nothing — and would report a LOWER
 * count, which reads as "the migration made progress" and passes the gate.
 *
 * @param {string} root
 * @returns {string[]}
 */
function sdkImportFiles(root) {
  const base = path.join(root, ...MCP_SRC.split('/'));
  if (!existsSync(base) || !statSync(base).isDirectory()) {
    throw new Error(
      `check-measured-premises: SDK import scan root "${MCP_SRC}" does not exist ` +
        `under ${root}. An unresolvable scan root reports 0 import sites and would ` +
        `read as a completed migration, so it fails rather than being trusted.`,
    );
  }
  const files = walkTypeScript(base, []);
  if (files.length === 0) {
    throw new Error(
      `check-measured-premises: SDK import scan root "${MCP_SRC}" resolved 0 ` +
        `TypeScript files. An empty denominator reports 0 import sites and would ` +
        `read as a completed migration, so it fails rather than being trusted.`,
    );
  }
  const seamDir = path.join(root, ...SDK_SEAM_DIR.split('/'));
  return files.filter(
    (file) =>
      !file.startsWith(`${seamDir}${path.sep}`) &&
      countSdkImportSpecifiers(readFileSync(file, 'utf8'), file) > 0,
  );
}

/**
 * A test file, by the repo's own convention (`scripts/tsconfig-strictness/
 * count-casts.ts` uses the same two rules): a `.test` / `.bench` / `.type-test`
 * / `.fixture` basename, or any path segment named `__tests__`.
 *
 * @param {string} file Absolute or repo-relative path.
 */
function isTestFile(file) {
  const normalised = file.replaceAll('\\', '/');
  return (
    /\.(test|bench|type-test|fixture)\.ts$/.test(normalised) ||
    normalised.includes('/__tests__/')
  );
}

/**
 * Count `.command('<string literal>')` call sites — the hand-written half of
 * the CLI surface. Sites whose first argument is an identifier expression
 * (`cliName`, `harness`, `commandName`) are the derivation loops and are NOT
 * counted: G1's whole policy is that provenance is visible in the source and
 * erased in the built tree.
 *
 * Parsed, not matched (task 061). A JSDoc block in `cli.ts` writes
 * `program.command(...)` in prose and a naive `/\.command\(/g` counts it; the
 * comment-blanking predecessor handled that case but still counted a call site
 * written inside a STRING, and desynced on a nested template literal. The AST
 * has neither problem: a call expression inside a string literal is not a call
 * expression.
 *
 * @param {string} source
 * @param {string} [fileName]
 * @returns {number}
 */
export function countCommandLiterals(source, fileName = 'source.ts') {
  const sourceFile = parseModule(source, fileName);
  let count = 0;
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'command'
    ) {
      const first = node.arguments[0];
      if (
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return count;
}

/**
 * Count the declaration sites that construct a substantive `outputSchema`.
 *
 * Scoped to the `outputSchema: withCappedShape(...)` PROPERTY ASSIGNMENT on
 * purpose: the source also carries the function's own declaration and a JSDoc
 * mention, neither of which is a declaration. This derivation is INDEPENDENT of
 * the census — it reads the parsed source, the census reads the Zod object — so
 * the two agreeing on 10 is a genuine cross-check rather than one number quoted
 * twice.
 *
 * @param {string} source
 * @param {string} [fileName]
 * @returns {number}
 */
export function countWithCappedShapeDeclarations(source, fileName = 'source.ts') {
  const sourceFile = parseModule(source, fileName);
  let count = 0;
  /** @param {import('typescript').Node} node */
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'outputSchema' &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'withCappedShape'
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return count;
}

// ─── tsx bridge (same idiom as check-prefix-fingerprint.mjs) ────────────────

/**
 * Resolve how to invoke `tsx`. Prefers the JS CLI entrypoint run under
 * `process.execPath` over the `node_modules/.bin/tsx` shim, because the shim is
 * a POSIX shebang script with no `.exe`/`.cmd` extension and Win32 cannot
 * launch it without a shell.
 */
function resolveTsx(root) {
  const candidates = [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'servers', 'exarchos-mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return { command: 'tsx', args: [] };
}

/**
 * Run the TS derivation entrypoint once and return its value map. Any failure
 * is fatal (exit 2) rather than "no value": a derivation that cannot run must
 * not be silently downgraded to a missing number, or the gate reports clean on
 * the very tooling break that disabled it.
 */
function loadTsDerivations(root) {
  const entry = path.join(root, 'scripts', 'measured-premises-derive.ts');
  const { command, args } = resolveTsx(root);
  const result = spawnSync(command, [...args, entry], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (result.error) {
    fatal(`failed to spawn tsx (${command}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    fatal(
      'TS derivations failed\n' +
        `  entry:  ${entry}\n` +
        `  status: ${result.status}\n` +
        `  stderr: ${result.stderr ?? ''}`,
    );
  }
  try {
    const parsed = JSON.parse(result.stdout ?? '');
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (err) {
    fatal(
      `TS derivations produced unparseable stdout: ${JSON.stringify(result.stdout ?? '')} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return {};
}

/**
 * Build the lazy derivation seam. The `tsx` subprocess runs at most once, and
 * only if a `ts`-backed name is actually referenced by a scanned document.
 */
export function makeDeriver(root) {
  /** @type {Record<string, number> | undefined} */
  let tsValues;
  /** @type {Map<string, number>} */
  const memo = new Map();

  return {
    isKnownDerivation: (name) => Object.prototype.hasOwnProperty.call(DERIVATIONS, name),
    derive: (name) => {
      const hit = memo.get(name);
      if (hit !== undefined) return hit;
      const spec = DERIVATIONS[name];
      if (spec === undefined) return undefined;
      let value;
      if (spec.kind === 'ts') {
        if (tsValues === undefined) tsValues = loadTsDerivations(root);
        value = tsValues[name];
        if (typeof value !== 'number') {
          throw new Error(`TS derivation entrypoint returned no value for '${name}'`);
        }
      } else {
        value = spec.fn(root);
      }
      memo.set(name, value);
      return value;
    },
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function fatal(message) {
  process.stderr.write(`check-measured-premises: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: node scripts/check-measured-premises.mjs [flags]',
      '',
      'Flags:',
      '  --document <path>  Scan this document (repeatable). Default: DR-27 scope.',
      '  --fail-on-gap      Treat unprobed obligation rungs as a failure.',
      '  --json             Emit the machine-readable report.',
      '  --help             Show this message.',
      '',
      'Exit codes: 0 pass/gaps, 1 fail (or gaps under --fail-on-gap), 2 usage/env error.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const documents = [];
  let failOnGap = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--document':
        if (!value) {
          printHelp();
          fatal('--document requires a path');
        }
        documents.push(value);
        i++;
        break;
      case '--fail-on-gap':
        failOnGap = true;
        break;
      case '--json':
        json = true;
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(EXIT_PASS);
        break;
      default:
        printHelp();
        fatal(`unknown flag: ${flag}`);
    }
  }
  return {
    documents: documents.length > 0 ? documents : [...DEFAULT_DOCUMENTS],
    failOnGap,
    json,
  };
}

function formatReport(report) {
  const lines = [];
  const { counts } = report;
  lines.push(
    `check-measured-premises: ${counts.claimsResolved} measured claim(s) re-derived; ` +
      `${counts.rungRows} obligation row(s) classified.`,
  );

  for (const claim of report.claims) {
    if (claim.verdict === 'agree') continue;
    lines.push(
      `  [${claim.verdict.toUpperCase()}] ${claim.document}:${claim.line} ${claim.name} ` +
        `document=${claim.literal ?? '?'} derived=${claim.derived ?? '?'}`,
    );
  }

  if (counts.rungGaps > 0 || counts.rungsUnannotated > 0) {
    lines.push('');
    lines.push(
      `  proof-rung gaps (${counts.rungGaps} unprobed, ${counts.rungsProbed} probed of ` +
        `${counts.rungRows}) — reportable, NOT a pass:`,
    );
    for (const rung of report.rungs) {
      if (rung.verdict === 'probed') continue;
      lines.push(
        `    [${rung.verdict.toUpperCase()}] rung ${JSON.stringify(rung.rung)} — ` +
          `${rung.property}${rung.reason ? ` (${rung.reason})` : ''}`,
      );
    }
  }

  if (report.failures.length > 0) {
    lines.push('');
    lines.push(`  ${report.failures.length} failure(s):`);
    for (const failure of report.failures) lines.push(`    - ${failure}`);
  }

  lines.push('');
  lines.push(`  VERDICT: ${report.verdict.toUpperCase()}`);
  return lines.join('\n');
}

function main() {
  const { documents, failOnGap, json } = parseArgs(process.argv.slice(2));

  const loaded = documents.map((relative) => {
    const abs = path.resolve(REPO_ROOT, relative);
    if (!existsSync(abs)) fatal(`document not found: ${relative}`);
    return { path: relative, text: readFileSync(abs, 'utf8') };
  });

  const { derive, isKnownDerivation } = makeDeriver(REPO_ROOT);
  const report = checkMeasuredPremises({
    documents: loaded,
    derive,
    isKnownDerivation,
    failOnGap,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const text = `${formatReport(report)}\n`;
    if (report.exitCode === EXIT_PASS) process.stdout.write(text);
    else process.stderr.write(text);
  }
  process.exit(report.exitCode);
}

const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return path.resolve(argv1) === path.resolve(fileURLToPath(import.meta.url));
})();

if (invokedDirectly) main();
