#!/usr/bin/env node
/**
 * CI gate: drift in the measured premises of the documents in {@link DEFAULT_DOCUMENTS}.
 *
 * A measured claim is an inline annotation such as
 * `<!-- measured: output-schema-vacuous -->112<!-- /measured -->`. Its name resolves to an
 * entry in {@link DERIVATIONS}, and the gate compares the literal with the derived value.
 * A run that resolves zero claims fails. Each row of the obligation map needs exactly one
 * `rung-probe` annotation: `fixture:<path>`, `command:<npm script>`, or `none`.
 *
 * Exit 0 on `pass`. Exit 1 on `fail`: drift, an empty denominator, an unknown derivation,
 * a malformed literal, or a row with no probe. Exit 3 on `gaps` (unprobed rungs), or 1 with
 * `--fail-on-gap`. `--tolerate-gaps-until <YYYY-MM-DD>` maps `gaps` to exit 0 through that
 * day, and the report still says GAPS. Exit 2 on a usage or tooling error.
 * `--document <path>` (repeatable) sets the input, and `--json` prints the report as JSON.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { evaluatePackaging, diskTree } from './validate-plugin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

/** The declared scope: two documents and no others. */
export const DEFAULT_DOCUMENTS = Object.freeze([
  'docs/specs/2026-08-06-internal-mechanics-overhaul.md',
  '.exarchos/invariants.md',
]);

/** Verdict exit codes. They are exported, so a test reads the same constants that the process exits with. */
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
/**
 * The exit code of `gaps`. It differs from pass and fail, so the verdict survives the
 * process boundary. It is exported, so its consumers cannot drift from this gate.
 */
export const EXIT_GAPS = 3;

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
 * Parses a claim literal: a plain integer or a thousands-separated form such as `1,613`.
 * It returns `undefined` for any other text, and the check reports that as malformed.
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

/**
 * @typedef {Object} ObligationRow
 * @property {string} property   First cell — the property being claimed.
 * @property {string} rung       The `Primary proof (rung)` cell, markers stripped.
 * @property {string[]} probes   Raw probe declarations found on the row.
 * @property {number} line       1-based line of the row.
 */

