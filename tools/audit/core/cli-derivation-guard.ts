// The source-level CLI derivation guard.
//
// The CLI composition root holds no literal `.command('<name>')` call. Each
// command comes from a derivation helper (`registerActionCommand`, the
// composite-tool loop, or the harness loop) that takes its name from a registry
// declaration. `GOVERNED_SOURCES` and the allowlist file hold the policy as data.
//
// The guard parses the source, because a built Commander tree records no
// provenance: `program.command('doctor')` and `program.command(cliName)` give
// identical nodes. It uses the TypeScript parser, not a regex, so a call in a
// comment never counts, and a recovered parse fails closed. It never resolves
// `buildCli`, so it runs under plain `node` or `tsx` without Bun.
//
// The ratchet audits govern how the allowlist can change.
// `tools/audit/core/cli-derivation-ratchet-guard.ts` runs them in CI.

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { daysBetween, isIsoDay, isoDayUtc } from '../../conformance/src/waiver-ledger.js';
import { keySetDigest } from '../../conformance/src/waiver-ledger-digest.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_DIGEST_ALGORITHM,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from './cli-derivation-seed-pin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repository root — `<repo>/tools/audit/core` → `<repo>`. */
export const REPO_ROOT = path.resolve(HERE, '../../..');

/**
 * The governed composition roots, repo-relative and forward-slashed.
 *
 * A new composition root joins this list as data. Each entry must exist and
 * parse. A path that resolves to nothing fails the scan, and does not count as
 * zero sites (see {@link scanGovernedSources}).
 */
export const GOVERNED_SOURCES: readonly string[] = Object.freeze([
  'src/adapters/cli/cli.ts',
]);

/** Repo-relative location of the allowlist data file. */
export const ALLOWLIST_PATH = 'tools/audit/core/cli-derivation-allowlist.json';

/**
 * The kill fixture: command names that the allowlist can never hold.
 *
 * `merge-orchestrate` is a registry action. A hand-written
 * `.command('merge-orchestrate')` beside it is a second declaration, and the
 * remedy is to delete the hand-written command. {@link findDerivationViolations}
 * reports these names whatever the allowlist holds. {@link readPolicy} refuses a
 * policy file that lists one in either map, so the mistake fails at authoring
 * time.
 */
export const KILL_FIXTURE_COMMANDS: readonly string[] = Object.freeze(['merge-orchestrate']);

/** Is `name` a kill-fixture command — one that can never be exempted? */
export function isKillFixture(name: string): boolean {
  return KILL_FIXTURE_COMMANDS.includes(name);
}

/**
 * How a `.command(…)` site names its command.
 *
 * - `literal`: a string literal or a template with no substitution. The name is
 *   fixed in the composition root, and nothing ties it to a registry declaration.
 * - `derived`: any other expression. The name is computed, and the helpers read
 *   it from the registry.
 * - `indeterminate`: a `.command()` call with no argument. The guard cannot
 *   prove derivation, so it fails closed.
 */
export type CommandSiteKind = 'literal' | 'derived' | 'indeterminate';

export interface CommandSite {
  /** Repo-relative, forward-slashed path of the file containing the site. */
  readonly file: string;
  /** 1-based line number of the `.command` call. */
  readonly line: number;
  /** 1-based column of the `.command` call. */
  readonly column: number;
  readonly kind: CommandSiteKind;
  /**
   * For a `literal` site, the command NAME — the first whitespace-delimited
   * token of the literal, so `'feedback <message>'` yields `feedback`.
   * Empty for non-literal sites.
   */
  readonly name: string;
  /** The argument's source text, for the failure message. */
  readonly expression: string;
}

export interface DerivationScan {
  /** Every `.command(` call site found, in source order. */
  readonly sites: readonly CommandSite[];
  /** Sites whose name is baked as a literal — the population under policy. */
  readonly literals: readonly CommandSite[];
  /** Sites whose name is computed. */
  readonly derived: readonly CommandSite[];
  /** Sites that the guard cannot classify. Non-empty is a fail-closed condition. */
  readonly indeterminate: readonly CommandSite[];
}

/**
 * Reads `parseDiagnostics` without a type assertion.
 *
 * `parseDiagnostics` is not on the public `ts.SourceFile` surface. It is the
 * only way to tell a clean parse from a recovered one. `createSourceFile` never
 * throws: on broken input it returns a partial tree that under-reports
 * `.command(` sites. `Reflect.get` into an `unknown` keeps the read inside the
 * cast budget.
 */
function readParseErrors(sourceFile: ts.SourceFile): { readonly count: number; readonly detail: string } {
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  if (!Array.isArray(raw) || raw.length === 0) return { count: 0, detail: '' };
  const first: unknown = raw[0];
  const messageText: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'messageText') : undefined;
  return {
    count: raw.length,
    detail: typeof messageText === 'string' ? messageText : '(non-string diagnostic message)',
  };
}