/** Splits a markdown table row on unescaped pipes, and drops the empty cells outside the outer pipes. */
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
  if (cells.length >= 2 && cells[0].trim() === '') cells.shift();
  if (cells.length >= 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

const SEPARATOR_ROW = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Finds the obligation map and reads one record per row. The map is the first table whose
 * header has a `Primary proof` column and a `Failure signal` column, so a renamed section
 * heading does not hide it.
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
 * Resolves a probe against the working tree. `fixture:<path>` needs an existing file, and
 * `command:<script>` needs a script in the root `package.json`. A missing target is a gap
 * with a reason, not a pass. `none` is always a gap.
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

/**
 * @typedef {Object} CheckOptions
 * @property {{ path: string, text: string }[]} documents
 * @property {(name: string) => number | undefined} derive       Re-derive a claim.
 * @property {(name: string) => boolean} isKnownDerivation       Is the name bound at all?
 * @property {(probe: string) => { status: string, reason?: string }} [resolveProbe]
 * @property {boolean} [failOnGap]
 * @property {string} [tolerateGapsUntil] `YYYY-MM-DD`, inclusive.
 * @property {string} [today] `YYYY-MM-DD`, injected so the expiry is testable.
 */

/**
 * Compares each annotated claim with its derivation and classifies each obligation-map rung.
 * By default, each verdict has its own exit code. `failOnGap` and a gap toleration change
 * only the exit code of `gaps`, never the verdict.
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
    tolerateGapsUntil,
    today = new Date().toISOString().slice(0, 10),
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

  const tolerationLive =
    typeof tolerateGapsUntil === 'string' && tolerateGapsUntil >= today;
  const gapsExit = failOnGap
    ? EXIT_FAIL
    : tolerateGapsUntil === undefined
      ? EXIT_GAPS
      : tolerationLive
        ? EXIT_PASS
        : EXIT_FAIL;
  const exitCode =
    verdict === 'fail' ? EXIT_FAIL : verdict === 'gaps' ? gapsExit : EXIT_PASS;

  return {
    verdict,
    exitCode,
    ...(tolerateGapsUntil === undefined
      ? {}
      : { toleration: { until: tolerateGapsUntil, live: tolerationLive } }),
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

const MCP_SRC = 'src';
const CLI_SOURCE = `${MCP_SRC}/adapters/cli.ts`;
const REGISTRY_SOURCE = `${MCP_SRC}/registry.ts`;

/** The data files of the two `validate-*` derivations. */
const VALIDATE_MANIFEST = 'tools/audit/gates/validate-manifest.json';
const PACKAGING_POLICY = '.claude-plugin/packaging-policy.json';

/** The policy data of the `cli-allowlisted-literals` derivation. */
const CLI_DERIVATION_ALLOWLIST = 'tools/audit/core/cli-derivation-allowlist.json';
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
  /**
   * `auditCliAllowlistMembership` fails when a tracked name is not a live literal, and when a
   * live literal is not tracked. This count therefore cannot drift from the parsed literals.
   */
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
 * Returns the number of steps in the validate manifest. A missing manifest or zero steps
 * throws, because an empty denominator lets the document assert `0` and pass.
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
 * Returns the number of checks that the packaging policy produces against the tree at
 * `root`. It runs the real gate, because one clause can expand into more than one check.
 * A missing policy or zero checks throws.
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
 * Returns the number of keys in the `allowed` map of the CLI derivation allowlist.
 * `auditCliAllowlistMembership` binds that map to the live literals in both directions,
 * so this function does not copy the kill-fixture rule. A missing file, a bad shape, or
 * zero entries throws.
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

/** The owned SDK seam. Its modules are the sanctioned importers, so `sdkImportFiles` leaves them out. */
const SDK_SEAM_DIR = `${MCP_SRC}/sdk`;

/** The v1 package root. Every `@modelcontextprotocol/sdk/...` subpath is v1. */
const SDK_V1_PACKAGE = '@modelcontextprotocol/sdk';

/**
 * Parses one module and throws on a recovered parse. `ts.createSourceFile` never throws,
 * and a recovered tree silently drops nodes, so a count can fall below the truth.
 * `parseDiagnostics` is not public API, but it is the only signal of a recovered parse.
 * The `false` argument skips the parent pointers.
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
    false,
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
 * Returns each module specifier that the parsed program imports or re-exports: static
 * imports and exports, side-effect imports, `import()`, `require()`, and `import x = require()`.
 * A specifier in a comment, a string, or a template literal is not such a node, so it never counts.
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
 * True when `specifier` is exactly `pkg` or one of its subpaths. A plain `startsWith(pkg)`
 * also matches a different package such as `@modelcontextprotocol/sdk-next`.
 *
 * @param {string} specifier
 * @param {string} pkg
 */
function isPackageOrSubpath(specifier, pkg) {
  return specifier === pkg || specifier.startsWith(`${pkg}/`);
}

/**
 * Returns the number of v1 SDK specifiers that one module imports. A module that only
 * names the package in a comment, a string, or a template literal returns 0.
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
 * Returns each file under {@link MCP_SRC} that imports an SDK package outside the owned seam.
 * Tests count too, because the seam rule forbids a direct import everywhere. A missing scan
 * root or zero TypeScript files throws, because an empty scan reads as a finished migration.
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
 * True for a test file: a `.test`, `.bench`, `.type-test`, or `.fixture` basename, or a
 * path with a `__tests__` segment.
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
 * Counts the `.command('<string literal>')` call sites, the hand-written half of the CLI.
 * A call whose first argument is an identifier is a derivation loop and does not count.
 * The count parses the source, so a call in a comment or a string never counts.
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
 * Counts the `outputSchema: withCappedShape(...)` property assignments. The function
 * definition and a JSDoc mention do not count. The census reads the Zod objects and this
 * count reads the parsed source, so their agreement is an independent cross-check.
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

/**
 * Returns `{ command, args }` for `spawnSync`. It runs `tsx/dist/cli.mjs` with
 * `process.execPath` when that file exists, because Windows cannot launch the
 * `node_modules/.bin/tsx` shell shim without a shell. Else it runs `tsx` from PATH.
 */
function resolveTsx(root) {
  const candidates = [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  return { command: 'tsx', args: [] };
}

/**
 * Runs the TS derivation entrypoint once and returns its value map. Any failure exits 2,
 * so a tooling break never reads as a missing value and a clean run.
 */
function loadTsDerivations(root) {
  const entry = path.join(root, 'tools', 'audit', 'gates', 'measured-premises-derive.ts');
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
 * Builds the lazy, memoized derivation seam. The `tsx` subprocess runs at most once, and
 * only when a scanned document names a `ts` derivation.
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

function fatal(message) {
  process.stderr.write(`check-measured-premises: ${message}\n`);
  process.exit(EXIT_USAGE);
}

function printHelp() {
  process.stderr.write(
    [
      'Usage: node tools/audit/gates/check-measured-premises.mjs [flags]',
      '',
      'Flags:',
      '  --document <path>  Scan this document (repeatable). Default: DR-27 scope.',
      '  --fail-on-gap      Treat unprobed obligation rungs as a failure.',
      '  --tolerate-gaps-until <YYYY-MM-DD>',
      '                     Exit 0 on `gaps` through that day; exit 1 after it.',
      '                     The reported verdict is unchanged.',
      '  --json             Emit the machine-readable report.',
      '  --help             Show this message.',
      '',
      'Exit codes: 0 pass, 1 fail (or gaps under --fail-on-gap), 2 usage/env error,',
      '            3 gaps (unprobed rungs — reportable, and never a pass).',
      '',
    ].join('\n'),
  );
}

/**
 * Parses the flags. `--tolerate-gaps-until` needs a `YYYY-MM-DD` date, so an unreadable
 * date fails and is never ignored.
 */
function parseArgs(argv) {
  const documents = [];
  let failOnGap = false;
  let json = false;
  let tolerateGapsUntil;
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
      case '--tolerate-gaps-until':
        if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          printHelp();
          fatal('--tolerate-gaps-until requires a YYYY-MM-DD date');
        }
        tolerateGapsUntil = value;
        i++;
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
    tolerateGapsUntil,
  };
}

/**
 * Renders the text report. A gap toleration adds its own line, so the verdict line never
 * presents GAPS as a pass.
 */
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
  if (report.toleration !== undefined && report.verdict === 'gaps') {
    lines.push(
      report.toleration.live
        ? `  (gaps tolerated by this caller until ${report.toleration.until}; still NOT a pass)`
        : `  (the caller's gap toleration EXPIRED on ${report.toleration.until} — failing)`,
    );
  }
  return lines.join('\n');
}