/**
 * Parses `source` and refuses a recovered parse.
 *
 * Other source-level measurements reuse it, such as the live authority proof.
 * `label` prefixes the failure message. `setParentNodes` is for a measurement
 * that walks up from a site to the scope that declares an identifier. It is off
 * by default, because the extractors here only walk down.
 */
export function parseOrThrow(
  source: string,
  fileName: string,
  label: string = 'cli-derivation-guard',
  setParentNodes: boolean = false,
): ts.SourceFile {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, setParentNodes, ts.ScriptKind.TS);
  const errors = readParseErrors(sourceFile);
  if (errors.count > 0) {
    throw new Error(
      `${label}: ${fileName} did not parse cleanly (${errors.count} syntax ` +
        `error(s); first: ${errors.detail}). Refusing to report a result derived from a ` +
        'recovered parse, which would silently under-report literal command sites.',
    );
  }
  return sourceFile;
}

/**
 * True for `x.command(…)`, `x?.command(…)` and `x['command'](…)`. A check of the
 * property-access form alone misses the element-access form.
 */
function isCommandCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'command';
  if (ts.isElementAccessExpression(callee)) {
    const arg = callee.argumentExpression;
    return ts.isStringLiteralLike(arg) && arg.text === 'command';
  }
  return false;
}

function classify(arg: ts.Expression | undefined): CommandSiteKind {
  if (arg === undefined) return 'indeterminate';
  return ts.isStringLiteralLike(arg) ? 'literal' : 'derived';
}

/**
 * Parses `source` and returns each `.command(` site with its kind.
 *
 * It is pure over a source string, so the self-tests drive it with seeded input.
 * It throws on a source with zero sites. The check lives here, not in
 * {@link scanGovernedSources}, so a direct caller cannot bypass it. An empty
 * scan reads as a clean run, and that is how a moved composition root silently
 * stops being governed. The check has no opt-out parameter.
 */
export function scanSourceForCommandSites(source: string, file: string): DerivationScan {
  const sourceFile = parseOrThrow(source, file);
  const sites: CommandSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCommandCall(node)) {
      const arg = node.arguments[0];
      const kind = classify(arg);
      const pos = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile));
      const name = arg !== undefined && ts.isStringLiteralLike(arg) ? firstToken(arg.text) : '';
      sites.push({
        file,
        line: pos.line + 1,
        column: pos.character + 1,
        kind,
        name,
        expression: arg === undefined ? '<no argument>' : arg.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  if (sites.length === 0) {
    throw new Error(
      `cli-derivation-guard: "${file}" yielded 0 \`.command(\` sites. A source that ` +
        'registers no commands is not a composition root — this is a broken scan (renamed ' +
        'file, changed registration idiom, wrong path), not a clean run. The non-empty ' +
        'denominator is enforced in the pure scanner so no caller can route around it.',
    );
  }

  return {
    sites,
    literals: sites.filter((s) => s.kind === 'literal'),
    derived: sites.filter((s) => s.kind === 'derived'),
    indeterminate: sites.filter((s) => s.kind === 'indeterminate'),
  };
}

/** `'feedback <message>'` gives `feedback`, and `'doctor'` gives `doctor`. */
function firstToken(literal: string): string {
  return literal.trim().split(/\s+/)[0] ?? '';
}

/**
 * Scans each governed source under `repoRoot`.
 *
 * It throws when the source list is empty or a governed file is missing. A guard
 * that parses nothing passes clean, so a moved composition root reads as "policy
 * satisfied". The zero-site check lives in {@link scanSourceForCommandSites},
 * which names the file, so this function does not repeat it.
 */
export function scanGovernedSources(
  repoRoot: string = REPO_ROOT,
  sources: readonly string[] = GOVERNED_SOURCES,
): DerivationScan {
  if (sources.length === 0) {
    throw new Error(
      'cli-derivation-guard: no governed sources declared. An empty scan finds zero ' +
        'literal command sites and passes the policy clean, so it is rejected rather ' +
        'than trusted.',
    );
  }

  const all: CommandSite[] = [];
  for (const rel of sources) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      throw new Error(
        `cli-derivation-guard: governed source "${rel}" does not exist at ${abs}. The CLI ` +
          'composition root was moved or renamed; update GOVERNED_SOURCES. Refusing to ' +
          'report a clean scan over a file that is not there.',
      );
    }
    const scan = scanSourceForCommandSites(readFileSync(abs, 'utf8'), rel);
    all.push(...scan.sites);
  }

  return {
    sites: all,
    literals: all.filter((s) => s.kind === 'literal'),
    derived: all.filter((s) => s.kind === 'derived'),
    indeterminate: all.filter((s) => s.kind === 'indeterminate'),
  };
}