/** Planning corpus that mounts back via `npm run docs:mount` and is absent on CI. */
function isOptionalMount(relative) {
  return relative.startsWith('docs/specs/') || relative.startsWith('docs/guides/');
}

/**
 * Loads the documents, runs the check, and exits with the verdict code. An absent optional
 * mount can leave only an empty denominator or a missing rung map. That run passes, because
 * the subject is absent and not broken.
 */
function main() {
  const { documents, failOnGap, json, tolerateGapsUntil } = parseArgs(process.argv.slice(2));

  const skipped = [];
  const loaded = [];
  for (const relative of documents) {
    const abs = path.resolve(REPO_ROOT, relative);
    if (!existsSync(abs)) {
      if (isOptionalMount(relative)) {
        skipped.push(relative);
        continue;
      }
      fatal(`document not found: ${relative}`);
    }
    loaded.push({ path: relative, text: readFileSync(abs, 'utf8') });
  }
  if (loaded.length === 0) fatal('no in-scope documents readable');

  const { derive, isKnownDerivation } = makeDeriver(REPO_ROOT);
  const report = checkMeasuredPremises({
    documents: loaded,
    derive,
    isKnownDerivation,
    failOnGap,
    ...(tolerateGapsUntil === undefined ? {} : { tolerateGapsUntil }),
  });

  if (
    skipped.length > 0 &&
    report.counts.claimsResolved === 0 &&
    report.failures.length > 0 &&
    report.failures.every(
      (f) => f.startsWith('EMPTY_DENOMINATOR') || f.startsWith('RUNG_MAP_MISSING'),
    )
  ) {
    const unmounted = {
      verdict: 'pass',
      exitCode: EXIT_PASS,
      claims: [],
      rungs: [],
      failures: [],
      counts: {
        claimsAnnotated: 0,
        claimsResolved: 0,
        drifted: 0,
        rungRows: 0,
        rungsProbed: 0,
        rungGaps: 0,
        rungsUnannotated: 0,
      },
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(unmounted, null, 2)}\n`);
    } else {
      process.stdout.write(
        `check-measured-premises: skipped unmounted document(s): ${skipped.join(', ')}\n` +
          'remaining documents have no measured claims — nothing to re-derive in this checkout.\n',
      );
    }
    process.exit(EXIT_PASS);
  }

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