/**
 * Extensions that make a token in policy prose a file reference. The list is
 * data, so a new kind of referenced file gets the same check without a change
 * to the pattern.
 */
export const REFERENCED_EXTENSIONS: readonly string[] = Object.freeze([
  'ts',
  'mts',
  'cts',
  'js',
  'mjs',
  'json',
  'md',
  'yml',
  'yaml',
]);

const FILE_REFERENCE_PATTERN = new RegExp(
  `[A-Za-z0-9_@.\\-/]+\\.(?:${REFERENCED_EXTENSIONS.join('|')})\\b`,
  'g',
);

/** Every file reference the policy prose makes, in order of appearance. */
export function extractPolicyFileReferences(commentText: string): readonly string[] {
  return commentText.match(FILE_REFERENCE_PATTERN) ?? [];
}

export interface PolicyReferenceProblem {
  /** The offending token, or `'(none)'` for the empty-denominator case. */
  readonly reference: string;
  readonly detail: string;
}

/**
 * Checks each file reference in `commentText` against the tree at `repoRoot`.
 * The `$comment` is what a future author reads, so each file that it names must
 * resolve.
 *
 * - A bare basename names no single place on disk, so it cannot be checked.
 * - A repo-relative path that does not exist is stale.
 * - Prose that names no file fails too, because it looks like a broken extractor.
 */
export function findPolicyReferenceProblems(
  commentText: string,
  repoRoot: string = REPO_ROOT,
): readonly PolicyReferenceProblem[] {
  const references = extractPolicyFileReferences(commentText);
  if (references.length === 0) {
    return [
      {
        reference: '(none)',
        detail:
          'the policy prose names no file at all. It must point at the module that ' +
          'implements the policy, as a repo-relative path, so a reader can follow it and ' +
          'so a rename cannot go unnoticed. Zero references is also what a broken ' +
          'reference extractor looks like, and that must not read as a clean run.',
      },
    ];
  }

  const problems: PolicyReferenceProblem[] = [];
  for (const reference of references) {
    if (!reference.includes('/')) {
      problems.push({
        reference,
        detail:
          'is a bare filename. Write the repo-relative path (e.g. ' +
          '`tools/audit/core/<file>`) so the reference can be verified against ' +
          'the tree and followed by a reader.',
      });
      continue;
    }
    if (!existsSync(path.join(repoRoot, reference))) {
      problems.push({
        reference,
        detail:
          'does not exist. A policy file that names a module which is not there sends the ' +
          'next author looking for a file that was renamed or deleted — update the ' +
          'reference, or drop it.',
      });
    }
  }
  return problems;
}

/** Normalizes a `$comment` that is a string or an array of lines. */
function readCommentText(parsed: unknown): string {
  const raw: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, '$comment') : undefined;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const lines: string[] = [];
    for (const line of raw) if (typeof line === 'string') lines.push(line);
    return lines.join('\n');
  }
  return '';
}

/** One tolerated hand-written verb: who owns removing it, and by when. */
export interface CliWaiverEntry {
  /** Subsystem accountable for registering the verb through a derivation helper. */
  readonly owner: string;
  /**
   * ISO date (YYYY-MM-DD) of the last day that the waiver is live.
   * {@link auditCliDerivationExpiry} enforces it. A date later than
   * `CLI_DERIVATION_EXPIRY_HORIZON` fails, so an entry cannot extend itself. An
   * earlier date is always legal.
   */
  readonly expires: string;
}

/**
 * One paid-down verb.
 *
 * The pinned digest covers `keys(allowed) ∪ keys(retired)`. A legal paydown is
 * thus a move that keeps the digest, and an addition changes it.
 * {@link auditCliAllowlistMembership} reports a retired verb that is still a
 * literal as `RETIRED_BUT_LIVE`, so this map is not a suppression list.
 */
export interface CliRetiredEntry {
  /** Subsystem that owned the paydown. Carried over from the waiver. */
  readonly owner: string;
  /** ISO date (YYYY-MM-DD) on which the entry left `allowed`. */
  readonly retiredAt: string;
}

/**
 * The waiver ledger. An `allowed` entry is `{ owner, expires }`, keyed by the
 * waived name. A paid-down entry moves to `retired` as `{ owner, retiredAt }`.
 * One pinned horizon caps `expires`, and a pinned digest covers the key set of
 * both maps.
 */
export interface CliDerivationPolicy {
  readonly allowed: Readonly<Record<string, CliWaiverEntry>>;
  readonly retired: Readonly<Record<string, CliRetiredEntry>>;
}

/**
 * Reads one plain-object field off parsed JSON, without a type assertion. A
 * policy file of the wrong shape is refused, not reinterpreted. An array is
 * rejected explicitly, because `typeof [] === 'object'` and an `"allowed": []`
 * array yields zero waivers.
 */
function readObjectField(
  parsed: unknown,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  const raw: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, field) : undefined;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) out[key] = Reflect.get(raw, key);
  return out;
}

/** The string at `value[field]`, or `undefined` if it is absent or not a string. */
function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw: unknown = Reflect.get(value, field);
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * The whole policy, waivers and retired entries, read from {@link ALLOWLIST_PATH}.
 *
 * It fails closed on a missing or malformed file, and on a `$comment` that names
 * a missing file (see {@link findPolicyReferenceProblems}). This function checks
 * the shape. The audits check the content, so an empty owner or a bad date is a
 * finding, not a thrown error. It refuses a kill-fixture name in either map
 * before it checks references, so a stale pointer never hides that refusal.
 */
export function readPolicy(repoRoot: string = REPO_ROOT): CliDerivationPolicy {
  const abs = path.join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(abs)) {
    throw new Error(
      `cli-derivation-guard: allowlist file missing at ${abs}. The policy data is part of ` +
        'the guard; a missing allowlist is a broken gate, not an empty one.',
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'));

  const allowedRaw = readObjectField(parsed, 'allowed');
  if (allowedRaw === undefined) {
    throw new Error(
      `cli-derivation-guard: allowlist at ${ALLOWLIST_PATH} must have an "allowed" OBJECT ` +
        'mapping each tolerated command name to `{ "owner": "…", "expires": "YYYY-MM-DD" }`. ' +
        'Refusing to run against a policy file whose shape it cannot verify. (The pre-ratchet ' +
        'shape was a bare array of names, which carried neither an owner nor a deadline.)',
    );
  }
  const retiredRaw = readObjectField(parsed, 'retired');
  if (retiredRaw === undefined) {
    throw new Error(
      `cli-derivation-guard: allowlist at ${ALLOWLIST_PATH} must have a "retired" OBJECT ` +
        'mapping each paid-down command name to `{ "owner": "…", "retiredAt": "YYYY-MM-DD" }`. ' +
        'It may be empty, but it may not be ABSENT: the graveyard is half of the pinned seed ' +
        'key set, and a missing one silently shrinks the set the digest is taken over.',
    );
  }

  const allowed: Record<string, CliWaiverEntry> = {};
  for (const name of Object.keys(allowedRaw)) {
    const value = allowedRaw[name];
    const owner = readStringField(value, 'owner');
    const expires = readStringField(value, 'expires');
    if (owner === undefined || expires === undefined) {
      throw new Error(
        `cli-derivation-guard: "${name}" in ${ALLOWLIST_PATH} "allowed" must carry a string ` +
          '"owner" and a string "expires". A waiver without an owner has nobody the debt comes ' +
          'due for, and one without a deadline is a permanent exemption wearing a name.',
      );
    }
    allowed[name] = { owner, expires };
  }

  const retired: Record<string, CliRetiredEntry> = {};
  for (const name of Object.keys(retiredRaw)) {
    const value = retiredRaw[name];
    const owner = readStringField(value, 'owner');
    const retiredAt = readStringField(value, 'retiredAt');
    if (owner === undefined || retiredAt === undefined) {
      throw new Error(
        `cli-derivation-guard: "${name}" in ${ALLOWLIST_PATH} "retired" must carry a string ` +
          '"owner" and a string "retiredAt". The graveyard records who paid the debt down and ' +
          'when; an entry without them is not a record of anything.',
      );
    }
    retired[name] = { owner, retiredAt };
  }

  const exempted = [...Object.keys(allowed), ...Object.keys(retired)].filter(isKillFixture);
  if (exempted.length > 0) {
    throw new Error(
      `cli-derivation-guard: ${ALLOWLIST_PATH} allowlists the kill fixture ` +
        `${exempted.map((n) => `"${n}"`).join(', ')}. These names are the guard's live failing ` +
        'subject and must remain rejected — an earlier revision exempted `merge-orchestrate` ' +
        'and thereby neutralized the rejection DR-5 requires. The remedy is to DELETE the ' +
        'hand-written `.command(...)` call from the composition root and let the registry ' +
        'declaration be the single definition, never to add it here.',
    );
  }

  const referenceProblems = findPolicyReferenceProblems(readCommentText(parsed), repoRoot);
  if (referenceProblems.length > 0) {
    throw new Error(
      `cli-derivation-guard: ${ALLOWLIST_PATH} has ${referenceProblems.length} broken file ` +
        `reference(s) in its "$comment": ` +
        referenceProblems.map((p) => `"${p.reference}" ${p.detail}`).join(' ') +
        ' The comment is what a future author reads to decide whether their entry is ' +
        'legitimate, so a pointer that does not resolve is a broken policy file, not a typo.',
    );
  }

  return Object.freeze({ allowed: Object.freeze(allowed), retired: Object.freeze(retired) });
}

/**
 * The names tolerated as literals: the key set of `allowed` from
 * {@link readPolicy}. The derivation check takes only this set, so its verdict
 * cannot depend on an owner or a date.
 */
export function readAllowlist(repoRoot: string = REPO_ROOT): ReadonlySet<string> {
  return new Set(Object.keys(readPolicy(repoRoot).allowed));
}

export interface DerivationViolation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind: CommandSiteKind;
  readonly name: string;
  readonly detail: string;
}

/**
 * Each site that breaks the policy: a literal that the allowlist does not hold,
 * or a site that the guard cannot classify. A kill-fixture name is reported
 * whatever the allowlist holds, so data cannot turn its rejection off.
 */
export function findDerivationViolations(
  scan: DerivationScan,
  allowlist: ReadonlySet<string> = new Set<string>(),
): readonly DerivationViolation[] {
  const violations: DerivationViolation[] = [];

  for (const site of scan.literals) {
    const killFixture = isKillFixture(site.name);
    if (!killFixture && allowlist.has(site.name)) continue;
    violations.push({
      file: site.file,
      line: site.line,
      column: site.column,
      kind: site.kind,
      name: site.name,
      detail: killFixture
        ? `\`.command(${site.expression})\` is the DR-5 kill fixture: \`${site.name}\` is ` +
          'declared BOTH as a registry action and by hand here. It is not allowlistable. ' +
          'Delete the hand-written command and let the registry declaration — which carries ' +
          "`posture: 'shared-mutating'` — be the single remaining definition."
        : `\`.command(${site.expression})\` bakes the command name into the composition ` +
          'root. Register it through a derivation helper (registerActionCommand, the ' +
          'composite-tool loop, or the harness loop) so the name comes from a registry ' +
          'declaration.',
    });
  }

  for (const site of scan.indeterminate) {
    violations.push({
      file: site.file,
      line: site.line,
      column: site.column,
      kind: site.kind,
      name: site.name,
      detail:
        '`.command()` was called with no argument, so the guard cannot prove the command ' +
        'name is derived. Failing closed.',
    });
  }

  return violations;
}

/** Format one violation for the CLI/report surface. */
export function formatViolation(v: DerivationViolation): string {
  const at = `${v.file}:${v.line}:${v.column}`;
  const label = v.name.length > 0 ? `\`${v.name}\`` : '<unnamed>';
  return `  ✗ ${label} at ${at}\n      ${v.detail}`;
}

export { isIsoDay, isoDayUtc };

/** A disagreement between the tracked set and the live parse. */
export type CliMembershipFinding =
  | { readonly code: 'UNTRACKED_LITERAL'; readonly name: string; readonly message: string }
  | { readonly code: 'STALE_WAIVER'; readonly name: string; readonly message: string }
  | { readonly code: 'RETIRED_BUT_LIVE'; readonly name: string; readonly message: string };

export interface CliMembershipAudit {
  readonly ok: boolean;
  /** Literal command names in the live parse, kill fixtures excluded. */
  readonly literals: readonly string[];
  /** Names tracked as tolerated debt. */
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  readonly stale: readonly string[];
  readonly retiredButLive: readonly string[];
  readonly findings: readonly CliMembershipFinding[];
}

/**
 * Compares the policy with the live parse in both directions.
 *
 * The scan derives the count on each run, and nothing stores it. Kill fixtures
 * are excluded from both sides. They are a standing rejection that
 * {@link findDerivationViolations} reports, and they can never have an
 * allowlist entry.
 */
export function auditCliAllowlistMembership(
  scan: DerivationScan,
  policy: CliDerivationPolicy,
): CliMembershipAudit {
  const findings: CliMembershipFinding[] = [];
  const literals = [...new Set(scan.literals.map((s) => s.name).filter((n) => !isKillFixture(n)))].sort();
  const liveSet = new Set(literals);
  const tracked = Object.keys(policy.allowed).sort();
  const trackedSet = new Set(tracked);
  const retiredNames = Object.keys(policy.retired).sort();

  const untracked = literals.filter((n) => !trackedSet.has(n));
  for (const name of untracked) {
    findings.push({
      code: 'UNTRACKED_LITERAL',
      name,
      message:
        `'${name}' is a hand-written \`.command('${name}')\` literal in the composition root ` +
        'that no allowlist entry tracks. Register it through a derivation helper so its name ' +
        'comes from a registry declaration. Adding an entry is NOT the repair — the seed key ' +
        'set is pinned, so a new entry fails with SEED_KEY_SET_DRIFT.',
    });
  }

  const stale = tracked.filter((n) => !liveSet.has(n));
  for (const name of stale) {
    findings.push({
      code: 'STALE_WAIVER',
      name,
      message:
        `'${name}' holds a waiver but is no longer a hand-written literal in the composition ` +
        'root. If it was paid down, MOVE its entry to "retired" with a `retiredAt` date — the ' +
        'seed key set is the union of both maps, so a move keeps the pin valid and a deletion ' +
        'does not. There is deliberately no way to park a paid-down entry here.',
    });
  }

  const retiredButLive = retiredNames.filter((n) => liveSet.has(n));
  for (const name of retiredButLive) {
    findings.push({
      code: 'RETIRED_BUT_LIVE',
      name,
      message:
        `'${name}' is recorded as retired but is STILL a hand-written literal in the ` +
        'composition root. Retiring an entry without doing the work fails louder than leaving ' +
        'it alone, which is the point: the graveyard is a record of paydowns, not a ' +
        'suppression list.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    literals: Object.freeze(literals),
    tracked: Object.freeze(tracked),
    untracked: Object.freeze(untracked),
    stale: Object.freeze(stale),
    retiredButLive: Object.freeze(retiredButLive),
    findings: Object.freeze(findings),
  });
}

/** Render the membership audit for a human or an agent. */
export function formatCliMembershipAudit(audit: CliMembershipAudit): string {
  const lines: string[] = [
    `CLI derivation membership: ${audit.tracked.length} tracked waiver(s) against ` +
      `${audit.literals.length} live hand-written literal(s) — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      lines.push(`    [${finding.code}] ${finding.name}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** A condition that means the SEED's key set is no longer the one that was pinned. */
export type CliSeedFinding =
  | { readonly code: 'SEED_KEY_SET_DRIFT'; readonly message: string }
  | { readonly code: 'RETIRED_AND_WAIVED'; readonly name: string; readonly message: string };

export interface CliSeedIntegrityAudit {
  /** True when the live key set hashes to the pinned digest and the maps are disjoint. */
  readonly ok: boolean;
  /** `|allowed ∪ retired|` — the seed's size, which legal edits do not change. */
  readonly keySetSize: number;
  readonly digest: string;
  readonly pinnedDigest: string;
  /** Names present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  readonly findings: readonly CliSeedFinding[];
}

/**
 * The digest of the seed key set: `sha256` over the sorted, deduplicated names
 * joined by newlines. Order and duplicates do not change it, because the pinned
 * quantity is a set.
 */
export function cliDerivationSeedDigest(names: readonly string[]): string {
  return keySetDigest(names, CLI_DERIVATION_SEED_DIGEST_ALGORITHM);
}

/**
 * Audits the seed key set against its frozen pin. The inputs are injectable, so
 * a self-test can pose an in-place swap without an edit to the real policy file.
 */
export function auditCliDerivationSeedIntegrity(
  waived: readonly string[],
  retired: readonly string[],
  pinnedDigest: string = CLI_DERIVATION_SEED_KEY_SET_DIGEST,
): CliSeedIntegrityAudit {
  const findings: CliSeedFinding[] = [];
  const waivedSet = new Set(waived);
  const overlapping = [...new Set(retired)].filter((n) => waivedSet.has(n)).sort();
  const keySet = [...new Set([...waived, ...retired])].sort();
  const digest = cliDerivationSeedDigest(keySet);

  if (digest !== pinnedDigest) {
    findings.push({
      code: 'SEED_KEY_SET_DRIFT',
      message:
        `The CLI-derivation seed's key set no longer matches its frozen pin: ${keySet.length} ` +
        `name(s) hash to ${digest}, pinned ${pinnedDigest}. The seed key set is ` +
        'ALLOWED ∪ RETIRED, and it is invariant under every legal edit — paying a verb down ' +
        'MOVES its entry from "allowed" to "retired", it does not delete it. A drift therefore ' +
        'means a name was ADDED (a new hand-written verb smuggled in as a swap, which no ' +
        'comparison against the live parse can see) or DELETED (a paydown recorded as a ' +
        'deletion, which destroys the prior state this tooth is made of). Do NOT regenerate ' +
        'the pin to go green.',
    });
  }

  for (const name of overlapping) {
    findings.push({
      code: 'RETIRED_AND_WAIVED',
      name,
      message:
        `'${name}' is in BOTH the allowlist and the retirement record. A paydown is a MOVE, ` +
        'not a copy — delete the "allowed" entry. Left as is, the verb reads as retired while ' +
        'still holding a live waiver.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    keySetSize: keySet.length,
    digest,
    pinnedDigest,
    overlapping: Object.freeze(overlapping),
    findings: Object.freeze(findings),
  });
}

/** Render the seed-integrity audit for a human or an agent. */
export function formatCliSeedIntegrityAudit(audit: CliSeedIntegrityAudit): string {
  const lines: string[] = [
    `CLI derivation seed integrity: ${audit.keySetSize} name(s), digest ${audit.digest} ` +
      `against pin ${audit.pinnedDigest} — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'name' in finding ? ` ${finding.name}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** A condition that makes an allowlist entry's deadline invalid or past due. */
export type CliExpiryFinding =
  | { readonly code: 'EMPTY_ALLOWLIST'; readonly message: string }
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | { readonly code: 'MALFORMED_HORIZON'; readonly message: string }
  | { readonly code: 'MALFORMED_WAIVER'; readonly name: string; readonly message: string }
  | { readonly code: 'WAIVER_BEYOND_HORIZON'; readonly name: string; readonly message: string }
  | { readonly code: 'EXPIRED_WAIVER'; readonly name: string; readonly message: string };

export interface CliExpiryAudit {
  /** True when every entry is well-formed, within the horizon, and not past due. */
  readonly ok: boolean;
  /** The instant the verdict was taken at, echoed so a report is self-describing. */
  readonly today: string;
  readonly horizon: string;
  /** Entries examined. Zero is a failure, never a clean run. */
  readonly entryCount: number;
  /** Names whose `expires` is strictly before `today`. The deadline, bitten. */
  readonly expired: readonly string[];
  /** Names whose `expires` is later than the pinned horizon — a self-granted renewal. */
  readonly beyondHorizon: readonly string[];
  /** Names with an empty owner or an unparseable `expires`. Fails closed. */
  readonly malformed: readonly string[];
  /** Whole days from `today` to `horizon`. The value is negative after the horizon. */
  readonly daysToHorizon: number;
  readonly findings: readonly CliExpiryFinding[];
}

/**
 * Audits the deadline of each allowlist entry as of the day `today`.
 *
 * `today` has no default, so no unit test reads the clock. The gate entrypoint
 * `cli-derivation-ratchet-guard.ts` passes the UTC day. Dates compare as ISO
 * `YYYY-MM-DD` strings, so a time zone cannot change a verdict. It fails on an
 * empty allowlist, an empty owner, a bad date, an `expires` later than the
 * horizon, and an `expires` before `today`. An entry is live through its
 * `expires` day.
 */
export function auditCliDerivationExpiry(
  today: string,
  entries: Readonly<Record<string, CliWaiverEntry>>,
  horizon: string = CLI_DERIVATION_EXPIRY_HORIZON,
): CliExpiryAudit {
  const findings: CliExpiryFinding[] = [];
  const names = Object.keys(entries).sort();
  const clockOk = isIsoDay(today);
  const horizonOk = isIsoDay(horizon);

  if (!clockOk) {
    findings.push({
      code: 'UNREADABLE_CLOCK',
      message:
        `The expiry audit was handed '${today}' as the current day, which is not a real ` +
        'calendar date in YYYY-MM-DD form. Every deadline comparison below would be ' +
        'meaningless, so the audit fails rather than reporting the waivers live.',
    });
  }
  if (!horizonOk) {
    findings.push({
      code: 'MALFORMED_HORIZON',
      message:
        `The pinned expiry horizon '${horizon}' is not a real calendar date in YYYY-MM-DD ` +
        'form. CLI_DERIVATION_EXPIRY_HORIZON in ' +
        'tools/audit/core/cli-derivation-seed-pin.ts is the one deadline every ' +
        'waiver is measured against; an unreadable horizon disables the tooth that stops a ' +
        'waiver renewing itself, so it fails closed.',
    });
  }
  if (names.length === 0) {
    findings.push({
      code: 'EMPTY_ALLOWLIST',
      message:
        'The CLI-derivation allowlist resolved ZERO entries, so the expiry audit has an empty ' +
        'denominator and proves nothing — "no expired waiver" is trivially true over no ' +
        'waivers. That is what a moved policy file or a renamed field looks like, so it fails ' +
        'rather than reporting clean. If the debt really did reach zero at DR-19, the policy ' +
        'file, its pin and this audit are DELETED in the same commit.',
    });
  }

  const expired: string[] = [];
  const beyondHorizon: string[] = [];
  const malformed: string[] = [];

  for (const name of names) {
    const entry = entries[name];
    if (entry === undefined) continue;

    if (entry.owner.trim().length === 0 || !isIsoDay(entry.expires)) {
      malformed.push(name);
      findings.push({
        code: 'MALFORMED_WAIVER',
        name,
        message:
          `'${name}' carries owner '${entry.owner}' and expires '${entry.expires}'. A waiver ` +
          'needs a non-empty owner (someone the debt comes due for) and a real calendar date ' +
          'in YYYY-MM-DD form (something the deadline can be compared against). Neither can be ' +
          'inferred, so the entry fails closed.',
      });
      continue;
    }

    if (horizonOk && entry.expires > horizon) {
      beyondHorizon.push(name);
      findings.push({
        code: 'WAIVER_BEYOND_HORIZON',
        name,
        message:
          `'${name}' expires ${entry.expires}, later than the pinned horizon ${horizon}. A ` +
          'waiver may not name its own deadline — that is renewal without a decision. Pay the ' +
          'verb down (register it through a derivation helper and MOVE its entry to "retired"), ' +
          'or move CLI_DERIVATION_EXPIRY_HORIZON in ' +
          'tools/audit/core/cli-derivation-seed-pin.ts as a deliberate, isolated ' +
          'commit that re-dates the WHOLE outstanding debt.',
      });
    }

    if (clockOk && entry.expires < today) {
      expired.push(name);
      findings.push({
        code: 'EXPIRED_WAIVER',
        name,
        message:
          `'${name}' (owner: ${entry.owner}) expired on ${entry.expires}; today is ${today}. ` +
          'DR-5: the expiry is ENFORCED, not advisory. Register the verb through a derivation ' +
          'helper and MOVE its entry to "retired". Bumping the date is not the fix — the entry ' +
          `cannot exceed the pinned horizon ${horizon}.`,
      });
    }
  }

  return Object.freeze({
    ok: findings.length === 0,
    today,
    horizon,
    entryCount: names.length,
    expired: Object.freeze(expired),
    beyondHorizon: Object.freeze(beyondHorizon),
    malformed: Object.freeze(malformed),
    daysToHorizon: daysBetween(today, horizon),
    findings: Object.freeze(findings),
  });
}

/** Render the expiry audit for a human or an agent. */
export function formatCliExpiryAudit(audit: CliExpiryAudit): string {
  const lines: string[] = [
    `CLI derivation waiver expiry: ${audit.entryCount} waiver(s) as of ${audit.today}, ` +
      `horizon ${audit.horizon} (${audit.daysToHorizon} day(s)) — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'name' in finding ? ` ${finding.name}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

export interface CliRatchetVerdict {
  readonly ok: boolean;
  readonly membership: CliMembershipAudit;
  readonly seed: CliSeedIntegrityAudit;
  readonly expiry: CliExpiryAudit;
  /** Every finding code raised, across all three teeth, in tooth order. */
  readonly findings: readonly string[];
}

/**
 * Composes the membership, seed-integrity and expiry audits into one verdict as
 * of `today`. `ok` is true only when all three pass. The verdict needs no clock,
 * so tests can drive it directly.
 */
export function auditCliRatchetAsOf(
  today: string,
  scan: DerivationScan,
  policy: CliDerivationPolicy,
  pinnedDigest: string = CLI_DERIVATION_SEED_KEY_SET_DIGEST,
  horizon: string = CLI_DERIVATION_EXPIRY_HORIZON,
): CliRatchetVerdict {
  const membership = auditCliAllowlistMembership(scan, policy);
  const seed = auditCliDerivationSeedIntegrity(
    Object.keys(policy.allowed),
    Object.keys(policy.retired),
    pinnedDigest,
  );
  const expiry = auditCliDerivationExpiry(today, policy.allowed, horizon);
  return Object.freeze({
    ok: membership.ok && seed.ok && expiry.ok,
    membership,
    seed,
    expiry,
    findings: Object.freeze([
      ...membership.findings.map((f) => f.code),
      ...seed.findings.map((f) => f.code),
      ...expiry.findings.map((f) => f.code),
    ]),
  });
}

/** Runs the derivation check on the governed sources. It returns 0 when clean and 1 on a violation. */
export function runGuard(): number {
  const scan = scanGovernedSources();
  const violations = findDerivationViolations(scan, readAllowlist());

  if (violations.length === 0) {
    process.stdout.write(
      `cli:derivation-guard — OK (${scan.sites.length} \`.command(\` site(s); every command ` +
        'name derives from a registry declaration)\n',
    );
    return 0;
  }

  process.stderr.write(
    `cli:derivation-guard — ${violations.length} literal command name(s) in the CLI ` +
      `composition root (of ${scan.sites.length} total \`.command(\` site(s)):\n`,
  );
  for (const v of violations) process.stderr.write(`${formatViolation(v)}\n`);
  process.stderr.write(
    '\nDR-5: the composition root must contain no literal `.command(\'<name>\')` call.\n' +
      'Register the command through a derivation helper so its name comes from a registry\n' +
      `declaration, or record it as tracked debt in ${ALLOWLIST_PATH}.\n`,
  );
  return 1;
}

/**
 * A canonical absolute path for comparison. It resolves symlinks, because Node
 * reports the main module by its realpath while `argv[1]` keeps the link. A path
 * that does not exist falls back to plain resolution, so it reads as "not the
 * entrypoint" and does not throw.
 */
function canonicalPath(candidate: string): string {
  const absolute = path.resolve(candidate);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * True when this file is the main module. The check compares canonical paths,
 * not the filename, so a renamed copy still runs. The run sets
 * `process.exitCode`, not `process.exit`, so stdout drains first. The
 * assignment stays outside any function, because `hasDirectRunExit` finds
 * runnable gates that way.
 */
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = runGuard();
}
